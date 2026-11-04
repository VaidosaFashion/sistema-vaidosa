'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { DraftStore, DraftStoreError, TTL_MS, MAX_ITEMS } = require('../cart-draft-store.js');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clone = value => JSON.parse(JSON.stringify(value));
const scope = { store: 'test-store.supabase.co', userId: id(1) };
function fixture(options = {}) {
  const rows = new Map();
  const storage = {
    failRead: false, failWrite: false, failRemove: false, changeWrite: false,
    getItem(key) { if (this.failRead) throw Error('unavailable'); return rows.get(key) ?? null; },
    setItem(key, value) {
      if (this.failWrite) throw Error('quota');
      rows.set(key, this.changeWrite ? 'corrupt' : value);
    },
    removeItem(key) { if (this.failRemove) throw Error('unavailable'); rows.delete(key); }
  };
  let time = 1000, sequence = 10;
  const config = { storage, scope, now: () => time, uuid: () => id(sequence++), ...options };
  return { storage, rows, store: new DraftStore(config), config, tick: ms => { time += ms; } };
}
function draft(overrides = {}) {
  return { items: [{ productId: id(2), qty: 3 }], clientId: id(3), vendedorId: null,
    channel: 'Loja', kind: 'Venda', priceTier: 'Atacado', discount: 0.29, overrideTroca: false, ...overrides };
}
function payload(input = draft(), extra = {}) {
  return { p_client_id: input.clientId, p_vendedor_id: input.vendedorId,
    p_channel: input.channel, p_kind: input.kind, p_pay: 'Pendente', p_installments: 0,
    p_discount: input.discount, p_note: null,
    p_items: input.items.map(i => ({ product_id: i.productId, qty: i.qty })), p_price_tier: input.priceTier, ...extra };
}
const evidence = { code: '23514', constraint: 'sales_pay_check', verifiedAbsent: true, firstAttemptInThisPage: true };
function code(expected) { return error => error instanceof DraftStoreError && error.code === expected; }

test('UMD installs browser namespace without CommonJS and exports frozen scope', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../cart-draft-store.js'), 'utf8'), context);
  assert.equal(typeof context.VaidosaCartDrafts.DraftStore, 'function');
  const { store } = fixture();
  assert.deepEqual(store.scope, scope);
  assert.throws(() => { store.scope.userId = id(99); }, TypeError);
});

