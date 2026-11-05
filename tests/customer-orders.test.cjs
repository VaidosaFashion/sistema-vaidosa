const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../modules/customer-orders.js');
function order(id, clientId = 'client-a', extra = {}) {
  return { id, clientId, date: '2026-11-05T12:00:00Z', totalBruto: 100, netReceived: 90, paymentStatus: 'Pago',
    items: [{ id: 'line-' + id, productId: 'p', name: 'Peça', price: 100, qty: 1 }],
    payments: [{ id: 'payment-' + id, date: '2026-11-05', value: 100, netValue: 90, method: 'Credito' }], ...extra };
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test('all 62 orders can be loaded in stable pages beyond the old 15-order limit', async () => {
  const data = Array.from({ length: 62 }, (_, i) => order('order-' + String(i).padStart(3, '0'))).reverse();
  data.push(order('other-client', 'client-b'));
  const controller = C.createController({ repository: C.createMemoryRepository(data), pageSize: 15 });
  await controller.selectClient('client-a');
  assert.equal(controller.getState().orders.length, 15);
  while (controller.getState().hasMore) await controller.loadMore();
  const state = controller.getState();
  assert.equal(state.orders.length, 62);
  assert.equal(new Set(state.orders.map(o => o.id)).size, 62);
  assert.deepEqual(state.orders.map(o => o.id), data.filter(o => o.clientId === 'client-a').map(o => o.id).sort());
});

test('repository orders by sale instant descending and ID ascending, accepts epoch ms', async () => {
  const repo = C.createMemoryRepository([order('b'), order('a'), order('old', 'client-a', { date: Date.parse('2026-11-04T12:00:00Z') })]);
  const first = await repo.listCustomerOrders({ clientId: 'client-a', cursor: null, limit: 2 });
  assert.deepEqual(first.orders.map(o => o.id), ['a', 'b']);
  assert.deepEqual((await repo.listCustomerOrders({ clientId: 'client-a', cursor: first.nextCursor, limit: 2 })).orders.map(o => o.id), ['old']);
});

test('keyset pagination does not repeat rows if a new earlier order is added', async () => {
  const data = [order('a'), order('b'), order('c')];
  const repo = C.createMemoryRepository(() => data);
  const first = await repo.listCustomerOrders({ clientId: 'client-a', limit: 2 });
  data.push(order('0-new'));
  const second = await repo.listCustomerOrders({ clientId: 'client-a', limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.orders.map(o => o.id), ['c']);
});

test('duplicate calls while loading invoke only one read', async () => {
  const waiting = deferred(); let reads = 0;
  const controller = C.createController({ repository: { listCustomerOrders() { reads++; return waiting.promise; } } });
  const first = controller.selectClient('client-a');
  const second = controller.loadMore();
  await Promise.resolve();
  assert.equal(reads, 1);
  waiting.resolve({ orders: [order('a')], nextCursor: null });
  await Promise.all([first, second]);
  assert.equal(controller.getState().orders.length, 1);
});

test('switching client aborts previous read and ignores late results', async () => {
  const a = deferred(), b = deferred(); const signals = [];
  const controller = C.createController({ repository: { listCustomerOrders(args) { signals.push(args.signal); return args.clientId === 'client-a' ? a.promise : b.promise; } } });
  const first = controller.selectClient('client-a'); await Promise.resolve();
  const second = controller.selectClient('client-b'); await Promise.resolve();
  assert.equal(signals[0].aborted, true);
  b.resolve({ orders: [order('b', 'client-b')], nextCursor: null }); await second;
  a.resolve({ orders: [order('a')], nextCursor: null }); await first;
  assert.deepEqual(controller.getState().orders.map(o => o.id), ['b']);
});

test('failed page preserves loaded orders and retries the same cursor without raw error details', async () => {
  let reads = 0; const cursors = [];
  const controller = C.createController({ pageSize: 1, repository: { listCustomerOrders({ cursor }) {
    cursors.push(cursor); reads++;
    if (reads === 1) return { orders: [order('a')], nextCursor: 'next' };
    if (reads === 2) throw new Error('private database details');
    return { orders: [order('b')], nextCursor: null };
  } } });
  await controller.selectClient('client-a'); await controller.loadMore();
  assert.equal(controller.getState().orders.length, 1);
  assert.ok(controller.getState().error);
  assert.ok(!controller.getState().error.includes('private'));
  await controller.loadMore();
  assert.deepEqual(cursors, [null, 'next', 'next']);
  assert.deepEqual(controller.getState().orders.map(o => o.id), ['a', 'b']);
  assert.equal(controller.getState().error, null);
});

test('page deduplication uses sale IDs rather than matching totals, dates or client', async () => {
  let calls = 0;
  const controller = C.createController({ repository: { listCustomerOrders() {
    return ++calls === 1 ? { orders: [order('a')], nextCursor: 'next' } : { orders: [order('a'), order('b')], nextCursor: null };
  } } });
  await controller.selectClient('client-a'); await controller.loadMore();
  assert.deepEqual(controller.getState().orders.map(o => o.id), ['a', 'b']);
});

test('wrong-client rows and non-advancing cursors fail without exposing rows', async () => {
  const wrong = C.createController({ repository: { listCustomerOrders: () => ({ orders: [order('x', 'client-b')], nextCursor: null }) } });
  await wrong.selectClient('client-a');
  assert.equal(wrong.getState().orders.length, 0); assert.ok(wrong.getState().error);
  const loop = C.createController({ repository: { listCustomerOrders: () => ({ orders: [order('a')], nextCursor: 'same' }) } });
  await loop.selectClient('client-a'); await loop.loadMore();
  assert.equal(loop.getState().orders.length, 1); assert.ok(loop.getState().error);
});

test('invalid/missing cursor and oversized page are rejected rather than mistaken for complete history', async () => {
  for (const page of [{ orders: [order('a')] }, { orders: [order('a')], nextCursor: {} }, { orders: [order('a'), order('b')], nextCursor: null }]) {
    const controller = C.createController({ repository: { listCustomerOrders: () => page }, pageSize: 1 });
    await controller.selectClient('client-a');
    assert.ok(controller.getState().error);
    assert.equal(controller.getState().orders.length, 0);
    assert.equal(controller.getState().hasMore, true);
  }
});

test('minimal snapshot preserves order/item/payment identifiers but excludes CPF, notes and contacts', async () => {
  const source = order('a', 'client-a', { buyer_cpf_nfce: 'fixture-cpf', note: 'private', phone: 'private', client: { name: 'private' },
    items: [{ id: 'line-a', productId: 'p', name: 'Peça', note: 'private', cost: 10, qty: 1, price: 100 }],
    payments: [{ id: 'pay-a', date: '2026-11-05', value: 100, note: 'private', created_by: 'private' }] });
  const controller = C.createController({ repository: C.createMemoryRepository([source]) });
  await controller.selectClient('client-a');
  const result = controller.getState().orders[0];
  assert.equal(result.id, 'a'); assert.equal(result.items[0].id, 'line-a'); assert.equal(result.payments[0].id, 'pay-a');
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('cpf'), false);
  result.items[0].name = 'changed';
  assert.equal(controller.getState().orders[0].items[0].name, 'Peça');
  assert.equal(source.items[0].name, 'Peça');
});

test('open callback uses a loaded order ID and isolated snapshot only', async () => {
  const opened = [];
  const controller = C.createController({ repository: C.createMemoryRepository([order('a')]), onOpenOrder(id, snapshot) { opened.push(id); snapshot.items.length = 0; } });
  await controller.selectClient('client-a');
  assert.equal(controller.openOrder('unknown'), false);
  assert.equal(controller.openOrder('a'), true);
  assert.deepEqual(opened, ['a']);
  assert.equal(controller.getState().orders[0].items.length, 1);
  assert.equal(controller.savePayment, undefined);
});

test('refresh clears prior pages and disposal prevents late notifications or opening orders', async () => {
  const data = [order('a')]; let notifications = 0;
  const controller = C.createController({ repository: C.createMemoryRepository(() => data), onState() { notifications++; } });
  await controller.selectClient('client-a'); data.push(order('b')); await controller.refresh();
  assert.equal(controller.getState().orders.length, 2);
  controller.dispose(); const count = notifications;
  await controller.loadMore(); await controller.selectClient('client-a');
  assert.equal(controller.openOrder('a'), false);
  assert.equal(notifications, count);
  assert.equal(controller.getState().orders.length, 0);
});

test('deselecting client clears history and page limits are enforced', async () => {
  assert.throws(() => C.createController({ repository: C.createMemoryRepository([]), pageSize: 101 }));
  const controller = C.createController({ repository: C.createMemoryRepository([order('a')]) });
  await controller.selectClient('client-a'); await controller.selectClient(null);
  assert.equal(controller.getState().hasMore, false);
  assert.deepEqual(controller.getState().orders, []);
  await assert.rejects(C.createMemoryRepository([]).listCustomerOrders({ clientId: 'client-a', limit: 1, cursor: '{bad' }));
});

function fakeDocument() {
  const doc = { createElement(tag) {
    return { tag, ownerDocument: doc, children: [], attrs: {}, listeners: {}, textContent: '',
      get firstChild() { return this.children[0]; },
      appendChild(node) { this.children.push(node); return node; },
      removeChild(node) { this.children.splice(this.children.indexOf(node), 1); },
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, v) { this.listeners[k] = v; } };
  } };
  return doc;
}
test('optional view uses text nodes, offers order details and load-more callbacks', () => {
  const doc = fakeDocument(), container = doc.createElement('div'); const opened = []; let more = 0;
  const source = order('<img src=x>');
  C.renderHistory(container, { clientId: 'client-a', orders: [source], hasMore: true, loading: false, error: null }, {
    onOpenOrder: id => opened.push(id), onLoadMore: () => more++, formatDate: value => value, formatMoney: value => String(value) });
  const article = container.children.find(x => x.tag === 'article');
  const open = article.children.find(x => x.tag === 'button');
  assert.equal(open.textContent, 'Ver pedido <img src=x>');
  assert.equal(article.children.some(x => x.tag === 'img'), false);
  open.listeners.click(); container.children.find(x => x.tag === 'button').listeners.click();
  assert.deepEqual(opened, ['<img src=x>']); assert.equal(more, 1);
  C.renderHistory(container, { clientId: null, orders: [], hasMore: false });
  assert.equal(container.children.length, 1);
});
