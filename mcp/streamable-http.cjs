'use strict';
// Standard Streamable HTTP, stateless JSON response profile (MCP 2025-11-25).
// Import creates no listener and loads no environment, credential or database adapter.
const {createHash,randomBytes}=require('node:crypto');
const {createIdentityBoundary,AccessError,canonicalHttps,READ_SCOPES}=require('./http-identity.cjs');
const {projectReadonlyResult}=require('./read-contracts.cjs');
const {InputError,ToolError}=require('./service.cjs');
const VERSION='2025-11-25',MAX_INPUT=16384,MAX_OUTPUT=65536;
const TOOL_SCOPE=Object.freeze({vaidosa_stock_list:'stock:read',vaidosa_customer_orders:'sales:read',vaidosa_sale_get:'sales:read',vaidosa_receipts_summary:'finance:read',vaidosa_accounts_list:'finance:read'});
const METHODS=new Set(['initialize','ping','tools/list','tools/call','notifications/initialized','notifications/cancelled']);
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const validId=v=>typeof v==='string'&&v.length>0&&v.length<=128||Number.isSafeInteger(v);
const rpcError=(id,code,message)=>({jsonrpc:'2.0',id:validId(id)?id:null,error:{code,message}});
function outputSafe(value,depth=0){
 if(depth>16)throw Error('Output limit');
 if(value===null||typeof value==='boolean')return;
 if(typeof value==='number'){if(!Number.isFinite(value))throw Error('Invalid output');return;}
 if(typeof value==='string'){if(value.length>12000)throw Error('Output limit');return;}
 if(!value||typeof value!=='object')throw Error('Invalid output');
 if(Array.isArray(value)){if(value.length>200)throw Error('Output limit');for(const item of value)outputSafe(item,depth+1);return;}
 for(const [key,child] of Object.entries(value)){
  if(/^(?:__proto__|constructor|prototype|cpf|cnpj|buyer_cpf_nfce|email|phone|note|obs|xml|xml_signed|access_token|refresh_token|authorization|service_role|password)$/i.test(key))throw Error('Private output field');
  outputSafe(child,depth+1);
 }
}
function createStreamableHttpHandler({resource,issuer,allowedOrigins=[],verifyAccessToken,authorizePrincipal,createService,audit=()=>{},now=Date.now}={}){
 const endpoint=canonicalHttps(resource);canonicalHttps(issuer);
 if(endpoint.pathname==='/'||typeof createService!=='function'||typeof audit!=='function')throw Error('Explicit MCP path and service factory required');
 const origins=new Set(allowedOrigins.map(v=>{const u=canonicalHttps(v);if(u.pathname!=='/')throw Error('Origin required');return u.origin;}));
 const metadataPath='/.well-known/oauth-protected-resource'+endpoint.pathname;
 const metadataUrl=endpoint.origin+metadataPath;
 const identity=createIdentityBoundary({resource,issuer,verifyAccessToken,authorizePrincipal,now});
 const services=new Map(),salt=randomBytes(32);let window=now(),count=0,inFlight=0;
 const actorKey=p=>createHash('sha256').update(salt).update(JSON.stringify([p.id,p.store,p.permissions,p.customerIds])).digest('hex');
 function auditSafe(event){try{audit(Object.freeze(event));}catch{/* Telemetry failure never leaks input or changes authorization. */}}
 function response(status,body,extra={}){const headers={'cache-control':'no-store','x-content-type-options':'nosniff',...extra};if(body!==null)headers['content-type']='application/json; charset=utf-8';return new Response(body===null?null:JSON.stringify(body),{status,headers});}
 function denial(error){const status=error instanceof AccessError?error.status:401,code=error instanceof AccessError?error.code:'invalid_token';return response(status,{error:code},{'www-authenticate':`Bearer resource_metadata="${metadataUrl}", error="${code}", scope="${error instanceof AccessError?error.requiredScopes.join(' '):'mcp:read'}"`});}
 async function readJson(req,signal){
  const length=req.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_INPUT))throw Error('input_limit');
  const reader=req.body?.getReader();if(!reader)throw Error('invalid_json');
  const chunks=[];let size=0;
  const stop=()=>{reader.cancel().catch(()=>{});};signal.addEventListener('abort',stop,{once:true});
  try{while(true){if(signal.aborted)throw Error('request_timeout');const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_INPUT)throw Error('input_limit');chunks.push(value);}}
  finally{if(signal.aborted||size>MAX_INPUT)await reader.cancel().catch(()=>{});signal.removeEventListener('abort',stop);reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }
 async function execute(req,signal){
  signal.throwIfAborted();
  let url;try{url=new URL(req.url);}catch{return response(400,{error:'invalid_request'});}
  const origin=req.headers.get('origin');
  if(url.origin!==endpoint.origin||req.headers.has('host')&&req.headers.get('host')!==endpoint.host||origin!==null&&!origins.has(origin))return response(403,{error:'origin_denied'});
  if(url.search||url.hash||url.username||url.password)return response(400,{error:'invalid_request'});
  if(req.method==='GET'&&(url.pathname===metadataPath||url.pathname==='/.well-known/oauth-protected-resource'))return response(200,{resource,authorization_servers:[issuer],scopes_supported:['mcp:read',...READ_SCOPES],bearer_methods_supported:['header']});
  if(url.pathname!==endpoint.pathname)return response(404,{error:'not_found'});
  // No session is issued; reject attempted cross-session attachment.
  if(req.headers.has('mcp-session-id'))return response(400,{error:'sessions_not_supported'});
  const principal=await identity.authenticate(req,signal),key=actorKey(principal);
  signal.throwIfAborted();
  if(now()-window>=60000){window=now();count=0;}
  if(++count>500)return response(429,{error:'rate_limit'},{'retry-after':'60'});
  for(const [k,entry]of services)if(entry.expires<=now())services.delete(k);
  let cached=services.get(key);
  if(!cached){
   if(services.size>=64)return response(503,{error:'capacity'},{'retry-after':'60'});
   cached={promise:null,expires:now()+600000,count:0,window:now()};services.set(key,cached);
   const entry=cached;
   entry.promise=Promise.resolve().then(()=>{signal.throwIfAborted();return createService(principal,signal);}).catch(error=>{if(services.get(key)===entry)services.delete(key);throw error;});
  }
  const service=await cached.promise;signal.throwIfAborted();
  if(now()-cached.window>=60000){cached.window=now();cached.count=0;}
  if(++cached.count>120)return response(429,{error:'rate_limit'},{'retry-after':'60'});
  if(req.method!=='POST')return response(405,{error:'method_not_allowed'},{allow:'POST'});
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers.get('content-type')||''))return response(415,{error:'unsupported_media_type'});
  const accept=(req.headers.get('accept')||'').split(',').map(s=>s.trim().split(';')[0]);
  if(!accept.includes('application/json')||!accept.includes('text/event-stream'))return response(406,{error:'accept_required'});
  let message;try{message=await readJson(req,signal);signal.throwIfAborted();}catch(e){if(signal.aborted)return response(504,{error:'request_timeout'});return response(e.message==='input_limit'?413:400,rpcError(null,-32700,'Invalid bounded UTF-8 JSON input'));}
  if(!object(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string'||Object.hasOwn(message,'result')||Object.hasOwn(message,'error')||Object.hasOwn(message,'id')&&!validId(message.id))return response(400,rpcError(null,-32600,'Invalid request'));
  const notification=!Object.hasOwn(message,'id'),params=message.params??{};
  if(!object(params))return response(400,rpcError(message.id,-32602,'Invalid parameters'));
  if(message.method!=='initialize'&&req.headers.get('mcp-protocol-version')!==VERSION)return response(400,{error:'unsupported_protocol_version',supported:VERSION});
  auditSafe({event:'mcp_http',method:METHODS.has(message.method)?message.method:'unknown',actor:key.slice(0,16),outcome:'accepted'});
  if(notification){if(message.method==='notifications/initialized'||message.method==='notifications/cancelled')return response(202,null);return response(400,rpcError(null,-32600,'Unsupported notification'));}
  let result;
  try{
   if(message.method==='initialize'){
    if(typeof params.protocolVersion!=='string'||!object(params.capabilities)||!object(params.clientInfo)||typeof params.clientInfo.name!=='string'||typeof params.clientInfo.version!=='string')throw new InputError();
    result={protocolVersion:VERSION,capabilities:{tools:{listChanged:false}},serverInfo:{name:'vaidosa-readonly-transport-preparation',version:'0.2.0'},instructions:'Readonly transport preparation. Identity and business adapter must be independently authorized before activation.'};
   }else if(message.method==='ping')result={};
   else if(message.method==='tools/list'){
    if(Object.keys(params).some(k=>k!=='_meta'))throw new InputError();
    const definitions=await service.listTools(Object.freeze({principal,signal}));
    signal.throwIfAborted();
    if(!Array.isArray(definitions)||definitions.length>5||definitions.some(t=>!Object.hasOwn(TOOL_SCOPE,t.name)||!principal.permissions.includes(TOOL_SCOPE[t.name])))throw Error('Service contract');
    result={tools:definitions};
   }else if(message.method==='tools/call'){
    if(Object.keys(params).some(k=>!['name','arguments','_meta'].includes(k))||typeof params.name!=='string'||!Object.hasOwn(TOOL_SCOPE,params.name))throw new InputError();
    if(!principal.permissions.includes(TOOL_SCOPE[params.name]))return response(403,{error:'insufficient_scope'},{'www-authenticate':`Bearer resource_metadata="${metadataUrl}", error="insufficient_scope", scope="mcp:read ${TOOL_SCOPE[params.name]}"`});
    signal.throwIfAborted();
    const raw=await service.call(params.name,params.arguments??{},Object.freeze({principal,signal}));
    signal.throwIfAborted();const data=projectReadonlyResult(params.name,raw);outputSafe(data);result={content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data,isError:false};
   }else return response(200,rpcError(message.id,-32601,'Method not available'));
   const body={jsonrpc:'2.0',id:message.id,result};outputSafe(body);
   if(Buffer.byteLength(JSON.stringify(body))>MAX_OUTPUT)throw Error('Output limit');
   return response(200,body);
  }catch(e){
   if(signal.aborted)return response(504,{error:'request_timeout'});
   auditSafe({event:'mcp_http',method:METHODS.has(message.method)?message.method:'unknown',actor:key.slice(0,16),outcome:'failed'});
   if(e instanceof InputError)return response(200,rpcError(message.id,-32602,'Invalid parameters or tool scope'));
   if(e instanceof ToolError)return response(200,{jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:JSON.stringify({code:['NOT_AVAILABLE','INVALID_CURSOR','TOO_LARGE'].includes(e.toolCode)?e.toolCode:'NOT_AVAILABLE',message:'Resource unavailable for this identity'})}],isError:true}});
   return response(200,rpcError(message.id,-32603,'Service unavailable; no mutation tool is exposed'));
  }
 }
 return async request=>{
  if(request.signal.aborted)return response(504,{error:'request_timeout'});
  // No untrusted peer/IP headers are used. Ingress/network abuse controls remain
  // a separate deployment prerequisite; invalid tokens do not consume auth quotas.
  if(inFlight>=8)return response(503,{error:'verification_capacity'},{'retry-after':'1'});
  inFlight++;
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),5000);
  const abort=()=>controller.abort();request.signal.addEventListener('abort',abort,{once:true});
  let onAbort;
  const stopped=new Promise(resolve=>{
   onAbort=()=>resolve(response(504,{error:'request_timeout'}));
   if(controller.signal.aborted)onAbort();else controller.signal.addEventListener('abort',onAbort,{once:true});
  });
  if(request.signal.aborted)controller.abort();
  const work=execute(request,controller.signal).catch(e=>controller.signal.aborted?response(504,{error:'request_timeout'}):e instanceof AccessError?denial(e):response(503,{error:'service_unavailable'})).finally(()=>{inFlight--;});
  try{return await Promise.race([stopped,work]);}
  finally{clearTimeout(timer);controller.signal.removeEventListener('abort',onAbort);request.signal.removeEventListener('abort',abort);}
 };

}
module.exports={createStreamableHttpHandler,VERSION,MAX_INPUT,MAX_OUTPUT};
