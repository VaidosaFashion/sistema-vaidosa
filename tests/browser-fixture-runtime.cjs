'use strict';
// Source-only fixture factory. Calling source() returns text; it never starts the app.
function fixtureRuntime() {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const ids = {user:uuid(1),client:uuid(2),seller:uuid(3),product:uuid(4),account:uuid(20),sale:uuid(50),payment:uuid(51)};
  const storageKey='vaidosa-browser-fixture:v1';
  const attempts=[], errors=[];
  const deny = name => function(){attempts.push(name);throw Error('OFFLINE_FIXTURE: '+name+' blocked');};
  window.fetch=async()=>deny('fetch')();
  window.XMLHttpRequest=class {constructor(){deny('XHR')();}};
  window.WebSocket=class {constructor(){deny('WebSocket')();}};
  window.EventSource=class {constructor(){deny('EventSource')();}};
  Object.defineProperty(navigator,'sendBeacon',{configurable:true,value:deny('sendBeacon')});
  window.open=deny('window.open'); window.print=deny('print');
  window.showDirectoryPicker=deny('directory picker'); window.showSaveFilePicker=deny('save picker');
  window.showOpenFilePicker=deny('open picker');
  window.confirm=()=>true; window.prompt=()=> 'Motivo fictício do ensaio';
  window.Chart=undefined; // Exercise graceful degradation without a CDN.
  window.JsBarcode=()=>{}; window.jspdf={jsPDF:class {constructor(){throw Error('PDF excluded from browser flow fixture');}}};
  window.turnstile={render:()=> 'fixture-only',reset(){}};
  window.Image=class {set src(value){this._src=value;}get src(){return this._src;}};
  window.addEventListener('error',event=>errors.push(String(event.error?.message||event.message)));
  window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason?.message||event.reason)));
  function initial() {
    const product={id:ids.product,name:'Vestido de ensaio',cat:'Fixture',fabric:'Fictício',size:'G2',barcode:'TEST-004',stock:100,cost:25,price_atacado:50,price_varejo:80,color_id:uuid(5),colors:{nome:'Azul fictício'},created_at:'2026-11-01T12:00:00Z'};
    const sale={id:ids.sale,sold_at:'2026-11-04T12:00:00.123456+00:00',client_id:ids.client,vendedor_id:ids.seller,channel:'Loja',kind:'Venda',pay:'PIX',installments:0,discount:0,subtotal:3000,total_bruto:3000,cost_total:1500,fee_pct:0,fee_value:0,net_received:3000,profit:1500,payment_status:'Pago',price_tier:'Atacado',finance_revision:4,sale_items:Array.from({length:60},(_,i)=>({id:uuid(1000+i),product_id:ids.product,name:'Peça fictícia '+(i+1),size:'G2',barcode:'TEST-004',price:50,cost:25,qty:1})),sale_payments:[{id:ids.payment,sale_id:ids.sale,paid_on:'2026-11-04',value:3000,method:'PIX',installments:0,fee_pct:0,fee_value:0,net_value:3000}]};
    return {version:1,sequence:2000,tables:{profiles:[{id:ids.user,display_name:'Operador fictício',active:true,is_admin:true,is_vendedora:true,vendedor_id:ids.seller}],colors:[{id:uuid(5),nome:'Azul fictício'}],products:[product,{...product,id:uuid(7),barcode:'TEST-007',stock:0},{...product,id:uuid(8),barcode:'TEST-008',size:'G3',stock:1}],clients:[{id:ids.client,name:'Cliente fictício',troca_count:0,created_at:'2026-11-01T12:00:00Z'}],vendedores:[{id:ids.seller,name:'Vendedor fictício'}],sales:[sale,...Array.from({length:44},(_,i)=>({...clone(sale),id:uuid(100+i),subtotal:50,total_bruto:50,cost_total:25,net_received:0,profit:-25,pay:'Pendente',payment_status:'Aberto',finance_revision:0,sale_items:[{...clone(sale.sale_items[0]),id:uuid(1100+i)}],sale_payments:[]}))],sale_financial_audit:[],stock_moves:[],categorias:[{id:uuid(6),nome:'Categoria fictícia',tipo:'despesa'}],v_contas:[{id:ids.account,tipo:'receber',descricao:'Recebível fictício',valor:100,status:'ativo',proximo_vencimento:'2026-11-05',cliente_id:ids.client,cliente_nome:'Cliente fictício',forma_recebimento:'PIX',operation_revision:0,archived_at:null}],movimentacoes:[],store_settings:[{id:true,block_second_swap:true,card_fees:{debito:2.99,credito:{1:4.99,2:5.99,3:6.99,4:7.99,5:8.99,6:9.99,acima6:10.99}}}]},requests:{},stats:{saleCreates:0,corrections:0,settlements:0,stockEntries:0},faults:{}};
  }
  let state;
  try {state=JSON.parse(localStorage.getItem(storageKey));}catch(_){state=null;}
  if(!state || state.version!==1)state=initial();
  const save=()=>localStorage.setItem(storageKey,JSON.stringify(state)); save();
  const allocateId=()=>uuid(state.sequence++);
  const ok=data=>({data:clone(data),error:null});
  const fail=(code,message)=>({data:null,error:{code,message}});
  const request=(id,operation,args)=>{const old=state.requests[id];if(old && (old.operation!==operation || JSON.stringify(old.args)!==JSON.stringify(args)))throw Error('Fixture request payload conflict');return old;};
  const remember=(id,operation,args,result)=>{state.requests[id]={operation,args:clone(args),result:clone(result)};save();};
  function query(table) {
    if(!Object.hasOwn(state.tables,table))throw Error('Unexpected fixture table: '+table);
    const filters=[],orders=[];let one=false,range=null,limit=null,after=null,selectOptions=null;
    const q={select(_columns,options){selectOptions=options;return q;},order(key,options={}){orders.push([key,options.ascending!==false]);return q;},limit(n){limit=n;return q;},eq(key,value){filters.push(r=>r[key]===value);return q;},in(key,values){filters.push(r=>values.includes(r[key]));return q;},lt(key,value){filters.push(r=>r[key]<value);return q;},range(a,b){range=[a,b];return q;},single(){one=true;return q;},maybeSingle(){one=true;return q;},abortSignal(){return q;},or(value){const m=/^sold_at.lt.(.+),and\(sold_at.eq.(.+),id.gt.([a-f0-9-]+)\)$/.exec(value);if(!m||m[1]!==m[2])throw Error('Unexpected fixture cursor');after={date:m[1],id:m[3]};return q;},then(resolve,reject){return Promise.resolve().then(()=>{let rows=state.tables[table].filter(r=>filters.every(fn=>fn(r)));if(after)rows=rows.filter(r=>r.sold_at<after.date||(r.sold_at===after.date&&r.id>after.id));rows.sort((a,b)=>{for(const [key,asc]of orders){if(a[key]<b[key])return asc?-1:1;if(a[key]>b[key])return asc?1:-1;}return 0;});const count=rows.length;if(range)rows=rows.slice(range[0],range[1]+1);if(limit!==null)rows=rows.slice(0,limit);return {...ok(one?rows[0]||null:rows),...(selectOptions?.count?{count}:{})};}).then(resolve,reject);}};
    for(const op of ['insert','update','upsert','delete'])q[op]=()=>{throw Error('Unexpected direct fixture mutation: '+table+'.'+op);};
    return q;
  }
  async function rpc(name,args) {
    const id=args.p_request_id||args.p_client_request_id;
    if(name==='get_account_request_status') {
      if(state.faults.accountLookupFailures){state.faults.accountLookupFailures--;save();throw Error('Synthetic lookup unavailable');}
      const saved=request(id,args.p_expected_operation,args.p_expected_payload);
      return ok(saved?{status:'completed',result:saved.result}:{status:'not_found'});
    }
    if(name==='get_stock_entry_request') {
      const saved=state.requests[id];
      if(saved && (saved.operation!=='apply_stock_entry_v2'||JSON.stringify(saved.expected)!==JSON.stringify(args.p_expected_payload)))throw Error('Fixture stock payload conflict');
      if(!saved)return ok({status:'not_found',request_id:id});
      return ok({...saved.result,product:state.tables.products.find(p=>p.id===saved.result.move.product_id)||null});
    }
    const saved=request(id,name,args);if(saved)return ok(saved.result);
    if(name==='create_sale') {
      if(args.p_pay!=='Pendente'||state.faults.rejectPayOnce){delete state.faults.rejectPayOnce;save();return fail('23514','new row for relation "sales" violates check constraint "sales_pay_check"');}
      const items=args.p_items.map(item=>{const p=state.tables.products.find(p=>p.id===item.product_id);if(!p||p.stock<item.qty)throw Error('Fixture stock insufficient');return {id:allocateId(),product_id:p.id,name:p.name,barcode:p.barcode,size:p.size,price:args.p_price_tier==='Varejo'?p.price_varejo:p.price_atacado,cost:p.cost,qty:item.qty};});
      const subtotal=items.reduce((n,i)=>n+i.qty*i.price,0),cost=items.reduce((n,i)=>n+i.qty*i.cost,0);
      const row={id:allocateId(),client_request_id:id,sold_at:new Date().toISOString(),client_id:args.p_client_id,vendedor_id:args.p_vendedor_id,channel:args.p_channel,kind:args.p_kind,pay:args.p_pay,installments:0,discount:args.p_discount,subtotal,total_bruto:subtotal-args.p_discount,cost_total:cost,fee_pct:0,fee_value:0,net_received:0,profit:-cost,payment_status:'Aberto',price_tier:args.p_price_tier,finance_revision:0,sale_items:items,sale_payments:[]};
      for(const item of items)state.tables.products.find(p=>p.id===item.product_id).stock-=item.qty;
      state.tables.sales.unshift(row);state.stats.saleCreates++;remember(id,name,args,row);return ok(row);
    }
    if(name==='edit_sale_financials') {
      const row=state.tables.sales.find(s=>s.id===args.p_sale_id);if(!row||row.finance_revision!==args.p_expected_revision)return fail('40001','Fixture stale revision');
      const before=clone(row);row.discount=args.p_discount;row.total_bruto=row.subtotal-args.p_discount;
      row.sale_payments=args.p_payments.map(payment=>{const old=row.sale_payments.find(p=>p.id===payment.id);if(!old)throw Error('Fixture payment ID changed');const feePct=old.method===payment.method&&old.installments===payment.installments?old.fee_pct:window.taxaDoPagamento(payment.method,payment.installments);const fee=Math.round(payment.value*feePct)/100;return {...old,...payment,fee_pct:feePct,fee_value:fee,net_value:payment.value-fee};});
      row.fee_value=row.sale_payments.reduce((n,p)=>n+p.fee_value,0);row.net_received=row.sale_payments.reduce((n,p)=>n+p.net_value,0);row.profit=row.net_received-row.cost_total;row.finance_revision++;row.pay=[...new Set(row.sale_payments.map(p=>p.method))].join()||'Pendente';row.payment_status=row.sale_payments.reduce((n,p)=>n+p.value,0)>=row.total_bruto?'Pago':'Parcial';state.stats.corrections++;
      state.tables.sale_financial_audit.push({sale_id:row.id,created_at:new Date().toISOString(),reason:args.p_reason,before_data:before,after_data:clone(row)});remember(id,name,args,row);return ok(row);
    }
    if(name==='edit_account'||name==='settle_account') {
      const row=state.tables.v_contas.find(c=>c.id===args.p_account_id);if(!row)return fail('P0002','Fixture account missing');if(row.operation_revision!==args.p_expected_revision)return fail('40001','Fixture stale account revision');
      let movement=null;
      if(name==='edit_account')Object.assign(row,args.p_changes);
      else {if(row.status!=='ativo')return fail('22023','Fixture account already settled');row.status='concluido';movement={id:allocateId(),conta_id:row.id,tipo:row.tipo,descricao:row.descricao,valor:row.valor,data:args.p_paid_on,data_pagamento:args.p_paid_on,pago:true,operation_request_id:id};state.tables.movimentacoes.push(movement);state.stats.settlements++;}
      row.operation_revision++;const result={account:clone(row),movement:clone(movement),replayed:false};remember(id,name,args,result);
      if(name==='settle_account'&&state.faults.loseAccountResponse){delete state.faults.loseAccountResponse;state.faults.accountLookupFailures=1;save();throw Error('Synthetic lost response after fixture commit');}return ok(result);
    }
    if(name==='apply_stock_entry_v2') {
      const p=state.tables.products.find(p=>p.id===args.p_product_id);if(!p)return fail('P0002','Fixture product missing');if(p.stock+args.p_qty<0)return fail('23514','Fixture negative stock');p.stock+=args.p_qty;if(args.p_new_cost!==null)p.cost=args.p_new_cost;
      const move={id:allocateId(),moved_at:new Date().toISOString(),type:args.p_type,barcode:p.barcode,product_id:p.id,qty:args.p_qty,stock_after:p.stock,note:args.p_note};state.tables.stock_moves.unshift(move);state.stats.stockEntries++;
      const result={status:'applied',request_id:id,product:clone(p),move:clone(move),product_deleted:false};remember(id,name,args,result);state.requests[id].expected={product_id:args.p_product_id,qty:args.p_qty,type:args.p_type,note:args.p_note,new_cost:args.p_new_cost};save();return ok(result);
    }
    throw Error('Unexpected fixture RPC: '+name);
  }
  const client={from:query,rpc,auth:{getSession:async()=>({data:{session:{user:{id:ids.user},access_token:'fictional-offline-token'}},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signInWithPassword:async()=>{throw Error('Fixture login is already synthetic');},signOut:async()=>{throw Error('Fixture logout excluded');}},functions:{invoke:async()=>({data:null,error:{message:'Integration intentionally disabled in fixture'}})}};
  window.supabase={createClient:()=>client};
  window.__fixture=Object.freeze({ids,snapshot:()=>clone(state),errors:()=>errors.slice(),networkAttempts:()=>attempts.slice(),fault:(name,value)=>{state.faults[name]=value;save();},setStock:(id,stock)=>{const row=state.tables.products.find(p=>p.id===id);if(!row||!Number.isSafeInteger(stock)||stock<0)throw Error('Fixture stock override invalid');row.stock=stock;save();}});
}
module.exports={source:()=>`(${fixtureRuntime.toString()})();`};
