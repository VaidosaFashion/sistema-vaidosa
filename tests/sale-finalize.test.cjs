const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('  // Uma tentativa sem resposta pode já ter sido gravada.');
const end = html.indexOf('  function sendWhatsApp(', start);
assert.ok(start !== -1 && end > start, 'finalization flow must be present');
const source = html.slice(start, end);

function harness({ rpc, historyError = false } = {}) {
  // No scripts, resource loading, credentials or real Supabase connection.
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  const calls = [];
  const saved = new Map();
  const notifications = [];
  const handlers = {};
  const timers = [];
  for (const id of ['btnFinalize', 'btnClearSale']) {
    w.document.getElementById(id).addEventListener = (_, fn) => { handlers[id] = fn; };
  }
  w.currentSale = { items: [], finalizedSaleId: null };
  w.db = { sales: [], products: [{ id: 'product-1', name: 'Produto fictício', stock: 20 }] };
  w.settings = { blockSecondSwap: true };
  w.toNum = value => Number(value || 0);
  w.findClientById = () => null;
  w.saleTotals = () => ({ disc: Number(w.document.getElementById('sale_discount').value || 0) });
  w.currentPriceTier = () => w.document.getElementById('sale_price_tier').value;
  w.setSaleClient = value => { w.document.getElementById('sale_client').value = value; };
  w.renderSale = w.renderHome = w.renderSalesTable = () => {};
  w.toast = (...args) => notifications.push(args);
  w.pushStockToNuvemshop = () => {};
  w.loadStockMovesFromSupabase = async () => {
    if (historyError) throw new Error('simulated history unavailable');
  };
  w.mapSaleFromDb = row => ({ id: row.id, date: row.sold_at, items: row.sale_items, payments: row.sale_payments });
  w.console.warn = () => {};
  w.setTimeout = callback => { timers.push(callback); };
  function persist(payload) {
    if (!payload.p_pay) return { data: null, error: { code: '23514', message: 'sales_pay_check' }, status: 400 };
    let row = saved.get(payload.p_client_request_id);
    if (!row) {
      row = { id: `sale-${saved.size + 1}`, sold_at: '2026-11-04T12:00:00.000Z', pay: payload.p_pay };
      saved.set(payload.p_client_request_id, row);
    }
    return { data: row, error: null, status: 200 };
  }
  w.sb = { rpc: async (name, payload) => {
    assert.equal(name, 'create_sale');
    calls.push(JSON.parse(JSON.stringify(payload)));
    return rpc ? rpc(payload, calls.length, persist) : persist(payload);
  } };
  w.eval(source);
  const add = () => w.currentSale.items.push({ productId: 'product-1', name: 'Produto fictício', qty: 1, price: 100, cost: 50, barcode: 'TEST-1' });
  return { w, calls, saved, notifications, timers, add, finalize: handlers.btnFinalize, clear: handlers.btnClearSale, close: () => dom.window.close() };
}

test('hidden payment select reproduces the original invalid PIX reset', () => {
  const h = harness();
  const select = h.w.document.getElementById('sale_pay');
  assert.deepEqual([...select.options].map(option => option.value), ['Pendente']);
  select.value = 'PIX';
  assert.equal(select.value, '', 'old reset lost the payment value before the second sale');
  h.close();
});

test('two consecutive sales on the same date use distinct requests and pending payment', async () => {
  const h = harness();
  h.add();
  await h.finalize();
  assert.equal(h.w.currentSale.items.length, 0, 'confirmed sale is cleared immediately');
  assert.equal(h.w.document.getElementById('sale_pay').value, 'Pendente');
  h.add();
  await h.finalize();
  assert.equal(h.saved.size, 2);
  assert.equal(h.w.db.sales.length, 2);
  assert.equal(new Set(h.w.db.sales.map(s => s.date)).size, 1);
  assert.notEqual(h.calls[0].p_client_request_id, h.calls[1].p_client_request_id);
  assert.ok(h.calls.every(p => p.p_pay === 'Pendente' && p.p_installments === 0));
  assert.equal(h.w.db.products[0].stock, 18);
  assert.equal(h.timers.length, 0, 'no delayed reset may erase the next cart');
  h.close();
});

test('clearing a draft keeps the next sale valid', async () => {
  const h = harness();
  h.add();
  h.clear();
  assert.equal(h.w.currentSale.items.length, 0);
  assert.equal(h.w.document.getElementById('sale_pay').value, 'Pendente');
  h.add();
  await h.finalize();
  assert.equal(h.saved.size, 1);
  h.close();
});

test('parallel clicks and clear cannot change an in-flight request', async () => {
  let resolve;
  const h = harness({ rpc: (payload, _, persist) => new Promise(r => { resolve = () => r(persist(payload)); }) });
  h.add();
  const inFlight = h.finalize();
  assert.equal(h.w.document.getElementById('sale_discount').disabled, true);
  assert.equal(h.w.document.getElementById('btnClearSale').disabled, true);
  h.clear();
  await h.finalize();
  assert.equal(h.calls.length, 1);
  assert.equal(h.w.currentSale.items.length, 1);
  resolve();
  await inFlight;
  assert.equal(h.saved.size, 1);
  assert.equal(h.w.document.getElementById('sale_discount').disabled, false);
  h.close();
});

test('lost response retries the same committed sale without duplicate stock decrement', async () => {
  const h = harness({ rpc: (payload, attempt, persist) => {
    const result = persist(payload);
    return attempt === 1 ? { data: null, error: { message: 'Failed to fetch' }, status: 0 } : result;
  } });
  h.add();
  await h.finalize();
  assert.equal(h.saved.size, 1, 'server already committed before response was lost');
  assert.equal(h.w.document.getElementById('btnFinalize').textContent, 'Confirmar venda pendente');
  assert.equal(h.w.document.getElementById('btnClearSale').disabled, true);
  h.clear();
  assert.equal(h.w.currentSale.items.length, 1);
  await h.finalize();
  assert.deepEqual(h.calls[0], h.calls[1]);
  assert.equal(h.saved.size, 1);
  assert.equal(h.w.db.sales.length, 1);
  assert.equal(h.w.db.products[0].stock, 19);
  h.close();
});

test('definitive SQL rejection preserves editable draft and does not change stock', async () => {
  const h = harness({ rpc: () => ({ data: null, error: { code: 'P0001', message: 'Estoque insuficiente' }, status: 400 }) });
  h.add();
  await h.finalize();
  assert.equal(h.saved.size, 0);
  assert.equal(h.w.currentSale.items.length, 1);
  assert.equal(h.w.db.products[0].stock, 20);
  assert.equal(h.w.document.getElementById('sale_discount').disabled, false);
  assert.equal(h.w.document.getElementById('btnClearSale').disabled, false);
  h.close();
});

test('history refresh failure after commit cannot resubmit a sold cart', async () => {
  const h = harness({ historyError: true });
  h.add();
  await h.finalize();
  assert.equal(h.saved.size, 1);
  assert.equal(h.w.currentSale.items.length, 0);
  assert.equal(h.w.db.products[0].stock, 19);
  await h.finalize();
  assert.equal(h.calls.length, 1);
  assert.ok(h.notifications.some(([title]) => title === 'Venda salva'));
  h.close();
});
