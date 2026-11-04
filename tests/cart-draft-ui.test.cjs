'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { DraftStore, TTL_MS } = require('../cart-draft-store.js');
const { createController } = require('../cart-draft-ui.js');

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER = uuid(1);
const clone = object => JSON.parse(JSON.stringify(object));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
function draft(count = 1) {
  return { items: Array.from({ length: count }, (_, i) => ({ productId: uuid(100 + i), qty: i % 3 + 1 })),
    clientId: null, vendedorId: uuid(2), channel: 'Loja', kind: 'Venda', priceTier: 'Atacado', discount: 10, overrideTroca: false };
}
function payload(value) {
  return { p_client_id: value.clientId, p_vendedor_id: value.vendedorId, p_channel: value.channel,
    p_kind: value.kind, p_pay: 'Pendente', p_installments: 0, p_discount: value.discount, p_note: null,
    p_items: value.items.map(item => ({ product_id: item.productId, qty: item.qty })), p_price_tier: value.priceTier };
}
function memoryStorage() {
  const data = new Map();
  return { data, failWrite: false, failRead: false, skipWrite: false, failConfirmed: false,
    getItem(key) { if (this.failRead) throw Error('read blocked'); return data.get(key) ?? null; },
    setItem(key, value) {
      if (this.failWrite || (this.failConfirmed && JSON.parse(value).status === 'confirmed')) throw Error('quota');
      if (!this.skipWrite) data.set(key, value);
    },
    removeItem(key) { data.delete(key); }
  };
}
function locks() {
  const held = new Map();
  return { held, request(name, options, callback) {
    assert.equal(options.ifAvailable, true);
    if (held.has(name)) return Promise.resolve(callback(null));
    const lock = { name }; held.set(name, lock);
    return Promise.resolve(callback(lock)).finally(() => { if (held.get(name) === lock) held.delete(name); });
  } };
}
function backend() {
  return { rows: new Map(), rpcCalls: [], reads: [], stockMoves: 0, lookupError: null,
    find(id) { this.reads.push(id); if (this.lookupError) throw this.lookupError; return this.rows.get(id) || null; },
    commit(request) {
      let row = this.rows.get(request.p_client_request_id);
      if (!row) {
        row = { id: uuid(1000 + this.rows.size), client_request_id: request.p_client_request_id, sold_at: '2026-11-04T12:00:00Z' };
        this.rows.set(request.p_client_request_id, row);
        this.stockMoves += request.p_items.reduce((sum, item) => sum + item.qty, 0);
      }
      return { data: row, error: null };
    }
  };
}
function harness(t, options = {}) {
  // No script loading, fetch, Supabase client, credentials, or external resources.
  const dom = new JSDOM('<form><input id="discount"><select id="payment"><option value="Pendente">Pendente</option></select><button id="save">Salvar</button><output id="status"></output></form>', { url: 'https://offline.invalid/' });
  const storage = options.storage || memoryStorage();
  const mutex = options.locks || locks();
  const server = options.server || backend();
  let sequence = options.sequence || 5000;
  let time = options.time || 1800000000000;
  let userId = options.userId || USER;
  let form = options.initialDraft ? clone(options.initialDraft) : draft(0);
  const models = [], confirmations = [], events = [];
  const store = new DraftStore({ storage, scope: { store: options.project || 'test.supabase.co', userId }, now: () => time, uuid: () => uuid(sequence++) });
  const controller = createController({ store, locks: options.noLocks ? undefined : mutex,
    getUserId: async () => options.identity ? options.identity(userId) : userId,
    captureDraft: () => clone(form),
    applyDraft: async value => { events.push('restore'); form = clone(value); dom.window.document.getElementById('discount').value = form.discount; },
    clearForm: () => { events.push('clear'); if (options.clear) options.clear(); form = draft(0); dom.window.document.getElementById('payment').value = 'Pendente'; },
    makePayload: payload,
    validateDraft: async value => { if (!value.items.length) throw Error('empty cart'); if (options.validate) await options.validate(value); },
    findSale: async id => options.find ? options.find(id, server) : server.find(id),
    createSale: async request => {
      assert.equal(store.load().status, 'pending', 'durable pending record must precede any RPC');
      assert.deepEqual(store.load().request, request, 'persisted payload must exactly match RPC payload');
      assert.ok(Object.isFrozen(request) && Object.isFrozen(request.p_items), 'request must be frozen');
      server.rpcCalls.push(clone(request)); events.push('rpc');
      return options.create ? options.create(request, server) : server.commit(request);
    },
    onSaved: async row => { events.push('saved'); if (options.onSaved) await options.onSaved(row); },
    setLocked: value => { for (const control of dom.window.document.querySelectorAll('input,select,button')) control.disabled = value; },
    show: model => { models.push(model); dom.window.document.getElementById('status').textContent = model.message; },
    confirm: async message => { confirmations.push(message); return options.confirm ? options.confirm(message) : true; }
  });
  let closed = false;
  const h = { dom, storage, locks: mutex, server, store, controller, models, confirmations, events,
    get form() { return clone(form); }, setForm: value => { form = clone(value); }, setUser: value => { userId = value; }, setTime: value => { time = value; },
    close: () => { if (!closed) { controller.dispose(); dom.window.close(); closed = true; } } };
  t.after(h.close);
  return h;
}

