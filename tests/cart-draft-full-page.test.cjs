'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { fixtureSale, saleId, paymentId, clone } = require('./financial-fixture.cjs');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER = uuid(1), CLIENT = uuid(2), SELLER = uuid(3), PRODUCT = uuid(4);
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

async function fullPage(t, initialStorage = {}, options = {}) {
  const errors = [], reads = [], writes = [], networkAttempts = [], executed = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  // No resource loader: not even CDN script/image requests leave this process.
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://offline.invalid/', virtualConsole });
  const w = dom.window;
  const realm = value => w.JSON.parse(JSON.stringify(value));
  for (const [key, value] of Object.entries(initialStorage)) w.localStorage.setItem(key, value);
  w.addEventListener('error', event => errors.push(event.error || new Error(event.message)));
  w.addEventListener('unhandledrejection', event => errors.push(event.reason));
  w.confirm = () => true;
  w.fetch = async url => { networkAttempts.push(String(url)); throw new Error('Offline test blocks all fetch'); };
  w.XMLHttpRequest = class { constructor() { throw new Error('Offline test blocks XHR'); } };
  w.WebSocket = class { constructor() { throw new Error('Offline test blocks WebSocket'); } };
  w.Image = class { set src(_) {} };
  w.Chart = class { destroy() {} };
  w.JsBarcode = () => {};
  w.jspdf = { jsPDF: class {} };
  w.turnstile = { render: () => 'fixture-widget', reset() {} };
  let locked = false;
  Object.defineProperty(w.navigator, 'locks', { value: { request: async (_, __, callback) => {
    if (locked) return callback(null);
    locked = true;
    try { return await callback({}); } finally { locked = false; }
  } } });
  const fixtures = {
    profiles: [{ id: USER, display_name: 'Usuário fictício', active: true, is_admin: true, vendedor_id: SELLER }],
    colors: [{ id: uuid(5), nome: 'Azul fictício' }],
    products: [{ id: PRODUCT, name: 'Produto fictício', size: 'G2', barcode: 'TEST-004', stock: 60, cost: 25,
      price_atacado: 50, price_varejo: 80, color_id: uuid(5), colors: { nome: 'Azul fictício' } }],
    clients: [{ id: CLIENT, name: 'Cliente fictício', troca_count: 0 }],
    vendedores: [{ id: SELLER, name: 'Vendedor fictício' }],
    sales: options.financial ? [clone(options.sale || fixtureSale())] : [], sale_financial_audit: [],
    stock_moves: [], categorias: [{ id: uuid(6), nome: 'Vendas', tipo: 'receita' }],
    v_contas: [], movimentacoes: [], store_settings: [{ id: 1, card_fees: null }]
  };
  if (options.financial) for (const item of fixtures.sales[0].sale_items) fixtures.products.push({
    id:item.product_id,name:item.name,size:item.size,barcode:item.barcode,stock:10,cost:item.cost,
    price_atacado:item.price,price_varejo:item.price,color_id:uuid(5),colors:{nome:'Azul fictício'}
  });
  function query(table) {
    assert.ok(Object.hasOwn(fixtures, table), `Unexpected table: ${table}`);
    const filters = [];
    let one = false, range;
    const result = () => {
      reads.push(table);
      let data = fixtures[table].filter(row => filters.every(([key, values]) => values.includes(row[key])));
      if (range) data = data.slice(range[0], range[1] + 1);
      return realm({ data: one ? data[0] || null : data, error: null });
    };
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; },
      eq(key, value) { filters.push([key, [value]]); return q; },
      in(key, values) { filters.push([key, [...values]]); return q; },
      range(from, to) { range = [from, to]; return q; },
      single() { one = true; return q; }, maybeSingle() { one = true; return q; },
      then(resolve, reject) { return Promise.resolve().then(result).then(resolve, reject); }
    };
    for (const op of ['insert', 'update', 'upsert', 'delete']) q[op] = () => { writes.push({ table, op }); throw new Error(`Unexpected mutation ${table}.${op}`); };
    return q;
  }
  let authCalls = 0;
  const financialRequests = new Map();
  const sb = {
    auth: {
      async getSession() { authCalls++; return realm({ data: { session: { user: { id: USER } } }, error: null }); },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithPassword() { throw new Error('Real authentication is prohibited'); },
      signOut() { throw new Error('Unexpected sign out'); }
    },
    from: query,
    async rpc(name, payload) {
      writes.push({ rpc: name, payload: clone(payload) });
      assert.ok(options.financial && name === 'edit_sale_financials', 'Only explicit financial fixture RPC is allowed');
      if (financialRequests.has(payload.p_request_id)) return realm({ data: fixtures.sales[0], error: null });
      const before = clone(fixtures.sales[0]);
      assert.equal(payload.p_sale_id, before.id); assert.equal(payload.p_expected_revision, before.finance_revision);
      const payments = payload.p_payments.map(payment => {
        const previous = before.sale_payments.find(p => p.id === payment.id);
        assert.ok(previous, 'financial correction preserves payment IDs');
        const sameTerms = previous.method === payment.method && previous.installments === payment.installments;
        const feePct = sameTerms ? previous.fee_pct : w.taxaDoPagamento(payment.method, payment.installments);
        const feeValue = Math.round(payment.value * feePct) / 100;
        return { ...previous, ...payment, fee_pct: feePct, fee_value: feeValue, net_value: payment.value - feeValue };
      });
      const after = { ...before, discount: payload.p_discount, total_bruto: before.subtotal - payload.p_discount,
        sale_payments: payments, finance_revision: before.finance_revision + 1 };
      after.fee_value = payments.reduce((sum, payment) => sum + payment.fee_value, 0);
      after.net_received = payments.reduce((sum, payment) => sum + payment.net_value, 0);
      after.profit = after.net_received - before.cost_total;
      after.pay = [...new Set(payments.map(payment => payment.method))].join() || 'Pendente';
      fixtures.sales[0] = after; financialRequests.set(payload.p_request_id, true);
      fixtures.sale_financial_audit.push({created_at:'2026-11-04T13:00:00Z',reason:payload.p_reason,before_data:before,after_data:clone(after)});
      if (options.lostFinancialResponse && financialRequests.size === 1 && writes.length === 1) throw Error('Conexão interrompida depois da gravação fictícia');
      return realm({ data: after, error: null });
    },
    functions: { invoke() { throw new Error('Unexpected external integration'); } }
  };
  w.supabase = { createClient: () => sb };
  t.after(() => {
    try { w.eval('cartDraftController?.dispose()'); } catch {}
    dom.window.close();
  });
  const remoteStubs = ['jspdf', 'chart.js', 'supabase-js', 'JsBarcode', 'turnstile'];
  for (const [i, script] of [...w.document.scripts].entries()) {
    const src = script.getAttribute('src');
    if (src?.startsWith('https://')) {
      assert.ok(remoteStubs.some(name => src.toLowerCase().includes(name.toLowerCase())), `Missing explicit external stub: ${src}`);
      continue;
    }
    const filename = src || `index.inline.${i}.js`;
    const text = src ? fs.readFileSync(path.join(root, src), 'utf8') : script.textContent;
    // Evaluate whole script as shipped, not an extracted handler or wrapper.
    new vm.Script(text, { filename }).runInContext(dom.getInternalVMContext());
    executed.push(filename);
  }
  const controller = () => w.eval('cartDraftController');
  for (let n = 0; n < 100; n++) {
    await nextTurn();
    if (errors.length) throw errors[0];
    if (controller() && ['editing', 'restore', 'error', 'readonly'].includes(controller().status)) break;
  }
  assert.ok(controller(), 'automatic authenticated initialization must create the cart controller');
  assert.notEqual(controller().status, 'error', w.document.getElementById('cartDraftStatus').textContent);
  assert.equal(errors.length, 0);
  return { w, errors, reads, writes, networkAttempts, executed, controller, fixtures,
    authCalls: () => authCalls,
    state: () => w.eval('({ currentSale, db, currentProfile })'),
    storage: () => Object.fromEntries(Array.from({ length: w.localStorage.length }, (_, i) => {
      const key = w.localStorage.key(i); return [key, w.localStorage.getItem(key)];
    }))
  };
}

