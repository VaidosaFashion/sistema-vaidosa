'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sources = ['cart-draft-store.js', 'cart-draft-ui.js', 'cart-draft-app.js'].map(name => fs.readFileSync(path.join(root, name), 'utf8'));
const saleStart = html.indexOf('  function saleTotals(sale){');
const saleEnd = html.indexOf('  function sendWhatsApp(', saleStart);
assert.ok(saleStart > 0 && saleEnd > saleStart);
const saleSource = html.slice(saleStart, saleEnd);
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER = uuid(1), PRODUCT = uuid(101), SELLER = uuid(2), CLIENT = uuid(3);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function sharedMemory() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}
function sharedLocks() {
  const held = new Set();
  return { request: async (key, _, callback) => {
    if (held.has(key)) return callback(null);
    held.add(key);
    try { return await callback({ name: key }); } finally { held.delete(key); }
  } };
}

function harness(t, options = {}) {
  // Existing HTML structure, but outside-only scripts and no resource loader.
  // Only local cart code + extracted sale rendering/handlers are evaluated.
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://offline.invalid/' });
  const w = dom.window;
  const realm = value => w.JSON.parse(JSON.stringify(value));
  const remote = options.remote || { rows: new Map(), calls: [], lookups: [], productReads: [], stockMoves: 0 };
  const { rows, calls, lookups, productReads } = remote;
  const alerts = [], counterQueries = [], counterUpdates = [], authCallbacks = [];
  const clientCounts = new Map((options.clients || []).map(client => [client.id, client.trocaCount]));
  const product = { id: PRODUCT, name: 'Produto fictício', size: 'G2', barcode: 'TEST-101', cost: 30, stock: 100,
    price_atacado: 100, price_varejo: 120, priceAtacado: 100, priceVarejo: 120 };
  let authCallback;
  Object.defineProperty(w.navigator, 'locks', { value: options.locks || sharedLocks() });
  if (options.storage) Object.defineProperty(w, 'localStorage', { value: options.storage });
  w.confirm = message => { alerts.push(message); return options.confirm !== false; };
  w.fetch = () => { throw Error('Network is prohibited in this test'); };
  w.db = realm({ products: [product], clients: options.clients || [], vendedores: [{ id: SELLER, name: 'Vendedor fictício' }], sales: [] });
  w.currentSale = realm({ items: [], finalizedSaleId: null });
  w.currentProfile = realm({ id: USER });
  w.SUPABASE_URL = 'https://fixture.supabase.co';
  w.settings = { blockSecondSwap: true };
  w.sb = { auth: { getSession: async () => realm({ data: { session: { user: { id: USER } } }, error: null }),
    onAuthStateChange: callback => { authCallback = callback; authCallbacks.push(callback); return { data: { subscription: { unsubscribe() {} } } }; } },
    from(table) {
      if (table === 'clients') return { update(value) { return { eq(field, id) { return { lt: async (guard, count) => {
        counterUpdates.push({ value: JSON.parse(JSON.stringify(value)), field, id, guard, count });
        assert.equal(field, 'id'); assert.equal(guard, 'troca_count');
        if (options.counterUpdateError) return { error: { message: 'counter update unavailable' } };
        if (clientCounts.get(id) < count) clientCounts.set(id, value.troca_count);
        return { error: null };
      } }; } }; } };
      if (table === 'products') return { select() { return { in: async (_, ids) => {
        productReads.push([...ids]); if (options.productError) return { data: null, error: { message: 'simulated unavailable' } };
        options.productStarted?.resolve(); if (options.productGate) await options.productGate.promise;
        return realm({ data: ids.includes(PRODUCT) && !options.missingProduct ? [{ ...product, stock: options.stock ?? product.stock }] : [], error: null });
      } }; } };
      assert.equal(table, 'sales'); return { select(columns, query) {
        if (query?.head) return { eq(field, id) { return { eq: async (kindField, kind) => {
          counterQueries.push({ columns, query, field, id, kindField, kind });
          assert.equal(field, 'client_id'); assert.equal(kindField, 'kind'); assert.equal(kind, 'Troca');
          if (options.counterReadError) return { count: null, error: { message: 'counter read unavailable' } };
          return { count: [...rows.values()].filter(row => row.client_id === id && row.kind === kind).length, error: null };
        } }; } };
        return { eq(_, id) { return { maybeSingle: async () => {
        lookups.push(id); if (options.lookupError) return { data: null, error: { message: 'simulated lookup unavailable' } };
        return realm({ data: rows.get(id) || null, error: null });
      } }; } }; } };
    },
    async rpc(name, request) {
      assert.equal(name, 'create_sale'); calls.push(JSON.parse(JSON.stringify(request)));
      let row = rows.get(request.p_client_request_id);
      if (!row) {
        row = { id: uuid(2000 + rows.size), client_request_id: request.p_client_request_id, sold_at: '2026-11-04T12:00:00Z',
          kind: request.p_kind, client_id: request.p_client_id, sale_items: request.p_items.map(it => ({ ...it, barcode: product.barcode })), sale_payments: [] };
        rows.set(request.p_client_request_id, row); remote.stockMoves += request.p_items.reduce((sum, it) => sum + it.qty, 0);
      }
      if (options.lostResponse) throw Error('simulated response lost');
      return realm({ data: row, error: null });
    }
  };
  // Fixtures replace unrelated app services. They never call actual authentication or network.
  w.eval(`
    function toNum(x){return Number(x)||0;}
    function fmtBRL(x){return 'R$ '+Number(x).toFixed(2);}
    function escapeHtml(x){return String(x).replace(/[&<>\"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
    function corDoItem(){return '';}
    function calcCardFee(total){return {feeValue:0,net:total,pct:0};}
    function priceForTier(p,tier){return tier==='Varejo'?p.priceVarejo:p.priceAtacado;}
    function renderSaleClientSelect(){const select=document.getElementById('sale_client');if(!select.querySelector('option'))select.append(document.createElement('option'));for(const client of db.clients){if(!select.querySelector('[value="'+client.id+'"]')){const o=document.createElement('option');o.value=client.id;o.textContent='Cliente fictício';select.append(o);}}}
    function renderSaleVendedorSelect(){const select=document.getElementById('sale_vendedor');if(!select.querySelector('[value="${SELLER}"]')){const o=document.createElement('option');o.value='${SELLER}';o.textContent='Vendedor fictício';select.append(o);}}
    function setSaleClient(id){document.getElementById('sale_client').value=id;}
    function findClientById(id){return db.clients.find(c=>c.id===id);}
    function syncInstallmentsUI(){}
    function syncTrocaWarning(){}
    function renderSalesTable(){}
    function renderHome(){}
    function pushStockToNuvemshop(){}
    function toast(){}
    async function loadProductsFromSupabase(){}
    async function loadStockMovesFromSupabase(){}
    function mapSaleFromDb(row){return {id:row.id,kind:row.kind,clientId:row.client_id,items:row.sale_items};}
  `);
  for (const source of sources) new vm.Script(source).runInContext(dom.getInternalVMContext());
  new vm.Script(saleSource).runInContext(dom.getInternalVMContext());
  const controller = () => w.eval('cartDraftController');
  const h = { w, calls, rows, lookups, productReads, alerts, controller, remote, clientCounts, counterQueries, counterUpdates, authCallbacks,
    get stockMoves() { return remote.stockMoves; },
    init: () => w.initCartDraftApp(),
    add(qty = 1) {
      w.currentSale.items = realm([{ productId: PRODUCT, name: product.name, size: product.size, barcode: product.barcode, price: 100, cost: 30, qty }]);
      w.document.getElementById('sale_discount').value = '0';
      w.renderSale();
    },
    get record() { return controller().store.load(); },
    setNote: text => { w.document.getElementById('sale_note').value = text; },
    changeAccount: id => authCallback('SIGNED_IN', { user: { id } }),
    close: () => { controller()?.dispose(); dom.window.close(); }
  };
  t.after(h.close);
  return h;
}

