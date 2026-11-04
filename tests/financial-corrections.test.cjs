const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const {root, clone, saleId, paymentId, fixtureSale, readSource, functionSource} = require('./financial-fixture.cjs');

function harness({row = fixtureSale(), rpc, audit = []} = {}) {
  // outside-only does not execute index scripts, load CDNs or open connections.
  // Actual production modal, mapper, RPC detection and correction module run here.
  const dom = new JSDOM(readSource(), {url:'http://localhost/',runScripts:'outside-only'});
  const w = dom.window;
  const calls = [], reads = [], notices = [];
  const inventory = row.sale_items.map(x=>({id:x.product_id,stock:10}));
  w.escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  w.fmtBRL = value => Number(value).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  w.fmtDataBR = value => String(value).slice(0,10).split('-').reverse().join('/');
  w.taxaDoPagamento = (method,n) => method==='Debito'?2.99:method==='Credito'?(n===1?4.99:6.99):0;
  w.fecharEdicaoVenda = w.closePaymentModal = () => {};
  w.renderSalesTable = w.renderHome = () => {};
  w.toast = (...args) => notices.push(args);
  w.currentPaymentSaleId = w.editandoVendaId = saleId;
  w.eval(functionSource('mapSaleFromDb'));
  w.eval(functionSource('isMissingRpc'));
  w.db = {sales:[w.mapSaleFromDb(clone(row))],products:clone(inventory)};
  let current = clone(row);
  function persist(payload) {
    const payments = payload.p_payments.map(p=>{
      const old=current.sale_payments.find(x=>x.id===p.id);
      const pct=old.method===p.method && old.installments===p.installments ? old.fee_pct : w.taxaDoPagamento(p.method,p.installments);
      const fee=Math.round(p.value*pct)/100;
      return {...old,...p,fee_pct:pct,fee_value:fee,net_value:Math.round((p.value-fee)*100)/100};
    });
    current={...current,discount:payload.p_discount,total_bruto:current.subtotal-payload.p_discount,
      sale_payments:payments,fee_value:payments.reduce((a,p)=>a+p.fee_value,0),
      net_received:payments.reduce((a,p)=>a+p.net_value,0),finance_revision:current.finance_revision+1};
    current.profit=current.net_received-current.cost_total;
    return {data:clone(current),error:null};
  }
  w.sb = {
    from(table) {
      reads.push(table);
      const query={select(){return query},eq(){return query},order(){return query},
        single:async()=>({data:clone(current),error:null}),
        limit:async()=>({data:clone(audit),error:null})};
      assert.ok(['sales','sale_financial_audit'].includes(table),'correction must not touch inventory');
      return query;
    },
    async rpc(name,payload) {
      assert.equal(name,'edit_sale_financials');
      calls.push(clone(payload));
      return rpc ? rpc(payload,calls.length,persist) : persist(payload);
    }
  };
  let submit;
  const form=w.document.getElementById('financialCorrectionForm');
  const add=form.addEventListener.bind(form);
  form.addEventListener=(type,handler,...args)=>{
    if(type==='submit') submit=handler;
    add(type,handler,...args);
  };
  w.eval(fs.readFileSync(path.join(root,'financial-corrections.js'),'utf8'));
  const input=(id,value)=>{
    const el=w.document.getElementById(id);
    el.value=String(value);
    el.dispatchEvent(new w.Event('input',{bubbles:true}));
    return el;
  };
  return {w,calls,reads,notices,inventory,input,
    open:()=>w.openFinancialCorrection(saleId),
    submit:()=>submit({preventDefault(){}}),
    error:()=>w.document.getElementById('fc_error').textContent,
    isOpen:()=>!w.document.getElementById('modalFinancialCorrection').classList.contains('hide'),
    edit:()=>{input('fc_discount',600);input('fc_value_'+paymentId,2400);input('fc_reason','Desconto combinado após finalizar');},
    close:()=>dom.window.close()};
}

