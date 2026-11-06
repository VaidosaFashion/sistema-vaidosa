'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createIdentityBoundary}=require('../mcp/http-identity.cjs');
const {createBusinessReadAdapter,VERSION}=require('../mcp/business-adapter.cjs');
const {createBusinessReadService}=require('../mcp/business-service.cjs');
const {createStreamableHttpHandler,VERSION:PROTOCOL}=require('../mcp/streamable-http.cjs');
const RESOURCE='https://business.invalid/mcp',ISSUER='https://identity.invalid/';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const customer=id(1),otherCustomer=id(2),saleId=id(10),accountId=id(30);
const stock=()=>[1,2,3].map(n=>({id:id(n+100),name:'Produto fictício',size:'G'+n,color_name:'Azul',stock:n===2?0:n}));
const order=(n=10,client=customer,date='2026-11-01T01:30:00.000001Z')=>({id:id(n),client_id:client,sold_at:date,payment_status:'Pago',subtotal:'100.10',discount:'0.10',total_bruto:'100.00'});
const receipt=(n=20)=>({id:id(n),sale_id:saleId,client_id:customer,paid_on:'2026-11-02',value:'100.10',fee_value:'0.10',net_value:'100.00'});
const movement=(n=40,extra={})=>({id:id(n),conta_id:accountId,valor:'10.00',pago:true,reversed_at:null,...extra});
const account=()=>({id:accountId,cliente_id:customer,tipo:'receber',valor:'10.00',proximo_vencimento:'2026-11-10',status:'ativo',recorrencia:'mensal',parcela_atual:3,parcelas:4,archived_at:null,movimentacoes:[movement(40),movement(41),movement(42,{reversed_at:'2026-11-03T12:00:00Z'}),movement(43,{pago:false})],movements_complete:true});
async function identity(extra={}){
 const now=extra.now??(()=>Date.parse('2026-11-06T12:00:00Z'));
 const boundary=createIdentityBoundary({resource:extra.resource??RESOURCE,issuer:ISSUER,now,
  verifyAccessToken:async()=>({verified:true,issuer:ISSUER,audiences:[extra.resource??RESOURCE],subject:'user_one',expiresAt:Math.floor(now()/1000)+60,scopes:['mcp:read','stock:read','sales:read','finance:read']}),
  authorizePrincipal:async()=>({active:true,id:'user_one',store:extra.store??'store_one',permissions:extra.permissions??['stock:read','sales:read','finance:read'],customerIds:Object.hasOwn(extra,'customerIds')?extra.customerIds:null})});
 return boundary.authenticate(new Request(extra.resource??RESOURCE,{headers:{authorization:'Bearer fixture-token'}}));
}
async function setup(options={}){
 let clock=Date.parse('2026-11-06T12:00:00Z');const now=()=>clock,p=await identity({...options,now});const calls=[];
 const gateway={contractVersion:VERSION,store:'store_one',fixture:true,async readSnapshot(plan,context){
  calls.push({plan,context});assert.ok(Object.isFrozen(plan)&&Object.isFrozen(plan.identity)&&Object.isFrozen(plan.fields));
  let data,next=null;
  if(plan.operation==='stock_variants'){
   const offset=plan.page.continuation===null?0:Number(plan.page.continuation.slice(1));data=stock().slice(offset,offset+plan.page.limit);if(offset+data.length<stock().length)next='p'+(offset+data.length);
  }else if(plan.operation==='customer_orders')data=[order()];
  else if(plan.operation==='sale_detail')data={...order(),items:[{product_id:id(101),qty:2,price:'50.05'}],items_complete:true};
  else if(plan.operation==='sale_receipts')data=[receipt()];
  else if(plan.operation==='manual_accounts')data=[account()];
  else throw Error('UNEXPECTED_OPERATION');
  const result={version:VERSION,subject:plan.identity.subject,store:plan.identity.store,snapshot:plan.page.snapshot??'snapshot_one',next,complete:true,data};
  return options.respond?options.respond(result,plan,context,{setNow:v=>{clock=v;}}):result;
 }};
 const adapter=createBusinessReadAdapter({gateway,store:'store_one',resource:RESOURCE,issuer:ISSUER,timeZone:'America/Sao_Paulo',now,timeoutMs:options.timeoutMs??200,audit:options.audit});
 const service=createBusinessReadService({adapter,principal:p,now});return {p,calls,gateway,adapter,service,now,setNow:v=>{clock=v;}};
}
test('business library exposes only scoped reads and UUID schemas; importing creates no client',async()=>{
 const s=await setup();assert.equal(s.service.listTools().length,5);assert.ok(s.service.listTools().every(t=>t.annotations.readOnlyHint&&!t.annotations.destructiveHint));
 assert.match(s.service.listTools().find(t=>t.name==='vaidosa_sale_get').inputSchema.properties.saleId.pattern,/0-9a-f/);
 assert.equal(s.calls.length,0);assert.deepEqual(Object.keys(s.adapter).filter(k=>/write|insert|update|delete|rpc|sql/i.test(k)),[]);
});
test('stock keeps canonical variants, zero balance and explicit fields; no bearer or store_id invented',async()=>{
 const s=await setup(),r=await s.service.call('vaidosa_stock_list');assert.equal(r.contractVersion,2);assert.equal(r.fixture,true);assert.equal(r.items[1].available,0);
 const plan=s.calls[0].plan;assert.equal(plan.identity.store,'store_one');assert.ok(!JSON.stringify(plan).includes('fixture-token'));assert.ok(!JSON.stringify(plan).includes('store_id'));assert.equal(plan.maxResponseBytes,262144);
});
test('frozen forged principals and a different audience cannot reach gateway',async()=>{
 const s=await setup();const forged=Object.freeze({...s.p});await assert.rejects(s.service.call('vaidosa_stock_list',{}, {principal:forged}));
 const wrong=await identity({resource:'https://other.invalid/mcp'});await assert.rejects(s.service.call('vaidosa_stock_list',{}, {principal:wrong}));assert.equal(s.calls.length,0);
});
test('the same customer grant set stays canonical across reauthentication and cursor reuse',async()=>{
 const p=await identity({customerIds:[otherCustomer,customer,customer]});assert.deepEqual(p.customerIds,[customer,otherCustomer]);
 const s=await setup({customerIds:[otherCustomer,customer]}),first=await s.service.call('vaidosa_stock_list',{limit:1});
 const fresh=await identity({customerIds:[customer,otherCustomer]});assert.equal((await s.service.call('vaidosa_stock_list',{limit:1,cursor:first.nextCursor},{principal:fresh})).items[0].productId,id(102));
});
test('store and permission changes cannot reuse a service; unauthorized names are uniform',async()=>{
 const s=await setup(),other=await identity({store:'store_two'}),seller=await setup({permissions:['stock:read']});
 await assert.rejects(s.service.call('vaidosa_stock_list',{}, {principal:other}));
 await assert.rejects(seller.service.call('vaidosa_accounts_list'),/inválidos/);await assert.rejects(seller.service.call('delete_sale'),/inválidos/);assert.equal(s.calls.length,0);assert.equal(seller.calls.length,0);
});
test('customer authorization is checked before query and source rows checked after query',async()=>{
 const s=await setup({customerIds:[customer]});await assert.rejects(s.service.call('vaidosa_customer_orders',{customerId:otherCustomer}));assert.equal(s.calls.length,0);
 const bad=await setup({customerIds:[customer],respond:r=>({...r,data:[order(10,otherCustomer)]})});await assert.rejects(bad.service.call('vaidosa_customer_orders',{customerId:customer}));
 const good=await s.service.call('vaidosa_customer_orders',{customerId:customer});assert.equal(good.items[0].customerId,customer);assert.deepEqual(s.calls[0].plan.identity.customerIds,[customer]);
});
test('unknown and inaccessible sale both return unavailable; no PII or arbitrary filters exported',async()=>{
 for(const change of [null,{...order(10,otherCustomer),items:[],items_complete:true}]){
  const s=await setup({customerIds:[customer],respond:r=>({...r,data:change})});await assert.rejects(s.service.call('vaidosa_sale_get',{saleId}),e=>e.toolCode==='NOT_AVAILABLE');
 }
 const s=await setup();const result=await s.service.call('vaidosa_sale_get',{saleId});assert.equal(result.items.length,1);assert.ok(!JSON.stringify(result).includes('sold_at'));
 for(const args of [{saleId,sql:'select *'},{saleId,store:'store_two'},{saleId,role:'admin'},{saleId,authorization:'PRIVATE'}])await assert.rejects(s.service.call('vaidosa_sale_get',args));
});
test('sale day uses explicit store zone and exact decimal cents',async()=>{
 const s=await setup(),r=await s.service.call('vaidosa_sale_get',{saleId});assert.equal(r.soldOn,'2026-10-31');assert.equal(r.grossCents,10010);assert.equal(r.discountCents,10);assert.equal(r.totalCents,10000);
});
test('sale detail refuses an empty or inconsistent item snapshot instead of reporting partial totals',async()=>{
 for(const items of [[],[{product_id:id(101),qty:2,price:'45.00'}]]){
  const s=await setup({respond:r=>({...r,data:{...order(),items,items_complete:true}})});await assert.rejects(s.service.call('vaidosa_sale_get',{saleId}),e=>e.toolCode==='NOT_AVAILABLE');
 }
 const legacy=await setup({respond:r=>({...r,data:{...order(),items:[{product_id:null,qty:1,price:'100.10'}],items_complete:true}})});assert.equal((await legacy.service.call('vaidosa_sale_get',{saleId})).items[0].productId,null);
});
test('oversized or overflow source money is refused before unsafe totals are returned',async()=>{
 for(const value of ['9'.repeat(200),'90071992547409.92']){
  const s=await setup({respond:r=>({...r,data:[{...receipt(),value,fee_value:'0.00',net_value:value}]})});await assert.rejects(s.service.call('vaidosa_receipts_summary',{from:'2026-11-02',to:'2026-11-02'}));
 }
});
test('pagination hides source cursor and binds user, tool, filters, limit and snapshot',async()=>{
 const s=await setup(),a=await s.service.call('vaidosa_stock_list',{limit:1});assert.match(a.nextCursor,/^[A-Za-z0-9_-]{32}$/);
 const b=await s.service.call('vaidosa_stock_list',{limit:1,cursor:a.nextCursor});assert.equal(b.items[0].available,0);assert.equal(s.calls[1].plan.page.snapshot,'snapshot_one');assert.equal(s.calls[1].plan.page.continuation,'p1');
 const c=await s.service.call('vaidosa_stock_list',{limit:1,cursor:b.nextCursor});assert.equal(c.nextCursor,null);
 await assert.rejects(s.service.call('vaidosa_stock_list',{limit:2,cursor:a.nextCursor}),e=>e.toolCode==='INVALID_CURSOR');
 await assert.rejects(s.service.call('vaidosa_accounts_list',{limit:1,cursor:a.nextCursor}),e=>e.toolCode==='INVALID_CURSOR');
});
test('changed snapshot, repeated rows and no-progress pages fail instead of advancing',async()=>{
 for(const mode of ['snapshot','duplicate','empty']){
  const s=await setup({respond:(r,p)=>p.page.continuation?mode==='snapshot'?{...r,snapshot:'different'}:mode==='duplicate'?{...r,data:[stock()[0]]}:{...r,data:[],next:'p2'}:r});
  const first=await s.service.call('vaidosa_stock_list',{limit:1});await assert.rejects(s.service.call('vaidosa_stock_list',{limit:1,cursor:first.nextCursor}));
 }
});
test('microseconds determine order; timestamp offsets and invalid dates are checked',async()=>{
 const rows=[order(11,customer,'2026-11-01T00:00:00.000002Z'),order(10,customer,'2026-11-01T00:00:00.000001Z')];
 const good=await setup({respond:r=>({...r,data:rows})});assert.equal((await good.service.call('vaidosa_customer_orders',{customerId:customer})).items[0].saleId,id(11));
 const bad=await setup({respond:r=>({...r,data:rows.toReversed()})});await assert.rejects(bad.service.call('vaidosa_customer_orders',{customerId:customer}));
 const date=await setup({respond:r=>({...r,data:[order(10,customer,'2026-02-30T00:00:00Z')]})});await assert.rejects(date.service.call('vaidosa_customer_orders',{customerId:customer}));
});
test('receipts preserve paid_on, net zero, uniqueness and financial source separation',async()=>{
 const s=await setup(),r=await s.service.call('vaidosa_receipts_summary',{from:'2026-11-01',to:'2026-11-30'});assert.equal(r.receivedCents,10010);assert.equal(r.netCents,10000);assert.deepEqual(r.excludes,['manual_accounts','bank_reconciliation']);
 const zero=await setup({respond:r=>({...r,data:[{...receipt(),fee_value:'100.10',net_value:'0.00'}]})});assert.equal((await zero.service.call('vaidosa_receipts_summary',{from:'2026-11-02',to:'2026-11-02'})).netCents,0);
 const dup=await setup({respond:r=>({...r,data:[receipt(),receipt()]})});await assert.rejects(dup.service.call('vaidosa_receipts_summary',{from:'2026-11-02',to:'2026-11-02'}));
});
test('recurring account DTO names recorded amount and all effective payments without inventing balance',async()=>{
 const s=await setup(),r=await s.service.call('vaidosa_accounts_list');assert.equal(r.items[0].recordedAmountCents,1000);assert.equal(r.items[0].effectivePaidCents,2000);assert.equal(r.items[0].status,'ativo');assert.equal(r.items[0].installmentNumber,3);
 for(const key of ['balance','saldo','paidCents','cliente_id'])assert.equal(Object.hasOwn(r.items[0],key),false);assert.equal(r.paidBasis,'all_effective_recorded_movements_not_balance');
});
test('movement ownership, duplicate IDs and reversal completeness cannot distort account totals',async()=>{
 for(const movements of [[movement(40),movement(40)],[movement(40,{conta_id:id(31)})],[movement(40,{reversed_at:''})]]){
  const s=await setup({respond:r=>({...r,data:[{...account(),movimentacoes:movements}]})});await assert.rejects(s.service.call('vaidosa_accounts_list'));
 }
 const archived=await setup({respond:r=>({...r,data:[{...account(),archived_at:'2026-11-05T00:00:00Z'}]})});await assert.rejects(archived.service.call('vaidosa_accounts_list'));
});
test('partial/truncated source, too many items and private extra columns fail closed',async()=>{
 for(const patch of [{complete:false},{data:[{...stock()[0],cpf:'PRIVATE_PERSON_SENTINEL'}]},{subject:'other'},{store:'other'}]){
  const s=await setup({respond:r=>({...r,...patch})});await assert.rejects(s.service.call('vaidosa_stock_list'),e=>!e.message.includes('PRIVATE_PERSON_SENTINEL'));
 }
 const sale=await setup({respond:r=>({...r,data:{...order(),items:[],items_complete:false}})});await assert.rejects(sale.service.call('vaidosa_sale_get',{saleId}));
});
test('dates, IDs, precision and getters rejected; no fallback source reads',async()=>{
 const s=await setup();await assert.rejects(s.service.call('vaidosa_receipts_summary',{from:'2026-02-30',to:'2026-03-01'}));await assert.rejects(s.service.call('vaidosa_sale_get',{saleId:'sale_demo01'}));
 let touched=false;await assert.rejects(s.service.call('vaidosa_sale_get',Object.defineProperty({},'saleId',{enumerable:true,get(){touched=true;return saleId;}})));assert.equal(touched,false);assert.equal(s.calls.length,0);
 const bad=await setup({respond:r=>({...r,data:[{...stock()[0],stock:-1}]})});await assert.rejects(bad.service.call('vaidosa_stock_list'));
 const money=await setup({respond:r=>({...r,data:{...order(),subtotal:'100.001',items:[],items_complete:true}})});await assert.rejects(money.service.call('vaidosa_sale_get',{saleId}));
});
test('abort and expiry before or after source prevent result delivery',async()=>{
 const early=await setup(),c=new AbortController();c.abort();await assert.rejects(early.service.call('vaidosa_stock_list',{}, {principal:early.p,signal:c.signal}));assert.equal(early.calls.length,0);
 const late=await setup({respond:async(r,p,c,{setNow})=>{setNow(Date.parse('2026-11-06T12:02:00Z'));return r;}});await assert.rejects(late.service.call('vaidosa_stock_list'));
});
test('hanging gateway remains capacity bounded; raw upstream error and audit failures leak nothing',async()=>{
 const s=await setup({timeoutMs:10,respond:()=>new Promise(()=>{}),audit:()=>{throw Error('PRIVATE_AUDIT');}});
 await Promise.all(Array.from({length:4},()=>assert.rejects(s.service.call('vaidosa_stock_list'))));await assert.rejects(s.service.call('vaidosa_stock_list'));assert.equal(s.calls.length,4);
 const bad=await setup({respond:()=>{throw Error('PRIVATE_UPSTREAM_TOKEN');}});await assert.rejects(bad.service.call('vaidosa_stock_list'),e=>!e.message.includes('PRIVATE_UPSTREAM_TOKEN'));
});
test('HTTP integration reauthenticates scopes and grants; business DTO2 travels through existing transport',async()=>{
 const s=await setup();let revoked=false;const handler=createStreamableHttpHandler({resource:RESOURCE,issuer:ISSUER,now:s.now,
  verifyAccessToken:async()=>({verified:true,issuer:ISSUER,audiences:[RESOURCE],subject:'user_one',expiresAt:Math.floor(s.now()/1000)+60,scopes:['mcp:read','stock:read']}),
  authorizePrincipal:async()=>({active:!revoked,id:'user_one',store:'store_one',permissions:['stock:read'],customerIds:null}),
  createService:p=>createBusinessReadService({adapter:s.adapter,principal:p,now:s.now})});
 const request=()=>new Request(RESOURCE,{method:'POST',headers:{authorization:'Bearer fixture-token','content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':PROTOCOL},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'vaidosa_stock_list',arguments:{}}})});
 const response=await handler(request()),body=await response.json();assert.equal(response.status,200);assert.equal(body.result.structuredContent.contractVersion,2);assert.equal(body.result.structuredContent.fixture,true);
 revoked=true;const before=s.calls.length;assert.equal((await handler(request())).status,403);assert.equal(s.calls.length,before);
});
