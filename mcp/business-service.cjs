'use strict';
const {randomBytes,createHash}=require('node:crypto');
const {readDefinitions,validateArgs,validDate,InputError,ToolError}=require('./service.cjs');
const {comparePosition}=require('./business-adapter.cjs');
const {projectReadonlyResult}=require('./read-contracts.cjs');
const UUID='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const descriptions={vaidosa_stock_list:'Leitura de estoque canônico por variante.',vaidosa_customer_orders:'Pedidos autorizados do cliente, sem contato ou documentos.',vaidosa_sale_get:'Leitura de resumo e itens de uma venda autorizada.',vaidosa_receipts_summary:'Recebimentos de vendas por paid_on; exclui contas manuais e conciliação.',vaidosa_accounts_list:'Contas manuais: valor registrado por parcela e soma de movimentos efetivos; não calcula saldo nem concilia vendas.'};
const key=p=>JSON.stringify([p.id,p.store,p.permissions,p.customerIds]);
function createBusinessReadService({adapter,principal,now=Date.now}={}){
 if(adapter?.mode!=='business-readonly'||adapter.contractVersion!==2)throw Error('Business read adapter required');
 const bound=key(principal),cursors=new Map(),templates=readDefinitions();
 for(const t of templates){t.description=descriptions[t.name];for(const k of ['saleId','customerId'])if(t.inputSchema.properties[k])t.inputSchema.properties[k].pattern=UUID;}
 function current(context){const p=context?.principal??principal;if(key(p)!==bound)throw new InputError();adapter.authorize(p,p.permissions[0]);context?.signal?.throwIfAborted();return p;}
 function tools(p){return templates.filter(t=>p.permissions.includes(t.permission));}
 async function paginate(name,args,p,context,read){
  const limit=args.limit??20,filters={...args};delete filters.cursor;
  const scope=createHash('sha256').update(JSON.stringify([bound,name,filters,limit])).digest('hex');
  for(const [k,v]of cursors)if(v.expires<=now())cursors.delete(k);
  let previous=null;if(args.cursor){previous=cursors.get(args.cursor);if(!previous||previous.scope!==scope)throw new ToolError('INVALID_CURSOR','Página expirada.');}
  const page=await read({limit,continuation:previous?.continuation??null,snapshot:previous?.snapshot??null,signal:context?.signal});context?.signal?.throwIfAborted();
  if(!page)throw new ToolError('NOT_AVAILABLE','Recurso indisponível.');
  if(previous?.tail&&page.head&&comparePosition(previous.tail,page.head)>=0)throw new ToolError('NOT_AVAILABLE','Página inconsistente.');
  const seen=new Set(previous?.seen??[]);for(const id of page.ids){if(seen.has(id))throw new ToolError('NOT_AVAILABLE','Página inconsistente.');seen.add(id);}if(seen.size>2000)throw new ToolError('TOO_LARGE','Consulta excede o limite.');
  let nextCursor=null;if(page.next!==null){nextCursor=randomBytes(24).toString('base64url');if(cursors.size>=128)cursors.delete(cursors.keys().next().value);cursors.set(nextCursor,{scope,continuation:page.next,snapshot:page.snapshot,seen:[...seen],tail:page.tail,expires:now()+300000});}
  return {items:page.rows,nextCursor};
 }
 return Object.freeze({
  listTools(context){return tools(current(context)).map(({permission,...t})=>structuredClone({...t,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}}));},
  async call(name,args={},context){
   const p=current(context),tool=tools(p).find(t=>t.name===name);if(!tool)throw new InputError();
   if(!args||![Object.prototype,null].includes(Object.getPrototypeOf(args))||Object.values(Object.getOwnPropertyDescriptors(args)).some(d=>!Object.hasOwn(d,'value'))||Reflect.ownKeys(args).some(k=>typeof k!=='string'))throw new InputError();validateArgs(tool.inputSchema,args);
   let result;
   if(name==='vaidosa_stock_list')result=await paginate(name,args,p,context,q=>adapter.listStock(p,q));
   if(name==='vaidosa_customer_orders')result=await paginate(name,args,p,context,q=>adapter.listCustomerOrders(p,{...q,customerId:args.customerId}));
   if(name==='vaidosa_sale_get'){result=await adapter.getSale(p,{saleId:args.saleId,signal:context?.signal});if(!result)throw new ToolError('NOT_AVAILABLE','Recurso indisponível.');}
   if(name==='vaidosa_receipts_summary'){
    if(!validDate(args.from)||!validDate(args.to)||args.from>args.to||Date.parse(args.to)-Date.parse(args.from)>365*86400000)throw new InputError();
    result={from:args.from,to:args.to,dateBasis:'paid_on_inclusive_civil_date',sourceDomain:'sale_payments',...await adapter.summarizeReceipts(p,{...args,signal:context?.signal}),excludes:['manual_accounts','bank_reconciliation']};
   }
   if(name==='vaidosa_accounts_list')result={sourceDomain:'manual_accounts',valueBasis:'recorded_amount_per_installment',paidBasis:'all_effective_recorded_movements_not_balance',...await paginate(name,args,p,context,q=>adapter.listAccounts(p,{...q,kind:args.kind}))};
   context?.signal?.throwIfAborted();return projectReadonlyResult(name,{fixture:adapter.fixture,contractVersion:2,currency:'BRL',...result});
  }
 });
}
module.exports={createBusinessReadService};
