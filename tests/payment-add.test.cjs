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

function harness({ write, readSale, readPayment } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  const writes = [];
  const rows = new Map();
  const notifications = [];
  const paymentReads = [];
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
            paymentReads.push({ ...filters });
            const row = rows.get(filters.id);
            const result = { data: row?.sale_id === filters.sale_id ? row : null, error: null };
            return readPayment ? readPayment(paymentReads.length, result, filters) : result;
          }
          assert.equal(table, 'sales');
          saleReads += 1;
          return readSale ? readSale(saleReads, canonical) : { data: canonical(), error: null };
        },
        maybeSingle: async () => query.single()
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
  return { w, rows, writes, paymentReads, notifications, fill, save: () => handler(), close: () => dom.window.close() };
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

test('lost response and failed lookup keep payment locked; retry finds it and skips another write', async () => {
  const h = harness({ write: (payload, options, attempt, persist) => {
    const result = persist(payload, options);
    return attempt === 1 ? { error: { message: 'Failed to fetch' } } : result;
  }, readPayment: (attempt, result) => attempt === 1 ? { data: null, error: { message: 'lookup unavailable' } } : result });
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
  assert.equal(h.writes.length, 1, 'found ID must never be upserted again');
  assert.ok(h.paymentReads.every(filters => filters.id === h.writes[0].id && filters.sale_id === h.writes[0].sale_id));
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

test('RPC-style thrown response loss is reconciled by payment ID immediately when lookup succeeds', async t => {
  const h = harness({ write: (payload, options, _, persist) => { persist(payload, options); throw Error('response lost'); } });
  t.after(h.close); h.fill('10'); await h.save();
  assert.equal(h.writes.length, 1); assert.equal(h.rows.size, 1); assert.equal(h.paymentReads.length, 1);
  assert.equal(h.w.db.sales[0].payments[0].value, 10); assert.equal(h.w.document.getElementById('payment_value').value, '');
  assert.equal(h.w.document.getElementById('payment_value').disabled, false);
});

test('unavailable verification blocks all retries and preserves the original UUID and form lock', async t => {
  const h = harness({ write: () => ({ error: { message: 'Failed to fetch' } }),
    readPayment: () => ({ data: null, error: { code: '42501', message: 'lookup unavailable' } }) });
  t.after(h.close); h.fill('10'); await h.save();
  for (let i = 0; i < 3; i++) { h.fill('25'); await h.save(); }
  assert.equal(h.writes.length, 1); assert.equal(h.rows.size, 0); assert.equal(h.paymentReads.length, 4);
  assert.ok(h.paymentReads.every(filters => filters.id === h.writes[0].id && filters.sale_id === 'sale-1'));
  assert.equal(h.w.document.getElementById('payment_value').disabled, true);
  h.w.closePaymentModal(); assert.equal(h.w.currentPaymentSaleId, 'sale-1');
});

test('verified absence retries exactly the same payload and UUID, even if DOM values were changed', async t => {
  const h = harness({ write: (payload, options, attempt, persist) => attempt === 1
    ? { error: { message: 'Failed to fetch' } } : persist(payload, options) });
  t.after(h.close); h.fill('10'); await h.save(); h.fill('25', 'Credito'); await h.save();
  assert.equal(h.writes.length, 2); assert.deepEqual(h.writes[0], h.writes[1]);
  assert.equal(h.writes[0].value, 10); assert.equal(h.writes[0].method, 'PIX');
  assert.equal(h.rows.size, 1); assert.equal(h.paymentReads.length, 3, 'post-attempt lookup, pre-retry lookup and post-retry lookup');
});

test('commit with lost response then PGRST301/42501 retry errors never releases a new partial-payment UUID', async t => {
  for (const code of ['PGRST301', '42501']) {
    const h = harness({
      write: (payload, options, attempt, persist) => {
        if (attempt === 1) { persist(payload, options); return { error: { message: 'response lost' } }; }
        return { error: { code: attempt === 2 ? code : 'P0001', message: 'retry rejected' } };
      },
      readPayment: (attempt, found) => {
        if ([1, 4].includes(attempt)) return { data: null, error: { message: 'verification unavailable' } };
        if (attempt < 7) return { data: null, error: null };
        return found;
      }
    });
    t.after(h.close); h.fill('10'); await h.save();
    assert.equal(h.rows.size, 1); assert.equal(h.w.document.getElementById('payment_value').disabled, true);
    h.fill('30'); await h.save(); // Successful absence lookup, then explicit auth error and another absent lookup.
    assert.equal(h.writes.length, 2); assert.deepEqual(h.writes[0], h.writes[1]);
    assert.equal(h.w.document.getElementById('payment_value').disabled, true);
    h.w.closePaymentModal(); assert.equal(h.w.currentPaymentSaleId, 'sale-1');
    await h.save(); assert.equal(h.writes.length, 2, 'verification failure must not reach another upsert');
    h.fill('40'); await h.save(); // Even a later business rejection cannot undo prior uncertainty.
    assert.equal(h.writes.length, 3); assert.deepEqual(h.writes[0], h.writes[2]);
    assert.equal(h.w.document.getElementById('payment_value').disabled, true);
    await h.save(); // Payment finally becomes visible; reload without writing.
    assert.equal(h.writes.length, 3); assert.equal(new Set(h.writes.map(p => p.id)).size, 1);
    assert.equal(h.rows.size, 1); assert.equal(h.w.db.sales[0].payments.length, 1);
    assert.equal(h.w.db.sales[0].payments[0].value, 10); assert.equal(h.w.db.sales[0].paymentStatus, 'Parcial');
    assert.equal(h.w.document.getElementById('payment_value').value, '');
    assert.equal(h.w.document.getElementById('payment_value').disabled, false);
  }
});

test('first explicit business rejection only unlocks after successful verified absence', async t => {
  const h = harness({ write: () => ({ error: { code: '22023', message: 'value rejected' } }),
    readPayment: (attempt, result) => attempt === 1 ? { data: null, error: { message: 'lookup failed' } } : result });
  t.after(h.close); h.fill('10'); await h.save();
  assert.equal(h.w.document.getElementById('payment_value').disabled, true);
  await h.save(); assert.equal(h.writes.length, 2); assert.deepEqual(h.writes[0], h.writes[1]);
  assert.equal(h.w.document.getElementById('payment_value').disabled, true, 'later rejection cannot erase an uncertain earlier attempt');
});

test('payment found for a mismatched ID or sale cannot unlock the pending form', async t => {
  for (const wrong of [{ id: 'other-payment', sale_id: 'sale-1' }, { id: null, sale_id: 'other-sale' }]) {
    const h = harness({ readPayment: (_, result, filters) => ({ data: { ...wrong, id: wrong.id || filters.id }, error: null }) });
    t.after(h.close); h.fill('10'); await h.save(); await h.save();
    assert.equal(h.writes.length, 1); assert.equal(h.w.document.getElementById('payment_value').disabled, true);
    assert.equal(h.w.db.sales[0].payments.length, 0);
  }
});
