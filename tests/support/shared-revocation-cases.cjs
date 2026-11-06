'use strict';
const assert=require('node:assert/strict'),cp=require('node:child_process'),{randomUUID}=require('node:crypto');
const {createSharedJwtVerifier}=require('../../mcp/shared-jwt-verifier.cjs');
const {createSharedRevocationStore,revocationNamespace,revocationTarget}=require('../../mcp/shared-revocation-store.cjs');
const {createIdentityBoundary,requireVerifiedPrincipalAsync}=require('../../mcp/http-identity.cjs');
const {fixtureRevocationPort}=require('./revocation-executor.cjs');
module.exports=async function sharedCases(t,{sql,file,now,id,service,ROOT,stopServer,startServer}){
 const jose=await import('jose'),ISSUER='https://identity.invalid/',RESOURCE='https://fixture.invalid/mcp',namespace=revocationNamespace(ISSUER,RESOURCE),incarnation='88000000-0000-4000-8000-000000000001';
 sql(file('tests/sql/mcp_revocation_fixture.sql'));
 sql("insert into mcp_revocation_fixture.state(namespace,incarnation,cluster_id) values('"+namespace+"','"+incarnation+"',(select system_identifier::text from pg_control_system()))");
 const read=fixtureRevocationPort('read'),write=fixtureRevocationPort('write'),newStore=()=>createSharedRevocationStore({namespace,incarnation,executeRead:read});
 const admin=createSharedRevocationStore({namespace,incarnation,executeRead:read,executeWrite:write});
 const pair=async kid=>{const key=await jose.generateKeyPair('ES256');return{...key,jwk:{...await jose.exportJWK(key.publicKey),kid,alg:'ES256',use:'sig'}};};
 const one=await pair('shared-key-one'),two=await pair('shared-key-two'),publicKeys=[one.jwk,two.jwk];
 const verifier=store=>createSharedJwtVerifier({store,jose,issuer:ISSUER,resource:RESOURCE,publicKeys,maxTokenAgeSeconds:300,now});
 const a=await verifier(newStore()),b=await verifier(newStore()),n=Math.floor(now()/1000);
 const claims=(extra={})=>({iss:ISSUER,aud:RESOURCE,sub:id(1),jti:randomUUID(),iat:n,exp:n+60,scope:'mcp:read stock:read sales:read finance:read',...extra});
 const sign=(payload,key=one)=>new jose.SignJWT(payload).setProtectedHeader({alg:'ES256',typ:'at+jwt',kid:key.jwk.kid}).sign(key.privateKey);
 const verify=(v,token)=>v.verifyAccessToken(token,{issuer:ISSUER,audience:RESOURCE});
 const intent=(kind,value,cutoff=null,requestId=randomUUID())=>Object.freeze({requestId,kind,target:revocationTarget(namespace,kind,value),cutoff});
 const boundary=v=>createIdentityBoundary({issuer:ISSUER,resource:RESOURCE,now,verifyAccessToken:v.verifyAccessToken,authorizePrincipal:async()=>({active:true,id:id(1),store:'fixture_store',permissions:['stock:read','sales:read','finance:read'],customerIds:null})});
 const authenticate=(v,token)=>boundary(v).authenticate(new Request(RESOURCE,{headers:{authorization:'Bearer '+token}}));
 await t.test('two independent verifiers share committed token revocation without a positive cache',async()=>{
  const p=claims(),token=await sign(p);await verify(a,token);await verify(b,token);assert.equal((await admin.record(intent('token',p.jti))).status,'applied');await assert.rejects(verify(a,token));await assert.rejects(verify(b,token));
 });
 await t.test('fresh verifier and separate Node process observe the persisted tombstone',async()=>{
  const p=claims(),token=await sign(p);
  async function freshProcess(expected){
  const child=cp.spawn(process.execPath,[ROOT+'/tests/support/revocation-child.cjs'],{cwd:'/scratch',env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/scratch',TMPDIR:'/scratch',TMP:'/scratch',TEMP:'/scratch',XDG_CACHE_HOME:'/scratch/cache',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'America/Sao_Paulo'},stdio:['pipe','pipe','pipe']});
  let out='',size=0;const done=new Promise((resolve,reject)=>{child.stdout.on('data',buf=>{size+=buf.length;if(size>1024){child.kill('SIGKILL');reject(Error('Child output limit'));}else out+=buf;});child.stderr.on('data',buf=>{size+=buf.length;if(size>1024)child.kill('SIGKILL');});child.once('error',reject);child.once('close',code=>resolve(code));});const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({issuer:ISSUER,resource:RESOURCE,incarnation,now:now(),publicKey:one.jwk,token}));assert.equal(await done,0);clearTimeout(timer);assert.deepEqual(JSON.parse(out),{accepted:expected});
  }
  await freshProcess(true);await admin.record(intent('token',p.jti));await assert.rejects(verify(await verifier(newStore()),token));await freshProcess(false);
 });
 await t.test('idempotent concurrent request retries preserve a single event and mismatched payload is refused',async()=>{
  const q=intent('token',randomUUID()),before=sql('select count(*) from mcp_revocation_fixture.requests').stdout.trim();
  const [x,y]=await Promise.all([admin.record(q),admin.record(q)]);assert.ok([x.status,y.status].includes('applied'));assert.ok([x.status,y.status].includes('replayed'));
  assert.equal(sql('select count(*) from mcp_revocation_fixture.requests').stdout.trim(),String(Number(before)+1));assert.equal((await admin.record({...q,target:revocationTarget(namespace,'token',randomUUID())})).status,'uncertain');assert.equal((await admin.lookup(q)).status,'applied');
 });
 await t.test('lost post-COMMIT acknowledgement is uncertain and resolves by same immutable request lookup',async()=>{
  const q=intent('token',randomUUID()),lost=createSharedRevocationStore({namespace,incarnation,executeRead:read,executeWrite:async(...args)=>{await write(...args);throw Error('Lost acknowledgement');}});
  assert.equal((await lost.record(q)).status,'uncertain');assert.equal((await admin.lookup(q)).status,'applied');assert.equal((await admin.record(q)).status,'replayed');
 });
 await t.test('transaction failure leaves no partial event/tombstone and unchanged intent can retry',async()=>{
  const q=intent('token',randomUUID());sql("create function mcp_revocation_fixture.reject_event() returns trigger language plpgsql as $$begin raise exception 'Fixture failure' using errcode='23514';end $$;create trigger reject_event before insert on mcp_revocation_fixture.requests for each row execute function mcp_revocation_fixture.reject_event()");
  try{assert.equal((await admin.record(q)).status,'uncertain');assert.equal((await admin.lookup(q)).status,'not_found');assert.equal(sql("select count(*) from mcp_revocation_fixture.revoked where target='"+q.target+"'").stdout.trim(),'0');}finally{sql('drop trigger reject_event on mcp_revocation_fixture.requests;drop function mcp_revocation_fixture.reject_event()');}
  assert.equal((await admin.record(q)).status,'applied');
 });
 await t.test('subject cutoff is monotonic and does not reject a later unique token',async()=>{
  const p=claims({sub:id(91)}),token=await sign(p);await verify(a,token);await admin.record(intent('subject',p.sub,n));await admin.record(intent('subject',p.sub,n-10));await assert.rejects(verify(b,token));
  const future=await createSharedJwtVerifier({store:newStore(),jose,issuer:ISSUER,resource:RESOURCE,publicKeys,maxTokenAgeSeconds:300,now:()=>now()+1000});await verify(future,await sign(claims({sub:id(91),iat:n+1,exp:n+61})));
 });
 await t.test('an already registered principal and direct service/tool listing recheck shared state',async()=>{
  const p=claims(),token=await sign(p),principal=await authenticate(a,token),s=await service(1,{},principal);assert.equal((await s.service.call('vaidosa_stock_list')).items.length,3);
  await admin.record(intent('token',p.jti));await assert.rejects(requireVerifiedPrincipalAsync(principal,{issuer:ISSUER,resource:RESOURCE,now}));await assert.rejects(s.service.call('vaidosa_stock_list'));await assert.rejects(s.service.listTools());
 });
 await t.test('revocation committed during grant authorization prevents publishing a principal',async()=>{
  const p=claims(),token=await sign(p);let release,entered;const wait=new Promise(r=>{release=r;}),ready=new Promise(r=>{entered=r;});
  const gate=createIdentityBoundary({issuer:ISSUER,resource:RESOURCE,now,verifyAccessToken:a.verifyAccessToken,authorizePrincipal:async()=>{entered();await wait;return{active:true,id:id(1),store:'fixture_store',permissions:['stock:read'],customerIds:null};}});
  const pending=gate.authenticate(new Request(RESOURCE,{headers:{authorization:'Bearer '+token}}));await ready;await admin.record(intent('token',p.jti));release();await assert.rejects(pending);
 });
 await t.test('revocation committed during data read withholds its result at the post-read gate',async()=>{
  const p=claims(),token=await sign(p),principal=await authenticate(a,token);const {createBusinessReadAdapter}=require('../../mcp/business-adapter.cjs'),{createBusinessReadService}=require('../../mcp/business-service.cjs');
  let release,entered;const wait=new Promise(r=>{release=r;}),ready=new Promise(r=>{entered=r;});const source=await service(1,{},principal);
  const gateway={...source.gateway,readSnapshot:async(...args)=>{const result=await source.gateway.readSnapshot(...args);entered();await wait;return result;}};
  const adapter=createBusinessReadAdapter({gateway,issuer:ISSUER,resource:RESOURCE,store:'fixture_store',timeZone:'America/Sao_Paulo',now}),s=createBusinessReadService({adapter,principal,now});const pending=s.call('vaidosa_stock_list');await ready;await admin.record(intent('token',p.jti));release();await assert.rejects(pending);
 });
 await t.test('permission loss or missing namespace fails closed without local authorization fallback',async()=>{
  const token=await sign(claims());sql('revoke execute on function mcp_revocation_fixture.check_state(jsonb) from mcp_revocation_reader');try{await assert.rejects(verify(a,token));}finally{sql('grant execute on function mcp_revocation_fixture.check_state(jsonb) to mcp_revocation_reader');}
  const wrong=createSharedRevocationStore({namespace,incarnation:'88000000-0000-4000-8000-000000000099',executeRead:read});await assert.rejects(verify(await verifier(wrong),token));
 });
 await t.test('reader has no writer/table access and MCP actors cannot mutate revocation state',()=>{
  for(const [role,text]of [['mcp_revocation_reader','select * from mcp_revocation_fixture.revoked'],['mcp_revocation_reader',"select mcp_revocation_fixture.apply('{}')"],['mcp_fixture_manager','select * from mcp_revocation_fixture.state']]){const p=sql(text,role,false);assert.notEqual(p.status,0);assert.match(p.stderr,/42501/);}
 });
 await t.test('database outage denies verification and restart retains revocations and incarnation',async()=>{
  const p=claims(),token=await sign(p),good=await sign(claims());await admin.record(intent('token',p.jti));await stopServer();try{await assert.rejects(verify(a,good));}finally{await startServer();}
  await assert.rejects(verify(await verifier(newStore()),token));await verify(b,good);
 });
 await t.test('key revocation is visible across instances and fresh key configurations',async()=>{
  const token=await sign(claims(),two);await verify(a,token);await admin.record(intent('key',two.jwk.kid));await assert.rejects(verify(b,token));await assert.rejects(verify(await verifier(newStore()),token));
 });
 await t.test('bounded store keeps monotonic revisions, rejects replayed/stale responses and requires a backend',async()=>{
  await assert.rejects(createSharedJwtVerifier({jose,issuer:ISSUER,resource:RESOURCE,publicKeys,maxTokenAgeSeconds:300}));
  let stale=false;const fake=createSharedRevocationStore({namespace,incarnation,executeRead:async q=>({namespace,incarnation,nonce:q.nonce,revision:stale?'0':'1',allowed:true})});
  const meta={namespace,token:'a'.repeat(64),subject:'b'.repeat(64),key:'c'.repeat(64),iat:n,exp:n+60};assert.equal(await fake.check(meta),true);stale=true;await assert.rejects(fake.check(meta));
  const unavailable=createSharedRevocationStore({namespace,incarnation,executeRead:()=>new Promise(()=>{})});const blocked=await Promise.all(Array.from({length:8},()=>assert.rejects(unavailable.check(meta))));assert.equal(blocked.length,8);await assert.rejects(unavailable.check(meta));
 });
 await t.test('capacity exhaustion commits global lockdown instead of evicting a revocation',async()=>{
  const token=await sign(claims());await verify(a,token);sql('update mcp_revocation_fixture.state set entry_limit=(select count(*) from mcp_revocation_fixture.revoked)');const result=await admin.record(intent('token',randomUUID()));assert.equal(result.status,'locked_down');await assert.rejects(verify(a,token));await assert.rejects(verify(b,token));assert.equal(sql('select disabled from mcp_revocation_fixture.state').stdout.trim(),'t');
 });
};