test('entire HTML scripts and main parse in shipped order; real async init reaches editable cart', async t => {
  const h = await fullPage(t);
  assert.deepEqual(h.executed.slice(0, 3), ['cart-draft-store.js', 'cart-draft-ui.js', 'cart-draft-app.js']);
  assert.ok(h.executed.some(name => name.startsWith('index.inline.')));
  assert.equal(h.controller().canEdit(), true);
  assert.equal(h.state().currentProfile.id, USER);
  assert.equal(h.state().db.products[0].id, PRODUCT);
  assert.equal(h.w.document.getElementById('loginGate').classList.contains('hide'), true);
  assert.equal(h.w.document.getElementById('sale_barcode').disabled, false);
  assert.ok(h.authCalls() >= 2, 'startup and draft controller both check the fake session');
  for (const table of ['profiles', 'colors', 'products', 'stock_moves', 'clients', 'vendedores', 'sales', 'categorias', 'v_contas', 'store_settings', 'movimentacoes']) assert.ok(h.reads.includes(table), table);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.networkAttempts, ['http://localhost:9100/available'], 'printer probe is intercepted, never sent');
});

test('full initialized page persists real client/item controls, excludes note and clears via real reset', async t => {
  const h = await fullPage(t);
  h.w.setSaleClient(CLIENT);
  h.w.handleBarcodeInput('TEST-004');
  const note = h.w.document.getElementById('sale_note');
  note.value = 'Observação fictícia sensível';
  note.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  assert.equal(h.w.document.getElementById('sale_client').value, CLIENT);
  assert.equal(h.w.document.getElementById('sale_clientBusca').value, 'Cliente fictício');
  assert.equal(h.state().currentSale.items.length, 1);
  const record = h.controller().store.load();
  assert.equal(record.draft.clientId, CLIENT);
  assert.equal(record.draft.items[0].productId, PRODUCT);
  assert.doesNotMatch(JSON.stringify(h.storage()), /Observação fictícia sensível/);
  await h.controller().finalize();
  assert.deepEqual(h.writes, []);
  assert.match(h.w.document.getElementById('cartDraftStatus').textContent, /observação/i);
  assert.equal(note.value, 'Observação fictícia sensível');
  h.w.document.getElementById('btnClearSale').click();
  await nextTurn();
  assert.equal(h.state().currentSale.items.length, 0);
  assert.equal(h.w.document.getElementById('sale_client').value, '');
  assert.equal(h.w.document.getElementById('sale_clientBusca').value, '');
  assert.equal(h.w.document.getElementById('sale_pay').value, 'Pendente');
  assert.equal(note.value, '');
  assert.equal(h.errors.length, 0);
});

