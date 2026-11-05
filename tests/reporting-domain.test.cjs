const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../modules/reporting-domain.js');
const item = (productId, price, qty = 1) => ({ productId, price, qty });
const sale = (items, netReceived, extra = {}) => ({ id: 'sale-1', items, netReceived, ...extra });
const sum = rows => rows.reduce((a, row) => a + row.netCents, 0);

test('discounted sale allocates by item subtotal, not discounted total', () => {
  const rows = R.allocateSaleNet(sale([item('a', 60), item('b', 40)], 90, { totalBruto: 90, discount: 10 }));
  assert.deepEqual(rows.map(x => x.netCents), [5400, 3600]);
  assert.equal(sum(rows), 9000);
});

test('card net is preserved exactly without recalculating fees', () => {
  const rows = R.allocateSaleNet(sale([item('a', '19.99', 3), item('b', '40.03')], '83.27', { feeValue: 6.73, totalBruto: 90 }));
  assert.equal(sum(rows), 8327);
  assert.equal(rows.reduce((a, r) => a + r.grossCents, 0), 10000);
});

test('largest remainder ties are deterministic by line identity, independent of order', () => {
  const rows = R.allocateSaleNet(sale([item('b', 1), item('a', 1), item('c', 1)], '0.02'));
  assert.deepEqual(rows.map(x => [x.item.productId, x.netCents]), [['b', 1], ['a', 1], ['c', 0]]);
  const reordered = R.allocateSaleNet(sale([item('c', 1), item('b', 1), item('a', 1)], '0.02'));
  assert.deepEqual(Object.fromEntries(rows.map(x => [x.item.productId, x.netCents])), Object.fromEntries(reordered.map(x => [x.item.productId, x.netCents])));
});

test('100% discount / zero receipts produces zero allocation', () => {
  const rows = R.allocateSaleNet(sale([item('a', 20), item('b', 10, 2)], 0, { discount: 40, totalBruto: 0 }));
  assert.deepEqual(rows.map(x => x.netCents), [0, 0]);
  assert.deepEqual(R.allocateSaleNet(sale([], 0)), []);
  assert.equal(sum(R.allocateSaleNet(sale([item('a', 0)], 0))), 0);
});

test('positive net without item basis fails visibly instead of inventing allocation', () => {
  assert.throws(() => R.allocateSaleNet(sale([item('a', 0)], 1)), /sem base/);
  assert.throws(() => R.allocateSaleNet(sale([], 1)), /sem base/);
});

test('signed net maintains exact sum without defining new accounting categories', () => {
  assert.deepEqual(R.allocateSaleNet(sale([item('a', 1), item('b', 1)], '-0.03')).map(x => x.netCents), [-2, -1]);
});

test('all quantities are weighted and source objects are unchanged', () => {
  const source = sale([Object.freeze(item('a', 10, 3)), Object.freeze(item('b', 20))], 40);
  Object.freeze(source.items); Object.freeze(source);
  assert.deepEqual(R.allocateSaleNet(source).map(x => x.netCents), [2400, 1600]);
});

test('invalid monetary values and quantities are rejected instead of coercing', () => {
  for (const amount of ['', NaN, Infinity, null, '1,20', '1.005', '1e3']) assert.throws(() => R.moneyToCents(amount));
  for (const qty of [0, -1, 0.5, NaN, Infinity]) assert.throws(() => R.allocateSaleNet(sale([item('a', 1, qty)], 1)));
  assert.throws(() => R.allocateSaleNet(sale([item('a', -1)], 1)));
  assert.throws(() => R.moneyToCents('90071992547409.92'), /precisão/);
  assert.equal(R.moneyToCents('90071992547409.91'), Number.MAX_SAFE_INTEGER);
  assert.equal(R.moneyToCents(0.29), 29);
});

test('many generated allocations conserve net with each share within one cent of exact ratio', () => {
  for (let seed = 1; seed <= 250; seed++) {
    const items = Array.from({ length: seed % 17 + 1 }, (_, i) => item(String(i), ((seed * 7 + i * 19) % 999 + 1) / 100, i % 5 + 1));
    const netCents = (seed * 1237) % 20000;
    const rows = R.allocateSaleNet(sale(items, (netCents / 100).toFixed(2)));
    assert.equal(sum(rows), netCents);
    const gross = rows.reduce((a, x) => a + x.grossCents, 0);
    for (const row of rows) assert.ok(Math.abs(row.netCents - netCents * row.grossCents / gross) < 1);
  }
});

