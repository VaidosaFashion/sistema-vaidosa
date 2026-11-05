const test = require('node:test');
const assert = require('node:assert/strict');
const {createController} = require('../modules/stock-repository.js');
const productId = '00000000-0000-4000-8000-000000000001';
const requestId = '00000000-0000-4000-8000-000000000010';
const request2 = '00000000-0000-4000-8000-000000000011';
const input = {productId,qty:2,type:'ENTRADA',note:'Fixture',newCost:null};
const copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
function fixture() {
  let saved = null, serial = Promise.resolve(), nextId = requestId;
  const events = [], entries = new Map();
  let stock = 3;
  const journal = {read:async()=>copy(saved),write:async r=>{saved=copy(r);events.push('persist:'+r.phase);},clear:async()=>{saved=null;}};
  const withLock = fn => { const run = serial.then(fn); serial=run.catch(()=>{}); return run; };
  const client = {rpc:async(name,args)=>{
    events.push(name);
    if(name==='get_stock_entry_request') return {data:entries.get(args.p_request_id) || {status:'not_found',request_id:args.p_request_id},error:null};
    assert.equal(name,'apply_stock_entry_v2');
    assert.equal(saved.requestId,args.p_request_id);
    assert.equal(saved.phase,'submitting');
    if(!entries.has(args.p_request_id)) {
      stock+=args.p_qty;
      entries.set(args.p_request_id,{status:'applied',request_id:args.p_request_id,product:{id:productId,stock},move:{id:'move',qty:args.p_qty},product_deleted:false});
    }
    return {data:entries.get(args.p_request_id),error:null};
  }};
  const options = {client,createId:()=>nextId,journal,withLock};
  return {options,client,journal,events,entries,controller:()=>createController(options),get saved(){return copy(saved);},get stock(){return stock;},setNextId:id=>{nextId=id;}};
}
test('requires injected durable journal and cross-tab lock; has no fallback client.from', () => {
  assert.throws(()=>createController({client:{rpc(){}},createId:()=>requestId}),{code:'SETUP_REQUIRED'});
});
test('ready reports restored state without leaving the UI busy', async () => {
  const f=fixture(),c=f.controller();
  assert.deepEqual(await c.ready(),{busy:false,status:'idle',pending:null});
  assert.equal(c.getState().busy,false);
});
test('persists and verifies frozen payload before mutation; repeated save applies once', async () => {
  const f=fixture(), c=f.controller();
  assert.equal((await c.submit(input)).ok,true);
  assert.equal((await c.submit(input)).ok,true);
  assert.equal(f.stock,5);
  assert.deepEqual(f.events.slice(0,4),['persist:prepared','get_stock_entry_request','persist:submitting','apply_stock_entry_v2']);
  assert.equal(f.events.filter(x=>x==='apply_stock_entry_v2').length,1);
  assert.equal(c.getState().status,'applied');
});
test('two consecutive independent entries get distinct IDs after confirmed acknowledgment', async () => {
  const f=fixture(),c=f.controller();
  await c.submit(input); await c.acknowledge(); f.setNextId(request2);
  const second=await c.submit(input);
  assert.equal(second.requestId,request2); assert.equal(f.stock,7); assert.equal(f.entries.size,2);
});
test('storage write failure and readback mismatch prevent every mutating call', async () => {
  for(const behavior of ['throw','mismatch']) {
    const f=fixture(); f.journal.write=async()=>{if(behavior==='throw')throw new Error('quota');};
    await assert.rejects(f.controller().submit(input));
    assert.equal(f.events.filter(x=>x==='apply_stock_entry_v2').length,0);
  }
});
test('failure to persist submitting phase prevents RPC after prepared record', async () => {
  const f=fixture(),original=f.journal.write;
  f.journal.write=async r=>{if(r.phase==='submitting')throw new Error('quota');return original(r);};
  assert.equal((await f.controller().submit(input)).ok,false);
  assert.equal(f.saved.requestId,requestId); assert.equal(f.stock,3);
});
test('network failure after server commit is resolved by lookup without duplication', async () => {
  const f=fixture(),rpc=f.client.rpc;
  f.client.rpc=async(name,args)=>{const result=await rpc(name,args);if(name==='apply_stock_entry_v2')throw new Error('connection closed');return result;};
  const result=await f.controller().submit(input);
  assert.equal(result.ok,true);assert.equal(f.stock,5);
});
test('uncertain uncommitted request survives reload; retry queries then uses the SAME ID', async () => {
  const f=fixture(),rpc=f.client.rpc; let fail=true;
  f.client.rpc=async(name,args)=>{if(name==='apply_stock_entry_v2'&&fail)throw new Error('timeout');return rpc(name,args);};
  const c=f.controller();assert.equal((await c.submit(input)).status,'uncertain');
  await assert.rejects(c.discardRejected(),{code:'NOT_REJECTED'});
  await assert.rejects(c.submit({...input,qty:3}),{code:'PENDING_REQUEST'});
  fail=false;f.setNextId(request2);
  const restored=f.controller();assert.equal((await restored.retry()).requestId,requestId);assert.equal(f.stock,5);
});
test('failed status lookup never permits a blind resend', async () => {
  const f=fixture();f.client.rpc=async()=>({data:null,error:{code:'PGRST202',message:'Function unavailable'}});
  const result=await f.controller().submit(input);
  assert.equal(result.status,'uncertain');assert.equal(f.stock,3);assert.equal(f.saved.attempted,false);
});
test('known first SQL rejection plus absent lookup permits explicit discard only', async () => {
  const f=fixture(),rpc=f.client.rpc;
  f.client.rpc=async(name,args)=>name==='apply_stock_entry_v2'?{data:null,error:{code:'23514',message:'Estoque insuficiente'}}:rpc(name,args);
  const c=f.controller();assert.equal((await c.submit(input)).status,'rejected');
  assert.equal(f.saved.requestId,requestId); await c.discardRejected();assert.equal(f.saved,null);
});
test('generic error or later rejection after uncertainty never releases the frozen ID', async () => {
  for(const first of ['P0001','23514']) {
    const f=fixture(),rpc=f.client.rpc;let attempts=0;
    f.client.rpc=async(name,args)=>{
      if(name==='apply_stock_entry_v2') {attempts++;if(attempts===1&&first==='23514')throw new Error('timeout');return {data:null,error:{code:first,message:'error'}};}
      return rpc(name,args);
    };
    const c=f.controller();assert.equal((await c.submit(input)).status,'uncertain');
    assert.equal((await c.retry()).status,'uncertain');
    await assert.rejects(c.discardRejected(),{code:'NOT_REJECTED'});assert.equal(f.saved.requestId,requestId);
  }
});
test('acknowledgment checks server and does not clear unconfirmed request', async () => {
  const f=fixture(),rpc=f.client.rpc;
  f.client.rpc=async(name,args)=>name==='apply_stock_entry_v2'?Promise.reject(new Error('timeout')):rpc(name,args);
  const c=f.controller();await c.submit(input);await assert.rejects(c.acknowledge(),{code:'NOT_CONFIRMED'});assert.ok(f.saved);
});
test('two controllers sharing journal+cross-tab lock do not double-apply', async () => {
  const f=fixture(),a=f.controller(),b=f.controller();
  const results=await Promise.all([a.submit(input),b.submit(input)]);
  assert.ok(results.every(r=>r.ok));assert.equal(f.stock,5);assert.equal(f.entries.size,1);
});
test('a second tab cannot overwrite the first tab pending payload', async () => {
  const f=fixture(),a=f.controller(),b=f.controller();
  const results=await Promise.allSettled([a.submit(input),b.submit({...input,qty:8})]);
  assert.equal(results[0].status,'fulfilled');assert.equal(results[1].reason.code,'PENDING_REQUEST');
  assert.equal(f.stock,5);assert.equal(f.saved.payload.qty,2);
});
test('payload changes and mutation of exposed state cannot change pending submission', async () => {
  const f=fixture(),c=f.controller();await c.submit(input);
  c.getState().pending.payload.qty=40;
  await assert.rejects(c.submit({...input,qty:4}),{code:'PENDING_REQUEST'});
  assert.equal(c.getState().pending.payload.qty,2);
});
test('applied request with deleted product is confirmed, never recreated', async () => {
  const f=fixture(),c=f.controller();await c.submit(input);
  f.entries.set(requestId,{status:'applied',request_id:requestId,product:null,product_deleted:true,move:{id:'move'}});
  const again=await f.controller().retry();assert.equal(again.result.product_deleted,true);assert.equal(f.stock,5);
});
test('malformed persisted state fails closed without remote access', async () => {
  const f=fixture();await f.journal.write({version:999});
  await assert.rejects(f.controller().retry(),{code:'INVALID_JOURNAL'});assert.equal(f.events.filter(x=>x.startsWith('get_')).length,0);
});
test('an applied journal record missing from server stays blocked even if lookup is absent', async () => {
  const f=fixture(),c=f.controller();await c.submit(input);f.entries.clear();
  const result=await c.retry();assert.equal(result.status,'uncertain');assert.equal(f.stock,5);
});