test('reload with persisted draft runs full initialization and restores client/items with note omitted', async t => {
  const first = await fullPage(t);
  first.w.setSaleClient(CLIENT);
  first.w.handleBarcodeInput('TEST-004');
  first.w.document.getElementById('sale_note').value = 'Nota não persistida';
  const stored = first.storage();
  first.controller().dispose();
  const restored = await fullPage(t, stored);
  assert.equal(restored.controller().status, 'restore');
  assert.equal(restored.w.document.getElementById('sale_barcode').disabled, true);
  await restored.controller().restore();
  assert.equal(restored.controller().canEdit(), true);
  assert.equal(restored.state().currentSale.items[0].productId, PRODUCT);
  assert.equal(restored.w.document.getElementById('sale_client').value, CLIENT);
  assert.equal(restored.w.document.getElementById('sale_clientBusca').value, 'Cliente fictício');
  assert.equal(restored.w.document.getElementById('sale_note').value, '');
  assert.equal(restored.w.document.getElementById('sale_pay').value, 'Pendente');
  assert.deepEqual(restored.writes, []);
  assert.equal(restored.errors.length, 0);
});

function addLiveCart(h) {
  h.w.setSaleClient(CLIENT); h.w.handleBarcodeInput('TEST-004');
  const quantity = h.w.document.querySelector('#saleItems input[data-qty]');
  quantity.value = '40'; quantity.dispatchEvent(new h.w.Event('change', { bubbles: true }));
  assert.equal(h.state().currentSale.items[0].qty, 40);
}

function financialEdit(h) {
  for (const [id, value] of [['fc_discount', '600'], ['fc_value_' + paymentId, '2400'], ['fc_reason', 'Desconto combinado após finalizar']]) {
    const input = h.w.document.getElementById(id); input.value = value;
    input.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  }
}

async function submitFinancial(h) {
  h.w.document.getElementById('financialCorrectionForm').dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
  await nextTurn();
}