test('aggregation sums variants exactly and does not merge deleted products', () => {
  const result = R.aggregateProductSales([
    sale([item('a', 10, '2.0'), item(null, 5)], 20),
    sale([item('a', 5), item(null, 5)], 9, { id: 'sale-2' })
  ]);
  assert.equal(result.length, 3);
  assert.equal(result[0].qty, 3);
  assert.equal(result[0].brutoCents, 2500);
  assert.equal(result.reduce((a, x) => a + x.liquidoCents, 0), 2900);
  assert.equal(result[0].liquido, result[0].liquidoCents / 100);
});

test('sale month uses explicit store timezone at midnight boundary', () => {
  const rows = [{ id: 'oct', date: '2026-11-01T02:59:59Z', pay: 'PIX' }, { id: 'nov', date: '2026-11-01T03:00:00Z', pay: 'PIX' }];
  assert.deepEqual(R.selectSalesByMonth(rows, { month: '2026-10', timeZone: 'America/Sao_Paulo' }).map(x => x.id), ['oct']);
  assert.deepEqual(R.selectSalesByMonth(rows, { month: '2026-11', timeZone: 'UTC' }).map(x => x.id), ['oct', 'nov']);
  assert.equal(R.saleDay({ date: Date.parse(rows[0].date) }, 'America/Sao_Paulo'), '2026-10-31');
});

test('calendar receipt dates never shift by timezone and differ from sale dates', () => {
  const rows = [sale([], 9, { date: '2026-10-10T12:00:00Z', payments: [{ id: 'p1', date: '2026-11-01', value: 10, feeValue: 1, netValue: 9, method: 'Credito' }] })];
  assert.equal(R.selectSalesByMonth(rows, { month: '2026-11', timeZone: 'America/Sao_Paulo' }).length, 0);
  assert.deepEqual(R.selectReceiptsByMonth(rows, { month: '2026-11' }), [{ source: 'sale_payment', saleId: 'sale-1', paymentId: 'p1', date: '2026-11-01', grossCents: 1000, feeCents: 100, netCents: 900, method: 'Credito' }]);
  assert.equal(R.calendarDay('2024-02-29'), '2024-02-29');
  assert.throws(() => R.calendarDay('2026-02-29'));
  assert.throws(() => R.calendarDay('2026-11-01T00:00:00Z'));
});

test('ambiguous timestamps, missing timezone, invalid month are rejected', () => {
  assert.throws(() => R.saleDay({ date: '2026-11-01T00:00:00' }, 'UTC'));
  assert.throws(() => R.saleDay({ date: '2026-11-01' }, 'UTC'));
  assert.throws(() => R.saleDay({ date: '2026-11-01T00:00:00Z' }));
  assert.throws(() => R.selectSalesByMonth([], { month: '2026-13', timeZone: 'UTC' }));
});

test('impossible timestamp calendar dates and 24:00 are not silently shifted', () => {
  assert.throws(() => R.saleDay({ date: '2026-02-30T12:00:00Z' }, 'UTC'));
  assert.throws(() => R.saleDay({ date: '2026-11-01T24:00:00Z' }, 'UTC'));
  assert.equal(R.saleDay({ date: '2024-02-29T12:00:00.000001+00:00' }, 'UTC'), '2024-02-29');
});

test('pay and channel filters retain documented sale semantics', () => {
  const rows = [{ date: '2026-11-05T12:00:00Z', pay: 'PIX' }, { date: '2026-11-05T12:00:00Z', pay: 'Credito', channel: 'Loja' }];
  assert.equal(R.selectSalesByMonth(rows, { month: '2026-11', timeZone: 'UTC', pay: 'PIX', channel: 'Loja' }).length, 1);
});

test('manual and sale origins stay separate even for matching date, value and ID', () => {
  const source = { id: 'same', date: '2026-11-05', value: 100 };
  const result = R.separateFinancialSources({ saleReceipts: [source], manualMovements: [source] });
  assert.equal(result.saleReceipts.length, 1);
  assert.equal(result.manualMovements.length, 1);
  assert.equal(result.saleReceipts[0].source, 'sale_payment');
  assert.equal(result.manualMovements[0].source, 'manual_movement');
  assert.equal(source.source, undefined);
});
