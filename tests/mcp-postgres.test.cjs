'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),{createHash,randomUUID}=require('node:crypto');
const {createLocalJwtVerifier}=require('../mcp/local-jwt-verifier.cjs');
const {createIdentityBoundary}=require('../mcp/http-identity.cjs');
const {createBusinessReadAdapter,readPlans,VERSION}=require('../mcp/business-adapter.cjs');
const {createBusinessReadService}=require('../mcp/business-service.cjs');
const {createPostgresReadGateway}=require('../mcp/postgres-read-gateway.cjs');
const {createStreamableHttpHandler,VERSION:PROTOCOL}=require('../mcp/streamable-http.cjs');
const {createFixtureExecutor,fixtureReadAs,environment,DB,SOCKET,PSQL,ROLES,subject:id}=require('./support/mcp-postgres-executor.cjs');
const RESOURCE='https://fixture.invalid/mcp',ISSUER='https://identity.invalid/',STORE='fixture_store',SOURCE='vaidosa_disposable_source';
const ROOT=path.resolve(__dirname,'..'),PG='/usr/lib/postgresql/17/bin/',now=()=>Date.parse('2026-11-06T12:00:00Z');
const policies={1:{permissions:['stock:read','sales:read','finance:read'],customerIds:null},2:{permissions:['stock:read','sales:read'],customerIds:[id(10)]},3:{permissions:['sales:read','finance:read'],customerIds:[id(11)]},4:{permissions:['stock:read'],customerIds:null},5:{permissions:['stock:read','sales:read','finance:read'],customerIds:null},6:{permissions:['finance:read'],customerIds:[id(10)]}};
function run(cmd,args,{input,role='postgres',check=true,timeout=15000,db=DB}={}){const p=cp.spawnSync(cmd,args,{env:{...environment(role),PGDATABASE:db},cwd:'/scratch',input,encoding:'utf8',timeout,maxBuffer:2000000});if(check)assert.equal(p.status,0,'fixture infrastructure '+(p.error?.code||p.stderr?.match(/(?:ERROR|FATAL):\s+([A-Z0-9]{5})/)?.[1]||'SQL'));return p;}
const sql=(text,role='postgres',check=true)=>run(PSQL,['-X','-w','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate'],{input:text,role,check});
const file=relative=>fs.readFileSync(path.join(ROOT,relative),'utf8');
async function identity(n,extra={}){
 const boundary=createIdentityBoundary({resource:RESOURCE,issuer:ISSUER,now,
  verifyAccessToken:async token=>{if(token!=='fixture-token')throw Error('Rejected simulated identity');return {verified:true,issuer:ISSUER,audiences:[RESOURCE],subject:id(n),expiresAt:Math.floor(now()/1000)+600,scopes:['mcp:read','stock:read','sales:read','finance:read']};},
  authorizePrincipal:async()=>({active:true,id:id(n),store:extra.store??STORE,...policies[n],...extra})});
 return boundary.authenticate(new Request(RESOURCE,{headers:{authorization:'Bearer fixture-token'}}));
}
const request=(n,operation,filters={})=>({mode:'snapshot',source:SOURCE,store:STORE,subject:id(n),operation,customers:policies[n]?.customerIds??null,filters,maxRows:2000,maxBytes:260000});
async function service(n,extra={},trustedPrincipal=null){
 const p=trustedPrincipal??await identity(n,extra);let calls=0;const exec=createFixtureExecutor({resource:RESOURCE,issuer:ISSUER,now});
 const gateway=createPostgresReadGateway({sourceId:SOURCE,store:STORE,resource:RESOURCE,issuer:ISSUER,executeRead:async(q,c)=>{calls++;return exec(q,c);},fixture:true,now});
 const adapter=createBusinessReadAdapter({gateway,store:STORE,resource:RESOURCE,issuer:ISSUER,timeZone:'America/Sao_Paulo',now});
 return {p,gateway,adapter,service:createBusinessReadService({adapter,principal:p,now}),calls:()=>calls};
}
function plan(p,operation,filters={}){const template=Object.values(readPlans()).find(x=>x.operation===operation);return {...template,version:VERSION,identity:{subject:p.id,store:p.store,customerIds:p.customerIds},filters,page:{limit:operation==='sale_detail'?1:20,continuation:null,snapshot:null},maxResponseBytes:262144};}
test('five MCP reads backed by isolated PostgreSQL authorization and RLS',{timeout:73000},async t=>{
 fs.mkdirSync(SOCKET,{mode:0o700});run(PG+'initdb',['-D','/scratch/cluster','--username=postgres','--encoding=UTF8','--no-locale','--auth-local=trust','--auth-host=reject','--wal-segsize=1','--no-instructions'],{db:'postgres',timeout:30000});
 function launchServer(){
 const fd=fs.openSync('/scratch/postgres.log','a',0o600);const instance=cp.spawn(PG+'postgres',['-D','/scratch/cluster','-k',SOCKET,'-p','55432','-c','listen_addresses=','-c','shared_buffers=16MB','-c','dynamic_shared_memory_type=mmap','-c','max_connections=8','-c','max_worker_processes=0','-c','autovacuum=off','-c','min_wal_size=2MB','-c','max_wal_size=8MB','-c','timezone=UTC','-c','log_timezone=UTC','-c','log_statement=none','-c','log_min_error_statement=panic','-c','log_error_verbosity=terse','-c','log_min_messages=panic','-c','log_parameter_max_length_on_error=0'],{env:environment('postgres'),cwd:'/scratch',stdio:['ignore',fd,fd]});fs.closeSync(fd);return instance;
 }
 let server=launchServer();
 t.after(()=>{run(PG+'pg_ctl',['-D','/scratch/cluster','stop','-m','fast','-w','-t','5'],{db:'postgres',check:false,timeout:8000});server.kill('SIGTERM');});
 let ready=false;for(let i=0;i<60;i++){if(run(PG+'pg_isready',['-q'],{db:'postgres',check:false,timeout:1000}).status===0){ready=true;break;}await new Promise(r=>setTimeout(r,50));}assert.ok(ready);
 run(PG+'createdb',[DB],{db:'postgres'});fs.writeFileSync('/scratch/mcp-cluster-id',run(PSQL,['-X','-w','-qAt','-c','select system_identifier::text from pg_control_system()'],{db:'postgres'}).stdout,{mode:0o400});
 const manifest=JSON.parse(file('tests/fixtures/mcp-schema-inputs.json'));for(const entry of manifest.files)assert.equal(createHash('sha256').update(file(entry.file)).digest('hex'),entry.sha256);
 sql(file('tests/sql/bootstrap.sql')+manifest.files.filter(x=>x.file.startsWith('supabase/migrations/202608')).map(x=>file(x.file)).join('\n')+file('tests/sql/observed_schema.sql')+file('supabase/releases/20261104_install_sales.sql')+file('supabase/releases/20261105_install_blocks.sql')+file('tests/sql/mcp_read_fixture.sql')+file('tests/sql/mcp_read_seed.sql'));
 await t.test('projection owner is not table owner/BYPASSRLS and no store_id was invented',()=>{
  assert.equal(sql("select not rolbypassrls and not rolsuper and not rolcanlogin from pg_roles where rolname='mcp_fixture_reader'").stdout.trim(),'t');
  assert.equal(sql("select bool_and(pg_get_userbyid(c.relowner)<>'mcp_fixture_reader' and c.relrowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('products','colors','sales','sale_items','sale_payments','contas','movimentacoes')").stdout.trim(),'t');
  assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name in ('products','sales','contas') and column_name='store_id'").stdout.trim(),'0');
 });
 await t.test('all five tools use the PostgreSQL source and DTO2 exact cents/dates',async()=>{
  const s=await service(1);const stock=await s.service.call('vaidosa_stock_list');assert.equal(stock.items.length,3);assert.equal(stock.items[1].available,0);
  const orders=await s.service.call('vaidosa_customer_orders',{customerId:id(10)});assert.deepEqual(orders.items.map(x=>x.saleId),[id(41),id(40)]);
  const sale=await s.service.call('vaidosa_sale_get',{saleId:id(40)});assert.equal(sale.grossCents,10010);assert.equal(sale.discountCents,10);assert.equal(sale.soldOn,'2026-10-31');
  const receipts=await s.service.call('vaidosa_receipts_summary',{from:'2026-11-02',to:'2026-11-03'});assert.equal(receipts.receivedCents,30000);assert.equal(receipts.feeCents,200);assert.equal(receipts.netCents,29800);
  const accounts=await s.service.call('vaidosa_accounts_list');assert.equal(accounts.items.length,3);assert.equal(accounts.items.find(x=>x.accountId===id(50)).effectivePaidCents,1000);assert.ok(accounts.items.every(x=>x.accountId!==id(53)));assert.equal(s.calls(),5);
  for(const output of [stock,orders,sale,receipts,accounts]){assert.equal(output.contractVersion,2);assert.equal(output.fixture,true);assert.ok(!/PRIVATE_|cpf|buyer_cpf|note|payload|authorization|cluster|cost/i.test(JSON.stringify(output)));}
 });
 await t.test('missing or frozen forged principal is rejected before any database invocation',async()=>{
  const s=await service(1),q=plan(s.p,'stock_variants');await assert.rejects(s.gateway.readSnapshot(q,{}));await assert.rejects(s.gateway.readSnapshot(q,{principal:Object.freeze({...s.p})}));assert.equal(s.calls(),0);
 });
 await t.test('DB denies absent identity and subject forged against the session login',async()=>{
  await assert.rejects(fixtureReadAs('mcp_fixture_unknown',request(1,'stock_variants')),e=>e.sqlState==='42501');
  await assert.rejects(fixtureReadAs('mcp_fixture_alice',request(3,'customer_orders',{customerId:id(11)})),e=>e.sqlState==='42501');
 });
 await t.test('DB source/store binding refuses mismatches and rejects inactive profiles',async()=>{
  for(const change of [{source:'different_source'},{store:'different_store'}])await assert.rejects(fixtureReadAs('mcp_fixture_manager',{...request(1,'stock_variants'),...change}),e=>e.sqlState==='42501');
  const inactive=await service(5);await assert.rejects(inactive.service.call('vaidosa_stock_list'));
 });
 await t.test('application scope lies cannot grant finance permissions missing in the DB',async()=>{
  const s=await service(2,{permissions:['stock:read','sales:read','finance:read'],customerIds:null});await assert.rejects(s.service.call('vaidosa_receipts_summary',{from:'2026-11-01',to:'2026-11-30'}));
  await assert.rejects(fixtureReadAs('mcp_fixture_stock',request(4,'sale_detail',{saleId:id(40)})),e=>e.sqlState==='42501');
 });
 await t.test('DB RLS filters customers even if application allowlist is widened',async()=>{
  const s=await service(2,{customerIds:null});assert.equal((await s.service.call('vaidosa_customer_orders',{customerId:id(10)})).items.length,2);
  assert.equal((await s.service.call('vaidosa_customer_orders',{customerId:id(11)})).items.length,0);await assert.rejects(s.service.call('vaidosa_sale_get',{saleId:id(42)}));
  const direct=await fixtureReadAs('mcp_fixture_alice',{...request(2,'customer_orders',{customerId:id(11)}),customers:null});assert.deepEqual(direct.rows,[]);
 });
 await t.test('finance-only session reads its receipts/accounts without gaining sales tool access',async()=>{
  const s=await service(6);const r=await s.service.call('vaidosa_receipts_summary',{from:'2026-11-01',to:'2026-11-30'});assert.equal(r.receivedCents,10000);assert.equal((await s.service.call('vaidosa_accounts_list')).items.length,1);
  await assert.rejects(s.service.call('vaidosa_sale_get',{saleId:id(40)}));
  await assert.rejects(fixtureReadAs('mcp_fixture_finance',request(6,'sale_detail',{saleId:id(40)})),e=>e.sqlState==='42501');
 });
 await t.test('untrusted claim GUC does not impersonate another database session actor',()=>{
  const encoded=Buffer.from(JSON.stringify({...request(3,'sale_detail',{saleId:id(42)}),customers:null})).toString('base64');
  const r=sql("set request.jwt.claim.sub='"+id(3)+"';select mcp_fixture.read_snapshot(convert_from(decode('"+encoded+"','base64'),'UTF8')::jsonb)",'mcp_fixture_alice',false);assert.notEqual(r.status,0);assert.match(r.stderr,/42501/);
 });
 await t.test('raw tables, private ledgers, writes and SET ROLE remain unavailable',()=>{
  for(const statement of ['select id,name from public.products','select payload from vaidosa_private.account_requests',"update public.products set stock=100","set role mcp_fixture_reader"]){const r=sql(statement,'mcp_fixture_manager',false);assert.notEqual(r.status,0);assert.match(r.stderr,/42501/);}
 });
 await t.test('actual RLS predicate changes remove rows from the SECURITY DEFINER projection',async()=>{
  sql('alter policy mcp_sales on public.sales using(false)');try{const s=await service(1);await assert.rejects(s.service.call('vaidosa_sale_get',{saleId:id(40)}));}finally{sql("alter policy mcp_sales on public.sales using(mcp_fixture.can_read('sales:read',client_id,true) or mcp_fixture.can_read('finance:read',client_id,true))");}
 });
 await t.test('paged data remains a coherent materialized snapshot while current DB stock changes',async()=>{
  const s=await service(1),a=await s.service.call('vaidosa_stock_list',{limit:1});sql("update public.products set stock=99 where id='"+id(31)+"'");
  try{const b=await s.service.call('vaidosa_stock_list',{limit:1,cursor:a.nextCursor});assert.equal(b.items[0].available,0);assert.equal((await (await service(1)).service.call('vaidosa_stock_list')).items[1].available,99);}finally{sql("update public.products set stock=0 where id='"+id(31)+"'");}
 });
 await t.test('DB grant changes invalidate cached snapshots before another page is delivered',async()=>{
  const s=await service(1),a=await s.service.call('vaidosa_stock_list',{limit:1});sql("update mcp_fixture.grants set customers=array['"+id(10)+"'::uuid] where role_name='mcp_fixture_manager'");
  try{await assert.rejects(s.service.call('vaidosa_stock_list',{limit:1,cursor:a.nextCursor}));}finally{sql("update mcp_fixture.grants set customers=null where role_name='mcp_fixture_manager'");}
 });
 await t.test('reassignment to another client or row removal invalidates a cached authorized page',async()=>{
  const s=await service(2),a=await s.service.call('vaidosa_customer_orders',{customerId:id(10),limit:1});
  sql("update public.sales set client_id='"+id(11)+"' where id='"+id(40)+"'");
  try{await assert.rejects(s.service.call('vaidosa_customer_orders',{customerId:id(10),limit:1,cursor:a.nextCursor}));}finally{sql("update public.sales set client_id='"+id(10)+"' where id='"+id(40)+"'");}
  const second=await service(1),first=await second.service.call('vaidosa_stock_list',{limit:1});
  sql('alter policy mcp_stock on public.products using(false)');
  try{await assert.rejects(second.service.call('vaidosa_stock_list',{limit:1,cursor:first.nextCursor}));}finally{sql("alter policy mcp_stock on public.products using(mcp_fixture.can_read('stock:read'))");}
 });
 await t.test('customer cursor cannot be attached to another principal or wider page',async()=>{
  const s=await service(1),first=await s.service.call('vaidosa_customer_orders',{customerId:id(10),limit:1}),alice=await service(2);
  await assert.rejects(alice.service.call('vaidosa_customer_orders',{customerId:id(10),limit:1,cursor:first.nextCursor}));await assert.rejects(s.service.call('vaidosa_customer_orders',{customerId:id(10),limit:2,cursor:first.nextCursor}));
  assert.equal((await s.service.call('vaidosa_customer_orders',{customerId:id(10),limit:1,cursor:first.nextCursor})).items[0].saleId,id(40));
 });
 await t.test('inconsistent totals/items are refused instead of returning a partial sale',async()=>{
  sql("update public.sale_items set price=90 where sale_id='"+id(40)+"'");try{await assert.rejects((await service(1)).service.call('vaidosa_sale_get',{saleId:id(40)}));}finally{sql("update public.sale_items set price=100.10 where sale_id='"+id(40)+"'");}
 });
 await t.test('source enforces product field limits rather than returning a silently truncated field',async()=>{
  sql("update public.products set name=repeat('x',201) where id='"+id(30)+"'");try{await assert.rejects((await service(1)).service.call('vaidosa_stock_list'));}finally{sql("update public.products set name='Vestido fixture' where id='"+id(30)+"'");}
 });
 await t.test('abort before query produces no DB call; DB transaction rejects mutation attempts',async()=>{
  const s=await service(1),controller=new AbortController();controller.abort();await assert.rejects(s.service.call('vaidosa_stock_list',{}, {principal:s.p,signal:controller.signal}));assert.equal(s.calls(),0);
  const r=sql("begin read only;update public.products set stock=100;commit",'postgres',false);assert.notEqual(r.status,0);assert.match(r.stderr,/25006/);
 });
 await t.test('HTTP handler connects to the same PG gateway, rejects invalid simulated token and keeps DTOs minimal',async()=>{
  const s=await service(1);const handler=createStreamableHttpHandler({resource:RESOURCE,issuer:ISSUER,now,
   verifyAccessToken:async token=>{if(token!=='fixture-token')throw Error('No simulated identity');return {verified:true,issuer:ISSUER,audiences:[RESOURCE],subject:id(1),expiresAt:Math.floor(now()/1000)+60,scopes:['mcp:read','stock:read']};},
   authorizePrincipal:async()=>({active:true,id:id(1),store:STORE,permissions:['stock:read'],customerIds:null}),createService:p=>createBusinessReadService({adapter:s.adapter,principal:p,now})});
  const req=token=>new Request(RESOURCE,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':PROTOCOL},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'vaidosa_stock_list',arguments:{}}})});
  const response=await handler(req('fixture-token')),data=await response.json();assert.equal(response.status,200);assert.equal(data.result.structuredContent.items.length,3);assert.equal((await handler(req('forged-token'))).status,401);
 });
 await t.test('reads do not mutate business rows or sequence; private sentinels do not reach output logs',async()=>{
  const fingerprint=()=>sql("select md5((select jsonb_agg(to_jsonb(t) order by id)::text from public.sales t)||(select jsonb_agg(to_jsonb(t) order by id)::text from public.products t)||(select jsonb_agg(to_jsonb(t) order by id)::text from public.contas t));select last_value,is_called from public.product_barcode_seq").stdout;
  const before=fingerprint(),s=await service(1);await s.service.call('vaidosa_sale_get',{saleId:id(40)});await s.service.call('vaidosa_accounts_list');await s.service.call('vaidosa_stock_list');assert.equal(fingerprint(),before);
  const log=fs.readFileSync('/scratch/postgres.log','utf8');assert.ok(!log.includes('PRIVATE_'));assert.ok(!log.includes('fixture-token'));
 });
 await t.test('real JOSE signatures from ephemeral keys bind all five PG reads and revoke cached identity',async()=>{
  const jose=await import('jose'),keys=await jose.generateKeyPair('ES256'),pub={...await jose.exportJWK(keys.publicKey),kid:'pg-test-key',alg:'ES256',use:'sig'};
  const jwt=await createLocalJwtVerifier({jose,issuer:ISSUER,resource:RESOURCE,publicKeys:[pub],maxTokenAgeSeconds:300,now});
  const claims=jti=>({iss:ISSUER,aud:RESOURCE,sub:id(1),jti,iat:Math.floor(now()/1000),exp:Math.floor(now()/1000)+60,scope:'mcp:read stock:read sales:read finance:read'});
  const sign=jti=>new jose.SignJWT(claims(jti)).setProtectedHeader({alg:'ES256',typ:'at+jwt',kid:pub.kid}).sign(keys.privateKey);
  const firstId=randomUUID(),token=await sign(firstId),authorizePrincipal=async()=>({active:true,id:id(1),store:STORE,permissions:policies[1].permissions,customerIds:null});
  const boundary=createIdentityBoundary({issuer:ISSUER,resource:RESOURCE,verifyAccessToken:jwt.verifyAccessToken,authorizePrincipal,now});
  const p=await boundary.authenticate(new Request(RESOURCE,{headers:{authorization:'Bearer '+token}})),s=await service(1,{},p);
  assert.equal((await s.service.call('vaidosa_stock_list')).items.length,3);assert.equal((await s.service.call('vaidosa_customer_orders',{customerId:id(10)})).items.length,2);
  assert.equal((await s.service.call('vaidosa_sale_get',{saleId:id(40)})).totalCents,10000);assert.equal((await s.service.call('vaidosa_accounts_list')).items.length,3);
  assert.equal((await s.service.call('vaidosa_receipts_summary',{from:'2026-11-01',to:'2026-11-30'})).receivedCents,30000);
  const handler=createStreamableHttpHandler({issuer:ISSUER,resource:RESOURCE,verifyAccessToken:jwt.verifyAccessToken,authorizePrincipal,now,createService:principal=>createBusinessReadService({adapter:s.adapter,principal,now})});
  const request=access=>new Request(RESOURCE,{method:'POST',headers:{authorization:'Bearer '+access,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':PROTOCOL},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'vaidosa_stock_list',arguments:{}}})});
  const first=await handler(request(token));assert.equal((await first.json()).result.isError,false);const before=s.calls();jwt.revokeToken(firstId);
  await assert.rejects(s.service.call('vaidosa_stock_list'));assert.equal((await handler(request(token))).status,401);assert.equal(s.calls(),before);
  const fresh=await handler(request(await sign(randomUUID())));assert.equal((await fresh.json()).result.structuredContent.items.length,3);
 });
 await require('./support/shared-revocation-cases.cjs')(t,{sql,file,now,id,service,ROOT,
  stopServer:async()=>{run(PG+'pg_ctl',['-D','/scratch/cluster','stop','-m','fast','-w','-t','5'],{db:'postgres',timeout:8000});server.kill('SIGTERM');},
  startServer:async()=>{server=launchServer();let started=false;for(let i=0;i<60;i++){if(run(PG+'pg_isready',['-q'],{db:'postgres',check:false,timeout:1000}).status===0){started=true;break;}await new Promise(r=>setTimeout(r,50));}assert.ok(started,'same private PostgreSQL cluster must restart');}
 });
 console.log('POSTGRES_MCP_TERMINAL '+JSON.stringify({source:SOURCE,store:STORE,postgres:sql('show server_version').stdout.trim(),production_access:false,real_identity:false,roles_ephemeral:true}));
});
