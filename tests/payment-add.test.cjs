const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('  let pendingPaymentSubmission = null;');
const end = html.indexOf('  function generatePDF(', start);
assert.ok(start > 0 && end > start);
const source = html.slice(start, end);
const mapStart = html.indexOf('  function mapSaleFromDb(');
const mapEnd = html.indexOf('  async function loadSalesFromSupabase(', mapStart);

function harness({ write, readSale } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  const writes = [];
  const rows = new Map();
  const notifications = [];
  let handler;
  let saleReads = 0;
  w.document.getElementById('btnAddPayment').addEventListener = (_, fn) => { handler = fn; };
  w.currentPaymentSaleId = null;
  w.db = { sales: [], products: [{ id: 'p1', stock: 30 }], stockMoves: [] };
  w.toNum = value => Number(value || 0);
  w.hojeISOLocal = () => '2026-11-04';
  w.taxaDoPagamento = method => method === 'Credito' ? 2.99 : 0;
  w.findClientById = () => null;
  w.escapeHtml = text => String(text);
  w.fmtBRL = n => `R$ ${Number(n).toFixed(2)}`;
  w.fmtDataBR = value => value;
  w.getSalePaymentStatus = sale => sale.paymentStatus;
  w.renderSalesTable = w.renderHome = () => {};
  w.toast = (...args) => notifications.push(args);
  w.console.warn = () => {};
  function canonical() {
    const payments = [...rows.values()];
    const fee = payments.reduce((sum, p) => sum + p.fee_value, 0);
    const net = payments.reduce((sum, p) => sum + p.net_value, 0);
    return { id: 'sale-1', sold_at: '2026-11-04T12:00:00Z', total_bruto: 100, subtotal: 100,
      cost_total: 50, fee_value: fee, net_received: net, profit: net - 50,
      pay: payments.length ? payments[0].method : 'Pendente', payment_status: net + fee >= 100 ? 'Pago' : 'Parcial',
      finance_revision: payments.length, sale_items: [{ product_id: 'p1', qty: 2, price: 50, cost: 25 }], sale_payments: payments };
  }
  function persist(payload, options) {
    assert.equal(options.onConflict, 'id');
    assert.equal(options.ignoreDuplicates, true);
    if (!rows.has(payload.id)) rows.set(payload.id, JSON.parse(JSON.stringify(payload)));
    return { error: null };
  }
  w.sb = { from: table => ({
    upsert: async (payload, options) => {
      assert.equal(table, 'sale_payments');
      writes.push(JSON.parse(JSON.stringify(payload)));
      return write ? write(payload, options, writes.length, persist) : persist(payload, options);
    },
    select: () => {
      const filters = {};
      const query = {
        eq: (key, value) => { filters[key] = value; return query; },
        single: async () => {
          if (table === 'sale_payments') {
            const row = rows.get(filters.id);
            return { data: row?.sale_id === filters.sale_id ? row : null, error: null };
          }
          assert.equal(table, 'sales');
          saleReads += 1;
          return readSale ? readSale(saleReads, canonical) : { data: canonical(), error: null };
        }
      };
      return query;
    }
  }) };
  w.eval(html.slice(mapStart, mapEnd));
  w.db.sales = [w.mapSaleFromDb(canonical())];
  w.eval(source);
  w.openPaymentModal(w.db.sales[0]);
  function fill(value = '100', method = 'PIX') {
    w.document.getElementById('payment_value').value = value;
    w.document.getElementById('payment_method').value = method;
  }
  return { w, rows, writes, notifications, fill, save: () => handler(), close: () => dom.window.close() };
}

test('payment modal uses local calendar date and cancel writes nothing', () => {
  const h = harness();
  assert.equal(h.w.document.getElementById('payment_date').value, '2026-11-04');
  h.fill();
  h.w.closePaymentModal();
  assert.equal(h.rows.size, 0);
  assert.equal(h.w.currentPaymentSaleId, null);
  h.close();
});

