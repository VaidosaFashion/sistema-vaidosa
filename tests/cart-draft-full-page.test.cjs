'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER = uuid(1), CLIENT = uuid(2), SELLER = uuid(3), PRODUCT = uuid(4);
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

async function fullPage(t, initialStorage = {}) {
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
    sales: [], stock_moves: [], categorias: [{ id: uuid(6), nome: 'Vendas', tipo: 'receita' }],
    v_contas: [], movimentacoes: [], store_settings: [{ id: 1, card_fees: null }]
  };
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
  const sb = {
    auth: {
      async getSession() { authCalls++; return realm({ data: { session: { user: { id: USER } } }, error: null }); },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithPassword() { throw new Error('Real authentication is prohibited'); },
      signOut() { throw new Error('Unexpected sign out'); }
    },
    from: query,
    rpc(name) { writes.push({ rpc: name }); throw new Error('Unexpected RPC in full-page startup test'); },
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
  return { w, errors, reads, writes, networkAttempts, executed, controller,
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
