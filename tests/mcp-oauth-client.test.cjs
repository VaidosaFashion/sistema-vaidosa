'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const sdk=require('@modelcontextprotocol/client'),pkce=require('pkce-challenge');
const {createOAuthSessionFixture,ISSUER,RESOURCE,REDIRECT,TOKEN,SCOPE,METADATA}=require('./support/oauth-session-fixture.cjs');
const {createLocalJwtVerifier}=require('../mcp/local-jwt-verifier.cjs');
require('../mcp/offline-guard.cjs');
test('official OAuth client protocol with in-memory fictitious authorization responses',async t=>{
 const jose=await import('jose'),pair=await jose.generateKeyPair('ES256'),jwk={...await jose.exportJWK(pair.publicKey),kid:'oauth-fixture-key',alg:'ES256',use:'sig'};
 let time=Date.parse('2026-11-06T12:00:00Z');const now=()=>time,n=Math.floor(time/1000),session=randomUUID();
 const verifier=await createLocalJwtVerifier({jose,issuer:ISSUER,resource:RESOURCE,publicKeys:[jwk],maxTokenAgeSeconds:300,now});
 const sign=(extra={})=>new jose.SignJWT({iss:ISSUER,aud:RESOURCE,sub:'10000000-0000-4000-8000-000000000001',jti:randomUUID(),iat:n,exp:n+60,scope:SCOPE,...extra}).setProtectedHeader({alg:'ES256',typ:'at+jwt',kid:jwk.kid}).sign(pair.privateKey);
 const token=await sign();
 const response=(extra={})=>new Response(JSON.stringify({access_token:token,token_type:'Bearer',expires_in:60,scope:SCOPE,...extra}),{headers:{'content-type':'application/json'}});
 const callback=(authorization,change={})=>{const u=new URL(REDIRECT);for(const [k,v]of Object.entries({code:'fixture_code',state:new URL(authorization).searchParams.get('state'),iss:ISSUER,...change}))if(v!==null)u.searchParams.set(k,v);return u;};
 function fixture({respond=()=>response(),clock=now}={}){
  let calls=0,validated=0;const requests=[];
  const client=createOAuthSessionFixture({sdk,now:clock,verifyToken:async(...args)=>{validated++;return verifier.verifyAccessToken(...args);},fetchToken:async(input,init)=>{calls++;requests.push({input,init});return respond(input,init);}});
  return{client,requests,get calls(){return calls;},get validated(){return validated;}};
 }
 await t.test('dependency versions and public client metadata are fixed without registration or secrets',()=>{
  assert.equal(typeof sdk.auth,'function');assert.equal(METADATA.code_challenge_methods_supported[0],'S256');assert.deepEqual(METADATA.token_endpoint_auth_methods_supported,['none']);
  assert.equal(require('node:fs').readFileSync('/opt/candidate/node_modules/@modelcontextprotocol/client/package.json','utf8').includes('"version": "2.4.0"'),true);
 });
 await t.test('SDK builds code, state, PKCE S256, exact redirect, minimal scopes and resource indicator',async()=>{
  const f=fixture(),u=new URL(await f.client.begin(session)),q=u.searchParams;
  assert.equal(u.origin+u.pathname,ISSUER+'authorize');assert.equal(q.get('response_type'),'code');assert.equal(q.get('redirect_uri'),REDIRECT);assert.equal(q.get('resource'),RESOURCE);assert.equal(q.get('scope'),SCOPE);assert.equal(q.get('client_id'),'vaidosa-fixture-client');assert.equal(q.get('code_challenge_method'),'S256');assert.match(q.get('code_challenge'),/^[A-Za-z0-9_-]{43}$/);assert.match(q.get('state'),/^[A-Za-z0-9_-]{43}$/);assert.ok(!q.has('code_verifier'));assert.equal(f.calls,0);f.client.cancel();
 });
 await t.test('code exchange uses SDK form and PKCE library, then validates actual JWT signature and audience',async()=>{
  const f=fixture(),authorization=await f.client.begin(session);assert.deepEqual(await f.client.complete(callback(authorization).href,session),{fixture:true,authorized:true});
  assert.equal(f.calls,1);assert.equal(f.validated,1);const {input,init}=f.requests[0],q=new URLSearchParams(init.body);
  assert.equal(String(input),TOKEN);assert.equal(init.method,'POST');assert.equal(q.get('grant_type'),'authorization_code');assert.equal(q.get('redirect_uri'),REDIRECT);assert.equal(q.get('resource'),RESOURCE);assert.equal(q.get('client_id'),'vaidosa-fixture-client');assert.equal(q.get('code'),'fixture_code');assert.ok(await pkce.verifyChallenge(q.get('code_verifier'),new URL(authorization).searchParams.get('code_challenge')));assert.ok(!q.has('client_secret'));assert.ok(!new Headers(init.headers).has('authorization'));
 });
 await t.test('separate attempts have fresh challenges/states; another begin cannot overwrite pending correlation',async()=>{
  const f=fixture(),a=new URL(await f.client.begin(session));await assert.rejects(f.client.begin(session));f.client.cancel();const b=new URL(await f.client.begin(session));assert.ok(a.searchParams.get('state')!==b.searchParams.get('state'));assert.ok(a.searchParams.get('code_challenge')!==b.searchParams.get('code_challenge'));f.client.cancel();
 });
 await t.test('wrong/missing/duplicate state and another caller session are rejected before token exchange',async()=>{
  for(const [mutation,caller] of [[u=>u.searchParams.set('state','x'.repeat(43)),session],[u=>u.searchParams.delete('state'),session],[u=>u.searchParams.append('state','duplicate'),session],[u=>u,randomUUID()]]){
   const f=fixture(),u=callback(await f.client.begin(session));mutation(u);await assert.rejects(f.client.complete(u.href,caller));assert.equal(f.calls,0);
  }
 });
 await t.test('exact callback target rejects changed scheme/host/path, fragments and unknown fields',async()=>{
  for(const change of [u=>{u.protocol='http:';},u=>{u.hostname='other.invalid';},u=>{u.pathname='/else';},u=>{u.hash='private';},u=>u.searchParams.set('redirect_uri','https://other.invalid/')]){
   const f=fixture(),u=callback(await f.client.begin(session));change(u);await assert.rejects(f.client.complete(u.href,session));assert.equal(f.calls,0);
  }
 });
 await t.test('missing/wrong/duplicate issuer is refused before sending a code',async()=>{
  for(const change of [u=>u.searchParams.delete('iss'),u=>u.searchParams.set('iss','https://other.invalid/'),u=>u.searchParams.append('iss',ISSUER)]){
   const f=fixture(),u=callback(await f.client.begin(session));change(u);await assert.rejects(f.client.complete(u.href,session));assert.equal(f.calls,0);
  }
 });
 await t.test('denied authorization is consumed without echoing provider error descriptions',async()=>{
  const f=fixture(),u=callback(await f.client.begin(session),{code:null,error:'access_denied',error_description:'DO_NOT_ECHO_FIXTURE'});await assert.rejects(f.client.complete(u.href,session),e=>e.message==='Fixture authorization unavailable');await assert.rejects(f.client.complete(u.href,session));assert.equal(f.calls,0);
 });
 await t.test('concurrent and replayed callbacks cannot exchange a single code twice',async()=>{
  let release,entered;const ready=new Promise(r=>{entered=r;}),wait=new Promise(r=>{release=r;});const f=fixture({respond:async()=>{entered();await wait;return response();}}),u=callback(await f.client.begin(session));const first=f.client.complete(u.href,session);await ready;await assert.rejects(f.client.complete(u.href,session));release();await first;await assert.rejects(f.client.complete(u.href,session));assert.equal(f.calls,1);
 });
 await t.test('expiration and backward clock invalidate a pending callback without a request',async()=>{
  let tick=time;const f=fixture({clock:()=>tick}),u=callback(await f.client.begin(session));tick+=120000;await assert.rejects(f.client.complete(u.href,session));assert.equal(f.calls,0);
  tick=time;const g=fixture({clock:()=>tick}),v=callback(await g.client.begin(session));tick--;await assert.rejects(g.client.complete(v.href,session));assert.equal(g.calls,0);
 });
 await t.test('token errors, malformed replies, refresh tokens and unrequested scopes fail closed',async()=>{
  for(const respond of [()=>new Response(JSON.stringify({error:'invalid_grant',error_description:'PRIVATE_FIXTURE'}),{status:400}),()=>new Response('{broken'),()=>response({refresh_token:'fixture_refresh'}),()=>response({scope:SCOPE+' finance:read'}),()=>response({expires_in:0}),()=>response({token_type:'Unknown'})]){
   const f=fixture({respond}),u=callback(await f.client.begin(session));await assert.rejects(f.client.complete(u.href,session),e=>e.message==='Fixture authorization unavailable');assert.equal(f.calls,1);assert.equal(f.validated,0);
  }
 });
 await t.test('resource request is not audience proof: signed wrong audience/issuer and altered JWT are refused',async()=>{
  for(const access_token of [await sign({aud:'https://other.invalid/mcp'}),await sign({iss:'https://other.invalid/'}),token.slice(0,-5)+'XXXXX',await sign({scope:SCOPE+' finance:read'})]){
   const f=fixture({respond:()=>response({access_token})}),u=callback(await f.client.begin(session));await assert.rejects(f.client.complete(u.href,session));assert.equal(f.calls,1);assert.equal(f.validated,1);
  }
 });
 await t.test('SDK issuer-response validation also rejects mix-up and missing iss without invoking fetch',async()=>{
  let calls=0;for(const iss of [undefined,'https://other.invalid/'])await assert.rejects(sdk.exchangeAuthorization(ISSUER,{metadata:METADATA,clientInformation:{client_id:'fixture'},authorizationCode:'fixture_code',iss,codeVerifier:'x'.repeat(43),redirectUri:REDIRECT,resource:RESOURCE,fetchFn:async()=>{calls++;return response();}}));assert.equal(calls,0);
 });
 await t.test('finite token mock verifies wrong PKCE with the existing library; this is not an authorization server',async()=>{
  const authorization=await sdk.startAuthorization(ISSUER,{metadata:METADATA,clientInformation:{client_id:'fixture'},redirectUrl:REDIRECT,state:'fixture_state',scope:SCOPE,resource:RESOURCE});let calls=0;
  await assert.rejects(sdk.exchangeAuthorization(ISSUER,{metadata:METADATA,clientInformation:{client_id:'fixture',token_endpoint_auth_method:'none'},authorizationCode:'fixture_code',iss:ISSUER,codeVerifier:'x'.repeat(43),redirectUri:REDIRECT,resource:RESOURCE,fetchFn:async(_,init)=>{calls++;const matches=await pkce.verifyChallenge(new URLSearchParams(init.body).get('code_verifier'),authorization.authorizationUrl.searchParams.get('code_challenge'));assert.equal(matches,false);return new Response(JSON.stringify({error:'invalid_grant'}),{status:400});}}));assert.equal(calls,1);
 });
 await t.test('a redirected token reply cannot select an alternate endpoint',async()=>{
  const f=fixture({respond:()=>new Response(null,{status:307,headers:{location:'https://other.invalid/token'}})}),u=callback(await f.client.begin(session));await assert.rejects(f.client.complete(u.href,session));assert.equal(f.calls,1);
 });
 await t.test('timeout keeps pending work bounded and never retries or publishes a late response',async()=>{
  let release;const wait=new Promise(r=>{release=r;}),f=fixture({respond:()=>wait}),u=callback(await f.client.begin(session));await assert.rejects(f.client.complete(u.href,session));await assert.rejects(f.client.begin(session));assert.equal(f.calls,1);release(response());await new Promise(r=>setImmediate(r));assert.equal(f.validated,0);await f.client.begin(session);f.client.cancel();
 });
 await t.test('cancelled pending attempts cannot exchange and default network APIs remain denied',async()=>{
  const f=fixture(),u=callback(await f.client.begin(session));f.client.cancel();await assert.rejects(f.client.complete(u.href,session));assert.equal(f.calls,0);await assert.rejects(fetch(TOKEN));assert.throws(()=>require('node:net').connect({host:'example.invalid',port:443}));
 });
});
