'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {createLocalJwtVerifier}=require('../mcp/local-jwt-verifier.cjs');
const {createIdentityBoundary,requireVerifiedPrincipal}=require('../mcp/http-identity.cjs');
const ISSUER='https://offline-issuer.invalid/',RESOURCE='https://offline-resource.invalid/mcp',SUBJECT='77000000-0000-4000-8000-000000000001';
test('offline JOSE access token verification, rotation and revocation',{timeout:25000},async t=>{
 const jose=await import('jose');
 async function pair(kid='test-key-1'){
  const p=await jose.generateKeyPair('ES256');const jwk={...await jose.exportJWK(p.publicKey),kid,alg:'ES256',use:'sig'};return {...p,jwk,kid};
 }
 const first=await pair(),second=await pair('test-key-2');
 async function setup(extra={}){
  let clock=Date.parse('2026-11-06T12:00:00Z');const now=()=>clock;
  const control=await createLocalJwtVerifier({jose,issuer:ISSUER,resource:RESOURCE,publicKeys:[first.jwk],maxTokenAgeSeconds:300,now,...extra});
  const claims=(patch={})=>({iss:ISSUER,aud:RESOURCE,sub:SUBJECT,jti:randomUUID(),iat:Math.floor(now()/1000),exp:Math.floor(now()/1000)+60,scope:'mcp:read stock:read',...patch});
  const sign=(payload=claims(),key=first,header={})=>new jose.SignJWT(payload).setProtectedHeader({alg:'ES256',typ:'at+jwt',kid:key.kid,...header}).sign(key.privateKey);
  const verify=token=>control.verifyAccessToken(token,{issuer:ISSUER,audience:RESOURCE});
  const boundary=createIdentityBoundary({resource:RESOURCE,issuer:ISSUER,now,verifyAccessToken:control.verifyAccessToken,
   authorizePrincipal:async()=>({active:true,id:SUBJECT,store:'fixture_store',permissions:['stock:read','finance:read'],customerIds:null})});
  return {control,claims,sign,verify,boundary,now,setClock:n=>{clock=n;}};
 }
 await t.test('valid ES256 signature yields only normalized identity and local current-proof',async()=>{
  const s=await setup(),result=await s.verify(await s.sign());assert.equal(result.verified,true);assert.equal(result.subject,SUBJECT);assert.deepEqual(result.scopes,['mcp:read','stock:read']);assert.equal(typeof result.assertCurrent,'function');
  assert.deepEqual(Object.keys(result).sort(),['assertCurrent','audiences','expiresAt','issuer','scopes','subject','verified'].sort());assert.ok(Object.isFrozen(result));
 });
 await t.test('tampered payload or signature, wrong key and unsigned tokens fail closed',async()=>{
  const s=await setup(),token=await s.sign(),parts=token.split('.'),sig=Buffer.from(parts[2],'base64url');sig[0]^=1;
  const changed=[parts[0],parts[1],sig.toString('base64url')].join('.');await assert.rejects(s.verify(changed));
  await assert.rejects(s.verify([parts[0],Buffer.from(JSON.stringify(s.claims({sub:'77000000-0000-4000-8000-000000000002'}))).toString('base64url'),parts[2]].join('.')));
  await assert.rejects(s.verify(await s.sign(s.claims(),second,{kid:first.kid})));await assert.rejects(s.verify('eyJhbGciOiJub25lIn0.e30.'));
 });
 await t.test('HS256 confusion, typ, unknown kid, embedded or remote key headers are rejected',async()=>{
  const s=await setup(),secret=await jose.generateSecret('HS256');
  const hs=await new jose.SignJWT(s.claims()).setProtectedHeader({alg:'HS256',typ:'at+jwt',kid:first.kid}).sign(secret);await assert.rejects(s.verify(hs));
  for(const header of [{typ:'JWT'},{kid:'unknown'},{jku:'https://forbidden.invalid/jwks'},{jwk:first.jwk},{x5u:'https://forbidden.invalid/cert'},{cty:'JWT'}])await assert.rejects(s.verify(await s.sign(s.claims(),first,header)));
 });
 await t.test('issuer/audience are exact, single-resource bindings rather than token-selected routing',async()=>{
  const s=await setup();for(const patch of [{iss:'https://wrong.invalid/'},{aud:'https://wrong.invalid/mcp'},{aud:[RESOURCE,'https://other.invalid/mcp']}])await assert.rejects(s.verify(await s.sign(s.claims(patch))));
  const token=await s.sign();await assert.rejects(s.control.verifyAccessToken(token,{issuer:ISSUER,audience:'https://other.invalid/mcp'}));
 });
 await t.test('exp/nbf/iat and lifetime are bounded integer dates with zero skew',async()=>{
  const s=await setup(),n=Math.floor(s.now()/1000);
  for(const patch of [{exp:n},{exp:n-1},{nbf:n+1},{iat:n+1},{iat:n-301,exp:n+1},{exp:n+301},{exp:n+60.5},{iat:n-0.5},{nbf:n-1},{nbf:n+60}])await assert.rejects(s.verify(await s.sign(s.claims(patch))));
  assert.equal((await s.verify(await s.sign(s.claims({nbf:n})))).notBefore,n);
 });
 await t.test('missing/mistyped identity, jti and scope, unknown claims and write scopes are rejected',async()=>{
  const s=await setup();for(const patch of [{sub:'name'},{sub:[SUBJECT]},{jti:'name'},{scope:['mcp:read']},{scope:'mcp:read stock:read stock:read'},{scope:'mcp:read sales:write'},{role:'admin'},{store:'other'},{email:'PRIVATE_PERSON_SENTINEL'}])await assert.rejects(s.verify(await s.sign(s.claims(patch))));
  for(const field of ['iss','aud','sub','jti','iat','exp','scope']){const p=s.claims();delete p[field];await assert.rejects(s.verify(await s.sign(p)));}
 });
 await t.test('byte/malformed/abort input is bounded and raw errors never include tokens or claims',async()=>{
  const s=await setup();for(const token of ['x'.repeat(4097),'bad','a.b.c','a=.b.c','PRIVATE_PERSON_SENTINEL'])await assert.rejects(s.verify(token),e=>e.message==='Invalid local access token'&&!e.message.includes(token));
  const abort=new AbortController();abort.abort();await assert.rejects(s.control.verifyAccessToken(await s.sign(),{issuer:ISSUER,audience:RESOURCE,signal:abort.signal}));
 });
 await t.test('strict public JWK profile rejects private/symmetric/wrong-curve/duplicate/oversize config',async()=>{
  for(const keys of [[],Array(5).fill(first.jwk),[first.jwk,first.jwk],[{...first.jwk,d:'NEVER_ACCEPT_PRIVATE'}],[{...first.jwk,kty:'oct'}],[{...first.jwk,crv:'P-384'}],[{...first.jwk,alg:'HS256'}],[{...first.jwk,key_ops:['sign']}],[{...first.jwk,jku:'https://forbidden.invalid/'}]])await assert.rejects(createLocalJwtVerifier({jose,issuer:ISSUER,resource:RESOURCE,publicKeys:keys,maxTokenAgeSeconds:300}));
 });
 await t.test('rotation supports bounded overlap and removes old key trust and existing principals',async()=>{
  const s=await setup(),token=await s.sign(),p=await s.boundary.authenticate(new Request(RESOURCE,{headers:{authorization:'Bearer '+token}}));
  await s.control.replaceKeys([first.jwk,second.jwk]);await s.verify(token);await s.verify(await s.sign(s.claims(),second));assert.throws(()=>requireVerifiedPrincipal(p,{resource:RESOURCE,issuer:ISSUER,now:s.now}));
  await s.control.replaceKeys([second.jwk]);await assert.rejects(s.verify(token));await s.verify(await s.sign(s.claims(),second));
 });
 await t.test('invalid replacement is rejected atomically; explicit key revocation cannot be undone by rotation',async()=>{
  const s=await setup(),token=await s.sign();await assert.rejects(s.control.replaceKeys([{...first.jwk,crv:'wrong'}]));await s.verify(token);
  s.control.revokeKey(first.kid);await assert.rejects(s.verify(token));await assert.rejects(s.control.replaceKeys([first.jwk]));
 });
 await t.test('jti revocation invalidates new verification and a principal already registered',async()=>{
  const s=await setup(),claims=s.claims(),token=await s.sign(claims),p=await s.boundary.authenticate(new Request(RESOURCE,{headers:{authorization:'Bearer '+token}}));
  requireVerifiedPrincipal(p,{resource:RESOURCE,issuer:ISSUER,now:s.now});s.control.revokeToken(claims.jti);await assert.rejects(s.verify(token));assert.throws(()=>requireVerifiedPrincipal(p,{resource:RESOURCE,issuer:ISSUER,now:s.now}));
 });
 await t.test('subject cutoff revokes issued tokens; later unique token still requires fresh authorization',async()=>{
  const s=await setup(),token=await s.sign();s.control.revokeSubject(SUBJECT);await assert.rejects(s.verify(token));s.setClock(s.now()+1000);await s.verify(await s.sign());
 });
 await t.test('revocation while grant authorization awaits cannot publish an active principal',async()=>{
  const s=await setup(),claims=s.claims(),token=await s.sign(claims);let release,entered;const wait=new Promise(r=>{release=r;}),ready=new Promise(r=>{entered=r;});
  const boundary=createIdentityBoundary({resource:RESOURCE,issuer:ISSUER,now:s.now,verifyAccessToken:s.control.verifyAccessToken,authorizePrincipal:async()=>{entered();await wait;return{active:true,id:SUBJECT,store:'fixture_store',permissions:['stock:read'],customerIds:null};}});
  const pending=boundary.authenticate(new Request(RESOURCE,{headers:{authorization:'Bearer '+token}}));await ready;s.control.revokeToken(claims.jti);release();await assert.rejects(pending);
 });
 await t.test('rotation during real signature verification is detected before identity delivery',async()=>{
  let release,entered;const wait=new Promise(r=>{release=r;}),ready=new Promise(r=>{entered=r;});
  const wrapped={...jose,jwtVerify:async(...args)=>{const r=await jose.jwtVerify(...args);entered();await wait;return r;}};
  const s=await setup({jose:wrapped}),pending=s.verify(await s.sign());await ready;await s.control.replaceKeys([second.jwk]);release();await assert.rejects(pending);
 });
 await t.test('revocation entries are bounded; capacity exhaustion disables rather than forgetting revocations',async()=>{
  const s=await setup(),token=await s.sign();for(let i=0;i<128;i++)s.control.revokeToken(randomUUID());assert.throws(()=>s.control.revokeToken(randomUUID()));assert.equal(s.control.status().disabled,true);await assert.rejects(s.verify(token));
 });
 await t.test('expired revocations prune only after the maximum accepted token horizon',async()=>{
  const s=await setup();s.control.revokeToken(randomUUID());s.control.revokeSubject(SUBJECT);assert.equal(s.control.status().revokedTokens,1);s.setClock(s.now()+301000);assert.equal(s.control.status().revokedTokens,0);assert.equal(s.control.status().revokedSubjects,0);await s.verify(await s.sign());
 });
 await t.test('backward wall-clock movement disables this local verifier',async()=>{
  const s=await setup();await s.verify(await s.sign());s.setClock(s.now()-1000);await assert.rejects(s.verify(await s.sign()));
 });
 await t.test('token scopes intersect server grants; store/permissions never come from JWT payload',async()=>{
  const s=await setup(),token=await s.sign(s.claims({scope:'mcp:read stock:read finance:read'})),p=await s.boundary.authenticate(new Request(RESOURCE,{headers:{authorization:'Bearer '+token}}));assert.equal(p.store,'fixture_store');assert.deepEqual(p.permissions,['stock:read','finance:read']);assert.ok(!JSON.stringify(p).includes(token));
  const noScope=await s.sign(s.claims({scope:'stock:read'}));await assert.rejects(s.boundary.authenticate(new Request(RESOURCE,{headers:{authorization:'Bearer '+noScope}})),e=>e.status===403);
 });
});
