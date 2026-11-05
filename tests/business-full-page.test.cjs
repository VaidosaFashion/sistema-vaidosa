'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fullPage,uuid,CLIENT,PRODUCT,nextTurn}=require('./full-page-fixture.cjs');
const {fixtureSale,clone}=require('./financial-fixture.cjs');
const ACCOUNT=uuid(20),MOVE=uuid(21);
const account=()=>({id:ACCOUNT,tipo:'receber',descricao:'Recebível fictício',valor:100,status:'ativo',proximo_vencimento:'2026-11-05',cliente_id:CLIENT,cliente_nome:'Cliente fictício',forma_recebimento:'PIX',operation_revision:0});
async function waitUntil(check){for(let i=0;i<70;i++){await nextTurn();if(check())return;}assert.ok(check(),'fixture action should finish');}
function accountRpc({lost=false}={}){
 const saved=new Map();let settlements=0;
 return {count:()=>settlements,handle:async(name,args,f)=>{
  if(name==='get_account_request_status')return {data:saved.has(args.p_request_id)?{status:'completed',result:saved.get(args.p_request_id)}:{status:'not_found'},error:null};
  if(saved.has(args.p_request_id))return {data:saved.get(args.p_request_id),error:null};
  if(name==='settle_account'){
   settlements++;const a=f.v_contas[0];a.status='concluido';a.operation_revision++;
   f.movimentacoes.push({id:MOVE,conta_id:a.id,tipo:a.tipo,descricao:a.descricao,valor:a.valor,data:'2026-11-05',data_pagamento:'2026-11-05',pago:true,operation_request_id:args.p_request_id});
   const result={account:clone(a),movement:clone(f.movimentacoes[0])};saved.set(args.p_request_id,result);
   if(lost)throw Error('Synthetic lost response');return {data:result,error:null};
  }
  if(name==='edit_account'){
   Object.assign(f.v_contas[0],args.p_changes);f.v_contas[0].operation_revision++;
   const result={account:clone(f.v_contas[0])};saved.set(args.p_request_id,result);return {data:result,error:null};
  }
  throw Error('Unexpected fixture RPC '+name);
 }};
}
test('opening Finance with empty categories and missing Chart performs no writes and renders tables',async t=>{
 const h=await fullPage(t,{}, {noChart:true,fixtures:{categorias:[],v_contas:[account()]}});
 h.w.setTab('financeiro');await nextTurn();
 assert.match(h.w.document.getElementById('fin_tabelaReceber').textContent,/Recebível fictício/);
 assert.equal(h.w.document.getElementById('financeChartsNote').classList.contains('hide'),false);
 assert.deepEqual(h.writes,[]);assert.equal(h.errors.length,0);
});
test('editing a receivable before opening New preserves client reference and uses revision RPC',async t=>{
 const rpc=accountRpc(),h=await fullPage(t,{}, {fixtures:{v_contas:[account()]},rpc:rpc.handle});
 h.w.editarContaReceber(ACCOUNT);
 assert.equal(h.w.document.getElementById('receberCliente').value,CLIENT);
 h.w.document.getElementById('receberDescricao').value='Descrição ajustada';
 h.w.document.getElementById('btnSalvarReceber').click();
 await waitUntil(()=>h.w.document.getElementById('modalContaReceber').style.display==='none');
 const edit=h.writes.find(x=>x.rpc==='edit_account');
 assert.equal(edit.payload.p_changes.cliente_id,CLIENT);assert.equal(edit.payload.p_expected_revision,0);
 assert.equal(h.state().db.contas[0].clienteId,CLIENT);assert.equal(h.state().db.contas[0].operationRevision,1);
 assert.ok(h.clientsCreated.some(c=>c[2]?.global?.headers?.Authorization==='Bearer fictional-offline-token'));
 assert.doesNotMatch(JSON.stringify(h.storage()),/fictional-offline-token/);
});
test('settlement lost response is recovered by same request; 40-piece cart and inventory are preserved',async t=>{
 const rpc=accountRpc({lost:true}),h=await fullPage(t,{}, {fixtures:{v_contas:[account()]},rpc:rpc.handle});
 h.w.handleBarcodeInput('TEST-004');const input=h.w.document.querySelector('#saleItems input[data-qty]');input.value='40';input.dispatchEvent(new h.w.Event('change'));
 const before=JSON.stringify(h.state().currentSale.items),stock=h.state().db.products[0].stock;
 await h.w.receberConta(ACCOUNT);await h.w.receberConta(ACCOUNT);
 assert.equal(rpc.count(),1);assert.equal(h.fixtures.movimentacoes.length,1);
 assert.equal(h.state().db.contas[0].status,'concluido');assert.equal(JSON.stringify(h.state().currentSale.items),before);assert.equal(h.state().db.products[0].stock,stock);
 assert.ok(h.writes.every(x=>!x.table));assert.equal(h.errors.length,0);
});
test('mismatched session blocks every business RPC and keeps request for original user',async t=>{
 const h=await fullPage(t,{}, {fixtures:{v_contas:[account()]}});
 h.w.eval(`currentProfile.id='${uuid(99)}'`);
 assert.equal(await h.w.executeAccountOperation('settle_account',{p_account_id:ACCOUNT,p_expected_revision:0,p_paid_on:'2026-11-05'}),false);
 assert.equal(h.writes.length,0);
 assert.match(JSON.stringify(h.storage()),/settle_account/);
});
test('stock refresh updates canonical balance before rejection without erasing cart',async t=>{
 const h=await fullPage(t);h.w.handleBarcodeInput('TEST-004');h.fixtures.products[0].stock=0;
 await h.controller().finalize();
 assert.equal(h.state().db.products.find(p=>p.id===PRODUCT).stock,0);assert.equal(h.state().currentSale.items.length,1);assert.equal(h.writes.length,0);
 assert.match(h.w.document.getElementById('cartDraftStatus').textContent,/Estoque insuficiente/);
});
test('variant table responds to same filters as family summary and navigation closes sale drawer',async t=>{
 const h=await fullPage(t,{}, {financial:true});h.w.setTab('estoque');
 const before=h.w.document.querySelectorAll('#stockVariants tr').length;assert.ok(before>1);
 const search=h.w.document.getElementById('st_q');search.value='TEST-004';search.dispatchEvent(new h.w.Event('input'));
 assert.equal(h.w.document.querySelectorAll('#stockVariants tr').length,1);
 h.w.openSaleDrawer(h.fixtures.sales[0].id);h.w.setTab('clientes');
 assert.equal(h.w.document.getElementById('saleDrawer').getAttribute('aria-hidden'),'true');
});
test('finance history shows every installment, reversed records and sale receipt with customer and origin',async t=>{
 const sale=fixtureSale();sale.client_id=CLIENT;
 const h=await fullPage(t,{}, {financial:true,sale,fixtures:{v_contas:[account()],movimentacoes:[
 {id:MOVE,conta_id:ACCOUNT,tipo:'receber',descricao:'Parcela um',valor:50,data_pagamento:'2026-11-01',pago:true,reversed_at:'2026-11-03T12:00:00Z'},
 {id:uuid(22),conta_id:ACCOUNT,tipo:'receber',descricao:'Parcela dois',valor:50,data_pagamento:'2026-11-02',pago:true}]}});
 h.w.setTab('financeiro');await nextTurn();const text=h.w.document.getElementById('fin_tabelaHistorico').textContent;
 assert.match(text,/Parcela um/);assert.match(text,/Parcela dois/);assert.match(text,/Revertido/);assert.match(text,/Venda · recebido/);assert.match(text,/Cliente fictício/);
 assert.equal(h.writes.length,0);
});
test('customer history reads more than 20 orders, opens detail and resets pending selection on navigation',async t=>{
 const sales=Array.from({length:41},(_,i)=>({...fixtureSale(),id:uuid(100+i),client_id:CLIENT,sold_at:'2026-11-04T12:00:00.123456+00:00'}));
 const h=await fullPage(t,{}, {fixtures:{sales}});h.w.eval(`selectedClientId='${CLIENT}'`);h.w.renderClientHistory();
 await waitUntil(()=>h.w.document.querySelectorAll('#clientHistory article').length===20);
 await h.w.getCustomerOrdersController().loadMore();assert.equal(h.w.document.querySelectorAll('#clientHistory article').length,40);
 await h.w.getCustomerOrdersController().loadMore();assert.equal(h.w.document.querySelectorAll('#clientHistory article').length,41);
 h.w.setTab('clientes');await nextTurn();assert.match(h.w.document.getElementById('clientHistory').textContent,/Selecione um cliente/);
 assert.equal(h.writes.length,0);
});
test('read failure marks cached data stale and never seeds missing categories',async t=>{
 const h=await fullPage(t,{}, {readError:'categorias'});h.w.setTab('financeiro');await nextTurn();
 assert.equal(h.w.document.getElementById('dataFreshness').classList.contains('hide'),false);assert.match(h.w.document.getElementById('dataFreshness').textContent,/categorias/);assert.equal(h.writes.length,0);
});
test('dashboard keeps manual and sale receipt totals separate even when they describe the same money',async t=>{
 const date=new Date().toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
 const sale=fixtureSale();sale.sale_payments[0].paid_on=date;
 const h=await fullPage(t,{}, {financial:true,sale,fixtures:{v_contas:[account()],movimentacoes:[{id:MOVE,conta_id:ACCOUNT,tipo:'receber',descricao:'Mesmo fato sem vínculo canônico',valor:3000,data_pagamento:date,pago:true}]}});
 h.w.setTab('financeiro');await nextTurn();
 assert.match(h.w.document.getElementById('fin_dashEntradas').textContent,/3.000/);
 assert.match(h.w.document.getElementById('fin_dashVendas').textContent,/3.000/);
 assert.doesNotMatch(h.w.document.getElementById('fin_dashSaldo').textContent,/6.000/);
});
test('history month filter includes years represented only by sale receipts and ignores empty dates',async t=>{
 const sale=fixtureSale();sale.sale_payments[0].paid_on='2025-02-01';
 const h=await fullPage(t,{}, {financial:true,sale,fixtures:{movimentacoes:[{id:MOVE,conta_id:ACCOUNT,tipo:'receber',valor:1,pago:true,data_pagamento:null,data:null}]}});
 h.w.setTab('financeiro');await nextTurn();
 const values=[...h.w.document.getElementById('fin_historicoMes').options].map(o=>o.value);
 assert.ok(values.includes('2025-02'));assert.ok(!values.includes('0-01'));assert.ok(values.length<100);
});
