'use strict';

// Invented data only. No app configuration, environment credentials or network imports.
// The DTO boundary in service.cjs projects explicit fields even if an adapter has extras.
const products = [
  { id: 'product_demo01', store: 'demo', name: 'Blusa demonstração', size: 'G1', color: 'Azul', stock: 1 },
  { id: 'product_demo02', store: 'demo', name: 'Blusa demonstração', size: 'G2', color: 'Azul', stock: 0 },
  { id: 'product_demo03', store: 'demo', name: 'Calça demonstração', size: 'G3', color: 'Preto', stock: 8 },
  { id: 'product_other1', store: 'other', name: 'Produto de outra loja', size: 'G1', color: 'Verde', stock: 9 }
];
const sales = [
  { id: 'sale_demo01', store: 'demo', customerId: 'customer_demo01', soldOn: '2026-11-01', status: 'Pago', grossCents: 12000, discountCents: 1000, totalCents: 11000, items: [{ productId: 'product_demo01', quantity: 2, unitPriceCents: 6000 }] },
  { id: 'sale_demo02', store: 'demo', customerId: 'customer_demo01', soldOn: '2026-11-02', status: 'Parcial', grossCents: 9000, discountCents: 0, totalCents: 9000, items: [{ productId: 'product_demo03', quantity: 1, unitPriceCents: 9000 }] },
  { id: 'sale_demo03', store: 'demo', customerId: 'customer_demo02', soldOn: '2026-11-03', status: 'Aberto', grossCents: 6000, discountCents: 0, totalCents: 6000, items: [{ productId: 'product_demo02', quantity: 1, unitPriceCents: 6000 }] },
  { id: 'sale_other1', store: 'other', customerId: 'customer_other1', soldOn: '2026-11-01', status: 'Pago', grossCents: 5000, discountCents: 0, totalCents: 5000, items: [] }
];
const receipts = [
  { store: 'demo', saleId: 'sale_demo01', paidOn: '2026-11-01', method: 'PIX', valueCents: 11000, feeCents: 0, netCents: 11000 },
  { store: 'demo', saleId: 'sale_demo02', paidOn: '2026-11-03', method: 'Dinheiro', valueCents: 4000, feeCents: 0, netCents: 4000 },
  { store: 'other', saleId: 'sale_other1', paidOn: '2026-11-01', method: 'PIX', valueCents: 5000, feeCents: 0, netCents: 5000 }
];
const accounts = [
  { id: 'account_demo01', store: 'demo', kind: 'receivable', dueOn: '2026-11-10', status: 'open', valueCents: 3000, paidCents: 0 },
  { id: 'account_demo02', store: 'demo', kind: 'payable', dueOn: '2026-11-11', status: 'partial', valueCents: 10000, paidCents: 2000 },
  { id: 'account_other1', store: 'other', kind: 'receivable', dueOn: '2026-11-10', status: 'open', valueCents: 3000, paidCents: 0 }
];

const principals = Object.freeze({
  manager: Object.freeze({ id: 'fixture_manager', store: 'demo', permissions: Object.freeze(['stock:read', 'sales:read', 'finance:read']), customerIds: null }),
  seller: Object.freeze({ id: 'fixture_seller', store: 'demo', permissions: Object.freeze(['stock:read', 'sales:read']), customerIds: Object.freeze(['customer_demo01']) })
});
function fixturePrincipal(name) {
  if (!Object.hasOwn(principals, name)) throw new Error('Unknown fixture principal');
  return principals[name];
}
function canReadSale(principal, sale) {
  return sale.store === principal.store && (!principal.customerIds || principal.customerIds.includes(sale.customerId));
}
function page(rows, { offset, limit }) { return { rows: structuredClone(rows.slice(offset, offset + limit)), hasMore: rows.length > offset + limit }; }

function createFixtureAdapter() {
  return Object.freeze({
    mode: 'fixture', contractVersion: 1,
    listStock(principal, query) {
      return page(products.filter(row => row.store === principal.store).sort((a, b) => a.id.localeCompare(b.id)), query);
    },
    listCustomerOrders(principal, query) {
      // Resource access does not derive from a role/customer claim supplied by a tool.
      const allowed = sales.some(row => row.customerId === query.customerId && canReadSale(principal, row));
      if (!allowed) return null;
      return page(sales.filter(row => row.customerId === query.customerId && canReadSale(principal, row)).sort((a, b) => a.id.localeCompare(b.id)), query);
    },
    getSale(principal, id) {
      const sale = sales.find(row => row.id === id && canReadSale(principal, row));
      return sale ? structuredClone(sale) : null;
    },
    summarizeReceipts(principal, query) {
      const rows = receipts.filter(row => row.store === principal.store && row.paidOn >= query.from && row.paidOn <= query.to);
      return { count: rows.length, receivedCents: rows.reduce((a, b) => a + b.valueCents, 0), feeCents: rows.reduce((a, b) => a + b.feeCents, 0), netCents: rows.reduce((a, b) => a + b.netCents, 0) };
    },
    listAccounts(principal, query) {
      return page(accounts.filter(row => row.store === principal.store && (!query.kind || row.kind === query.kind)).sort((a, b) => a.id.localeCompare(b.id)), query);
    }
  });
}

module.exports = { createFixtureAdapter, fixturePrincipal };