test('local cart scripts load in dependency order before main app; sale buttons stay locked until init', async t => {
  const h = harness(t);
  const names = [...h.w.document.scripts].map(script => script.getAttribute('src')).filter(name => name?.startsWith('cart-draft-'));
  assert.deepEqual(names, ['cart-draft-store.js', 'cart-draft-ui.js', 'cart-draft-app.js']);
  assert.equal(h.w.document.getElementById('btnFinalize').disabled, true);
  assert.equal(h.w.document.getElementById('sale_barcode').disabled, true);
  await h.init(); assert.equal(h.controller().canEdit(), true);
  assert.equal(h.w.document.getElementById('btnFinalize').disabled, false);
});

test('actual renderSale and quantity/remove controls persist draft changes', async t => {
  const h = harness(t); await h.init(); h.add(40);
  assert.equal(h.record.draft.items[0].qty, 40);
  const quantity = h.w.document.querySelector('#saleItems input[data-qty]'); quantity.value = '43';
  quantity.dispatchEvent(new h.w.Event('change', { bubbles: true }));
  assert.equal(h.record.draft.items[0].qty, 43);
  h.w.document.querySelector('#saleItems button[data-rm]').click(); assert.equal(h.record.draft.items.length, 0);
});

test('actual discount field persists and note stays out of local storage', async t => {
  const h = harness(t); await h.init(); h.add(40);
  const discount = h.w.document.getElementById('sale_discount'); discount.value = '123.45';
  discount.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  assert.equal(h.record.draft.discount, 123.45); h.setNote('Confidencial CPF 12345678900');
  await h.controller().finalize();
  assert.equal(h.calls.length, 0); assert.equal(h.w.currentSale.items.length, 1);
  assert.equal(h.w.document.getElementById('sale_note').value, 'Confidencial CPF 12345678900');
  assert.doesNotMatch(h.w.localStorage.getItem(h.controller().store.key), /Confidencial|12345678900/);
  assert.match(h.w.document.getElementById('cartDraftStatus').textContent, /Copie a observação/);
});

