'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fullPage,uuid,USER,CLIENT,SELLER,PRODUCT,nextTurn}=require('./full-page-fixture.cjs');
const {fixtureSale,saleId,paymentId,clone}=require('./financial-fixture.cjs');
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
