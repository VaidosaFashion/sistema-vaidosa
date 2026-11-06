'use strict';
// Business read boundary over a narrow, injected canonical snapshot gateway.
// No SDK client, URL, credential, SQL executor, environment or network is loaded.
const {randomBytes,createHash}=require('node:crypto');
const {requireVerifiedPrincipal,requireVerifiedPrincipalAsync,hasSharedAuthorization,canonicalHttps}=require('./http-identity.cjs');
const {ToolError}=require('./service.cjs');
const {requireUUID,requireDate,isEffectiveMovement}=require('../modules/accounts-domain.js');
const {moneyToCents}=require('../modules/reporting-domain.js');
const VERSION='vaidosa-business-read-v1';
const PLANS=Object.freeze({
 stock:Object.freeze({operation:'stock_variants',fields:['id','name','size','color_name','stock'],order:['id:asc']}),
 orders:Object.freeze({operation:'customer_orders',fields:['id','client_id','sold_at','payment_status','subtotal','discount','total_bruto'],order:['sold_at:desc','id:asc']}),
 sale:Object.freeze({operation:'sale_detail',fields:['id','client_id','sold_at','payment_status','subtotal','discount','total_bruto','items','items_complete'],order:[]}),
 receipts:Object.freeze({operation:'sale_receipts',fields:['id','sale_id','client_id','paid_on','value','fee_value','net_value'],order:['paid_on:asc','id:asc']}),
 accounts:Object.freeze({operation:'manual_accounts',fields:['id','cliente_id','tipo','valor','proximo_vencimento','status','recorrencia','parcela_atual','parcelas','archived_at','movimentacoes','movements_complete'],order:['id:asc']})
});
function unavailable(){return new ToolError('NOT_AVAILABLE','Recurso indisponível para esta sessão.');}
function plain(v,keys){
 if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))throw unavailable();
 const ds=Object.getOwnPropertyDescriptors(v);if(Reflect.ownKeys(ds).some(k=>typeof k!=='string'||!keys.includes(k)||!Object.hasOwn(ds[k],'value'))||keys.some(k=>!Object.hasOwn(ds,k)))throw unavailable();return v;
}
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function text(v,max=200){if(typeof v!=='string'||!v.length||v.length>max)throw unavailable();return v;}
function count(v,min=0){if(!Number.isSafeInteger(v)||v<min)throw unavailable();return v;}
function cents(v,min=0){if(typeof v==='string'&&v.length>32)throw unavailable();const n=moneyToCents(v);return count(n,min);}
function sum(values){const n=values.reduce((a,b)=>a+BigInt(b),0n);return count(Number(n));}
function instant(v){
 const m=typeof v==='string'&&/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(v);
 if(!m||Number(m[2])>23||Number(m[3])>59||Number(m[4])>59)throw unavailable();requireDate(m[1]);
 const seconds=Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}${m[6]}`);if(!Number.isFinite(seconds))throw unavailable();
 return BigInt(seconds)*1000n+BigInt((m[5]||'').padEnd(6,'0'));
}
function comparePosition(a,b){if(a.time!==null||b.time!==null){if(a.time===null||b.time===null)throw unavailable();if(a.time!==b.time)return a.time>b.time?-1:1;}return a.id<b.id?-1:a.id>b.id?1:0;}
function createBusinessReadAdapter({gateway,store,resource,issuer,timeZone,now=Date.now,timeoutMs=1500,audit=()=>{}}={}){
 canonicalHttps(resource);canonicalHttps(issuer);text(store,128);
 if(!timeZone||typeof gateway?.readSnapshot!=='function'||gateway.contractVersion!==VERSION||gateway.store!==store||typeof gateway.fixture!=='boolean'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000||typeof audit!=='function')throw Error('Explicit canonical read gateway and binding required');
 const dayFormat=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}),salt=randomBytes(32);let inFlight=0;
 function authorize(principal,permission){
  requireVerifiedPrincipal(principal,{issuer,resource,now});if(principal.store!==store||!principal.permissions.includes(permission))throw unavailable();
  return principal.customerIds===null?null:principal.customerIds.map(requireUUID);
 }
 const customerAllowed=(ids,id)=>ids===null||id!==null&&ids.includes(id);
 function authorizeFresh(principal,permission,signal){
  const customers=authorize(principal,permission);
  if(!hasSharedAuthorization(principal))return customers;
  return requireVerifiedPrincipalAsync(principal,{issuer,resource,now,signal}).then(()=>{authorize(principal,permission);return customers;});
 }
 async function read(kind,principal,query,permission,maxRows){
  const customers=authorize(principal,permission);query.signal?.throwIfAborted();if(inFlight>=4)throw unavailable();
  const controller=new AbortController(),abort=()=>controller.abort();query.signal?.addEventListener('abort',abort,{once:true});
  if(query.signal?.aborted)controller.abort();const timer=setTimeout(abort,timeoutMs);
  const plan=freeze({...PLANS[kind],version:VERSION,identity:{subject:principal.id,store,customerIds:customers},filters:structuredClone(query.filters||{}),page:{limit:maxRows,continuation:query.continuation??null,snapshot:query.snapshot??null},maxResponseBytes:262144});
  let onAbort;const stopped=new Promise((_,reject)=>{onAbort=()=>reject(unavailable());if(controller.signal.aborted)onAbort();else controller.signal.addEventListener('abort',onAbort,{once:true});});
  inFlight++;const work=Promise.resolve().then(async()=>{
   controller.signal.throwIfAborted();await authorizeFresh(principal,permission,controller.signal);
   const value=await gateway.readSnapshot(plan,Object.freeze({signal:controller.signal,principal}));
   await authorizeFresh(principal,permission,controller.signal);return value;
  }).finally(()=>{inFlight--;});
  try{
   const result=await Promise.race([work,stopped]);controller.signal.throwIfAborted();authorize(principal,permission);
   plain(result,['version','subject','store','snapshot','next','complete','data']);
   if(result.version!==VERSION||result.subject!==principal.id||result.store!==store||result.complete!==true||typeof result.snapshot!=='string'||!/^[A-Za-z0-9:_-]{1,96}$/.test(result.snapshot)||result.next!==null&&(typeof result.next!=='string'||!/^[A-Za-z0-9:_-]{1,96}$/.test(result.next))||query.snapshot&&result.snapshot!==query.snapshot)throw unavailable();
   return {result,customers};
  }catch{throw unavailable();}
  finally{clearTimeout(timer);query.signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',onAbort);try{audit(Object.freeze({event:'business_read',operation:PLANS[kind].operation,actor:createHash('sha256').update(salt).update(principal.id).digest('hex').slice(0,16)}));}catch{}}
 }
 function sale(row,customers){
  const client=row.client_id===null?null:requireUUID(row.client_id);if(!customerAllowed(customers,client))throw unavailable();
  const gross=cents(row.subtotal),discount=cents(row.discount),total=cents(row.total_bruto);if(gross-discount!==total||!['Pago','Parcial','Aberto'].includes(row.payment_status))throw unavailable();
  const time=instant(row.sold_at);return {dto:{saleId:requireUUID(row.id),customerId:client,soldOn:dayFormat.format(new Date(row.sold_at)),status:row.payment_status,grossCents:gross,discountCents:discount,totalCents:total},position:{time,id:requireUUID(row.id)}};
 }
 async function page(kind,principal,query,map){
  const {result,customers}=await read(kind,principal,query,kind==='stock'?'stock:read':kind==='orders'?'sales:read':'finance:read',query.limit);
  if(result.data===null)return null;
  if(!Array.isArray(result.data)||result.data.length>query.limit||!result.data.length&&result.next!==null)throw unavailable();
  const mapped=result.data.map(r=>map(r,customers)),ids=new Set();for(let i=0;i<mapped.length;i++){const k=mapped[i].position;if(ids.has(k.id)||i&&comparePosition(mapped[i-1].position,k)>=0)throw unavailable();ids.add(k.id);}
  return {rows:mapped.map(x=>x.dto),snapshot:result.snapshot,next:result.next,head:mapped[0]?.position??null,tail:mapped.at(-1)?.position??null,ids:[...ids]};
 }
 return Object.freeze({mode:'business-readonly',contractVersion:2,fixture:gateway.fixture,resource,issuer,store,
  authorize,authorizeFresh,
  listStock:(p,q)=>page('stock',p,q,row=>{plain(row,PLANS.stock.fields);const id=requireUUID(row.id);return {dto:{productId:id,name:text(row.name),size:text(row.size,20),color:text(row.color_name,80),available:count(row.stock)},position:{time:null,id}};}),
  listCustomerOrders:async(p,q)=>{
   const ids=authorize(p,'sales:read'),id=requireUUID(q.customerId);if(!customerAllowed(ids,id))return null;
   return page('orders',p,{...q,filters:{customerId:id}},(row,customers)=>{plain(row,PLANS.orders.fields);if(row.client_id!==id)throw unavailable();return sale(row,customers);});
  },
  getSale:async(p,q)=>{
   const {result,customers}=await read('sale',p,{...q,filters:{saleId:requireUUID(q.saleId)}},'sales:read',1);if(result.next!==null)throw unavailable();if(result.data===null)return null;
   const row=plain(result.data,PLANS.sale.fields);if(row.id!==q.saleId||row.items_complete!==true||!Array.isArray(row.items)||!row.items.length||row.items.length>200)throw unavailable();
   const header=sale(row,customers).dto,items=row.items.map(it=>{plain(it,['product_id','qty','price']);return {productId:it.product_id===null?null:requireUUID(it.product_id),quantity:count(it.qty,1),unitPriceCents:cents(it.price)};});
   if(sum(items.map(it=>BigInt(it.quantity)*BigInt(it.unitPriceCents)))!==header.grossCents)throw unavailable();
   return {...header,items};
  },
  summarizeReceipts:async(p,q)=>{
   const {result,customers}=await read('receipts',p,{...q,filters:{from:q.from,to:q.to}},'finance:read',1000);if(result.next!==null||!Array.isArray(result.data)||result.data.length>1000)throw unavailable();
   const values=[],fees=[],nets=[],ids=new Set();for(const row of result.data){plain(row,PLANS.receipts.fields);const id=requireUUID(row.id);if(ids.has(id))throw unavailable();ids.add(id);requireUUID(row.sale_id);const client=row.client_id===null?null:requireUUID(row.client_id);if(!customerAllowed(customers,client)||requireDate(row.paid_on)<q.from||row.paid_on>q.to)throw unavailable();const value=cents(row.value),fee=cents(row.fee_value),net=cents(row.net_value);if(value-fee!==net)throw unavailable();values.push(value);fees.push(fee);nets.push(net);}
   return {count:values.length,receivedCents:sum(values),feeCents:sum(fees),netCents:sum(nets)};
  },
  listAccounts:(p,q)=>page('accounts',p,{...q,filters:{kind:q.kind??null,includeArchived:false}},(row,customers)=>{
   plain(row,PLANS.accounts.fields);const id=requireUUID(row.id),client=row.cliente_id===null?null:requireUUID(row.cliente_id);if(!customerAllowed(customers,client)||row.archived_at!==null||!['pagar','receber'].includes(row.tipo)||q.kind&&row.tipo!==(q.kind==='payable'?'pagar':'receber')||!['ativo','concluido'].includes(row.status)||![null,'unica','semanal','mensal'].includes(row.recorrencia)||row.movements_complete!==true||!Array.isArray(row.movimentacoes)||row.movimentacoes.length>100)throw unavailable();
   const movementIds=new Set(),paid=row.movimentacoes.map(m=>{plain(m,['id','conta_id','valor','pago','reversed_at']);const mid=requireUUID(m.id);if(movementIds.has(mid)||requireUUID(m.conta_id)!==id||typeof m.pago!=='boolean')throw unavailable();movementIds.add(mid);if(m.reversed_at!==null)instant(m.reversed_at);return isEffectiveMovement(m)?cents(m.valor):0;});
   return {dto:{accountId:id,kind:row.tipo==='pagar'?'payable':'receivable',dueOn:requireDate(row.proximo_vencimento),status:row.status,recordedAmountCents:cents(row.valor,1),effectivePaidCents:sum(paid),recurrence:row.recorrencia,installmentNumber:row.parcela_atual===null?null:count(row.parcela_atual,1),installmentCount:row.parcelas===null?null:count(row.parcelas,1)},position:{time:null,id}};
  })
 });
}
module.exports={createBusinessReadAdapter,comparePosition,VERSION,readPlans:()=>structuredClone(PLANS)};
