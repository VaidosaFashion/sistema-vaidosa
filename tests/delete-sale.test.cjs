const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('  function openSaleDrawer(');
const end = html.indexOf('  let pendingPaymentSubmission = null;', start);
const missingStart = html.indexOf('  function isMissingRpc(');
const missingEnd = html.indexOf('  function setProductStockFieldsEnabled(', missingStart);
assert.ok(start > 0 && end > start && missingStart > 0 && missingEnd > missingStart);

function harness({ rpcError = null, fiscal = null, fiscalError = null, confirm = true } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  const calls = { rpc: [], reads: [], writes: [], stock: [], sync: [], reloads: 0 };
  const notifications = [];
  let pendingClick = Promise.resolve();
  const addEventListener = w.EventTarget.prototype.addEventListener;
  w.EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (this.id === 'sd_excluir' && type === 'click') {
      return addEventListener.call(this, type, event => {
        pendingClick = Promise.resolve(listener.call(this, event));
      }, options);
    }
    return addEventListener.call(this, type, listener, options);
  };
  w.db = {
    sales: [{ id: 'sale-1', date: '2026-11-04T12:00:00Z', totalBruto: 600,
      paymentStatus: 'Pago', payments: [{ method: 'PIX', value: 600, date: '2026-11-04' }],
      items: [{ productId: 'p1', barcode: 'VF000001', name: 'Peça teste', qty: 60, price: 10 }] }],
    products: [{ id: 'p1', stock: 5 }], stockMoves: []
  };
  w.saleDrawerId = null;
  w.toNum = value => Number(value || 0);
  w.escapeHtml = value => String(value);
  w.fmtBRL = value => `R$ ${Number(value).toFixed(2)}`;
  w.fmtDataBR = value => value;
  w.findClientById = w.findVendedorById = () => null;
  w.corDoItem = () => '';
  w.getSalePaymentStatus = sale => sale.paymentStatus;
  w.chipDeStatus = () => 'chipPago';
  w.confirm = () => confirm;
  w.toast = (...args) => notifications.push(args);
  w.renderSale = w.renderHome = () => {};
  w.loadProductsFromSupabase = async () => { w.db.products[0].stock=63; }; // canonical 65 minus concurrent sale of 2
  w.loadStockMovesFromSupabase = async () => { calls.reloads += 1; };
  w.pushStockToNuvemshop = barcodes => calls.sync.push([...barcodes]);
  w.applyStockEntry = async (product, qty) => {
    calls.stock.push({ id: product.id, qty });
    product.stock += qty;
    return { ok: true };
  };
  w.sb = {
    rpc: async (name, payload) => {
      calls.rpc.push({ name, payload: JSON.parse(JSON.stringify(payload)) });
      return { error: rpcError };
    },
    from: table => {
      const query = {
        select: columns => { calls.reads.push({ table, columns }); return query; },
        eq: () => query,
        maybeSingle: async () => ({ data: fiscal, error: fiscalError }),
        then: (resolve, reject) => Promise.resolve({ data: null, error: null }).then(resolve, reject)
      };
      for (const operation of ['insert', 'update', 'delete', 'upsert']) {
        query[operation] = payload => { calls.writes.push({ table, operation, payload }); return query; };
      }
      return query;
    }
  };
  w.eval(html.slice(missingStart, missingEnd));
  w.eval(html.slice(start, end));
  w.openSaleDrawer('sale-1');
  return {
    w, calls, notifications,
    click: () => { w.document.getElementById('sd_excluir').click(); return pendingClick; },
    close: () => dom.window.close()
  };
}

