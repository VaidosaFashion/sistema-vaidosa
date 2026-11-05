'use strict';
// Prepared tests. Run only in the OS sandbox documented for this follow-up.
require('../mcp/offline-guard.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createStreamableHttpHandler,VERSION}=require('../mcp/streamable-http.cjs');
const {createFixtureHttpHandler,RESOURCE,ISSUER}=require('../mcp/http-fixture.cjs');
const {createReadService}=require('../mcp/service.cjs');
const {fixturePrincipal,createFixtureAdapter}=require('../mcp/fixture-adapter.cjs');
const INIT={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:VERSION,capabilities:{},clientInfo:{name:'fixture-client',version:'1'}}};
const message=(method,params={},id=2)=>({jsonrpc:'2.0',id,method,params});
function request(body=INIT,{token='fixture_manager_token',headers={},method='POST',url=RESOURCE,signal}={}){
 const h={'accept':'application/json, text/event-stream','content-type':'application/json','mcp-protocol-version':VERSION,...(token?{authorization:'Bearer '+token}:{}),...headers};
 return new Request(url,{method,headers:h,...(!['GET','DELETE'].includes(method)?{body:typeof body==='string'?body:JSON.stringify(body)}:{}),...(signal?{signal}:{})});
}
function harness(options={}){
 const principal=fixturePrincipal('manager'),events=[],clock={time:1800000000000};
 const claims={verified:true,issuer:ISSUER,audiences:[RESOURCE],subject:principal.id,expiresAt:clock.time/1000+60,scopes:['mcp:read',...principal.permissions],...options.claims};
 const grant={...principal,active:true,...options.grant};let calls=0,verifications=0,authInputs=[];
 const handler=createStreamableHttpHandler({resource:RESOURCE,issuer:ISSUER,allowedOrigins:['https://allowed-fixture.invalid/'],now:()=>clock.time,audit:e=>events.push(e),
 verifyAccessToken:async(token,context)=>{verifications++;assert.equal(context.audience,RESOURCE);if(options.verifyError)throw Error('PRIVATE_MARKER');return claims;},
 authorizePrincipal:async c=>{authInputs.push(c);if(options.grantError)throw Error('PRIVATE_MARKER');return grant;},
 createService:async p=>{calls++;return options.service||createReadService({adapter:createFixtureAdapter(),principal:p,now:()=>clock.time});}});
 return {handler,events,clock,claims,grant,authInputs,calls:()=>calls,verifications:()=>verifications};
}
test('constructor fails closed without explicit identity and service adapters',()=>{
 for(const options of [{},{resource:RESOURCE,issuer:ISSUER},{resource:'http://fixture.invalid/mcp',issuer:ISSUER,createService:()=>{}}])assert.throws(()=>createStreamableHttpHandler(options));
});
test('metadata discovery and 401 challenge use canonical configured resource, no OAuth execution',async()=>{
 const h=createFixtureHttpHandler();const meta=await h(request(null,{method:'GET',token:null,url:'https://vaidosa-fixture.invalid/.well-known/oauth-protected-resource/mcp'}));
 assert.equal(meta.status,200);assert.equal((await meta.json()).resource,RESOURCE);
 const denied=await h(request(INIT,{token:null}));assert.equal(denied.status,401);assert.match(denied.headers.get('www-authenticate'),/resource_metadata=/);assert.equal(denied.headers.get('cache-control'),'no-store');
});
test('standard lifecycle JSON-response profile includes 202 notification and GET/DELETE 405',async()=>{
 const h=createFixtureHttpHandler();const init=await h(request());assert.equal(init.status,200);assert.equal((await init.json()).result.protocolVersion,VERSION);assert.equal(init.headers.has('mcp-session-id'),false);
 const notice=await h(request({jsonrpc:'2.0',method:'notifications/initialized'}));assert.equal(notice.status,202);assert.equal(await notice.text(),'');
 for(const method of ['GET','DELETE'])assert.equal((await h(request(null,{method}))).status,405);
 assert.equal((await h(request(message('tools/list')))).status,200);
});
test('invalid origin, Host, URL query token and attached session are rejected before service creation',async()=>{
 const h=harness();for(const options of [{headers:{origin:'https://attacker.invalid'}},{headers:{origin:'null'}},{headers:{host:'attacker.invalid'}},{url:RESOURCE+'?access_token=PRIVATE_MARKER'},{headers:{'mcp-session-id':'alien'}}])assert.ok([400,403].includes((await h.handler(request(INIT,options))).status));assert.equal(h.calls(),0);
});
test('only canonical allowlisted Origin is accepted; forwarded headers do not select resource',async()=>{
 const h=harness();const r=await h.handler(request(INIT,{headers:{origin:'https://allowed-fixture.invalid','x-forwarded-host':'attacker.invalid'}}));assert.equal(r.status,200);
});
test('missing or unsupported protocol, media and Accept headers fail explicitly',async()=>{
 const h=createFixtureHttpHandler();assert.equal((await h(request(message('tools/list'),{headers:{'mcp-protocol-version':'unsupported'}}))).status,400);
 assert.equal((await h(request(INIT,{headers:{'content-type':'text/plain'}}))).status,415);assert.equal((await h(request(INIT,{headers:{accept:'application/json'}}))).status,406);
});
test('identity boundary rejects unverifiable, expired, future, wrong-issuer, wrong-audience tokens',async()=>{
 for(const claims of [{verified:false},{expiresAt:1},{notBefore:2000000000},{issuer:'https://other.invalid/'},{audiences:['https://other.invalid/mcp']},{subject:'attacker user'}]){
  const h=harness({claims});assert.equal((await h.handler(request())).status,401);assert.equal(h.calls(),0);
 }
 const scope=harness({claims:{scopes:['stock:read']}});assert.equal((await scope.handler(request())).status,403);
 const h=harness({verifyError:true});assert.equal((await h.handler(request())).status,401);
});
test('inactive, mismatched or unscoped grants cannot use token claims as a role',async()=>{
 for(const grant of [{active:false},{id:'other_user'},{permissions:[]},{customerIds:undefined}]){const h=harness({grant});assert.equal((await h.handler(request())).status,403);assert.equal(h.calls(),0);}
});
test('bearer token never passes to business adapter or audit; authorization refreshes every request',async()=>{
 const h=harness();await h.handler(request());await h.handler(request(message('tools/list')));assert.equal(h.verifications(),2);assert.equal(h.authInputs.length,2);assert.doesNotMatch(JSON.stringify(h.authInputs)+JSON.stringify(h.events),/fixture_manager_token|PRIVATE_MARKER/);
 h.grant.active=false;assert.equal((await h.handler(request(message('tools/list')))).status,403);
});
test('customer grant changes invalidate cached service, preventing stale expanded access',async()=>{
 const h=harness();await h.handler(request());h.grant.customerIds=['customer_demo01'];const r=await h.handler(request(message('tools/call',{name:'vaidosa_sale_get',arguments:{saleId:'sale_demo03'}})));
 assert.equal(h.calls(),2);assert.equal((await r.json()).result.isError,true);
});
test('seller exposes only authorized read tools and cannot supply role/store/SQL/write commands',async()=>{
 const h=createFixtureHttpHandler();const opts={token:'fixture_seller_token'};
 const listed=await (await h(request(message('tools/list'),opts))).json();assert.equal(listed.result.tools.length,3);
 for(const name of ['execute_sql','delete_sale','constructor','__proto__'])assert.equal((await (await h(request(message('tools/call',{name,arguments:{} }),opts))).json()).error.code,-32602);
 assert.equal((await h(request(message('tools/call',{name:'vaidosa_receipts_summary',arguments:{from:'2026-11-01',to:'2026-11-05'}}),opts))).status,403);
 const bad=await (await h(request(message('tools/call',{name:'vaidosa_stock_list',arguments:{role:'manager'}}),opts))).json();assert.equal(bad.error.code,-32602);
});
test('pagination is scoped by principal and survives separate stateless HTTP requests',async()=>{
 const h=createFixtureHttpHandler();const first=await (await h(request(message('tools/call',{name:'vaidosa_stock_list',arguments:{limit:1}})))).json();const cursor=first.result.structuredContent.nextCursor;assert.ok(cursor);
 const next=await (await h(request(message('tools/call',{name:'vaidosa_stock_list',arguments:{limit:1,cursor}})))).json();assert.notDeepEqual(next.result.structuredContent.items,first.result.structuredContent.items);
 const foreign=await (await h(request(message('tools/call',{name:'vaidosa_stock_list',arguments:{limit:1,cursor}}),{token:'fixture_seller_token'}))).json();assert.equal(foreign.result.isError,true);
});
test('malformed/batch and over-limit JSON are bounded; no input is echoed',async()=>{
 const h=createFixtureHttpHandler();for(const body of ['{PRIVATE_MARKER',[],{jsonrpc:'2.0',id:null,method:'ping'}]){const r=await h(request(body));assert.equal(r.status,400);assert.doesNotMatch(await r.text(),/PRIVATE_MARKER/);}
 assert.equal((await h(request(' '.repeat(16385)))).status,413);
});
test('asynchronous service is awaited and private output fields fail closed',async()=>{
 const service={listTools:async()=>[],call:async()=>({fixture:true,cpf:'PRIVATE_MARKER'})};const h=harness({service});
 const body=await (await h.handler(request(message('tools/call',{name:'vaidosa_stock_list',arguments:{}})))).json();assert.equal(body.error.code,-32603);assert.doesNotMatch(JSON.stringify(body),/PRIVATE_MARKER/);
});
test('pre-aborted request starts no verification or service',async()=>{
 const h=harness(),abort=new AbortController();abort.abort();assert.equal((await h.handler(request(INIT,{signal:abort.signal}))).status,504);assert.equal(h.verifications(),0);
});
test('rate limits bound authenticated requests and unknown methods never enable writes',async()=>{
 const h=harness();for(let i=0;i<120;i++)assert.equal((await h.handler(request(message('ping')))).status,200);
 assert.equal((await h.handler(request(message('ping')))).status,429);h.clock.time+=60000;h.claims.expiresAt=h.clock.time/1000+60;
 const r=await (await h.handler(request(message('execute_sql',{sql:'PRIVATE_MARKER'})))).json();assert.equal(r.error.code,-32601);assert.doesNotMatch(JSON.stringify(h.events),/PRIVATE_MARKER|fixture_manager_token/);
});
test('concurrent requests memoize one service factory and share the same rate/cursor state',async()=>{
 let release,calls=0;const gate=new Promise(resolve=>release=resolve),p=fixturePrincipal('manager');
 const handler=createStreamableHttpHandler({resource:RESOURCE,issuer:ISSUER,
  verifyAccessToken:async()=>({verified:true,issuer:ISSUER,audiences:[RESOURCE],subject:p.id,expiresAt:Math.floor(Date.now()/1000)+60,scopes:['mcp:read',...p.permissions]}),authorizePrincipal:async()=>({...p,active:true}),
  createService:async principal=>{calls++;await gate;return createReadService({adapter:createFixtureAdapter(),principal});}});
 const a=handler(request()),b=handler(request());await new Promise(r=>setImmediate(r));assert.equal(calls,1);release();
 assert.equal((await a).status,200);assert.equal((await b).status,200);
});
test('aborted verification cannot proceed later to factory or tools even if verifier ignores signal',async()=>{
 let release,factories=0;const gate=new Promise(r=>release=r),p=fixturePrincipal('manager'),abort=new AbortController();
 const handler=createStreamableHttpHandler({resource:RESOURCE,issuer:ISSUER,verifyAccessToken:async()=>{await gate;return {verified:true,issuer:ISSUER,audiences:[RESOURCE],subject:p.id,expiresAt:Math.floor(Date.now()/1000)+60,scopes:['mcp:read',...p.permissions]};},authorizePrincipal:async()=>({...p,active:true}),createService:async()=>{factories++;return {};}});
 const pending=handler(request(INIT,{signal:abort.signal}));abort.abort();assert.equal((await pending).status,504);release();await new Promise(r=>setImmediate(r));assert.equal(factories,0);
});
test('DTO allowlist rejects unfamiliar nested fields even when they are not a known secret name',async()=>{
 const {projectReadonlyResult}=require('../mcp/read-contracts.cjs');
 const value={fixture:true,contractVersion:1,currency:'BRL',items:[{productId:'p1',name:'Exemplo',size:'G1',color:'Azul',available:1,privateCustomerData:'PRIVATE_MARKER'}],nextCursor:null};
 assert.throws(()=>projectReadonlyResult('vaidosa_stock_list',value));delete value.items[0].privateCustomerData;
 assert.deepEqual(projectReadonlyResult('vaidosa_stock_list',value),value);
 assert.throws(()=>projectReadonlyResult('vaidosa_stock_list',Object.assign(Object.create({hidden:1}),value)));
 const getter={...value};Object.defineProperty(getter,'items',{get:()=>value.items,enumerable:true});assert.throws(()=>projectReadonlyResult('vaidosa_stock_list',getter));
});
test('a synchronous abort inside the verifier resolves immediately and never starts a service',async()=>{
 const abort=new AbortController();let calls=0;
 const handler=createStreamableHttpHandler({resource:RESOURCE,issuer:ISSUER,verifyAccessToken:async()=>{abort.abort();return {};},authorizePrincipal:async()=>({}),createService:async()=>{calls++;return {};}});
 assert.equal((await handler(request(INIT,{signal:abort.signal}))).status,504);assert.equal(calls,0);
});
test('rejected tokens do not exhaust the authenticated minute quota',async()=>{
 const h=createFixtureHttpHandler();for(let i=0;i<501;i++)assert.equal((await h(request(INIT,{token:'bad_fixture_token'}))).status,401);
 assert.equal((await h(request(INIT))).status,200);
});
test('timeout responses do not free concurrency slots while ignored verifier work is still pending',async()=>{
 const p=fixturePrincipal('manager');let release;const gate=new Promise(r=>release=r);
 const handler=createStreamableHttpHandler({resource:RESOURCE,issuer:ISSUER,verifyAccessToken:async()=>{await gate;return {verified:true,issuer:ISSUER,audiences:[RESOURCE],subject:p.id,expiresAt:Math.floor(Date.now()/1000)+60,scopes:['mcp:read',...p.permissions]};},authorizePrincipal:async()=>({...p,active:true}),createService:async principal=>createReadService({adapter:createFixtureAdapter(),principal})});
 const attempts=Array.from({length:8},()=>{const c=new AbortController(),pending=handler(request(INIT,{signal:c.signal}));c.abort();return pending;});
 for(const response of await Promise.all(attempts))assert.equal(response.status,504);
 assert.equal((await handler(request())).status,503);release();await new Promise(r=>setImmediate(r));assert.equal((await handler(request())).status,200);
});
test('legacy sale items preserve a null product reference without inventing a canonical product ID',()=>{
 const {projectReadonlyResult}=require('../mcp/read-contracts.cjs');
 const sale={fixture:true,contractVersion:1,currency:'BRL',saleId:'sale_legacy',customerId:null,soldOn:'2026-11-01',status:'Pago',grossCents:100,discountCents:0,totalCents:100,items:[{productId:null,quantity:1,unitPriceCents:100}]};
 assert.equal(projectReadonlyResult('vaidosa_sale_get',sale).items[0].productId,null);
});
test('insufficient read scope challenges advertise a usable smallest authorized scope',async()=>{
 const h=harness({claims:{scopes:['mcp:read']}});const response=await h.handler(request());assert.equal(response.status,403);
 assert.match(response.headers.get('www-authenticate'),/scope="mcp:read stock:read"/);
});