test('saved payment reloads canonical fees/status/revision without stock changes', async () => {
  const h = harness();
  const stock = JSON.stringify(h.w.db.products);
  h.fill('100', 'Credito');
  await h.save();
  assert.equal(h.rows.size, 1);
  assert.equal(h.w.db.sales[0].pay, 'Credito');
  assert.equal(h.w.db.sales[0].feeValue, 2.99);
  assert.equal(h.w.db.sales[0].netReceived, 97.01);
  assert.equal(h.w.db.sales[0].paymentStatus, 'Pago');
  assert.equal(h.w.db.sales[0].financeRevision, 1);
  assert.equal(h.w.db.sales[0].payments.length, 1);
  assert.equal(JSON.stringify(h.w.db.products), stock);
  assert.equal(h.w.db.stockMoves.length, 0);
  await h.save();
  assert.equal(h.writes.length, 1, 'repeated save after success has an empty form');
  h.close();
});

test('lost response keeps UUID/payload and retries without overwriting or duplicating', async () => {
  const h = harness({ write: (payload, options, attempt, persist) => {
    const result = persist(payload, options);
    return attempt === 1 ? { error: { message: 'Failed to fetch' } } : result;
  } });
  h.fill();
  await h.save();
  assert.equal(h.rows.size, 1);
  assert.equal(h.w.document.getElementById('payment_value').disabled, true);
  assert.equal(h.w.document.getElementById('btnReviewFinancials').disabled, true);
  h.w.closePaymentModal();
  assert.equal(h.w.currentPaymentSaleId, 'sale-1');
  h.w.openPaymentModal({ id: 'other-sale' });
  assert.equal(h.w.currentPaymentSaleId, 'sale-1');
  await h.save();
  assert.deepEqual(h.writes[0], h.writes[1]);
  assert.equal(h.rows.size, 1);
  assert.equal(h.w.db.sales[0].payments.length, 1);
  assert.equal(h.w.document.getElementById('payment_value').disabled, false);
  h.close();
});

test('refresh failure after saved response retries read only', async () => {
  const h = harness({ readSale: (attempt, canonical) => attempt === 1
    ? { data: null, error: { message: 'offline' } } : { data: canonical(), error: null } });
  h.fill();
  await h.save();
  assert.equal(h.writes.length, 1);
  assert.equal(h.w.document.getElementById('btnAddPayment').textContent, 'Atualizar pagamento salvo');
  await h.save();
  assert.equal(h.writes.length, 1);
  assert.equal(h.w.db.sales[0].payments.length, 1);
  assert.equal(h.w.db.sales[0].financeRevision, 1);
  h.close();
});

test('concurrent clicks send once and input stays locked until response', async () => {
  let resolve;
  const h = harness({ write: (payload, options, _, persist) => new Promise(r => { resolve = () => r(persist(payload, options)); }) });
  h.fill();
  const first = h.save();
  await h.save();
  assert.equal(h.writes.length, 1);
  assert.equal(h.w.document.getElementById('payment_method').disabled, true);
  resolve();
  await first;
  assert.equal(h.rows.size, 1);
  h.close();
});

test('SQL rejection unlocks draft; invalid precision never reaches database', async () => {
  const h = harness({ write: () => ({ error: { code: 'P0001', message: 'Pagamento maior que saldo' } }) });
  h.fill('1.001');
  await h.save();
  assert.equal(h.writes.length, 0);
  h.fill();
  await h.save();
  assert.equal(h.rows.size, 0);
  assert.equal(h.w.document.getElementById('payment_value').value, '100');
  assert.equal(h.w.document.getElementById('payment_value').disabled, false);
  h.w.closePaymentModal();
  assert.equal(h.w.currentPaymentSaleId, null);
  h.close();
});

test('payment history displays zero net value without substituting gross', () => {
  const h = harness();
  h.w.renderPaymentHistory({ payments: [{ method: 'Credito', date: '2026-11-04', value: 100, netValue: 0, feeValue: 100 }] });
  const cells = h.w.document.querySelectorAll('#paymentHistory td');
  assert.equal(cells[4].textContent, 'R$ 0.00');
  h.close();
});