test('45-item cart survives reload but requires explicit review and restore', async t => {
  const first = harness(t); await first.controller.start(); first.setForm(draft(45));
  assert.equal(first.controller.changed(), true); first.close(); await settle();
  const next = harness(t, { storage: first.storage, locks: first.locks }); await next.controller.start();
  assert.equal(next.controller.status, 'restore'); assert.equal(next.form.items.length, 0);
  assert.equal(next.controller.canEdit(), false); assert.equal(next.server.rpcCalls.length, 0);
  await next.controller.restore();
  assert.deepEqual(next.form, draft(45)); assert.equal(next.controller.canEdit(), true);
  assert.equal(next.confirmations.length, 1); assert.equal(next.server.rpcCalls.length, 0);
});

test('cancelling restoration leaves the saved draft untouched and does not submit', async t => {
  const h = harness(t, { confirm: () => false }); h.store.saveDraft(draft(42)); await h.controller.start();
  const before = h.storage.getItem(h.store.key); await h.controller.restore();
  assert.equal(h.form.items.length, 0); assert.equal(h.controller.status, 'restore');
  assert.equal(h.storage.getItem(h.store.key), before); assert.equal(h.server.rpcCalls.length, 0);
});

test('expired draft requires review; expired pending request remains locked', async t => {
  const h = harness(t); h.store.saveDraft(draft()); h.setTime(1800000000000 + TTL_MS + 1); await h.controller.start();
  assert.equal(h.controller.status, 'expired'); await h.controller.restore();
  assert.equal(h.store.load().status, 'draft'); assert.equal(h.controller.canEdit(), true);
  const pending = harness(t, { project: 'other.supabase.co' }); pending.store.saveDraft(draft()); pending.store.prepare(payload(draft()));
  pending.setTime(1800000000000 + TTL_MS * 2); await pending.controller.start();
  assert.equal(pending.store.load().aged, true); assert.equal(pending.controller.status, 'pending');
  await pending.controller.discard(); assert.equal(pending.store.load().status, 'pending');
});

test('two sales on the same date have distinct request IDs and Pendente payment', async t => {
  const h = harness(t); await h.controller.start();
  for (let count = 0; count < 3; count++) {
    h.setForm(draft(2)); h.controller.changed(); await h.controller.finalize();
    assert.equal(h.controller.status, 'confirmed'); assert.equal(h.form.items.length, 0);
    assert.equal(h.dom.window.document.getElementById('payment').value, 'Pendente');
    assert.equal(h.controller.canEdit(), false); await h.controller.startNew();
  }
  assert.equal(h.server.rows.size, 3); assert.equal(new Set(h.server.rpcCalls.map(r => r.p_client_request_id)).size, 3);
  assert.ok(h.server.rpcCalls.every(r => r.p_pay === 'Pendente' && r.p_installments === 0));
  assert.equal(new Set([...h.server.rows.values()].map(row => row.sold_at)).size, 1);
  assert.equal(h.server.stockMoves, 9);
});