test('opening reads fresh sale and cancel never writes or changes 60 items/stock', async()=>{
  const h=harness(); const before=JSON.stringify(h.w.db);
  await h.open(); h.edit();
  assert.equal(h.isOpen(),true);
  h.w.document.getElementById('btnCancelFinancialCorrection').click();
  assert.equal(h.isOpen(),false);
  assert.equal(h.calls.length,0);
  assert.equal(JSON.stringify(h.w.db),before);
  assert.deepEqual(h.reads,['sales','sale_financial_audit']);
  h.close();
});

test('discount and received value are one RPC preserving sale/payment IDs and all pieces',async()=>{
  const h=harness(); await h.open(); h.edit(); await h.submit();
  assert.equal(h.calls.length,1);
  const p=h.calls[0];
  assert.equal(p.p_sale_id,saleId); assert.equal(p.p_discount,600);
  assert.equal(p.p_expected_revision,4); assert.equal(p.p_payments[0].id,paymentId);
  assert.equal(p.p_payments[0].value,2400); assert.ok(p.p_request_id);
  assert.deepEqual(Object.keys(p).sort(),['p_discount','p_expected_revision','p_payments','p_reason','p_request_id','p_sale_id']);
  const saved=h.w.db.sales[0];
  assert.equal(saved.items.length,60); assert.equal(saved.totalBruto,2400);
  assert.equal(saved.netReceived,2400); assert.equal(saved.profit,900);
  assert.equal(saved.financeRevision,5); assert.equal(saved.payments[0].id,paymentId);
  assert.deepEqual(clone(h.w.db.products),h.inventory);
  assert.equal(h.isOpen(),false);
  h.close();
});

test('discount does not silently reduce received payment and rejects overpayment',async()=>{
  const h=harness();await h.open();h.input('fc_discount',600);h.input('fc_reason','Desconto após finalizar');
  assert.equal(h.w.document.getElementById('fc_value_'+paymentId).value,'3000.00');
  assert.match(h.error(),/ultrapassam/);
  await h.submit(); assert.equal(h.calls.length,0);assert.equal(h.isOpen(),true);
  h.close();
});

test('unchanged form is no-op even without reason',async()=>{
  const h=harness();await h.open();await h.submit();
  assert.equal(h.calls.length,0);assert.equal(h.isOpen(),false);
  assert.equal(h.notices.at(-1)[0],'Sem alterações');h.close();
});

test('credit method change enables installments and previews current configured fee',async()=>{
  const h=harness();await h.open();h.edit();
  const method=h.input('fc_method_'+paymentId,'Credito');
  method.dispatchEvent(new h.w.Event('change',{bubbles:true}));
  h.input('fc_installments_'+paymentId,3);
  assert.equal(h.w.document.getElementById('fc_installments_'+paymentId).disabled,false);
  const summary=h.w.document.getElementById('fc_summary').textContent;
  assert.match(summary,/167,76/);assert.match(summary,/2\.232,24/);
  await h.submit();assert.equal(h.calls[0].p_payments[0].method,'Credito');
  assert.equal(h.calls[0].p_payments[0].installments,3);h.close();
});

test('amount-only change preserves historical fee instead of today rate',async()=>{
  const row=fixtureSale();Object.assign(row.sale_payments[0],{method:'Credito',installments:3,fee_pct:2,fee_value:60,net_value:2940});
  const h=harness({row});await h.open();h.edit();
  assert.match(h.w.document.getElementById('fc_summary').textContent,/48,00/);
  await h.submit();assert.equal(h.w.db.sales[0].payments[0].feePct,2);h.close();
});

test('double submit while saving sends once and keeps form controls locked',async()=>{
  let resolve;const h=harness({rpc:(p,n,persist)=>new Promise(r=>{resolve=()=>r(persist(p));})});
  await h.open();h.edit();const first=h.submit();
  assert.equal(h.w.document.getElementById('btnSaveFinancialCorrection').disabled,true);
  await h.submit();assert.equal(h.calls.length,1);
  h.w.closeFinancialCorrection();assert.equal(h.isOpen(),true);
  resolve();await first;assert.equal(h.isOpen(),false);h.close();
});