test('only allowlisted IDs/quantities/options persist; empty cart overwrites old items', () => {
  const { store, rows } = fixture();
  const input = draft({ note: 'private note', cpf: '00000000000', name: 'private name' });
  input.items[0].name = 'private product'; input.items[0].price = 123;
  input.toJSON = () => ({ cpf: 'leak' });
  store.saveDraft(input);
  assert.deepEqual(store.get().draft, draft());
  assert.doesNotMatch(rows.get(store.key), /private|cpf|name|price":|toJSON/);
  store.saveDraft(draft({ items: [] }));
  assert.deepEqual(store.get().draft.items, []);
  assert.throws(() => store.prepare(payload(draft({ items: [] }))), code('INVALID_DATA'));
});

test('accounts and store hostnames use separate keys and reject copied scope', () => {
  const a = fixture(); a.store.saveDraft(draft());
  const b = new DraftStore({ ...a.config, scope: { ...scope, userId: id(9) } });
  const c = new DraftStore({ ...a.config, scope: { ...scope, store: 'other.supabase.co' } });
  assert.notEqual(a.store.key, b.key); assert.notEqual(a.store.key, c.key);
  assert.equal(b.get().status, 'empty'); assert.equal(c.get().status, 'empty');
  a.rows.set(b.key, a.rows.get(a.store.key));
  assert.equal(b.get().status, 'corrupt');
  assert.throws(() => b.discard(), code('CORRUPT'));
});

test('draft expires at seven days; review restores explicitly and pending never expires', () => {
  const f = fixture(); f.store.saveDraft(draft()); const before = f.rows.get(f.store.key);
  f.tick(TTL_MS);
  assert.equal(f.store.get().status, 'expired'); assert.equal(f.rows.get(f.store.key), before);
  assert.throws(() => f.store.prepare(payload()), code('EXPIRED'));
  assert.throws(() => f.store.saveDraft(draft()), code('EXPIRED'));
  assert.equal(f.store.restoreExpired().status, 'draft');
  const request = f.store.prepare(payload()); f.tick(TTL_MS * 20);
  const pending = new DraftStore(f.config).get();
  assert.equal(pending.status, 'pending'); assert.equal(pending.aged, true);
  assert.deepEqual(pending.request, request);
  assert.throws(() => f.store.discard(), code('PENDING'));
});

test('prepare persists exact request first; UUID and deeply frozen payload survive reload/retry', () => {
  const f = fixture(); const input = payload(); f.store.saveDraft(draft());
  const request = f.store.prepare(input);
  const serialized = f.rows.get(f.store.key);
  assert.deepEqual(JSON.parse(serialized).request, request);
  input.p_items[0].qty = 100;
  assert.equal(request.p_items[0].qty, 3);
  assert.throws(() => { request.p_items[0].qty = 100; }, TypeError);
  assert.throws(() => request.p_items.push({}), TypeError);
  assert.deepEqual(f.store.prepare(payload()), request);
  const recovered = new DraftStore(f.config);
  assert.deepEqual(recovered.get().request, request);
  assert.deepEqual(recovered.prepare(payload()), request);
  assert.equal(f.rows.get(f.store.key), serialized);
  assert.throws(() => recovered.saveDraft(draft()), code('PENDING'));
  assert.throws(() => recovered.reset(), code('PENDING'));
  assert.throws(() => recovered.prepare(payload(draft({ discount: 1 }))), code('PENDING'));
});

test('prepare must match saved draft and rejects private note/noncanonical payment', () => {
  const f = fixture(); f.store.saveDraft(draft());
  assert.throws(() => f.store.prepare(payload(draft({ discount: 5 }))), code('DRAFT_MISMATCH'));
  assert.throws(() => f.store.prepare(payload(draft(), { p_note: 'do not store' })), code('NOTE_NOT_ALLOWED'));
  assert.throws(() => f.store.prepare(payload(draft(), { p_pay: 'PIX' })), code('INVALID_DATA'));
  assert.throws(() => f.store.prepare(payload(draft(), { p_installments: 1 })), code('INVALID_DATA'));
  const request = f.store.prepare(payload(draft(), { buyer_cpf_nfce: '00000000000', personName: 'private' }));
  assert.equal(request.p_note, null);
  assert.doesNotMatch(f.rows.get(f.store.key), /buyer_cpf|personName|private/);
});

test('storage write failure blocks prepare and retry keeps same UUID without allowing edits', () => {
  const f = fixture(); f.store.saveDraft(draft()); const original = f.rows.get(f.store.key);
  f.storage.failWrite = true;
  assert.throws(() => f.store.prepare(payload()), code('STORAGE_WRITE'));
  assert.equal(f.rows.get(f.store.key), original);
  assert.equal(f.store.get().status, 'corrupt');
  assert.throws(() => f.store.saveDraft(draft({ discount: 2 })), code('CORRUPT'));
  f.storage.failWrite = false;
  const request = f.store.prepare(payload());
  assert.equal(request.p_client_request_id, id(10));
  assert.throws(() => f.store.rejectKnown(request.p_client_request_id, evidence), code('REJECTION_UNPROVEN'));
});

test('failed readback blocks send; read recovery finds durable pending rather than new UUID', () => {
  const f = fixture();
  const set = f.storage.setItem;
  f.storage.setItem = function (key, value) { set.call(this, key, value); this.failRead = true; };
  assert.throws(() => f.store.prepare(payload()), code('STORAGE_READ'));
  f.storage.failRead = false; f.storage.setItem = set;
  assert.equal(f.store.get().status, 'pending');
  assert.equal(f.store.prepare(payload()).p_client_request_id, id(10));
  assert.throws(() => f.store.rejectKnown(id(10), evidence), code('REJECTION_UNPROVEN'));
});

test('nonmatching readback fails closed without silently replacing corrupted data', () => {
  const f = fixture(); f.storage.changeWrite = true;
  assert.throws(() => f.store.prepare(payload()), code('STORAGE_VERIFY'));
  f.storage.changeWrite = false;
  assert.equal(f.store.get().status, 'corrupt');
  assert.throws(() => f.store.prepare(payload()), code('CORRUPT'));
  assert.equal(f.rows.get(f.store.key), 'corrupt');
});

test('confirmation requires matching request, persists minimal tombstone, and can repeat', () => {
  const f = fixture(); const request = f.store.prepare(payload());
  assert.throws(() => f.store.confirmed({ id: id(50), client_request_id: id(99) }), code('CONFIRMATION_MISMATCH'));
  const result = f.store.confirmed({ id: id(50), client_request_id: request.p_client_request_id, cpf: 'discard' });
  assert.equal(result.status, 'confirmed');
  const stored = JSON.parse(f.rows.get(f.store.key));
  assert.deepEqual(Object.keys(stored).sort(), ['confirmedAt', 'sale', 'scope', 'status', 'version']);
  assert.deepEqual(Object.keys(stored.sale).sort(), ['client_request_id', 'id']);
  assert.deepEqual(f.store.confirmed(result.sale), result);
  const terminal = f.rows.get(f.store.key);
  assert.throws(() => f.store.saveDraft(draft()), code('CONFIRMED'));
  assert.throws(() => new DraftStore(f.config).saveDraft(draft()), code('CONFIRMED'));
  assert.equal(f.rows.get(f.store.key), terminal, 'confirmed marker remains intact until explicit reset');
  assert.throws(() => f.store.prepare(payload()), code('CONFIRMED'));
  assert.equal(f.store.reset().status, 'empty');
  assert.notEqual(f.store.prepare(payload()).p_client_request_id, request.p_client_request_id);
});

test('failed confirmation persistence preserves pending and never allows a new cart', () => {
  const f = fixture(); const request = f.store.prepare(payload()); const original = f.rows.get(f.store.key);
  f.storage.failWrite = true;
  assert.throws(() => f.store.confirmed({ id: id(50), client_request_id: request.p_client_request_id }), code('STORAGE_WRITE'));
  assert.equal(f.rows.get(f.store.key), original); assert.equal(f.store.get().status, 'pending');
  assert.throws(() => f.store.saveDraft(draft()), code('PENDING'));
  assert.throws(() => f.store.reset(), code('PENDING'));
  f.storage.failWrite = false;
  assert.equal(f.store.confirmed({ id: id(50), client_request_id: request.p_client_request_id }).status, 'confirmed');
});

test('confirmation readback error remains blocked until exact confirmed record is read', () => {
  const f = fixture(); const request = f.store.prepare(payload());
  const set = f.storage.setItem;
  f.storage.setItem = function (key, value) { set.call(this, key, value); this.failRead = true; };
  assert.throws(() => f.store.confirmed({ id: id(50), client_request_id: request.p_client_request_id }), code('STORAGE_READ'));
  assert.throws(() => f.store.saveDraft(draft()), code('STORAGE_READ'));
  f.storage.failRead = false; f.storage.setItem = set;
  assert.equal(f.store.get().status, 'confirmed');
  const terminal = f.rows.get(f.store.key);
  assert.throws(() => f.store.saveDraft(draft()), code('CONFIRMED'));
  assert.equal(f.rows.get(f.store.key), terminal);
  assert.equal(f.store.discard().status, 'empty');
  assert.equal(f.store.saveDraft(draft()).status, 'draft');
});

test('corrupt and unknown schemas are preserved and all mutating operations fail closed', () => {
  for (const corrupt of ['{bad', 'null', '[]', '{}', JSON.stringify({ version: 99, scope, status: 'draft' })]) {
    const f = fixture(); f.rows.set(f.store.key, corrupt);
    assert.equal(f.store.get().status, 'corrupt');
    assert.throws(() => f.store.saveDraft(draft()), code('CORRUPT'));
    assert.throws(() => f.store.prepare(payload()), code('CORRUPT'));
    assert.throws(() => f.store.reset(), code('CORRUPT'));
    assert.equal(f.rows.get(f.store.key), corrupt);
  }
  const f = fixture(); f.store.saveDraft(draft());
  const record = JSON.parse(f.rows.get(f.store.key)); record.draft.cpf = 'unexpected';
  f.rows.set(f.store.key, JSON.stringify(record));
  assert.equal(new DraftStore(f.config).get().status, 'corrupt');
});

test('known fields reject non-JSON values, invalid IDs/quantities/money and too many items', () => {
  const invalid = [
    draft({ discount: NaN }), draft({ discount: Infinity }), draft({ discount: -1 }), draft({ discount: 1.001 }),
    draft({ clientId: 'customer name' }), draft({ overrideTroca: 'yes' }), draft({ channel: '__proto__' }),
    draft({ items: [{ productId: id(2), qty: 0 }] }), draft({ items: [{ productId: id(2), qty: 1.1 }] }),
    draft({ items: [{ productId: id(2), qty: '1' }] }), draft({ items: [{ productId: id(2), qty: 2147483648 }] }),
    draft({ items: [{ productId: id(2), qty: 1 }, { productId: id(2), qty: 2 }] }),
    draft({ items: Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ productId: id(i + 100), qty: 1 })) })
  ];
  for (const input of invalid) assert.throws(() => fixture().store.saveDraft(input), code('INVALID_DATA'));
  const accessor = draft(); Object.defineProperty(accessor, 'discount', { get() { throw Error('must not run'); } });
  assert.throws(() => fixture().store.saveDraft(accessor), code('INVALID_DATA'));
  const safe = draft(); safe.circular = safe; safe.symbol = Symbol('private'); safe.func = () => {};
  assert.deepEqual(fixture().store.saveDraft(safe).draft, draft());
});