test('storage write failure or unconfirmed readback prevents all RPCs and preserves visible cart', async t => {
  for (const flag of ['failWrite', 'skipWrite']) {
    const h = harness(t); await h.controller.start(); h.setForm(draft(41)); h.storage[flag] = true;
    await h.controller.finalize(); assert.equal(h.server.rpcCalls.length, 0);
    assert.equal(h.form.items.length, 41); assert.match(h.models.at(-1).message, /bloqueado/i);
  }
});

test('failure persisting the pending request prevents RPC even after draft saved', async t => {
  const storage = memoryStorage(), original = storage.setItem;
  storage.setItem = function(key, value) { if (JSON.parse(value).status === 'pending') throw Error('quota'); return original.call(this, key, value); };
  const h = harness(t, { storage }); await h.controller.start(); h.setForm(draft(42)); await h.controller.finalize();
  assert.equal(h.server.rpcCalls.length, 0); assert.equal(h.form.items.length, 42);
});

test('pending write accepted but readback failing cannot expose an editable replacement cart', async t => {
  const storage = memoryStorage(), originalSet = storage.setItem, originalGet = storage.getItem;
  let rejectNextRead = false;
  storage.setItem = function(key, value) {
    originalSet.call(this, key, value);
    if (JSON.parse(value).status === 'pending') rejectNextRead = true;
  };
  storage.getItem = function(key) { if (rejectNextRead) { rejectNextRead = false; throw Error('readback denied'); } return originalGet.call(this, key); };
  const h = harness(t, { storage }); await h.controller.start(); h.setForm(draft(43)); await h.controller.finalize();
  assert.equal(h.server.rpcCalls.length, 0); assert.equal(h.store.load().status, 'pending');
  assert.equal(h.controller.canEdit(), false); assert.equal(h.form.items.length, 43);
});

test('lost RPC response followed by unavailable lookup remains pending; reload reconciles without another write', async t => {
  const h = harness(t, { create: (request, server) => { server.commit(request); server.lookupError = Error('offline'); throw Error('lost response'); } });
  await h.controller.start(); h.setForm(draft(43)); await h.controller.finalize();
  assert.equal(h.store.load().status, 'pending'); assert.equal(h.form.items.length, 43); assert.equal(h.server.rows.size, 1);
  const stockMoves = h.server.stockMoves; h.close(); await settle(); h.server.lookupError = null;
  const next = harness(t, { storage: h.storage, locks: h.locks, server: h.server }); await next.controller.start();
  assert.equal(next.controller.status, 'pending'); await next.controller.checkPending();
  assert.equal(next.controller.status, 'confirmed'); assert.equal(next.server.rpcCalls.length, 1);
  assert.equal(next.server.stockMoves, stockMoves); assert.equal(next.server.rows.size, 1);
});

test('RPC exception after commit is reconciled immediately when lookup succeeds', async t => {
  const h = harness(t, { create: (request, server) => { server.commit(request); throw Error('response lost'); } });
  await h.controller.start(); h.setForm(draft()); await h.controller.finalize();
  assert.equal(h.controller.status, 'confirmed'); assert.equal(h.server.rpcCalls.length, 1);
  assert.equal(h.server.reads.length, 1); assert.equal(h.server.rows.size, 1);
});

test('storage read failure while handling uncertain send leaves the controller locked without crashing', async t => {
  const h = harness(t, { create: (_, server) => { h.storage.failRead = true; server.lookupError = Error('offline'); throw Error('lost response'); } });
  await h.controller.start(); h.setForm(draft(41));
  await assert.doesNotReject(h.controller.finalize());
  assert.equal(h.controller.status, 'pending'); assert.equal(h.controller.canEdit(), false);
  assert.equal(h.form.items.length, 41); assert.equal(h.server.rpcCalls.length, 1);
  h.storage.failRead = false; assert.equal(h.store.load().status, 'pending');
});

