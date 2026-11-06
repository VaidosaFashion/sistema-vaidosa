'use strict';
// Shared state port. No connection, SQL, credential, raw JWT or remote I/O here.
const {createHash,randomUUID}=require('node:crypto');
const {canonicalHttps}=require('./http-identity.cjs');
const HEX=/^[a-f0-9]{64}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest=x=>createHash('sha256').update(x).digest('hex');
const unavailable=()=>{throw Error('Shared authorization unavailable');};
function revocationNamespace(issuer,resource){canonicalHttps(issuer);canonicalHttps(resource);return digest(issuer+'\0'+resource);}
function revocationTarget(namespace,kind,value){
 if(!HEX.test(namespace)||!['token','subject','key'].includes(kind)||typeof value!=='string'||(kind==='key'?!/^[A-Za-z0-9_-]{1,64}$/.test(value):!UUID.test(value)))unavailable();
 return digest(namespace+'\0'+kind+'\0'+value);
}
function createSharedRevocationStore({namespace,incarnation,executeRead,executeWrite}={}){
 if(!HEX.test(namespace)||!UUID.test(incarnation)||typeof executeRead!=='function'||executeWrite!==undefined&&typeof executeWrite!=='function')throw Error('Explicit bounded revocation ports required');
 let highest=0n,inFlight=0;
 async function port(fn,q,{signal}={}){
  signal?.throwIfAborted();if(inFlight>=8)unavailable();inFlight++;
  const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  let onAbort;const stopped=new Promise((_,reject)=>{onAbort=()=>reject(Error('Shared authorization unavailable'));if(controller.signal.aborted)onAbort();else controller.signal.addEventListener('abort',onAbort,{once:true});});
  const timer=setTimeout(abort,1000),work=Promise.resolve().then(()=>{controller.signal.throwIfAborted();return fn(q,Object.freeze({signal:controller.signal}));}).finally(()=>{inFlight--;});
  try{return await Promise.race([work,stopped]);}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',onAbort);}
 }
 function accept(result,nonce){
  if(!result||result.namespace!==namespace||result.incarnation!==incarnation||result.nonce!==nonce||typeof result.revision!=='string'||!/^\d{1,19}$/.test(result.revision))unavailable();
  const revision=BigInt(result.revision);if(revision>9223372036854775807n||revision<highest)unavailable();highest=revision;return result;
 }
 function command(input){
  if(!input||!UUID.test(input.requestId)||!['token','subject','key'].includes(input.kind)||!HEX.test(input.target)||input.kind==='subject'&&(!Number.isSafeInteger(input.cutoff)||input.cutoff<0)||input.kind!=='subject'&&input.cutoff!==null||Object.keys(input).some(k=>!['requestId','kind','target','cutoff'].includes(k)))unavailable();
  return Object.freeze({...input,namespace,incarnation});
 }
 return Object.freeze({
  async check(meta,{signal}={}){
   signal?.throwIfAborted();if(meta?.namespace!==namespace||!['token','subject','key'].every(k=>HEX.test(meta[k]))||!Number.isSafeInteger(meta.iat)||!Number.isSafeInteger(meta.exp))unavailable();
   const nonce=randomUUID(),q=Object.freeze({namespace,incarnation,nonce,token:meta.token,subject:meta.subject,key:meta.key,iat:meta.iat,exp:meta.exp});
   const result=accept(await port(executeRead,q,{signal}),nonce);signal?.throwIfAborted();if(result.allowed!==true)unavailable();return true;
  },
  async record(input,{signal}={}){
   if(typeof executeWrite!=='function')unavailable();
   const q=command(input),nonce=randomUUID();signal?.throwIfAborted();
   try{const result=accept(await port(executeWrite,Object.freeze({...q,nonce,mode:'record'}),{signal}),nonce);signal?.throwIfAborted();
    if(result.requestId!==q.requestId||!['applied','replayed','locked_down'].includes(result.status))unavailable();return Object.freeze({status:result.status,requestId:q.requestId,revision:result.revision});
   }catch{return Object.freeze({status:'uncertain',requestId:q.requestId});}
  },
  async lookup(input,{signal}={}){
   if(typeof executeWrite!=='function')unavailable();
   const q=command(input),nonce=randomUUID();signal?.throwIfAborted();
   const result=accept(await port(executeWrite,Object.freeze({...q,nonce,mode:'lookup'}),{signal}),nonce);signal?.throwIfAborted();
   if(result.requestId!==q.requestId||!['applied','not_found','locked_down'].includes(result.status))unavailable();return Object.freeze({status:result.status,requestId:q.requestId,revision:result.revision});
  }
 });
}
module.exports={createSharedRevocationStore,revocationNamespace,revocationTarget};