test('lost response retains form and reuses request ID on retry',async()=>{
  const h=harness({rpc:(p,n,persist)=>n===1?Promise.reject(new Error('Conexão interrompida')):persist(p)});
  await h.open();h.edit();await h.submit();
  assert.equal(h.isOpen(),true);assert.match(h.error(),/Conexão interrompida/);
  assert.equal(h.w.document.getElementById('fc_discount').value,'600');
  await h.submit();assert.equal(h.calls.length,2);
  assert.deepEqual(h.calls[0],h.calls[1]);assert.equal(h.isOpen(),false);h.close();
});

test('stale revision reports server conflict and leaves cache/stock unchanged',async()=>{
  const h=harness({rpc:async()=>({data:null,error:{code:'40001',message:'A venda mudou. Abra novamente.'}})});
  const before=JSON.stringify(h.w.db);await h.open();h.edit();await h.submit();
  assert.equal(h.isOpen(),true);assert.match(h.error(),/venda mudou/);
  assert.equal(JSON.stringify(h.w.db),before);h.close();
});

test('missing migration blocks opening without writing',async()=>{
  const row=fixtureSale();delete row.finance_revision;
  const h=harness({row});await h.open();
  assert.equal(h.isOpen(),false);assert.equal(h.calls.length,0);
  assert.match(h.notices[0][1],/atualização do banco/);h.close();
});

test('missing RPC fails closed without direct table update fallback',async()=>{
  const h=harness({rpc:async()=>({data:null,error:{code:'PGRST202',message:'could not find the function'}})});
  await h.open();h.edit();await h.submit();
  assert.match(h.error(),/Nenhuma correção foi feita/);assert.equal(h.isOpen(),true);
  assert.deepEqual(h.reads,['sales','sale_financial_audit']);h.close();
});

test('discount validation and reason are enforced before sending',async()=>{
  const h=harness();await h.open();h.input('fc_discount',3001);await h.submit();
  assert.match(h.error(),/desconto/);assert.equal(h.calls.length,0);
  h.edit();h.input('fc_reason','  ');await h.submit();
  assert.match(h.error(),/motivo/);assert.equal(h.calls.length,0);h.close();
});

test('historical payments and reason are escaped in visible audit',async()=>{
  const h=harness({audit:[{created_at:'2026-11-04T12:00:00Z',actor_name:'Operador fictício',reason:'<img src=x onerror=alert(1)>',before_data:{discount:0},after_data:{discount:600}}]});
  await h.open();await Promise.resolve();
  const history=h.w.document.getElementById('fc_audit');
  assert.equal(history.querySelector('img'),null);assert.match(history.textContent,/<img/);
  assert.match(history.textContent,/Operador fictício/);
  assert.match(history.textContent,/600/);h.close();
});

test('partial balance allowed and zero-total sale with no payments can be settled',async()=>{
  const h=harness();await h.open();h.input('fc_value_'+paymentId,2000);h.input('fc_reason','Corrigir valor recebido');
  assert.match(h.w.document.getElementById('fc_summary').textContent,/Parcial/);
  await h.submit();assert.equal(h.calls.length,1);h.close();
  const row=fixtureSale();row.sale_payments=[];row.payment_status='Aberto';
  const empty=harness({row});await empty.open();empty.input('fc_discount',3000);empty.input('fc_reason','Bonificação integral');
  assert.match(empty.w.document.getElementById('fc_summary').textContent,/Pago/);
  await empty.submit();assert.equal(empty.calls[0].p_payments.length,0);empty.close();
});

module.exports={harness};

test('date-only correction keeps historical recorded fee even if rate calculation differs',async()=>{
  const row=fixtureSale();Object.assign(row.sale_payments[0],{method:'Credito',installments:3,fee_pct:2,fee_value:61,net_value:2939});
  const h=harness({row});await h.open();h.input('fc_date_'+paymentId,'2026-11-03');
  assert.match(h.w.document.getElementById('fc_summary').textContent,/61,00/);
  h.close();
});