test('pending retry requires a fresh successful lookup and repeats the exact frozen payload', async t => {
  let first = true;
  const h = harness(t, { create: (request, server) => { if (first) { first = false; return { data: null, error: { message: 'connection interrupted' } }; } return server.commit(request); } });
  await h.controller.start(); h.setForm(draft(44)); await h.controller.finalize();
  const original = clone(h.store.load().request); assert.equal(h.controller.status, 'pending');
  h.setForm(draft(1)); assert.equal(h.controller.changed(), false);
  await h.controller.checkPending(); const reads = h.server.reads.length; await h.controller.retryPending();
  assert.deepEqual(h.server.rpcCalls, [original, original]); assert.equal(h.server.reads.length, reads + 2);
  assert.equal(h.server.rows.size, 1); assert.equal(h.controller.status, 'confirmed');
});

test('failed pending verification prevents retry, new cart, editing and discard', async t => {
  const h = harness(t); h.store.saveDraft(draft(40)); const request = h.store.prepare(payload(draft(40)));
  await h.controller.start(); h.server.lookupError = Error('read unavailable');
  await h.controller.checkPending(); await h.controller.retryPending(); await h.controller.startNew(); await h.controller.discard();
  assert.equal(h.server.rpcCalls.length, 0); assert.equal(h.controller.canEdit(), false);
  assert.deepEqual(h.store.load().request, request); assert.equal(h.store.load().status, 'pending');
});

test('retry lookup finding committed sale confirms without replaying RPC', async t => {
  const h = harness(t); h.store.saveDraft(draft()); const request = h.store.prepare(payload(draft()));
  await h.controller.start(); await h.controller.checkPending(); h.server.commit(request);
  await h.controller.retryPending(); assert.equal(h.server.rpcCalls.length, 0); assert.equal(h.controller.status, 'confirmed');
});

test('general SQL error with absent lookup does not allow a different request', async t => {
  const h = harness(t, { create: () => ({ data: null, error: { code: '23514', message: 'products_stock_check' } }) });
  await h.controller.start(); h.setForm(draft()); await h.controller.finalize();
  assert.equal(h.store.load().status, 'pending'); assert.equal(h.controller.canEdit(), false);
  await h.controller.finalize(); assert.equal(h.server.rpcCalls.length, 1);
});

test('known first payment-constraint rejection is editable only after successful absent lookup', async t => {
  let first = true;
  const h = harness(t, { create: (request, server) => { if (first) { first = false; return { data: null, error: { code: '23514', message: 'violates check constraint "sales_pay_check"' } }; } return server.commit(request); } });
  await h.controller.start(); h.setForm(draft()); await h.controller.finalize();
  assert.equal(h.controller.canEdit(), true); assert.equal(h.store.load().status, 'draft');
  await h.controller.finalize(); assert.equal(h.controller.status, 'confirmed');
  assert.notEqual(h.server.rpcCalls[0].p_client_request_id, h.server.rpcCalls[1].p_client_request_id);
});

test('recovered pending payment rejection stays locked even when lookup is absent', async t => {
  const h = harness(t, { create: () => ({ data: null, error: { code: '23514', message: 'sales_pay_check' } }) });
  h.store.saveDraft(draft()); h.store.prepare(payload(draft())); await h.controller.start(); await h.controller.retryPending();
  assert.equal(h.controller.canEdit(), false); assert.equal(h.store.load().status, 'pending');
});

test('wrong request confirmation cannot clear cart or unlock another sale', async t => {
  const h = harness(t, { find: () => ({ id: uuid(999), client_request_id: uuid(888) }) });
  await h.controller.start(); h.events.length = 0; h.setForm(draft(45)); await h.controller.finalize();
  assert.equal(h.controller.status, 'pending'); assert.equal(h.form.items.length, 45);
  assert.equal(h.events.includes('clear'), false); assert.equal(h.store.load().status, 'pending');
});

