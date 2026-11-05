'use strict';
// Resource-server boundary only. No JWT decoding, OAuth, discovery fetch or credentials here.
const READ_SCOPES=Object.freeze(['stock:read','sales:read','finance:read']);
class AccessError extends Error {constructor(status,code,requiredScopes=['mcp:read']){super(code);this.status=status;this.code=code;this.requiredScopes=Object.freeze(requiredScopes.filter(s=>s==='mcp:read'||READ_SCOPES.includes(s)));}}
function canonicalHttps(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.hash||u.search||u.href!==value)throw Error('Canonical HTTPS URL required');return u;}
function createIdentityBoundary({resource,issuer,verifyAccessToken,authorizePrincipal,now=Date.now}={}){
 canonicalHttps(resource);canonicalHttps(issuer);
 if(typeof verifyAccessToken!=='function'||typeof authorizePrincipal!=='function')throw Error('Explicit verifier and authorization adapter required');
 return Object.freeze({authenticate:async(request,signal)=>{
  signal?.throwIfAborted();
  const header=request.headers.get('authorization')||'';
  const match=/^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(header);
  if(!match||header.length>8192)throw new AccessError(401,'invalid_token');
  let claims;
  try{claims=await verifyAccessToken(match[1],Object.freeze({issuer,audience:resource,signal}));}
  catch{signal?.throwIfAborted();throw new AccessError(401,'invalid_token');}
  signal?.throwIfAborted();
  const second=Math.floor(now()/1000);
  if(!claims||claims.verified!==true||claims.issuer!==issuer||!Array.isArray(claims.audiences)||!claims.audiences.includes(resource)||
    typeof claims.subject!=='string'||!/^[A-Za-z0-9:_-]{1,128}$/.test(claims.subject)||
    !Number.isSafeInteger(claims.expiresAt)||claims.expiresAt<=second||
    (claims.notBefore!==undefined&&(!Number.isSafeInteger(claims.notBefore)||claims.notBefore>second))||
    !Array.isArray(claims.scopes)||claims.scopes.length>64||claims.scopes.some(s=>typeof s!=='string'))throw new AccessError(401,'invalid_token');
  if(!claims.scopes.includes('mcp:read'))throw new AccessError(403,'insufficient_scope');
  let grant;
  // Never pass the bearer token to the business adapter, service, logs, or upstream API.
  try{grant=await authorizePrincipal(Object.freeze({subject:claims.subject,issuer,audience:resource,scopes:Object.freeze([...claims.scopes])}),signal);}
  catch{signal?.throwIfAborted();throw new AccessError(403,'access_denied');}
  signal?.throwIfAborted();
  if(!grant||grant.active!==true||grant.id!==claims.subject||typeof grant.store!=='string'||!/^[A-Za-z0-9:_-]{1,128}$/.test(grant.store)||!Array.isArray(grant.permissions))throw new AccessError(403,'access_denied');
  const allowed=READ_SCOPES.filter(p=>grant.permissions.includes(p));
  if(!allowed.length)throw new AccessError(403,'access_denied');
  const permissions=allowed.filter(p=>claims.scopes.includes(p));
  if(!permissions.length)throw new AccessError(403,'insufficient_scope',['mcp:read',allowed[0]]);
  if(grant.customerIds!==null&&(!Array.isArray(grant.customerIds)||grant.customerIds.length>100||grant.customerIds.some(v=>typeof v!=='string'||!/^[A-Za-z0-9:_-]{1,128}$/.test(v))))throw new AccessError(403,'access_denied');
  return Object.freeze({id:grant.id,store:grant.store,permissions:Object.freeze(permissions),customerIds:grant.customerIds===null?null:Object.freeze([...grant.customerIds])});
 }});
}
module.exports={createIdentityBoundary,AccessError,canonicalHttps,READ_SCOPES};