test('real app resets payment to Pendente and launches three consecutive sales without migration RPCs', async t => {
  const h = harness(t); await h.init();
  const payment = h.w.document.getElementById('sale_pay');
  assert.deepEqual([...payment.options].map(o => o.value), ['Pendente']);
  payment.value = 'PIX'; assert.equal(payment.value, '', 'reproduces the legacy empty select');
  for (let i = 0; i < 3; i++) {
    h.add(i + 1); await h.controller().finalize();
    assert.equal(h.controller().status, 'confirmed'); assert.equal(payment.value, 'Pendente');
    assert.equal(h.w.currentSale.items.length, 0); assert.equal(h.w.document.getElementById('btnFinalize').disabled, true);
    const button = [...h.w.document.querySelectorAll('#cartDraftStatus button')].find(b => b.textContent === 'Nova venda');
    assert.ok(button); await h.controller().startNew();
  }
  assert.equal(h.rows.size, 3); assert.equal(h.w.db.sales.length, 3); assert.equal(h.stockMoves, 6);
  assert.equal(new Set(h.calls.map(c => c.p_client_request_id)).size, 3);
  assert.ok(h.calls.every(c => c.p_pay === 'Pendente' && c.p_installments === 0 && c.p_note === null));
  assert.equal(h.lookups.length, 3); assert.equal(h.productReads.length, 3);
});

test('clearing with actual app resets payment and does not delete saved sales', async t => {
  const h = harness(t); await h.init(); h.add(40); h.w.document.getElementById('sale_pay').value = 'PIX';
  await h.controller().discard(); assert.equal(h.w.currentSale.items.length, 0);
  assert.equal(h.w.document.getElementById('sale_pay').value, 'Pendente');
  h.add(); await h.controller().finalize(); await h.controller().startNew();
  h.add(3); await h.controller().discard(); assert.equal(h.rows.size, 1); assert.equal(h.calls.length, 1);
});

