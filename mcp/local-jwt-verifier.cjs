'use strict';
// Offline access-token profile. Signature/JWK work is delegated to reviewed JOSE;
// no signing, network discovery, remote JWKS, environment or credential I/O here.
const {createHash,randomBytes}=require('node:crypto');
const {canonicalHttps}=require('./http-identity.cjs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPES=['mcp:read','stock:read','sales:read','finance:read'];
const fail=()=>{throw Error('Invalid local access token');};
function plain(v,allowed){
 if(!v||![Object.prototype,null].includes(Object.getPrototypeOf(v))||Reflect.ownKeys(v).some(k=>typeof k!=='string'||!allowed.includes(k))||Object.values(Object.getOwnPropertyDescriptors(v)).some(x=>!Object.hasOwn(x,'value')))fail();
}
async function createLocalJwtVerifier({jose,issuer,resource,publicKeys,maxTokenAgeSeconds,now=Date.now}={}){
 canonicalHttps(issuer);canonicalHttps(resource);
 if(!['jwtVerify','importJWK','decodeProtectedHeader'].every(x=>typeof jose?.[x]==='function')||!Number.isSafeInteger(maxTokenAgeSeconds)||maxTokenAgeSeconds<1||maxTokenAgeSeconds>900||typeof now!=='function')throw Error('Explicit local JOSE/token policy required');
 const salt=randomBytes(32),tokens=new Map(),subjects=new Map(),revokedKeys=new Set();let state=null,update=0,disabled=false,lastSecond=-1;
 const digest=s=>createHash('sha256').update(salt).update(s).digest('hex');
 function seconds(){const n=Math.floor(now()/1000);if(!Number.isSafeInteger(n)||n<0||n<lastSecond){disabled=true;fail();}lastSecond=n;return n;}
 function cleanup(second){for(const [k,v]of tokens)if(v<=second)tokens.delete(k);for(const [k,v]of subjects)if(v.expires<=second)subjects.delete(k);}
 function ready(){const n=seconds();cleanup(n);if(disabled||!state)fail();return n;}
 function bounded(map,key){if(!map.has(key)&&map.size>=128){disabled=true;fail();}}
 async function replaceKeys(keys){
  const version=++update;
  if(disabled||!Array.isArray(keys)||keys.length<1||keys.length>4)fail();const next=new Map();
  try{for(const input of keys){
   plain(input,['kid','kty','crv','x','y','alg','use','key_ops']);
   if(typeof input.kid!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(input.kid)||next.has(input.kid)||revokedKeys.has(input.kid)||input.kty!=='EC'||input.crv!=='P-256'||input.alg!=='ES256'||input.use!=='sig'||!['x','y'].every(k=>typeof input[k]==='string'&&/^[A-Za-z0-9_-]{43}$/.test(input[k]))||input.key_ops!==undefined&&JSON.stringify(input.key_ops)!=='["verify"]')fail();
   next.set(input.kid,await jose.importJWK(structuredClone(input),'ES256'));
  }}catch{fail();}
  if(version!==update||disabled)fail();state=Object.freeze({version,keys:next});
 }
 function assertCurrent(meta){
  const second=ready();
  if(state!==meta.state||revokedKeys.has(meta.kid)||meta.exp<=second||meta.iat>second||second-meta.iat>maxTokenAgeSeconds||tokens.has(meta.jti)||meta.iat<=(subjects.get(meta.subject)?.cutoff??-1))fail();
 }
 // This closure retains only hashes, times, public-key state and kid; never JWT.
 const currentGuard=meta=>()=>assertCurrent(meta);
 await replaceKeys(publicKeys);
 return Object.freeze({
  async verifyAccessToken(token,context){
   try{
    ready();context?.signal?.throwIfAborted();if(context?.issuer!==issuer||context?.audience!==resource||typeof token!=='string'||Buffer.byteLength(token)>4096||!/^[-A-Za-z0-9_]+\.[-A-Za-z0-9_]+\.[-A-Za-z0-9_]+$/.test(token))fail();
    const header=jose.decodeProtectedHeader(token);plain(header,['alg','typ','kid']);
    if(header.alg!=='ES256'||header.typ!=='at+jwt'||typeof header.kid!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(header.kid)||revokedKeys.has(header.kid))fail();
    const captured=state,key=captured.keys.get(header.kid);if(!key)fail();
    const {payload}=await jose.jwtVerify(token,key,{algorithms:['ES256'],issuer,audience:resource,typ:'at+jwt',requiredClaims:['iss','aud','sub','jti','iat','exp','scope'],maxTokenAge:maxTokenAgeSeconds,clockTolerance:0,currentDate:new Date(now())});
    context?.signal?.throwIfAborted();plain(payload,['iss','aud','sub','jti','iat','exp','nbf','scope']);
    const second=seconds();
    if(payload.iss!==issuer||payload.aud!==resource||typeof payload.sub!=='string'||!UUID.test(payload.sub)||typeof payload.jti!=='string'||!UUID.test(payload.jti)||!Number.isSafeInteger(payload.iat)||!Number.isSafeInteger(payload.exp)||payload.iat>second||payload.exp<=second||payload.exp<=payload.iat||payload.exp-payload.iat>maxTokenAgeSeconds||payload.nbf!==undefined&&(!Number.isSafeInteger(payload.nbf)||payload.nbf>second||payload.nbf<payload.iat||payload.nbf>=payload.exp)||typeof payload.scope!=='string'||payload.scope.length>128)fail();
    const scopes=payload.scope.split(' ');if(!scopes.length||new Set(scopes).size!==scopes.length||scopes.some(s=>!SCOPES.includes(s)))fail();
    const guard=currentGuard(Object.freeze({state:captured,kid:header.kid,jti:digest(payload.jti),subject:digest(payload.sub),iat:payload.iat,exp:payload.exp}));guard();
    return Object.freeze({verified:true,issuer,audiences:Object.freeze([resource]),subject:payload.sub,expiresAt:payload.exp,...(payload.nbf===undefined?{}:{notBefore:payload.nbf}),scopes:Object.freeze(scopes),assertCurrent:guard});
   }catch{fail();}
  },
  replaceKeys,
  revokeToken(jti){const n=ready();if(!UUID.test(jti))fail();const k=digest(jti);bounded(tokens,k);tokens.set(k,n+maxTokenAgeSeconds);},
  revokeSubject(subject){const n=ready();if(!UUID.test(subject))fail();const k=digest(subject);bounded(subjects,k);subjects.set(k,{cutoff:n,expires:n+maxTokenAgeSeconds});},
  revokeKey(kid){ready();if(typeof kid!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(kid))fail();bounded(revokedKeys,kid);revokedKeys.add(kid);},
  status(){cleanup(seconds());return Object.freeze({configured:state!==null,disabled,keys:state?.keys.size??0,revokedTokens:tokens.size,revokedSubjects:subjects.size,revokedKeys:revokedKeys.size});}
 });
}
module.exports={createLocalJwtVerifier};
