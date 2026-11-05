'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {create} = require('../modules/operation-journal.js');
function storage() { const values = new Map(); return {values,getItem:k=>values.has(k)?values.get(k):null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}; }
function locks() { const held = new Set(); return {request:async(key,options,fn)=> { assert.equal(options.ifAvailable,true); if(held.has(key))return fn(null); held.add(key);try{return await fn({name:key});}finally{held.delete(key);} }}; }
function context(overrides={}) {return create({storage:storage(),locks:locks(),projectId:'fixture-project',userId:'fixture-user',area:'accounts',...overrides});}
test('journal scope isolates account, project and module with verified JSON copies',()=>{
  const s=storage(),a=context({storage:s}),b=context({storage:s,userId:'second'}),c=context({storage:s,projectId:'other'}),d=context({storage:s,area:'stock'});
  const record={requestId:'one',args:{value:10}};a.journal.write(record);record.args.value=20;
  assert.deepEqual(a.journal.read(),{requestId:'one',args:{value:10}});
  const read=a.journal.read();read.args.value=30;assert.equal(a.journal.read().args.value,10);
  assert.equal(b.journal.read(),null);assert.equal(c.journal.read(),null);assert.equal(d.journal.read(),null);
});
test('journal rejects cross-scope copies and corruption without deleting evidence',()=>{
  const s=storage(),a=context({storage:s}),b=context({storage:s,userId:'second'});a.journal.write({requestId:'one'});
  s.setItem(b.key,s.getItem(a.key));assert.throws(()=>b.journal.read(),{code:'JOURNAL_CORRUPT'});assert.ok(s.getItem(b.key));
  s.setItem(a.key,'broken');assert.throws(()=>a.journal.read(),{code:'JOURNAL_CORRUPT'});assert.equal(s.getItem(a.key),'broken');
});
test('journal refuses secrets, personal identifier fields, unsupported values and oversized records',()=>{
  const a=context();
  for(const record of [{cpf:'fake'},{args:{access_token:'fake'}},{undefinedValue:undefined},{n:NaN},{n:Infinity},{x:()=>{}},{x:new Date()}])assert.throws(()=>a.journal.write(record));
  assert.throws(()=>a.journal.write({x:'a'.repeat(100000)}),{code:'JOURNAL_TOO_LARGE'});
  assert.equal(a.journal.read(),null);
});
test('journal does not expire uncertain operations; clear verifies expected identifier',()=>{
  const a=context();a.journal.write({requestId:'one',createdAt:'2000-01-01T00:00:00Z',status:'uncertain'});
  assert.equal(a.journal.read().status,'uncertain');assert.throws(()=>a.journal.clear('two'),{code:'JOURNAL_CONFLICT'});
  a.journal.clear('one');assert.equal(a.journal.read(),null);
});
test('failed or silent storage writes are not accepted',()=>{
  const s=storage(),a=context({storage:s});s.setItem=()=>{};
  assert.throws(()=>a.journal.write({requestId:'one'}),{code:'JOURNAL_WRITE'});
  s.setItem=()=>{throw Error('quota');};assert.throws(()=>a.journal.write({requestId:'one'}),{code:'JOURNAL_WRITE'});
  s.getItem=()=>{throw Error('disabled');};assert.throws(()=>a.journal.read(),{code:'JOURNAL_READ'});
});
test('failed clear preserves a detectable record',()=>{
  const s=storage(),a=context({storage:s});a.journal.write({requestId:'one'});s.removeItem=()=>{};
  assert.throws(()=>a.journal.clear('one'),{code:'JOURNAL_CLEAR'});assert.ok(a.journal.read());
});
test('cross-tab lock serializes writers, fails safely when unavailable and releases on failure',async()=>{
  const s=storage(),l=locks(),a=context({storage:s,locks:l}),b=context({storage:s,locks:l});
  let unblock;const gate=new Promise(r=>unblock=r);const first=a.withLock(async()=>{await gate;return 1;});
  await assert.rejects(b.withLock(()=>2),{code:'LOCK_BUSY'});unblock();assert.equal(await first,1);
  await assert.rejects(a.withLock(()=>{throw Error('failure');}),/failure/);assert.equal(await b.withLock(()=>2),2);
  assert.throws(()=>context({locks:null}),{code:'LOCK_UNAVAILABLE'});
});