test('actual finalize, Nova venda and clear button handlers route through the safe controller', async t => {
  const h = harness(t); await h.init(); h.add(40);
  h.w.document.getElementById('btnFinalize').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.controller().status, 'confirmed'); assert.equal(h.rows.size, 1);
  [...h.w.document.querySelectorAll('#cartDraftStatus button')].find(b => b.textContent === 'Nova venda').click();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.controller().canEdit(), true);
  h.add(2); h.w.document.getElementById('btnClearSale').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.w.currentSale.items.length, 0); assert.equal(h.calls.length, 1); assert.equal(h.rows.size, 1);
});

test('auth account change locks actual cart controls and leaves its stored draft in the original scope', async t => {
  const h = harness(t); await h.init(); h.add(44); const key = h.controller().store.key;
  h.changeAccount(uuid(9));
  assert.equal(h.controller().canEdit(), false); assert.equal(h.w.document.getElementById('btnFinalize').disabled, true);
  assert.equal(h.w.document.getElementById('cartDraftStatus').dataset.status, 'account-changed');
  assert.equal(JSON.parse(h.w.localStorage.getItem(key)).scope.userId, USER);
  assert.equal(JSON.parse(h.w.localStorage.getItem(key)).draft.items[0].qty, 44); assert.equal(h.calls.length, 0);
});

test('fresh stock check blocks missing, unavailable or insufficient product without losing cart', async t => {
  for (const options of [{ productError: true }, { missingProduct: true }, { stock: 2 }]) {
    const h = harness(t, options); await h.init(); h.add(40); await h.controller().finalize();
    assert.equal(h.calls.length, 0); assert.equal(h.w.currentSale.items[0].qty, 40);
    assert.equal(h.record.status, 'draft'); assert.equal(h.record.draft.items[0].qty, 40);
  }
});

test('app blocks discount above updated subtotal but preserves it for correction', async t => {
  const h = harness(t); await h.init(); h.add(2); h.w.document.getElementById('sale_discount').value = '201';
  await h.controller().finalize(); assert.equal(h.calls.length, 0);
  assert.equal(h.record.draft.discount, 201); assert.match(h.w.document.getElementById('cartDraftStatus').textContent, /subtotal/);
});

test('app preserves pending snapshot and disables actual controls when post-submit lookup fails', async t => {
  const h = harness(t, { lostResponse: true, lookupError: true }); await h.init(); h.add(40); await h.controller().finalize();
  assert.equal(h.record.status, 'pending'); assert.equal(h.calls.length, 1); assert.equal(h.rows.size, 1);
  for (const id of ['sale_discount', 'sale_note', 'sale_barcode', 'btnManualAdd', 'btnFinalize', 'btnClearSale']) assert.equal(h.w.document.getElementById(id).disabled, true, id);
  for (const control of h.w.document.querySelectorAll('#saleItems input, #saleItems button')) assert.equal(control.disabled, true);
  const labels = [...h.w.document.querySelectorAll('#cartDraftStatus button')].map(b => b.textContent);
  assert.deepEqual(labels, ['Verificar se a venda foi salva']);
  assert.match(h.w.document.getElementById('cartDraftStatus').textContent, /40 peças guardadas/);
});

test('saved pending request found after lost response updates recent sales once and clears cart', async t => {
  const h = harness(t, { lostResponse: true }); await h.init(); h.add(40); await h.controller().finalize();
  assert.equal(h.controller().status, 'confirmed'); assert.equal(h.rows.size, 1); assert.equal(h.w.db.sales.length, 1);
  assert.equal(h.calls.length, 1); assert.equal(h.w.currentSale.items.length, 0); assert.equal(h.stockMoves, 40);
});

