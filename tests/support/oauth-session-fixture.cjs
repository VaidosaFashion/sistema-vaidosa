'use strict';
// TEST ONLY. Application callback correlation around the official SDK; not an AS.
// No configurable endpoints, network discovery, client registration or persistence.
const {randomBytes,timingSafeEqual}=require('node:crypto');
const ISSUER='https://identity.invalid/',RESOURCE='https://fixture.invalid/mcp',REDIRECT='https://client.invalid/callback',TOKEN='https://identity.invalid/token';
const SCOPE='mcp:read stock:read',CLIENT='vaidosa-fixture-client';
const METADATA=Object.freeze({issuer:ISSUER,authorization_endpoint:ISSUER+'authorize',token_endpoint:TOKEN,response_types_supported:['code'],grant_types_supported:['authorization_code'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],authorization_response_iss_parameter_supported:true});
const fail=()=>{throw Error('Fixture authorization unavailable');};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function createOAuthSessionFixture({sdk,fetchToken,verifyToken,now=Date.now}={}){
 if(typeof sdk?.startAuthorization!=='function'||typeof sdk?.exchangeAuthorization!=='function'||typeof fetchToken!=='function'||typeof verifyToken!=='function'||typeof now!=='function')fail();
 let pending=null,running=null,last=0;
 function clock(){const n=now();if(!Number.isSafeInteger(n)||n<last){pending=null;running?.abort();fail();}last=n;return n;}
 async function begin(sessionId){
  if(!UUID.test(sessionId)||running||pending&&pending.expires>clock())fail();
  const entry={sessionId,state:randomBytes(32).toString('base64url'),expires:clock()+120000};pending=entry;
  try{
   const result=await sdk.startAuthorization(ISSUER,{metadata:METADATA,clientInformation:{client_id:CLIENT,token_endpoint_auth_method:'none'},redirectUrl:REDIRECT,scope:SCOPE,state:entry.state,resource:new URL(RESOURCE)});
   if(pending!==entry||clock()>=entry.expires)fail();entry.verifier=result.codeVerifier;
   return result.authorizationUrl.href;
  }catch{if(pending===entry)pending=null;fail();}
 }
 async function complete(callbackUrl,sessionId){
  const entry=pending;
  try{
   if(!entry||running||sessionId!==entry.sessionId||clock()>=entry.expires||typeof callbackUrl!=='string'||Buffer.byteLength(callbackUrl)>2048||typeof entry.verifier!=='string')fail();
   const url=new URL(callbackUrl),base=new URL(url);base.search='';
   if(base.href!==REDIRECT||url.hash||[...url.searchParams.keys()].some(k=>!['code','state','iss','error','error_description'].includes(k))||[...url.searchParams.keys()].some(k=>url.searchParams.getAll(k).length!==1))fail();
   const state=url.searchParams.get('state');if(!state||state.length!==entry.state.length||!timingSafeEqual(Buffer.from(state),Buffer.from(entry.state)))fail();
   const iss=url.searchParams.get('iss');if(iss!==ISSUER||url.searchParams.has('error'))fail();
   const code=url.searchParams.get('code');if(!code||code.length>512||!/^[A-Za-z0-9_-]+$/.test(code))fail();
   // Consume before await: concurrent/replayed callbacks never exchange twice.
   pending=null;const controller=new AbortController();running=controller;
   const port=async(input,init)=>{
    controller.signal.throwIfAborted();if(String(input)!==TOKEN||init?.method!=='POST')fail();
    const result=await fetchToken(input,{...init,signal:controller.signal});controller.signal.throwIfAborted();return result;
   };
   const work=(async()=>{
    const tokens=await sdk.exchangeAuthorization(ISSUER,{metadata:METADATA,clientInformation:{client_id:CLIENT,token_endpoint_auth_method:'none'},authorizationCode:code,iss,codeVerifier:entry.verifier,redirectUri:REDIRECT,resource:new URL(RESOURCE),fetchFn:port});
    controller.signal.throwIfAborted();
    if(!/^Bearer$/i.test(tokens.token_type)||typeof tokens.access_token!=='string'||tokens.access_token.length>4096||!Number.isSafeInteger(tokens.expires_in)||tokens.expires_in<1||tokens.expires_in>300||tokens.refresh_token!==undefined||typeof tokens.scope!=='string'||tokens.scope.split(' ').some(x=>!SCOPE.split(' ').includes(x))||!tokens.scope.split(' ').includes('mcp:read'))fail();
    const identity=await verifyToken(tokens.access_token,{issuer:ISSUER,audience:RESOURCE,signal:controller.signal});
    controller.signal.throwIfAborted();if(clock()>=entry.expires||running!==controller||identity?.verified!==true||identity.issuer!==ISSUER||!Array.isArray(identity.audiences)||identity.audiences.length!==1||identity.audiences[0]!==RESOURCE||!Array.isArray(identity.scopes)||[...identity.scopes].sort().join(' ')!==tokens.scope.split(' ').sort().join(' '))fail();
    return Object.freeze({fixture:true,authorized:true});
   })().finally(()=>{if(running===controller)running=null;entry.verifier=null;});
   let timer;const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Fixture authorization unavailable'));},1000);});
   try{return await Promise.race([work,deadline]);}finally{clearTimeout(timer);}
  }catch{if(pending===entry)pending=null;fail();}
 }
 return Object.freeze({begin,complete,cancel(){pending=null;running?.abort();}});
}
module.exports={createOAuthSessionFixture,ISSUER,RESOURCE,REDIRECT,TOKEN,SCOPE,METADATA};
