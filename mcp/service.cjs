'use strict';
const { randomBytes, createHash } = require('node:crypto');

const ID = '^[a-z]+_[a-z0-9]{4,24}$';
const pageProperties = { limit: { type: 'integer', minimum: 1, maximum: 50 }, cursor: { type: 'string', pattern: '^[A-Za-z0-9_-]{32}$', maxLength: 32 } };
const input = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const definitions = [
  ['vaidosa_stock_list', 'Estoque fictício por variante (produto, tamanho e cor), sem agrupar saldos.', input(pageProperties), 'stock:read'],
  ['vaidosa_customer_orders', 'Pedidos fictícios de um cliente autorizado, paginados e sem dados de contato.', input({ customerId: { type: 'string', pattern: ID, maxLength: 40 }, ...pageProperties }, ['customerId']), 'sales:read'],
  ['vaidosa_sale_get', 'Resumo financeiro e itens fictícios de uma venda autorizada; não altera pagamentos nem estoque.', input({ saleId: { type: 'string', pattern: ID, maxLength: 40 } }, ['saleId']), 'sales:read'],
  ['vaidosa_receipts_summary', 'Agrega recebimentos de vendas fictícios pela data civil de recebimento. Não soma contas manuais nem promete conciliação bancária.', input({ from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }, ['from', 'to']), 'finance:read'],
  ['vaidosa_accounts_list', 'Contas manuais fictícias, separadas dos recebimentos de vendas; sem descrição ou dados pessoais.', input({ kind: { type: 'string', enum: ['payable', 'receivable'] }, ...pageProperties }), 'finance:read']
].map(([name, description, inputSchema, permission]) => Object.freeze({ name, description, inputSchema, permission }));
class InputError extends Error { constructor() { super('Argumentos inválidos para esta ferramenta.'); this.code = -32602; } }
class ToolError extends Error { constructor(code, message) { super(message); this.toolCode = code; } }
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
function validateArgs(schema, args) {
  if (!plainObject(args) || Object.keys(args).some(key => !Object.hasOwn(schema.properties, key))) throw new InputError();
  if (schema.required.some(key => !Object.hasOwn(args, key))) throw new InputError();
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (rule.type === 'string' && (typeof value !== 'string' || value.length > (rule.maxLength || 40) || (rule.pattern && !(new RegExp(rule.pattern)).test(value)) || (rule.enum && !rule.enum.includes(value)))) throw new InputError();
    if (rule.type === 'integer' && (!Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum)) throw new InputError();
  }
}
function validDate(value) {
  const stamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
}
const saleSummary = row => ({ saleId: row.id, customerId: row.customerId, soldOn: row.soldOn, status: row.status, grossCents: row.grossCents, discountCents: row.discountCents, totalCents: row.totalCents });

function createReadService({ adapter, principal, now = Date.now }) {
  if (adapter?.mode !== 'fixture' || adapter.contractVersion !== 1 || !principal?.id || !Object.isFrozen(principal)) throw new Error('Only fixture adapter and fixed fixture identity are enabled');
  for (const method of ['listStock', 'listCustomerOrders', 'getSale', 'summarizeReceipts', 'listAccounts']) if (typeof adapter[method] !== 'function') throw new Error('Invalid read adapter contract');
  const cursors = new Map();
  const exposed = definitions.filter(tool => principal.permissions.includes(tool.permission));
  function scopeFor(name, filters) { return createHash('sha256').update(JSON.stringify([principal.id, principal.store, name, filters])).digest('hex'); }
  function paginate(name, args, filters, read, project) {
    const limit = args.limit ?? 20;
    const scope = scopeFor(name, { ...filters, limit });
    let offset = 0;
    for (const [key, record] of cursors) if (record.expires <= now()) cursors.delete(key);
    if (args.cursor) {
      const record = cursors.get(args.cursor);
      if (!record || record.scope !== scope) throw new ToolError('INVALID_CURSOR', 'Página expirada ou incompatível; reinicie a consulta.');
      offset = record.offset;
    }
    const page = read({ ...filters, offset, limit });
    if (!page) throw new ToolError('NOT_AVAILABLE', 'Recurso indisponível para esta sessão.');
    if (!Array.isArray(page.rows) || page.rows.length > limit || typeof page.hasMore !== 'boolean') throw new Error('Adapter page contract violation');
    let nextCursor = null;
    if (page.hasMore) {
      nextCursor = randomBytes(24).toString('base64url');
      if (cursors.size >= 128) cursors.delete(cursors.keys().next().value);
      cursors.set(nextCursor, { scope, offset: offset + page.rows.length, expires: now() + 600_000 });
    }
    return { items: page.rows.map(project), nextCursor };
  }
  return Object.freeze({
    listTools() { return exposed.map(({ permission, ...tool }) => structuredClone({ ...tool, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } })); },
    hasTool(name) { return exposed.some(tool => tool.name === name); },
    call(name, args = {}) {
      const tool = exposed.find(tool => tool.name === name);
      if (!tool) throw new InputError(); // Unknown and unauthorized names are indistinguishable.
      validateArgs(tool.inputSchema, args);
      let result;
      if (name === 'vaidosa_stock_list') result = paginate(name, args, {}, q => adapter.listStock(principal, q), row => ({ productId: row.id, name: row.name, size: row.size, color: row.color, available: row.stock }));
      if (name === 'vaidosa_customer_orders') result = paginate(name, args, { customerId: args.customerId }, q => adapter.listCustomerOrders(principal, q), saleSummary);
      if (name === 'vaidosa_sale_get') {
        const row = adapter.getSale(principal, args.saleId);
        if (!row) throw new ToolError('NOT_AVAILABLE', 'Recurso indisponível para esta sessão.');
        if (!Array.isArray(row.items) || row.items.length > 200) throw new ToolError('TOO_LARGE', 'Venda excede o limite desta ferramenta.');
        result = { ...saleSummary(row), items: row.items.map(item => ({ productId: item.productId, quantity: item.quantity, unitPriceCents: item.unitPriceCents })) };
      }
      if (name === 'vaidosa_receipts_summary') {
        if (!validDate(args.from) || !validDate(args.to) || args.from > args.to || Date.parse(args.to) - Date.parse(args.from) > 365 * 86400000) throw new InputError();
        const row = adapter.summarizeReceipts(principal, args);
        result = { from: args.from, to: args.to, dateBasis: 'paid_on_inclusive_civil_date', sourceDomain: 'sale_payments', count: row.count, receivedCents: row.receivedCents, feeCents: row.feeCents, netCents: row.netCents, excludes: ['manual_accounts', 'bank_reconciliation'] };
      }
      if (name === 'vaidosa_accounts_list') result = { sourceDomain: 'manual_accounts', ...paginate(name, args, { kind: args.kind ?? null }, q => adapter.listAccounts(principal, q), row => ({ accountId: row.id, kind: row.kind, dueOn: row.dueOn, status: row.status, valueCents: row.valueCents, paidCents: row.paidCents })) };
      return { fixture: true, contractVersion: 1, currency: 'BRL', ...result };
    }
  });
}
module.exports = { createReadService, InputError, ToolError, plainObject,
  readDefinitions: () => structuredClone(definitions), validateArgs, validDate };
