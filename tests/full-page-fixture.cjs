'use strict';
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
  w.Chart = options.noChart ? undefined : class { destroy() {} };
  w.HTMLCanvasElement.prototype.getContext=()=>({});
  w.JsBarcode = () => {};
  w.jspdf = { jsPDF: class {} };
  w.turnstile = { render: () => 'fixture-widget', reset() {} };
  const locksHeld = new Set();
  Object.defineProperty(w.navigator, 'locks', { value: { request: async (name, options, callback) => {
    if(typeof options==='function'){callback=options;options={};}
    if (locksHeld.has(name)) { if(options.ifAvailable) return callback(null); throw Error('Concurrent fixture lock'); }
    locksHeld.add(name);
    try { return await callback({}); } finally { locksHeld.delete(name); }
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
  if(options.fixtures) Object.assign(fixtures,clone(options.fixtures));
  function query(table) {
    assert.ok(Object.hasOwn(fixtures, table), `Unexpected table: ${table}`);
    const filters = [];
    let one = false, range, after;
    const result = () => {
      reads.push(table);
      if(options.readError===table) return realm({data:null,error:{message:'Synthetic read failure'}});
      let data = fixtures[table].filter(row => filters.every(([key, values]) => values.includes(row[key])));
      if(after) data=data.filter(row=>row.sold_at<after.date || (row.sold_at===after.date && row.id>after.id));
      if (range) data = data.slice(range[0], range[1] + 1);
      return realm({ data: one ? data[0] || null : data, error: null });
    };
    const q = {
      select() { return q; }, order() { return q; }, limit(n) { range=[0,n-1]; return q; }, abortSignal(){return q;}, or(value){const m=/^sold_at.lt.(.+),and\(sold_at.eq.(.+),id.gt.([a-f0-9-]+)\)$/.exec(value);assert.ok(m);assert.equal(m[1],m[2]);after={date:m[1],id:m[3]};return q;},
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
      async getSession() { authCalls++; return realm({ data: { session: { user: { id: options.sessionUser || USER }, access_token: 'fictional-offline-token' } }, error: null }); },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithPassword() { throw new Error('Real authentication is prohibited'); },
      signOut() { throw new Error('Unexpected sign out'); }
    },
    from: query,
    async rpc(name, payload) {
      writes.push({ rpc: name, payload: clone(payload) });
      if(options.rpc) return realm(await options.rpc(name,payload,fixtures));
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
  const clientsCreated=[];
  w.supabase = { createClient: (...args) => {clientsCreated.push(args);return sb;} };
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
  return { w, errors, reads, writes, networkAttempts, executed, controller, fixtures, clientsCreated,
    authCalls: () => authCalls,
    state: () => w.eval('({ currentSale, db, currentProfile })'),
    storage: () => Object.fromEntries(Array.from({ length: w.localStorage.length }, (_, i) => {
      const key = w.localStorage.key(i); return [key, w.localStorage.getItem(key)];
    }))
  };
}


module.exports={fullPage,uuid,USER,CLIENT,SELLER,PRODUCT,nextTurn};