function invariants(h) {
  return {
    cart: JSON.stringify(h.state().currentSale), storage: JSON.stringify(h.storage()),
    products: JSON.stringify(h.state().db.products),
    visibleSoldItems: JSON.stringify(h.state().db.sales.find(sale => sale.id === saleId).items),
    pieces: JSON.stringify(h.fixtures.sales[0].sale_items), stockMoves: JSON.stringify(h.fixtures.stock_moves)
  };
}

test('full page financial cancel keeps active 40-piece cart, sold 60 items and stock unchanged', async t => {
  const h = await fullPage(t, {}, { financial: true }); addLiveCart(h);
  const before = invariants(h); const revision = h.fixtures.sales[0].finance_revision;
  await h.w.openFinancialCorrection(saleId); financialEdit(h);
  h.w.document.getElementById('btnCancelFinancialCorrection').click();
  assert.equal(h.w.document.getElementById('modalFinancialCorrection').classList.contains('hide'), true);
  assert.deepEqual(invariants(h), before); assert.equal(h.controller().canEdit(), true);
  assert.equal(h.fixtures.sales[0].finance_revision, revision); assert.deepEqual(h.writes, []);
  assert.equal(h.errors.length, 0);
});

test('full page financial save adjusts existing payment and discount while active cart, 60 items and inventory stay intact', async t => {
  const h = await fullPage(t, {}, { financial: true }); addLiveCart(h);
  const before = invariants(h); await h.w.openFinancialCorrection(saleId); financialEdit(h); await submitFinancial(h);
  assert.equal(h.w.document.getElementById('modalFinancialCorrection').classList.contains('hide'), true);
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].rpc, 'edit_sale_financials');
  const payload = h.writes[0].payload;
  assert.equal(payload.p_sale_id, saleId); assert.equal(payload.p_discount, 600);
  assert.equal(payload.p_payments[0].id, paymentId); assert.equal(payload.p_payments[0].value, 2400);
  assert.deepEqual(invariants(h), before, 'financial edit must not mutate a separate live cart, sale_items or stock');
  const saved = h.state().db.sales.find(sale => sale.id === saleId);
  assert.equal(saved.totalBruto, 2400); assert.equal(saved.netReceived, 2400); assert.equal(saved.financeRevision, 5);
  assert.equal(saved.items.length, 60); assert.equal(saved.payments[0].id, paymentId);
  assert.equal(h.controller().canEdit(), true); assert.equal(h.w.document.getElementById('btnFinalize').disabled, false);
  assert.equal(h.fixtures.sale_financial_audit.length, 1);
  assert.doesNotMatch(JSON.stringify(h.storage()), /Desconto combinado/);
  await submitFinancial(h); assert.equal(h.writes.length, 1, 'closed financial form cannot repeat the save');
  assert.equal(h.errors.length, 0);
});

test('full page financial retry after lost response leaves pending cart frozen and does not duplicate financial effects', async t => {
  const h = await fullPage(t, {}, { financial: true, lostFinancialResponse: true }); addLiveCart(h);
  h.w.eval('cartDraftController.store.prepare(cartDraftPayload(cartDraftCapture())); cartDraftController.load();');
  assert.equal(h.controller().status, 'pending'); const before = invariants(h);
  await h.w.openFinancialCorrection(saleId); financialEdit(h); await submitFinancial(h);
  assert.equal(h.fixtures.sales[0].total_bruto, 2400, 'fixture server committed before losing the response');
  assert.equal(h.w.document.getElementById('modalFinancialCorrection').classList.contains('hide'), false);
  assert.match(h.w.document.getElementById('fc_error').textContent, /Conexão interrompida/);
  assert.deepEqual(invariants(h), before); assert.equal(h.controller().canEdit(), false);
  await submitFinancial(h);
  assert.equal(h.writes.length, 2); assert.deepEqual(h.writes[0], h.writes[1]);
  assert.equal(h.fixtures.sales[0].finance_revision, 5); assert.equal(h.fixtures.sale_financial_audit.length, 1);
  assert.deepEqual(invariants(h), before); assert.equal(h.controller().status, 'pending');
  for (const id of ['btnFinalize', 'btnClearSale', 'sale_barcode', 'sale_discount']) assert.equal(h.w.document.getElementById(id).disabled, true, id);
  assert.ok(h.writes.every(write => write.rpc === 'edit_sale_financials'), 'no sale creation, deletion or stock RPC');
  assert.equal(h.errors.length, 0);
});
