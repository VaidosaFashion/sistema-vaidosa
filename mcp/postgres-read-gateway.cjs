'use strict';
// Read gateway over an explicitly injected bounded PostgreSQL executor.
// Import does not connect, read environment, create a listener or load credentials.
const {randomBytes}=require('node:crypto');
const {requireVerifiedPrincipal,requireVerifiedPrincipalAsync,canonicalHttps}=require('./http-identity.cjs');
const {VERSION,readPlans}=require('./business-adapter.cjs');
const PLANS=Object.values(readPlans());
const SCOPES={stock_variants:'stock:read',customer_orders:'sales:read',sale_detail:'sales:read',sale_receipts:'finance:read',manual_accounts:'finance:read'};
const opaque=()=>randomBytes(24).toString('base64url');
const key=p=>JSON.stringify([p.id,p.store,p.permissions,p.customerIds]);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function reject(){throw Error('Bounded business source unavailable');}
function createPostgresReadGateway({sourceId,store,resource,issuer,executeRead,fixture,now=Date.now}={}){
 canonicalHttps(resource);canonicalHttps(issuer);
 if(typeof sourceId!=='string'||!/^[A-Za-z0-9:_-]{1,128}$/.test(sourceId)||typeof store!=='string'||!/^[A-Za-z0-9:_-]{1,128}$/.test(store)||typeof executeRead!=='function'||typeof fixture!=='boolean')throw Error('Explicit source binding and read executor required');
 const snapshots=new Map();
 function principalFor(plan,context){
  const p=requireVerifiedPrincipal(context?.principal,{resource,issuer,now});
  const expected=PLANS.find(x=>x.operation===plan?.operation);
  if(!expected||plan.version!==VERSION||p.store!==store||!p.permissions.includes(SCOPES[plan.operation])||!same(plan.identity,{subject:p.id,store,customerIds:p.customerIds})||!same(plan.fields,expected.fields)||!same(plan.order,expected.order)||plan.maxResponseBytes!==262144)reject();
  if(!Number.isSafeInteger(plan.page?.limit)||plan.page.limit<1||plan.page.limit>(plan.operation==='sale_receipts'?1000:plan.operation==='sale_detail'?1:50))reject();
  context?.signal?.throwIfAborted();return p;
 }
 async function request(mode,plan,p,context){
  await requireVerifiedPrincipalAsync(p,{resource,issuer,now,signal:context?.signal});
  const query=Object.freeze({mode,source:sourceId,store,subject:p.id,operation:plan.operation,customers:p.customerIds,filters:structuredClone(plan.filters),maxRows:2000,maxBytes:260000});
  const answer=await executeRead(query,Object.freeze({principal:p,signal:context?.signal}));
  context?.signal?.throwIfAborted();await requireVerifiedPrincipalAsync(p,{resource,issuer,now,signal:context?.signal});
  if(!answer||answer.source!==sourceId||answer.store!==store||answer.subject!==p.id||typeof answer.authorization!=='string'||!/^[a-f0-9]{64}$/.test(answer.authorization)||Buffer.byteLength(JSON.stringify(answer))>262144)reject();
  return answer;
 }
 return Object.freeze({contractVersion:VERSION,store,fixture,
  async readSnapshot(plan,context){
   const p=principalFor(plan,context),binding=key(p),filter=JSON.stringify([plan.operation,plan.filters,plan.page.limit]);
   for(const [id,s]of snapshots)if(s.expires<=now())snapshots.delete(id);
   let entry,snapshot=plan.page.snapshot,start=0;
   if(snapshot!==null){
    entry=snapshots.get(snapshot);if(!entry||entry.binding!==binding||entry.filter!==filter||!entry.cursors.has(plan.page.continuation))reject();
    start=entry.cursors.get(plan.page.continuation);
    const check=await request('authorize',plan,p,context);if(check.authorization!==entry.authorization)reject();
   }else{
    if(plan.page.continuation!==null)reject();
    const answer=await request('snapshot',plan,p,context);
    if(plan.operation==='sale_detail'){
     if(answer.rows!==null&&(!answer.rows||typeof answer.rows!=='object'||Array.isArray(answer.rows)))reject();
     return {version:VERSION,subject:p.id,store,snapshot:opaque(),next:null,complete:true,data:structuredClone(answer.rows)};
    }
    if(!Array.isArray(answer.rows)||answer.rows.length>(plan.operation==='sale_receipts'?1000:2000))reject();
    if(plan.operation==='sale_receipts')return {version:VERSION,subject:p.id,store,snapshot:opaque(),next:null,complete:true,data:structuredClone(answer.rows)};
    snapshot=opaque();entry={binding,filter,authorization:answer.authorization,rows:structuredClone(answer.rows),cursors:new Map(),expires:now()+300000};
    if(snapshots.size>=8)snapshots.delete(snapshots.keys().next().value);snapshots.set(snapshot,entry);
   }
   const rows=entry.rows.slice(start,start+plan.page.limit);let next=null;
   if(start+rows.length<entry.rows.length){next=opaque();if(entry.cursors.size>=128)entry.cursors.delete(entry.cursors.keys().next().value);entry.cursors.set(next,start+rows.length);}
   return {version:VERSION,subject:p.id,store,snapshot,next,complete:true,data:structuredClone(rows)};
  }
 });
}
module.exports={createPostgresReadGateway};
