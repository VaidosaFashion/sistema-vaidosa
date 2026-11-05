'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const domain = require('../modules/accounts-domain.js');
const id='00000000-0000-4000-8000-000000000001', request='00000000-0000-4000-8000-000000000002';
const account={id,status:'ativo',operation_revision:0,cliente_id:id};
test('settlement preserves explicit UUID, date and revision across retry',()=>{
  assert.deepEqual(domain.settleRequest(account,request,'2026-01-31'),domain.settleRequest(account,request,'2026-01-31'));
  assert.ok(Object.isFrozen(domain.settleRequest(account,request,'2026-01-31')));
  assert.throws(()=>domain.settleRequest({...account,status:'concluido'},request,'2026-01-31'));
  assert.throws(()=>domain.settleRequest({...account,archived_at:'2026-01-31'},request,'2026-01-31'));
});
test('unknown revision and malformed dates fail before sending',()=>{
  for(const value of [null,undefined,-1,1.5,'',Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>domain.revisionOf({...account,operation_revision:value}));
  for(const value of ['2026-02-29','2026-02-30','2026-13-01','01/01/2026','2026-01-01T00:00:00Z','0000-01-01']) assert.throws(()=>domain.requireDate(value));
  assert.equal(domain.requireDate('2028-02-29'),'2028-02-29');
});
test('decimal values reject rounding, zero, infinity and numeric overflow',()=>{
  assert.equal(domain.moneyToCents('3600.00'),360000);
  assert.equal(domain.moneyToCents(0.29),29);
  for(const value of [0,-1,NaN,Infinity,'','1e2','1,20','1.001',100000000,null,1.001]) assert.throws(()=>domain.moneyToCents(value));
});
test('editing value does not clear client; clearing is explicit',()=>{
  const update=domain.editRequest(account,request,{valor:'3600.00'});
  assert.deepEqual(update.p_changes,{valor:3600});
  assert.equal(account.cliente_id,id);
  assert.deepEqual(domain.editRequest(account,request,{cliente_id:null}).p_changes,{cliente_id:null});
  assert.throws(()=>domain.editRequest(account,request,{cliente_id:undefined}));
  assert.throws(()=>domain.editRequest(account,request,{status:'concluido'}));
});
test('reversal stays in history but never counts as effective money',()=>{
  assert.equal(domain.isEffectiveMovement({pago:true}),true);
  assert.equal(domain.isEffectiveMovement({pago:true,reversed_at:'2026-01-31'}),false);
  assert.equal(domain.isEffectiveMovement({pago:false}),false);
});