test('failed confirmation persistence keeps pending; screen refresh failure after confirmed does not resend', async t => {
  const h = harness(t); await h.controller.start(); h.setForm(draft(44)); h.storage.failConfirmed = true;
  await h.controller.finalize(); assert.equal(h.store.load().status, 'pending'); assert.equal(h.form.items.length, 44);
  await h.controller.startNew(); assert.equal(h.controller.canEdit(), false); assert.equal(h.server.rpcCalls.length, 1);
  h.storage.failConfirmed = false; await h.controller.checkPending(); assert.equal(h.controller.status, 'confirmed');
  const refreshed = harness(t, { onSaved: async () => { throw Error('history unavailable'); } });
  await refreshed.controller.start(); refreshed.setForm(draft()); await refreshed.controller.finalize();
  assert.equal(refreshed.store.load().status, 'confirmed'); assert.equal(refreshed.form.items.length, 0);
  await refreshed.controller.finalize(); assert.equal(refreshed.server.rpcCalls.length, 1);
  assert.match(refreshed.models.at(-1).message, /Não reenvie/i);
});

test('confirmed write with transient readback failure shows confirmed and never repeats clearing or RPC', async t => {
  const storage = memoryStorage(), originalSet = storage.setItem, originalGet = storage.getItem;
  let failNextRead = false;
  storage.setItem = function(key, value) { originalSet.call(this, key, value); if (JSON.parse(value).status === 'confirmed') failNextRead = true; };
  storage.getItem = function(key) { if (failNextRead) { failNextRead = false; throw Error('temporary read failure'); } return originalGet.call(this, key); };
  const h = harness(t, { storage }); await h.controller.start(); h.events.length = 0; h.setForm(draft(44)); await h.controller.finalize();
  assert.equal(h.controller.status, 'confirmed'); assert.equal(h.store.load().status, 'confirmed');
  assert.equal(h.form.items.length, 44); assert.equal(h.events.filter(e => e === 'clear').length, 0);
  await h.controller.checkPending(); assert.equal(h.controller.status, 'confirmed'); assert.equal(h.events.filter(e => e === 'clear').length, 0);
  await h.controller.finalize(); assert.equal(h.server.rpcCalls.length, 1);
  await h.controller.startNew(); assert.equal(h.form.items.length, 0); assert.equal(h.controller.canEdit(), true);
});

test('rendering error after durable confirmation cannot change it into a resendable pending request', async t => {
  let failClear = false;
  const h = harness(t, { clear: () => { if (failClear) throw Error('render failed'); } });
  await h.controller.start(); h.events.length = 0; failClear = true; h.setForm(draft(41)); await h.controller.finalize();
  assert.equal(h.controller.status, 'confirmed'); assert.equal(h.store.load().status, 'confirmed');
  await h.controller.checkPending(); assert.equal(h.events.filter(e => e === 'clear').length, 1);
  await h.controller.startNew(); assert.equal(h.store.load().status, 'confirmed', 'failed clear must preserve durable confirmation');
  failClear = false; await h.controller.startNew(); assert.equal(h.controller.status, 'empty'); assert.equal(h.form.items.length, 0);
  assert.equal(h.server.rpcCalls.length, 1);
});

test('storage failure in discard and new-sale controls stays locked without rejected handlers', async t => {
  const h = harness(t); await h.controller.start(); h.setForm(draft()); await h.controller.finalize();
  h.storage.failRead = true;
  await assert.doesNotReject(h.controller.startNew()); await assert.doesNotReject(h.controller.discard());
  assert.equal(h.controller.canEdit(), false); assert.equal(h.server.rpcCalls.length, 1);
  h.storage.failRead = false; assert.equal(h.store.load().status, 'confirmed');
});