test('stored draft status renders product names as text, not injected HTML', async t => {
  const h = harness(t); await h.init(); h.add(3);
  h.w.db.products[0].name = '<img src=x onerror=alert(1)>';
  h.w.cartDraftShow({ status: 'restore', message: 'Revisar', draft: h.record.draft, canRestore: true });
  assert.equal(h.w.document.querySelector('#cartDraftStatus img'), null);
  assert.match(h.w.document.getElementById('cartDraftStatus').textContent, /<img src=x/);
});

test('BFCache page restored after another tab sold and reset the same cart cannot submit stale items again', async t => {
  const storage = sharedMemory(), locks = sharedLocks();
  const first = harness(t, { storage, locks }); await first.init(); first.add(40);
  first.w.dispatchEvent(new first.w.PageTransitionEvent('pagehide', { persisted: true })); await tick();
  assert.equal(first.w.currentSale.items[0].qty, 40, 'BFCache retains the old in-memory form');
  assert.equal(first.controller().canEdit(), false);
  const other = harness(t, { storage, locks, remote: first.remote }); await other.init();
  assert.equal(other.controller().status, 'restore'); await other.controller().restore();
  assert.equal(other.w.currentSale.items[0].qty, 40);
  await other.controller().finalize(); assert.equal(other.rows.size, 1); assert.equal(other.stockMoves, 40);
  await other.controller().startNew(); assert.equal(other.record.status, 'empty');
  other.w.dispatchEvent(new other.w.PageTransitionEvent('pagehide', { persisted: true })); await tick();
  first.w.dispatchEvent(new first.w.PageTransitionEvent('pageshow', { persisted: true })); await tick();
  assert.equal(first.controller().status, 'empty'); assert.equal(first.controller().canEdit(), true);
  assert.equal(first.w.currentSale.items.length, 0, 'empty durable state must clear the stale BFCache form');
  first.w.document.getElementById('btnFinalize').click(); await tick();
  assert.equal(first.calls.length, 1); assert.equal(first.rows.size, 1); assert.equal(first.stockMoves, 40);
});

test('BFCache restore while another tab has confirmed cart keeps the stale form locked until Nova venda', async t => {
  const storage = sharedMemory(), locks = sharedLocks();
  const first = harness(t, { storage, locks }); await first.init(); first.add(42);
  first.w.dispatchEvent(new first.w.PageTransitionEvent('pagehide', { persisted: true })); await tick();
  const other = harness(t, { storage, locks, remote: first.remote }); await other.init(); await other.controller().restore();
  await other.controller().finalize(); other.w.dispatchEvent(new other.w.PageTransitionEvent('pagehide', { persisted: true })); await tick();
  first.w.dispatchEvent(new first.w.PageTransitionEvent('pageshow', { persisted: true })); await tick();
  assert.equal(first.controller().status, 'confirmed'); assert.equal(first.controller().canEdit(), false);
  first.w.document.getElementById('btnFinalize').click(); await tick(); assert.equal(first.calls.length, 1);
  await first.controller().startNew(); assert.equal(first.w.currentSale.items.length, 0); assert.equal(first.controller().canEdit(), true);
});

