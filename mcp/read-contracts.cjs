'use strict';
// Versioned output DTOs. Unknown fields fail closed instead of being silently exported.
const own=(v,k)=>Object.prototype.hasOwnProperty.call(v,k);
function fail(){throw Error('Readonly DTO contract violation');}
function record(value,keys){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).some(k=>typeof k!=='string'||!keys.includes(k)))fail();
 const descriptors=Object.getOwnPropertyDescriptors(value);if(Object.values(descriptors).some(d=>!own(d,'value')))fail();
 for(const key of keys)if(!own(value,key))fail();return value;
}
function text(v,max=128){if(typeof v!=='string'||!v.length||v.length>max)fail();return v;}
function id(v){text(v);if(!/^[A-Za-z0-9:_-]+$/.test(v))fail();return v;}
function integer(v,min=0){if(!Number.isSafeInteger(v)||v<min)fail();return v;}
function day(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v+'T00:00:00Z'))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)fail();return v;}
function cursor(v){if(v!==null&&(typeof v!=='string'||!/^[A-Za-z0-9_-]{32}$/.test(v)))fail();return v;}
function list(v,max,project){if(!Array.isArray(v)||v.length>max)fail();return v.map(project);}
const BASE=['fixture','contractVersion','currency'];
function base(v,extra){record(v,[...BASE,...extra]);if(typeof v.fixture!=='boolean'||![1,2].includes(v.contractVersion)||v.currency!=='BRL')fail();return {fixture:v.fixture,contractVersion:v.contractVersion,currency:'BRL'};}
const SALE=['saleId','customerId','soldOn','status','grossCents','discountCents','totalCents'];
function saleFields(v){
 const s={saleId:id(v.saleId),customerId:v.customerId===null?null:id(v.customerId),soldOn:day(v.soldOn),status:text(v.status,20),grossCents:integer(v.grossCents),discountCents:integer(v.discountCents),totalCents:integer(v.totalCents)};
 if(!['Pago','Parcial','Aberto'].includes(s.status)||s.grossCents-s.discountCents!==s.totalCents)fail();return s;
}
function projectReadonlyResult(name,value){
 if(name==='vaidosa_stock_list')return {...base(value,['items','nextCursor']),items:list(value.items,50,row=>{record(row,['productId','name','size','color','available']);return {productId:id(row.productId),name:text(row.name,200),size:text(row.size,20),color:text(row.color,80),available:integer(row.available)};}),nextCursor:cursor(value.nextCursor)};
 if(name==='vaidosa_customer_orders')return {...base(value,['items','nextCursor']),items:list(value.items,50,row=>{record(row,SALE);return saleFields(row);}),nextCursor:cursor(value.nextCursor)};
 if(name==='vaidosa_sale_get')return {...base(value,[...SALE,'items']),...saleFields(value),items:list(value.items,200,row=>{record(row,['productId','quantity','unitPriceCents']);return {productId:row.productId===null?null:id(row.productId),quantity:integer(row.quantity,1),unitPriceCents:integer(row.unitPriceCents)};})};
 if(name==='vaidosa_receipts_summary'){
  const result={...base(value,['from','to','dateBasis','sourceDomain','count','receivedCents','feeCents','netCents','excludes']),from:day(value.from),to:day(value.to),dateBasis:value.dateBasis,sourceDomain:value.sourceDomain,count:integer(value.count),receivedCents:integer(value.receivedCents),feeCents:integer(value.feeCents),netCents:integer(value.netCents),excludes:['manual_accounts','bank_reconciliation']};
  if(value.dateBasis!=='paid_on_inclusive_civil_date'||value.sourceDomain!=='sale_payments'||!Array.isArray(value.excludes)||JSON.stringify(value.excludes)!==JSON.stringify(result.excludes)||result.from>result.to||result.receivedCents-result.feeCents!==result.netCents)fail();return result;
 }
 if(name==='vaidosa_accounts_list'){
  if(Object.getOwnPropertyDescriptor(value,'contractVersion')?.value===2){
   const result={...base(value,['sourceDomain','valueBasis','paidBasis','items','nextCursor']),sourceDomain:'manual_accounts',valueBasis:'recorded_amount_per_installment',paidBasis:'all_effective_recorded_movements_not_balance',items:list(value.items,50,row=>{
    record(row,['accountId','kind','dueOn','status','recordedAmountCents','effectivePaidCents','recurrence','installmentNumber','installmentCount']);
    if(!['payable','receivable'].includes(row.kind)||!['ativo','concluido'].includes(row.status)||![null,'unica','semanal','mensal'].includes(row.recurrence))fail();
    return {accountId:id(row.accountId),kind:row.kind,dueOn:day(row.dueOn),status:row.status,recordedAmountCents:integer(row.recordedAmountCents,1),effectivePaidCents:integer(row.effectivePaidCents),recurrence:row.recurrence,installmentNumber:row.installmentNumber===null?null:integer(row.installmentNumber,1),installmentCount:row.installmentCount===null?null:integer(row.installmentCount,1)};
   }),nextCursor:cursor(value.nextCursor)};
   if(value.sourceDomain!==result.sourceDomain||value.valueBasis!==result.valueBasis||value.paidBasis!==result.paidBasis)fail();return result;
  }
  const result={...base(value,['sourceDomain','items','nextCursor']),sourceDomain:'manual_accounts',items:list(value.items,50,row=>{record(row,['accountId','kind','dueOn','status','valueCents','paidCents']);if(!['payable','receivable'].includes(row.kind)||!['open','partial','paid'].includes(row.status))fail();return {accountId:id(row.accountId),kind:row.kind,dueOn:day(row.dueOn),status:row.status,valueCents:integer(row.valueCents),paidCents:integer(row.paidCents)};}),nextCursor:cursor(value.nextCursor)};
  if(value.sourceDomain!=='manual_accounts')fail();return result;
 }
 fail();
}
module.exports={projectReadonlyResult};