test('only a proven first-attempt sales_pay_check rejection restores draft and retires UUID', () => {
  const f = fixture(); const request = f.store.prepare(payload());
  for (const altered of [ { ...evidence, code: '400' }, { ...evidence, constraint: 'other' },
    { ...evidence, verifiedAbsent: false }, { ...evidence, firstAttemptInThisPage: false } ]) {
    assert.throws(() => f.store.rejectKnown(request.p_client_request_id, altered), code('REJECTION_UNPROVEN'));
  }
  const restored = f.store.rejectKnown(request.p_client_request_id, evidence);
  assert.equal(restored.status, 'draft'); assert.deepEqual(restored.draft.items, draft().items);
  assert.equal(restored.rejectedRequestId, request.p_client_request_id);
  assert.throws(() => f.store.prepare(payload(draft(), { p_client_request_id: request.p_client_request_id })), code('REJECTED_ID'));
  const second = f.store.prepare(payload());
  assert.notEqual(second.p_client_request_id, request.p_client_request_id);
});

test('recovered/retried pending cannot use known-rejection escape even with supplied flags', () => {
  const f = fixture(); const request = f.store.prepare(payload());
  const recovered = new DraftStore(f.config);
  assert.throws(() => recovered.rejectKnown(request.p_client_request_id, evidence), code('REJECTION_UNPROVEN'));
  f.store.prepare(payload());
  assert.throws(() => f.store.rejectKnown(request.p_client_request_id, evidence), code('REJECTION_UNPROVEN'));
  assert.equal(f.store.get().status, 'pending');
});