test('late validation from a BFCache controller cannot restore or send its old cart over a newer draft', async t => {
  const storage = sharedMemory(), locks = sharedLocks(), productGate = deferred(), productStarted = deferred();
  const first = harness(t, { storage, locks, productGate, productStarted }); await first.init(); first.add(40);
  const originalController = first.controller(); const originalFinalize = originalController.finalize(); await productStarted.promise;
  first.w.dispatchEvent(new first.w.PageTransitionEvent('pagehide', { persisted: true })); await tick();
  const other = harness(t, { storage, locks, remote: first.remote }); await other.init(); await other.controller().restore();
  await other.controller().finalize(); await other.controller().startNew();
  other.w.dispatchEvent(new other.w.PageTransitionEvent('pagehide', { persisted: true })); await tick();
  first.w.dispatchEvent(new first.w.PageTransitionEvent('pageshow', { persisted: true })); await tick();
  const activeController = first.controller(); assert.notEqual(activeController, originalController);
  assert.equal(activeController.status, 'empty'); assert.equal(first.w.currentSale.items.length, 0);
  first.add(3); const before = storage.getItem(activeController.store.key);
  productGate.resolve(); await originalFinalize; await tick();
  assert.equal(first.w.currentSale.items[0].qty, 3); assert.equal(first.record.draft.items[0].qty, 3);
  assert.equal(storage.getItem(activeController.store.key), before, 'late result must not persist the obsolete cart');
  assert.equal(activeController.status, 'editing'); assert.equal(activeController.canEdit(), true);
  assert.equal(first.w.document.getElementById('btnFinalize').disabled, false);
  assert.equal(first.calls.length, 1); assert.equal(first.rows.size, 1); assert.equal(first.stockMoves, 40);
  first.authCallbacks[0]('SIGNED_OUT', null);
  assert.equal(activeController.canEdit(), true, 'old auth subscription cannot dispose the current controller');
  assert.equal(first.w.document.getElementById('btnFinalize').disabled, false);
});

function makeExchange(h, priorCount = 0) {
  h.add(2); h.w.document.getElementById('sale_client').value = CLIENT;
  h.w.document.getElementById('sale_kind').value = 'Troca';
  h.w.document.getElementById('overrideTroca').checked = priorCount > 0;
  h.w.cartDraftChanged();
}

test('confirmed exchange uses exact sale count once and conditional counter update', async t => {
  const h = harness(t, { clients: [{ id: CLIENT, trocaCount: 0 }] }); await h.init(); makeExchange(h);
  await h.controller().finalize();
  assert.equal(h.controller().status, 'confirmed'); assert.equal(h.calls.length, 1);
  assert.equal(h.counterQueries.length, 1); assert.equal(h.counterQueries[0].query.count, 'exact');
  assert.equal(h.counterUpdates.length, 1); assert.equal(h.counterUpdates[0].value.troca_count, 1);
  assert.equal(h.counterUpdates[0].guard, 'troca_count'); assert.equal(h.counterUpdates[0].count, 1);
  assert.equal(h.clientCounts.get(CLIENT), 1); assert.equal(h.w.db.clients[0].trocaCount, 1);
  await h.controller().checkPending(); await h.controller().finalize();
  assert.equal(h.counterUpdates.length, 1); assert.equal(h.calls.length, 1); assert.equal(h.stockMoves, 2);
});

test('exchange count update never lowers a larger legacy client count', async t => {
  const h = harness(t, { clients: [{ id: CLIENT, trocaCount: 5 }] }); await h.init(); makeExchange(h, 5);
  await h.controller().finalize(); assert.equal(h.controller().status, 'confirmed');
  assert.equal(h.counterUpdates.length, 1); assert.equal(h.counterUpdates[0].count, 1);
  assert.equal(h.clientCounts.get(CLIENT), 5); assert.equal(h.w.db.clients[0].trocaCount, 5);
});

test('exchange count read/update failure preserves confirmed sale without retrying stock or payment effects', async t => {
  for (const options of [{ counterReadError: true }, { counterUpdateError: true }]) {
    const h = harness(t, { ...options, clients: [{ id: CLIENT, trocaCount: 0 }] }); await h.init(); makeExchange(h);
    await h.controller().finalize(); assert.equal(h.record.status, 'confirmed'); assert.equal(h.controller().status, 'confirmed');
    assert.equal(h.rows.size, 1); assert.equal(h.calls.length, 1); assert.equal(h.stockMoves, 2);
    assert.equal(h.clientCounts.get(CLIENT), 0); assert.equal(h.w.currentSale.items.length, 0);
    assert.match(h.w.document.getElementById('cartDraftStatus').textContent, /Não reenvie/);
    await h.controller().checkPending(); await h.controller().finalize();
    assert.equal(h.calls.length, 1); assert.equal(h.stockMoves, 2);
    assert.equal(h.counterUpdates.length, options.counterReadError ? 0 : 1);
  }
});
