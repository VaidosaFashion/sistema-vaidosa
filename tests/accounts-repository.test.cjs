'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createController}=require('../modules/accounts-repository.js');
const {create}=require('../modules/operation-journal.js');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const request={operation:'settle_account',args:{p_account_id:id(1),p_expected_revision:0,p_paid_on:'2026-11-05'}};
function harness(options={}){
  const values=new Map(),calls=[],completed=new Map();let seq=10,locked=false,first=true;
  const storage={getItem:k=>values.has(k)?values.get(k):null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const locks={request:async(_,__,fn)=>{if(locked)return fn(null);locked=true;try{return await fn({});}finally{locked=false;}}};
  const scoped=create({storage,locks,projectId:'fixture',userId:'fixture-user',area:'accounts'});
  const client={rpc:async(name,payload)=>{
    calls.push({name,payload:structuredClone(payload)});
    assert.ok(scoped.journal.read(),'must be persisted before even lookup');
    if(name==='get_account_request_status'){
      if(options.lookupError)throw Error('lookup unavailable');
      assert.equal(payload.p_expected_payload.p_request_id,payload.p_request_id);
      if(completed.has(payload.p_request_id))return {data:{status:'completed',result:completed.get(payload.p_request_id)},error:null};
      return {data:{status:'not_found'},error:null};
    }
    if(options.reject)return {data:null,error:{code:options.reject,message:'Rejected fixture'}};
    if(options.transportBefore)throw Error('transport before known response');
    const result={account:{id:payload.p_account_id||id(3),operation_revision:1,status:'concluido'},movement:{id:id(4)},replayed:false};
    completed.set(payload.p_request_id,result);
    if(options.lostResponse&&first){first=false;throw Error('lost response after commit');}
    return {data:result,error:null};
  }};
  const newController=()=>createController({client,...scoped,createId:()=>id(seq++)});
  return {controller:newController(),newController,scoped,storage,calls,completed,options};
}
test('durable request is frozen before RPC; acknowledgment releases only completed result',async()=>{
  const h=harness(),c=h.controller;assert.equal((await c.ready()).status,'idle');assert.equal(h.calls.length,0);
  const result=await c.submit(request);assert.equal(result.ok,true);assert.equal(result.status,'completed');
  assert.deepEqual(h.calls.map(c=>c.name),['get_account_request_status','settle_account']);
  const stored=h.scoped.journal.read();assert.equal(stored.status,'completed');assert.equal(stored.result,undefined);
  assert.ok(Object.isFrozen(c.getState().request.args));assert.equal((await c.acknowledge()).ok,true);assert.equal(h.scoped.journal.read(),null);
});
test('lost response is resolved by lookup without a second settlement',async()=>{
  const h=harness({lostResponse:true});const result=await h.controller.submit(request);
  assert.equal(result.ok,true);assert.equal(h.calls.filter(c=>c.name==='settle_account').length,1);
  assert.equal(h.calls.filter(c=>c.name==='get_account_request_status').length,2);
});
test('reload performs no automatic RPC; explicit retry checks same ID and returns existing result',async()=>{
  const h=harness();await h.controller.submit(request);const saved=h.scoped.journal.read(),count=h.calls.length,c=h.newController();
  assert.equal((await c.ready()).status,'completed');assert.equal(h.calls.length,count);assert.equal((await c.acknowledge()).ok,false);
  assert.equal((await c.retry()).ok,true);assert.equal(h.calls.at(-1).payload.p_request_id,saved.requestId);
  assert.equal(h.calls.filter(c=>c.name==='settle_account').length,1);assert.equal((await c.acknowledge()).ok,true);
});
test('uncertain request blocks changed payload and discard, retry retains ID and original payload',async()=>{
  const h=harness({transportBefore:true});const result=await h.controller.submit(request);assert.equal(result.status,'uncertain');
  const pending=h.scoped.journal.read(),count=h.calls.length;
  assert.equal((await h.controller.submit({...request,args:{...request.args,p_expected_revision:1}})).ok,false);
  assert.equal(h.calls.length,count);assert.equal((await h.controller.discardRejected()).ok,false);
  h.options.transportBefore=false;assert.equal((await h.controller.retry()).ok,true);
  const attempts=h.calls.filter(c=>c.name==='settle_account');assert.equal(attempts.length,2);assert.deepEqual(attempts[0].payload,attempts[1].payload);
  assert.equal(attempts[1].payload.p_request_id,pending.requestId);
});
test('specific SQL rejection requires successful lookup before explicit discard',async()=>{
  const h=harness({reject:'23514'});assert.equal((await h.controller.submit(request)).status,'rejected');
  const count=h.calls.length;assert.equal((await h.controller.submit(request)).ok,false);assert.equal(h.calls.length,count);
  h.options.lookupError=true;assert.equal((await h.controller.discardRejected()).ok,false);assert.ok(h.scoped.journal.read());
  h.options.lookupError=false;assert.equal((await h.controller.discardRejected()).ok,true);assert.equal(h.scoped.journal.read(),null);
  h.options.reject=null;assert.equal((await h.controller.submit(request)).ok,true);assert.notEqual(h.calls[1].payload.p_request_id,h.calls.at(-1).payload.p_request_id);
});
test('P0001 and unreadable status remain uncertain; absence alone never proves rejection',async()=>{
  const a=harness({reject:'P0001'});assert.equal((await a.controller.submit(request)).status,'uncertain');assert.equal((await a.controller.discardRejected()).ok,false);
  const b=harness({lookupError:true});assert.equal((await b.controller.submit(request)).status,'uncertain');assert.equal(b.calls.filter(c=>c.name==='settle_account').length,0);
});
test('a rejection on a later retry cannot erase uncertainty from an earlier attempt',async()=>{
  const h=harness({transportBefore:true});assert.equal((await h.controller.submit(request)).status,'uncertain');
  h.options.transportBefore=false;h.options.reject='23514';assert.equal((await h.controller.retry()).status,'uncertain');
  assert.equal((await h.controller.discardRejected()).ok,false);assert.ok(h.scoped.journal.read());
});
test('a completed request missing on lookup is never submitted again',async()=>{
  const h=harness();await h.controller.submit(request);h.completed.clear();
  assert.equal((await h.newController().retry()).status,'uncertain');assert.equal(h.calls.filter(c=>c.name==='settle_account').length,1);
});
test('stale revision is a known rejected transaction only with conclusive not_found lookup',async()=>{
  const h=harness({reject:'40001'});const rejected=await h.controller.submit(request);assert.equal(rejected.status,'rejected');
  assert.equal((await h.controller.discardRejected()).ok,true);h.options.reject=null;
  const next=await h.controller.submit({...request,args:{...request.args,p_expected_revision:1}});
  assert.equal(next.ok,true);assert.notEqual(next.requestId,rejected.requestId);assert.equal(h.calls.at(-1).payload.p_expected_revision,1);
});
test('missing account SQL response can be released only after confirming no request applied',async()=>{
  const h=harness({reject:'P0002'});assert.equal((await h.controller.submit(request)).status,'rejected');assert.equal((await h.controller.discardRejected()).ok,true);
});
test('known completion survives a crash while rechecking its result',async()=>{
  const h=harness();await h.controller.submit(request);const record=h.scoped.journal.read();
  h.scoped.journal.write({...record,status:'checking'});h.completed.clear();
  assert.equal((await h.newController().retry()).status,'uncertain');assert.equal(h.calls.filter(c=>c.name==='settle_account').length,1);
});
test('simultaneous controllers respect the shared lock before reading or creating another request',async()=>{
  const h=harness();let release;const gate=new Promise(resolve=>release=resolve);
  const holder=h.scoped.withLock(()=>gate);const result=await h.controller.submit(request);
  assert.equal(result.ok,false);assert.equal(h.calls.length,0);assert.equal(h.scoped.journal.read(),null);release();await holder;
  assert.equal((await h.controller.submit(request)).ok,true);
});
test('quota or failed persistence prevents every RPC and frozen input is unaffected by caller mutation',async()=>{
  const h=harness();h.storage.setItem=()=>{throw Error('quota');};assert.equal((await h.controller.submit(request)).ok,false);assert.equal(h.calls.length,0);
  const other=harness({transportBefore:true}),input=structuredClone(request);await other.controller.submit(input);input.args.p_paid_on='2099-01-01';
  assert.equal(other.scoped.journal.read().args.p_paid_on,'2026-11-05');
});
test('two controllers sharing journal cannot turn a completed unacknowledged request into another operation',async()=>{
  const h=harness(),second=h.newController();await h.controller.submit(request);
  const result=await second.submit({operation:'archive_account',args:{p_account_id:id(1),p_expected_revision:1,p_reason:'Fixture'}});
  assert.equal(result.ok,false);assert.equal(h.calls.filter(c=>c.name==='archive_account').length,0);
  assert.equal((await second.submit(request)).ok,true);assert.equal(h.calls.filter(c=>c.name==='settle_account').length,1);
});
test('only whitelisted operations/signatures are allowed, with request ID owned by controller',async()=>{
  const h=harness();
  for(const input of [{operation:'delete_sale',args:{}},{operation:'settle_account',args:{}},{...request,args:{...request.args,p_request_id:id(99)}},{...request,args:{...request.args,p_expected_revision:-1}}])assert.equal((await h.controller.submit(input)).ok,false);
  assert.equal(h.calls.length,0);assert.equal(h.scoped.journal.read(),null);
});
test('create, edit, archive, and reversal preserve exact allowed payloads',async()=>{
  const cases=[
    {operation:'create_account_v2',args:{p_values:{tipo:'receber',descricao:'Fixture',valor:10,cliente_id:id(2)}}},
    {operation:'edit_account',args:{p_account_id:id(1),p_expected_revision:0,p_changes:{descricao:'Fixture'}}},
    {operation:'archive_account',args:{p_account_id:id(1),p_expected_revision:0,p_reason:'Fixture'}},
    {operation:'reverse_account_settlement',args:{p_account_id:id(1),p_expected_revision:0,p_movement_id:id(4),p_reason:'Fixture'}}
  ];
  for(const input of cases){const h=harness();assert.equal((await h.controller.submit(input)).ok,true);const {p_request_id,...args}=h.calls[1].payload;assert.ok(p_request_id);assert.deepEqual(args,input.args);}
});
test('malformed journal is never sent or silently deleted',async()=>{
  const h=harness();h.scoped.journal.write({version:1,kind:'account-operation',requestId:id(10),operation:'unknown',args:{},status:'uncertain'});
  assert.equal((await h.controller.ready()).status,'error');assert.equal((await h.controller.retry()).ok,false);assert.equal(h.calls.length,0);assert.ok(h.scoped.journal.read());
});
