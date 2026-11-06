'use strict';
// Integration only: SDK HTTP client -> private Unix HTTP server -> JWT/revocation
// -> existing gateway -> PostgreSQL/RLS -> DTO2. No real AS, TCP or credentials.
const assert=require('node:assert/strict'),fs=require('node:fs'),{randomUUID,randomBytes}=require('node:crypto');
const sdk=require('@modelcontextprotocol/client'),pkce=require('pkce-challenge');
const {createUnixHttpFixture}=require('./unix-http-fixture.cjs');
const {createSharedJwtVerifier}=require('../../mcp/shared-jwt-verifier.cjs');
const {createSharedRevocationStore,revocationNamespace,revocationTarget}=require('../../mcp/shared-revocation-store.cjs');
const {fixtureRevocationPort}=require('./revocation-executor.cjs');
const {createFixtureExecutor}=require('./mcp-postgres-executor.cjs');
const {createPostgresReadGateway}=require('../../mcp/postgres-read-gateway.cjs');
const {createBusinessReadAdapter}=require('../../mcp/business-adapter.cjs');
const {createBusinessReadService}=require('../../mcp/business-service.cjs');
const {createStreamableHttpHandler}=require('../../mcp/streamable-http.cjs');
const RESOURCE='https://e2e.fixture.invalid/mcp',ISSUER='https://e2e.identity.invalid/',REDIRECT='https://e2e.client.invalid/callback',STORE='fixture_store';
module.exports=async function e2eCases(t,{sql,now,id}){
 const jose=await import('jose'),keys=await jose.generateKeyPair('ES256'),publicKey={...await jose.exportJWK(keys.publicKey),kid:'e2e-test-key',alg:'ES256',use:'sig'};
 const namespace=revocationNamespace(ISSUER,RESOURCE),incarnation=randomUUID(),read=fixtureRevocationPort('read'),write=fixtureRevocationPort('write');
 sql("insert into mcp_revocation_fixture.state(namespace,incarnation,cluster_id) values('"+namespace+"','"+incarnation+"',(select system_identifier::text from pg_control_system()))");
 const newStore=()=>createSharedRevocationStore({namespace,incarnation,executeRead:read}),admin=createSharedRevocationStore({namespace,incarnation,executeRead:read,executeWrite:write});
 const newVerifier=()=>createSharedJwtVerifier({store:newStore(),jose,issuer:ISSUER,resource:RESOURCE,publicKeys:[publicKey],maxTokenAgeSeconds:300,now});let verifier=await newVerifier();
 const actors={manager:{id:id(1),permissions:['stock:read','sales:read','finance:read'],customerIds:null},alice:{id:id(2),permissions:['stock:read','sales:read'],customerIds:[id(10)]}};
 const metadata={issuer:ISSUER,authorization_endpoint:ISSUER+'authorize',token_endpoint:ISSUER+'token',response_types_supported:['code'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],authorization_response_iss_parameter_supported:true};
 const codes=new Map(),sessions=new Set(),issued=new Map(),events=[];let dataReads=0,serviceCreations=0,hold=null,bridge;
 const exec=createFixtureExecutor({issuer:ISSUER,resource:RESOURCE,now});
 const gateway=createPostgresReadGateway({sourceId:'vaidosa_disposable_source',store:STORE,issuer:ISSUER,resource:RESOURCE,fixture:true,now,executeRead:async(q,c)=>{dataReads++;const result=await exec(q,c);if(hold){const h=hold;hold=null;h.enter();await h.wait;}return result;}});
 const adapter=createBusinessReadAdapter({gateway,store:STORE,issuer:ISSUER,resource:RESOURCE,timeZone:'America/Sao_Paulo',now});
 const makeHandler=()=>createStreamableHttpHandler({issuer:ISSUER,resource:RESOURCE,now,verifyAccessToken:(...args)=>verifier.verifyAccessToken(...args),authorizePrincipal:async p=>{const a=Object.values(actors).find(a=>a.id===p.subject);return a?{active:true,...a,store:STORE}:null;},createService:p=>{serviceCreations++;return createBusinessReadService({adapter,principal:p,now});}});
 let mcp=makeHandler();
 const json=(status,data,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
 // Finite AS response fixture: a preselected fictional actor is treated as logged
 // in. This does not implement consent/login or a deployable authorization server.
 async function route(request){
  const u=new URL(request.url);
  if(u.origin===new URL(RESOURCE).origin){
   const response=await mcp(request),body=await response.clone().json().catch(()=>null);let toolCode=null;
   if(body?.result?.isError){try{const code=JSON.parse(body.result.content[0].text).code;if(['NOT_AVAILABLE','INVALID_CURSOR','TOO_LARGE'].includes(code))toolCode=code;}catch{}}
   if(events.length>=128)events.shift();events.push({status:response.status,rpc:Number.isSafeInteger(body?.error?.code)?body.error.code:null,auth:['invalid_token','insufficient_scope'].includes(body?.error)?body.error:null,toolCode});return response;
  }
  if(u.origin!==new URL(ISSUER).origin)return json(403,{error:'fixture_denied'});
  if(u.pathname==='/authorize'&&request.method==='GET'){
   const q=u.searchParams,actor=actors[q.get('client_id')];
   if(!actor||q.get('redirect_uri')!==REDIRECT||q.get('resource')!==RESOURCE||q.get('response_type')!=='code'||q.get('code_challenge_method')!=='S256'||q.get('scope')!=='mcp:read '+actor.permissions.join(' ')||!q.get('state')||codes.size>=8)return json(400,{error:'invalid_request'});
   const code=randomUUID();codes.set(code,{actor,challenge:q.get('code_challenge'),client:q.get('client_id'),expires:now()+60000});const callback=new URL(REDIRECT);callback.searchParams.set('code',code);callback.searchParams.set('state',q.get('state'));callback.searchParams.set('iss',ISSUER);return new Response(null,{status:302,headers:{location:callback.href}});
  }
  if(u.pathname==='/token'&&request.method==='POST'){
   const q=new URLSearchParams(await request.text()),entry=codes.get(q.get('code'));codes.delete(q.get('code'));
   if(!entry||entry.expires<=now()||q.get('client_id')!==entry.client||q.get('redirect_uri')!==REDIRECT||q.get('resource')!==RESOURCE||q.get('grant_type')!=='authorization_code'||!await pkce.verifyChallenge(q.get('code_verifier')??'',entry.challenge))return json(400,{error:'invalid_grant'});
   const jti=randomUUID(),scope='mcp:read '+entry.actor.permissions.join(' '),iat=Math.floor(now()/1000),token=await new jose.SignJWT({iss:ISSUER,aud:RESOURCE,sub:entry.actor.id,jti,iat,exp:iat+120,scope}).setProtectedHeader({alg:'ES256',typ:'at+jwt',kid:publicKey.kid}).sign(keys.privateKey);issued.set(token,jti);
   return json(200,{access_token:token,token_type:'Bearer',expires_in:120,scope});
  }
  return json(404,{error:'not_found'});
 }
 async function start(){bridge=await createUnixHttpFixture({authorities:[new URL(RESOURCE).origin,new URL(ISSUER).origin],handler:route});}
 await start();
 async function closeClients(){for(const s of [...sessions]){await s.client.close();sessions.delete(s);}}
 t.after(async()=>{hold?.release();await closeClients();await bridge.close();codes.clear();issued.clear();});
 async function authorize(actor){
  const scope='mcp:read '+actors[actor].permissions.join(' '),state=randomBytes(32).toString('base64url'),clientInformation={client_id:actor,token_endpoint_auth_method:'none'};
  const started=await sdk.startAuthorization(ISSUER,{metadata,clientInformation,redirectUrl:REDIRECT,scope,state,resource:RESOURCE});
  const auth=await bridge.fetch(started.authorizationUrl);assert.equal(auth.status,302);const callback=new URL(auth.headers.get('location'));assert.equal(callback.origin+callback.pathname,REDIRECT);assert.ok(callback.searchParams.get('state')===state);
  const tokens=await sdk.exchangeAuthorization(ISSUER,{metadata,clientInformation,authorizationCode:callback.searchParams.get('code'),iss:callback.searchParams.get('iss'),codeVerifier:started.codeVerifier,redirectUri:REDIRECT,resource:RESOURCE,fetchFn:bridge.fetch});assert.ok(issued.has(tokens.access_token));return tokens.access_token;
 }
 async function connect(token){
  const client=new sdk.Client({name:'vaidosa-private-http-integration',version:'fixture'},{capabilities:{},versionNegotiation:{mode:'auto'}}),transport=new sdk.StreamableHTTPClientTransport(new URL(RESOURCE),{fetch:bridge.fetch,authProvider:{token:async()=>token,authorize:async()=>{throw Error('No external reauthorization');}},onInsufficientScope:'throw',maxStepUpRetries:0,redirectPolicy:'same-origin'}),s={client,transport,token};
  client.onerror=()=>{};sessions.add(s);try{await client.connect(transport,{timeout:3000});return s;}catch{await client.close();sessions.delete(s);throw Error('Fixture SDK connection unavailable');}
 }
 const open=async actor=>connect(await authorize(actor));
 const call=(s,name,args={})=>s.client.callTool({name,arguments:args},{timeout:3000});
 const data=r=>{assert.equal(r.isError,false);const d=r.structuredContent;assert.ok(d?.fixture&&d.contractVersion===2);assert.ok(!/PRIVATE_|buyer_cpf|cpf|password|access_token|refresh_token|xml|note|cost/.test(JSON.stringify(d)));return d;};
 const denied=async(task,expected)=>{const mark=events.length;let refused=false;try{refused=(await task).isError===true;}catch{refused=true;}assert.ok(refused,'SDK must refuse the result');const observed=events.slice(mark);assert.ok(observed.some(e=>expected?expected(e):e.status===403||[-32602,-32603].includes(e.rpc)||e.toolCode!==null),'server must have returned an explicit denial, not merely a transport error');};
 const revoke=async token=>{const r=await admin.record({requestId:randomUUID(),kind:'token',target:revocationTarget(namespace,'token',issued.get(token)),cutoff:null});assert.equal(r.status,'applied');};
 const fingerprint=()=>sql("select md5(concat((select jsonb_agg(to_jsonb(t) order by id)::text from public.sales t),(select jsonb_agg(to_jsonb(t) order by id)::text from public.products t),(select jsonb_agg(to_jsonb(t) order by id)::text from public.contas t),(select jsonb_agg(to_jsonb(t) order by id)::text from public.sale_payments t),(select jsonb_agg(to_jsonb(t) order by id)::text from public.sale_items t),(select jsonb_agg(to_jsonb(t) order by id)::text from public.stock_moves t),(select jsonb_agg(to_jsonb(t) order by id)::text from public.movimentacoes t)));select last_value,is_called from public.product_barcode_seq").stdout;
 const before=fingerprint();let manager,cursor;
 await t.test('official client completes private HTTP handshake, code/PKCE exchange and all five PostgreSQL reads',async()=>{
  assert.equal((await bridge.fetch(RESOURCE,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  const discovery=await bridge.fetch(new URL(RESOURCE).origin+'/.well-known/oauth-protected-resource/mcp');assert.equal((await discovery.json()).resource,RESOURCE);
  manager=await open('manager');assert.equal(manager.client.getNegotiatedProtocolVersion(),'2025-11-25');assert.equal((await manager.client.listTools()).tools.length,5);
  const stock=data(await call(manager,'vaidosa_stock_list',{limit:1}));assert.equal(stock.items[0].productId,id(30));assert.equal(stock.items[0].available,7);cursor=stock.nextCursor;assert.ok(cursor);assert.equal(data(await call(manager,'vaidosa_stock_list',{limit:1,cursor})).items[0].available,0);
  assert.equal(data(await call(manager,'vaidosa_customer_orders',{customerId:id(10)})).items.length,2);assert.equal(data(await call(manager,'vaidosa_sale_get',{saleId:id(40)})).totalCents,10000);
  assert.equal(data(await call(manager,'vaidosa_receipts_summary',{from:'2026-11-01',to:'2026-11-30'})).receivedCents,30000);assert.equal(data(await call(manager,'vaidosa_accounts_list')).items.length,3);assert.ok(dataReads>=6);
 });
 await t.test('a second OAuth fixture identity stays within database/customer scope and cannot reuse another cursor or write',async()=>{
  const foreign=data(await call(manager,'vaidosa_stock_list',{limit:1})).nextCursor;assert.ok(foreign);const alice=await open('alice');assert.equal((await alice.client.listTools()).tools.length,3);assert.equal(data(await call(alice,'vaidosa_customer_orders',{customerId:id(10)})).items.length,2);
  await denied(call(alice,'vaidosa_sale_get',{saleId:id(42)}),e=>e.toolCode==='NOT_AVAILABLE');await denied(call(alice,'vaidosa_stock_list',{limit:1,cursor:foreign}),e=>e.toolCode==='INVALID_CURSOR');await denied(call(alice,'vaidosa_accounts_list'),e=>e.status===403&&e.auth==='insufficient_scope');await denied(call(alice,'execute_sql',{sql:'select 1'}),e=>e.rpc===-32602);
 });
 await t.test('current database grants invalidate an already cached HTTP page instead of returning stale authorization',async()=>{
  const first=data(await call(manager,'vaidosa_stock_list',{limit:1}));sql("update mcp_fixture.grants set customers=array['"+id(10)+"'::uuid] where role_name='mcp_fixture_manager'");
  try{await denied(call(manager,'vaidosa_stock_list',{limit:1,cursor:first.nextCursor}));}finally{sql("update mcp_fixture.grants set customers=null where role_name='mcp_fixture_manager'");}
 });
 await t.test('committed shared revocation denies an existing SDK connection before data and a fresh token uses the same service safely',async()=>{
  await revoke(manager.token);const count=dataReads,created=serviceCreations,mark=events.length;await assert.rejects(manager.client.listTools());assert.ok(events.slice(mark).some(e=>e.status===401&&e.auth==='invalid_token'));assert.equal(dataReads,count);manager=await open('manager');assert.equal(data(await call(manager,'vaidosa_stock_list')).items.length,3);assert.equal(serviceCreations,created,'fresh JWT must reuse the same scoped service with fresh proof');
 });
 await t.test('revocation during the actual PostgreSQL read withholds the HTTP result before SDK delivery',async()=>{
  let enter,release;const ready=new Promise(r=>{enter=r;}),wait=new Promise(r=>{release=r;});hold={enter,release,wait};const token=manager.token,pending=call(manager,'vaidosa_stock_list');pending.catch(()=>{});let timer;
  try{await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Read barrier timeout')),2000);})]);await revoke(token);}finally{clearTimeout(timer);release();hold=null;}
  await denied(pending);
 });
 await t.test('HTTP server restart keeps database revocation, accepts fresh identity and leaves business data unchanged',async()=>{
  const revoked=manager.token;await closeClients();await bridge.close();verifier=await newVerifier();mcp=makeHandler();await start();await assert.rejects(connect(revoked));const fresh=await open('manager');assert.equal(data(await call(fresh,'vaidosa_stock_list')).items.length,3);
  assert.equal(fingerprint(),before);assert.equal(bridge.stats().tcp,false);assert.equal(fs.statSync('/scratch/mcp-http.sock').mode&0o777,0o600);assert.ok(!fs.readFileSync('/scratch/postgres.log','utf8').includes('PRIVATE_'));
  await assert.rejects(bridge.fetch('https://example.com/'));console.log('MCP_E2E_TERMINAL '+JSON.stringify({transport:'real_http_over_private_unix_socket',sdk:'2.4.0',postgres:true,oauth_fixture_only:true,jwt_signature:true,shared_revocation:true,tcp:false,external_network:false,production:false}));
 });
};