test('double-clicks and discard during send cannot change the in-flight request', async t => {
  const gate = deferred(), started = deferred();
  const h = harness(t, { create: async (request, server) => { started.resolve(); await gate.promise; return server.commit(request); } });
  await h.controller.start(); h.setForm(draft(42)); const run = h.controller.finalize(); await started.promise;
  assert.equal(h.dom.window.document.getElementById('discount').disabled, true);
  await h.controller.finalize(); await h.controller.discard(); assert.equal(h.controller.changed(), false);
  assert.equal(h.server.rpcCalls.length, 1); assert.equal(h.store.load().request.p_items.length, 42);
  gate.resolve(); await run; assert.equal(h.controller.status, 'confirmed');
});

test('same account and project uses one tab; another account or project has independent draft and lock', async t => {
  const sharedLocks = locks(), storage = memoryStorage();
  const first = harness(t, { locks: sharedLocks, storage }); await first.controller.start(); first.setForm(draft(40)); first.controller.changed();
  const second = harness(t, { locks: sharedLocks, storage }); await second.controller.start();
  assert.equal(second.controller.status, 'readonly'); assert.equal(second.controller.canEdit(), false);
  second.setForm(draft()); await second.controller.finalize(); assert.equal(second.server.rpcCalls.length, 0);
  const otherUser = harness(t, { locks: sharedLocks, storage, userId: uuid(8) }); await otherUser.controller.start();
  const otherProject = harness(t, { locks: sharedLocks, storage, project: 'another.supabase.co' }); await otherProject.controller.start();
  assert.equal(otherUser.controller.canEdit(), true); assert.equal(otherProject.controller.canEdit(), true);
  assert.equal(otherUser.store.load().status, 'empty'); assert.equal(otherProject.store.load().status, 'empty');
  first.close(); await settle();
  const replacement = harness(t, { locks: sharedLocks, storage }); await replacement.controller.start();
  assert.equal(replacement.controller.status, 'restore'); assert.equal(replacement.store.load().draft.items.length, 40);
});

test('account change during validation or pending lookup blocks RPC', async t => {
  const validation = deferred(), started = deferred();
  const h = harness(t, { validate: async () => { started.resolve(); await validation.promise; } });
  await h.controller.start(); h.setForm(draft()); const run = h.controller.finalize(); await started.promise;
  h.setUser(uuid(9)); validation.resolve(); await run; assert.equal(h.server.rpcCalls.length, 0); assert.equal(h.controller.canEdit(), false);
  const lookup = deferred(), readStarted = deferred();
  const pending = harness(t, { find: async () => { readStarted.resolve(); await lookup.promise; return null; } });
  pending.store.saveDraft(draft()); pending.store.prepare(payload(draft())); await pending.controller.start();
  const retry = pending.controller.retryPending(); await readStarted.promise; pending.setUser(uuid(9)); lookup.resolve(); await retry;
  assert.equal(pending.server.rpcCalls.length, 0); assert.equal(pending.store.load().status, 'pending');
});

test('missing Web Locks blocks editing and sending instead of relying on advisory local flags', async t => {
  const h = harness(t, { noLocks: true }); await h.controller.start(); h.setForm(draft()); await h.controller.finalize();
  assert.equal(h.controller.status, 'unsupported'); assert.equal(h.controller.canEdit(), false); assert.equal(h.server.rpcCalls.length, 0);
});

test('releasing the tab lock during an identity check prevents the prepared RPC', async t => {
  const gate = deferred(), reached = deferred(); let calls = 0;
  const h = harness(t, { identity: async id => { calls++; if (calls === 5) { reached.resolve(); await gate.promise; } return id; } });
  await h.controller.start(); h.setForm(draft()); const run = h.controller.finalize(); await reached.promise;
  h.controller.dispose(); gate.resolve(); await run;
  assert.equal(h.server.rpcCalls.length, 0); assert.equal(h.controller.canEdit(), false);
  assert.equal(h.store.load().status, 'pending');
});

test('cancelling finalization never prepares a request or writes a sale', async t => {
  const h = harness(t, { confirm: () => false }); await h.controller.start(); h.setForm(draft(44)); await h.controller.finalize();
  assert.equal(h.store.load().status, 'draft'); assert.equal(h.form.items.length, 44); assert.equal(h.server.rpcCalls.length, 0);
  assert.equal(h.controller.canEdit(), true);
});
