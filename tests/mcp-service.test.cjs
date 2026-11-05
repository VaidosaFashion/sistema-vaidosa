'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixtureAdapter, fixturePrincipal } = require('../mcp/fixture-adapter.cjs');
const { createReadService, InputError } = require('../mcp/service.cjs');
function service(role = 'manager', extras = {}) { return createReadService({ adapter: createFixtureAdapter(), principal: fixturePrincipal(role), ...extras }); }

test('MCP fixture tools are read-only and permission-filtered, not role arguments', () => {
  const manager = service(); const seller = service('seller');
  assert.equal(manager.listTools().length, 5); assert.equal(seller.listTools().length, 3);
  for (const tool of manager.listTools()) {
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.throws(() => seller.call('vaidosa_receipts_summary', { from: '2026-11-01', to: '2026-11-05' }), InputError);
  for (const extra of ['role', 'user_role', 'userId', 'store', 'sql', 'url', '__proto__']) {
    assert.throws(() => seller.call('vaidosa_stock_list', JSON.parse(`{"${extra}":"manager"}`)), InputError);
  }
  assert.throws(() => createReadService({ adapter: { mode: 'production' }, principal: fixturePrincipal('manager') }));
});
test('Variant stock remains separate and repeated reads do not mutate it', () => {
  const s = service(); const before = s.call('vaidosa_stock_list');
  assert.deepEqual(before.items.map(row => row.available), [1, 0, 8]);
  assert.deepEqual(s.call('vaidosa_stock_list'), before);
  assert.equal(before.items.some(row => row.productId === 'product_other1'), false);
  assert.equal(before.fixture, true);
});
test('Sales and customer queries enforce scope with uniform unavailable errors', () => {
  const s = service('seller');
  assert.equal(s.call('vaidosa_sale_get', { saleId: 'sale_demo01' }).totalCents, 11000);
  const denial = id => { try { s.call('vaidosa_sale_get', { saleId: id }); } catch (e) { return [e.toolCode, e.message]; } };
  assert.deepEqual(denial('sale_demo03'), denial('sale_none00'));
  assert.deepEqual(denial('sale_other1'), denial('sale_none00'));
  assert.throws(() => s.call('vaidosa_customer_orders', { customerId: 'customer_demo02' }), { toolCode: 'NOT_AVAILABLE' });
  assert.throws(() => s.call('vaidosa_customer_orders', { customerId: 'customer_other1' }), { toolCode: 'NOT_AVAILABLE' });
  const rows = s.call('vaidosa_customer_orders', { customerId: 'customer_demo01' }).items;
  assert.deepEqual(rows.map(row => row.saleId), ['sale_demo01', 'sale_demo02']);
});
test('Opaque pagination rejects tampering, scope changes, another session and expiration', () => {
  let time = 0; const s = service('manager', { now: () => time });
  const first = s.call('vaidosa_stock_list', { limit: 1 });
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]{32}$/);
  const second = s.call('vaidosa_stock_list', { limit: 1, cursor: first.nextCursor });
  assert.notEqual(second.items[0].productId, first.items[0].productId);
  const third = s.call('vaidosa_stock_list', { limit: 1, cursor: second.nextCursor });
  assert.equal(third.nextCursor, null);
  for (const args of [{ limit: 2, cursor: first.nextCursor }, { limit: 1, cursor: 'a'.repeat(32) }]) assert.throws(() => s.call('vaidosa_stock_list', args), { toolCode: 'INVALID_CURSOR' });
  assert.throws(() => s.call('vaidosa_accounts_list', { limit: 1, cursor: first.nextCursor }), { toolCode: 'INVALID_CURSOR' });
  assert.throws(() => service().call('vaidosa_stock_list', { limit: 1, cursor: first.nextCursor }), { toolCode: 'INVALID_CURSOR' });
  assert.throws(() => service('seller').call('vaidosa_stock_list', { limit: 1, cursor: first.nextCursor }), { toolCode: 'INVALID_CURSOR' });
  time = 600001;
  assert.throws(() => s.call('vaidosa_stock_list', { limit: 1, cursor: first.nextCursor }), { toolCode: 'INVALID_CURSOR' });
});
test('Argument boundaries reject invalid IDs, limits, dates and injected extra fields', () => {
  const s = service();
  for (const limit of [0, -1, 51, 1.2, '1', null]) assert.throws(() => s.call('vaidosa_stock_list', { limit }), InputError);
  for (const cursor of ['', 'a'.repeat(100000), 1]) assert.throws(() => s.call('vaidosa_stock_list', { cursor }), InputError);
  for (const saleId of ["';drop table sales;--", '../secret', 'https://example.test', 'sale_demo01\n', null]) assert.throws(() => s.call('vaidosa_sale_get', { saleId }), InputError);
  for (const dates of [{ from: '2026-02-30', to: '2026-03-01' }, { from: '2026-11-04', to: '2026-11-03' }, { from: '2020-01-01', to: '2026-11-04' }]) assert.throws(() => s.call('vaidosa_receipts_summary', dates), InputError);
});
test('Receipts use paid_on and integer cents, excluding manual accounts and other stores', () => {
  const s = service();
  const one = s.call('vaidosa_receipts_summary', { from: '2026-11-03', to: '2026-11-03' });
  assert.equal(one.count, 1); assert.equal(one.receivedCents, 4000);
  const all = s.call('vaidosa_receipts_summary', { from: '2026-11-01', to: '2026-11-05' });
  assert.equal(all.receivedCents, 15000); assert.equal(all.netCents, 15000);
  assert.equal(all.sourceDomain, 'sale_payments'); assert.deepEqual(all.excludes, ['manual_accounts', 'bank_reconciliation']);
  assert.equal(s.call('vaidosa_accounts_list', { kind: 'payable' }).items.length, 1);
});
test('Output allowlist excludes private adapter fields and raw financial notes', () => {
  const base = createFixtureAdapter();
  const adapter = { ...base, getSale(...args) { return { ...base.getSale(...args), buyer_cpf_nfce: 'PRIVATE_MARKER', email: 'PRIVATE_MARKER', phone: 'PRIVATE_MARKER', note: 'PRIVATE_MARKER', secret: 'PRIVATE_MARKER' }; } };
  const s = service('manager', { adapter });
  const result = s.call('vaidosa_sale_get', { saleId: 'sale_demo01' });
  assert.equal(JSON.stringify(result).includes('PRIVATE_MARKER'), false);
  assert.deepEqual(Object.keys(result).sort(), ['fixture', 'contractVersion', 'currency', 'saleId', 'customerId', 'soldOn', 'status', 'grossCents', 'discountCents', 'totalCents', 'items'].sort());
});