test('failed known-rejection persistence keeps original pending and cannot clear it', () => {
  const f = fixture(); const request = f.store.prepare(payload()); const original = f.rows.get(f.store.key);
  f.storage.failWrite = true;
  assert.throws(() => f.store.rejectKnown(request.p_client_request_id, evidence), code('STORAGE_WRITE'));
  assert.equal(f.rows.get(f.store.key), original); assert.equal(f.store.get().status, 'pending');
  assert.throws(() => f.store.reset(), code('PENDING'));
});

test('sparse or accessor arrays never become a persisted pending request', () => {
  const f = fixture();
  assert.throws(() => f.store.prepare(payload(draft(), { p_items: new Array(1) })), code('INVALID_DATA'));
  assert.equal(f.store.get().status, 'empty');
  assert.throws(() => f.store.saveDraft(draft({ items: new Array(2) })), code('INVALID_DATA'));
  const items = []; Object.defineProperty(items, '0', { get() { throw Error('must not execute'); } });
  assert.throws(() => f.store.saveDraft(draft({ items })), code('INVALID_DATA'));
  assert.equal(f.rows.size, 0);
});

test('loaded UUIDs canonicalize before comparison; retired uppercase UUID is never reused', () => {
  const retired = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
  const f = fixture({ uuid: () => retired });
  const request = f.store.prepare(payload()); f.store.rejectKnown(request.p_client_request_id, evidence);
  const record = JSON.parse(f.rows.get(f.store.key)); record.rejectedRequestId = retired.toUpperCase();
  f.rows.set(f.store.key, JSON.stringify(record));
  const recovered = new DraftStore(f.config);
  assert.equal(recovered.get().rejectedRequestId, retired);
  assert.throws(() => recovered.prepare(payload()), code('REJECTED_ID'));
  const pending = fixture(); pending.store.prepare(payload());
  const tampered = JSON.parse(pending.rows.get(pending.store.key)); tampered.request.p_note = '';
  pending.rows.set(pending.store.key, JSON.stringify(tampered));
  assert.equal(new DraftStore(pending.config).get().status, 'corrupt');
});