test('missing delete RPC leaves sale and 60 pieces untouched, including repeated attempts', async t => {
  const h = harness({ rpcError: { code: 'PGRST202', message: 'Function missing from schema cache' } });
  t.after(h.close);
  const before = JSON.stringify(h.w.db);
  const button = h.w.document.getElementById('sd_excluir');
  const first = h.click();
  assert.equal(button.disabled, true);
  await first;
  assert.equal(button.disabled, false);
  await h.click();
  assert.equal(h.calls.rpc.length, 2);
  assert.deepEqual(h.calls.rpc[0], { name: 'delete_sale', payload: { p_sale_id: 'sale-1' } });
  assert.equal(JSON.stringify(h.w.db), before);
  assert.deepEqual(h.calls.writes, []);
  assert.deepEqual(h.calls.stock, []);
  assert.deepEqual(h.calls.sync, []);
  assert.equal(h.calls.reloads, 0);
  assert.equal(h.notifications.at(-1)[0], 'Exclusão indisponível');
  assert.match(h.notifications.at(-1)[1], /venda foi mantida/);
  assert.equal(h.w.document.getElementById('saleDrawer').getAttribute('aria-hidden'), 'false');
});

test('unavailable fiscal lookup cannot enable direct deletion when delete RPC is missing', async t => {
  const h = harness({ rpcError: { code: '42883', message: 'function does not exist' },
    fiscalError: { code: '42501', message: 'permission denied' } });
  t.after(h.close);
  const before = JSON.stringify(h.w.db);
  await h.click();
  assert.equal(JSON.stringify(h.w.db), before);
  assert.deepEqual(h.calls.writes, []);
  assert.deepEqual(h.calls.stock, []);
  assert.equal(h.notifications.at(-1)[0], 'Exclusão indisponível');
});

test('authorized fiscal note keeps its existing blocking message without stock changes', async t => {
  const h = harness({ rpcError: { code: 'PGRST202' }, fiscal: { numero: 'TESTE-1' } });
  t.after(h.close);
  const before = JSON.stringify(h.w.db);
  await h.click();
  assert.match(h.notifications.at(-1)[1], /NFC-e autorizada/);
  assert.equal(JSON.stringify(h.w.db), before);
  assert.deepEqual(h.calls.writes, []);
  assert.deepEqual(h.calls.stock, []);
  assert.equal(h.w.document.getElementById('sd_excluir').disabled, false);
});

test('RPC business rejection preserves sale without entering fallback', async t => {
  const h = harness({ rpcError: { code: 'P0001', message: 'Venda com NFC-e autorizada' } });
  t.after(h.close);
  const before = JSON.stringify(h.w.db);
  await h.click();
  assert.equal(JSON.stringify(h.w.db), before);
  assert.deepEqual(h.calls.reads, []);
  assert.deepEqual(h.calls.writes, []);
  assert.deepEqual(h.calls.stock, []);
  assert.deepEqual(h.notifications.at(-1), ['Não pode excluir', 'Venda com NFC-e autorizada']);
});

test('canceling deletion invokes neither RPC nor table access', async t => {
  const h = harness({ confirm: false });
  t.after(h.close);
  const before = JSON.stringify(h.w.db);
  await h.click();
  assert.equal(JSON.stringify(h.w.db), before);
  assert.equal(h.calls.rpc.length, 0);
  assert.deepEqual(h.calls.reads, []);
  assert.deepEqual(h.calls.writes, []);
  assert.deepEqual(h.calls.stock, []);
});

test('successful deletion reloads canonical stock after a concurrent sale instead of adding to stale cache', async t => {
  const h = harness();
  t.after(h.close);
  await h.click();
  assert.equal(h.w.db.sales.length, 0);
  assert.equal(h.w.db.products[0].stock, 63);
  assert.equal(h.calls.rpc.length, 1);
  assert.deepEqual(h.calls.writes, []);
  assert.deepEqual(h.calls.stock, []);
  assert.equal(h.calls.reloads, 1);
  assert.deepEqual(h.calls.sync, [['VF000001']]);
  await h.click();
  assert.equal(h.calls.rpc.length, 1);
  assert.equal(h.w.db.products[0].stock, 63);
});