test('payment status uses cents so 0.10 + 0.70 settles a 0.80 sale',()=>{
  const dom=new JSDOM('',{runScripts:'outside-only'});
  dom.window.toNum=value=>Number(value||0);
  dom.window.eval(functionSource('getSalePaymentStatus'));
  assert.equal(dom.window.getSalePaymentStatus({totalBruto:0.8,payments:[{value:0.1},{value:0.7}]}),'Pago');
  assert.equal(dom.window.getSalePaymentStatus({totalBruto:0.81,payments:[{value:0.1},{value:0.7}]}),'Parcial');
  dom.window.close();
});

test('full production inline script and correction module compile without execution',()=>{
  const vm=require('node:vm');
  const dom=new JSDOM(readSource(),{runScripts:'outside-only'});
  const inline=[...dom.window.document.scripts].filter(s=>!s.src&&s.textContent.trim());
  assert.equal(inline.length,1,'main application script is parsed whole, never executed');
  for(const script of inline) assert.doesNotThrow(()=>new vm.Script(script.textContent));
  assert.doesNotThrow(()=>new vm.Script(fs.readFileSync(path.join(root,'financial-corrections.js'),'utf8')));
  dom.window.close();
});

test('reviewable preview has no production endpoints and runs actual correction UI offline',async()=>{
  const {buildPreview,policy}=require('./preview-server.cjs');
  const html=buildPreview();
  assert.match(policy,/connect-src 'none'/);
  assert.doesNotMatch(html,/https?:\/\/|SUPABASE_ANON_KEY|ysultkzfhgtyujbomfqz|localStorage|sessionStorage/);
  const dom=new JSDOM(html,{runScripts:'outside-only',url:'http://localhost/'});
  const w=dom.window;
  // A single eval preserves the lexical scope shared by browser script tags.
  // Individual jsdom eval calls isolate const/let bindings unlike page scripts.
  w.eval([...w.document.scripts].map(script=>script.src
    ? fs.readFileSync(path.join(root,'financial-corrections.js'),'utf8')
    : script.textContent).join('\n'));
  assert.match(w.document.getElementById('demoCount').textContent,/60 peças/);
  await w.openFinancialCorrection(saleId);
  w.document.getElementById('fc_discount').value='600';
  w.document.getElementById('fc_value_'+paymentId).value='2400';
  w.document.getElementById('fc_reason').value='Desconto demonstrativo';
  w.document.getElementById('financialCorrectionForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(w.document.getElementById('demoTotal').textContent,/2\.400,00/);
  assert.match(w.document.getElementById('demoCount').textContent,/60 peças/);
  assert.match(w.document.getElementById('demoStock').textContent,/600 unidades/);
  assert.match(w.document.getElementById('demoAuditCount').textContent,/1 correção/);
  await w.openFinancialCorrection(saleId);await Promise.resolve();
  assert.match(w.document.getElementById('fc_audit').textContent,/Desconto demonstrativo/);
  dom.window.close();
});

test('standalone preview embeds all scripts/assets and remains network-free',async()=>{
  const {buildStandalonePreview}=require('./preview-server.cjs');
  const html=buildStandalonePreview();
  const dom=new JSDOM(html,{runScripts:'outside-only',url:'http://localhost/'});
  const w=dom.window;
  assert.equal(w.document.querySelectorAll('script[src]').length,0);
  assert.match(w.document.querySelector('.demo-head img').src,/^data:image\/png;base64,/);
  assert.match(w.document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,/connect-src 'none'/);
  w.eval([...w.document.scripts].map(script=>script.textContent).join('\n'));
  await w.openFinancialCorrection(saleId);
  assert.equal(w.document.getElementById('modalFinancialCorrection').classList.contains('hide'),false);
  assert.equal(w.document.querySelectorAll('#fc_payments fieldset').length,1);
  dom.window.close();
});
