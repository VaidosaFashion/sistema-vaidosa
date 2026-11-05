(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VaidosaCustomerOrders = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const orderFields = ['id', 'clientId', 'date', 'channel', 'kind', 'pay', 'installments', 'discount', 'subtotal', 'totalBruto', 'netReceived', 'paymentStatus'];
  const itemFields = ['id', 'productId', 'name', 'barcode', 'size', 'qty', 'price'];
  const paymentFields = ['id', 'date', 'value', 'method', 'installments', 'feePct', 'feeValue', 'netValue'];
  function pick(source, fields) {
    const target = {};
    fields.forEach(function (field) {
      const value = source[field];
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) target[field] = value;
    });
    return target;
  }
  function normalizeOrder(order, clientId) {
    if (!order || typeof order.id !== 'string' || !order.id || order.clientId !== clientId) throw new TypeError('Pedido inválido ou de outro cliente.');
    const result = pick(order, orderFields);
    result.items = (order.items || []).map(function (item) { return pick(item, itemFields); });
    result.payments = (order.payments || []).map(function (payment) { return pick(payment, paymentFields); });
    return result;
  }
  function cloneOrders(orders, clientId) { return orders.map(function (order) { return normalizeOrder(order, clientId); }); }
  function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function epoch(date) { return typeof date === 'number' ? date : Date.parse(date); }
  function compareOrders(a, b) { return epoch(b.date) - epoch(a.date) || compareText(a.id, b.id); }
  function pageSize(value) {
    if (!Number.isInteger(value) || value < 1 || value > 100) throw new RangeError('Página deve conter entre 1 e 100 pedidos.');
    return value;
  }

  function createMemoryRepository(source) {
    const read = typeof source === 'function' ? source : function () { return source; };
    return Object.freeze({ listCustomerOrders: async function (options) {
      const limit = pageSize(options.limit);
      if (options.signal && options.signal.aborted) throw new Error('Consulta cancelada.');
      let after = null;
      if (options.cursor != null) {
        try { after = JSON.parse(options.cursor); } catch (_) { throw new TypeError('Cursor inválido.'); }
        if (!after || after.clientId !== options.clientId || typeof after.id !== 'string' || !Number.isFinite(epoch(after.date))) throw new TypeError('Cursor inválido.');
      }
      const orders = read().filter(function (order) { return order.clientId === options.clientId; }).map(function (order) {
        if (!Number.isFinite(epoch(order.date))) throw new TypeError('Data de pedido inválida.');
        return normalizeOrder(order, options.clientId);
      }).sort(compareOrders).filter(function (order) { return !after || compareOrders(order, after) > 0; });
      const page = orders.slice(0, limit);
      const last = page[page.length - 1];
      return { orders: page, nextCursor: orders.length > limit ? JSON.stringify({ clientId: options.clientId, date: last.date, id: last.id }) : null };
    } });
  }

  function createController(options) {
    if (!options || !options.repository || typeof options.repository.listCustomerOrders !== 'function') throw new TypeError('Repositório de leitura obrigatório.');
    const limit = pageSize(options.pageSize == null ? 15 : options.pageSize);
    const notify = typeof options.onState === 'function' ? options.onState : function () {};
    let state = { clientId: null, orders: [], loading: false, error: null, hasMore: false };
    let generation = 0;
    let cursor = null;
    let controller = null;
    let pending = null;
    let disposed = false;
    let visited = new Set();

    function getState() { return Object.assign({}, state, { orders: cloneOrders(state.orders, state.clientId) }); }
    function emit() { notify(getState()); }
    function cancel() {
      generation++;
      if (controller) controller.abort();
      controller = null;
      pending = null;
    }
    function selectClient(clientId) {
      if (disposed) return Promise.resolve(getState());
      if (clientId != null && (typeof clientId !== 'string' || !clientId)) throw new TypeError('Identificador de cliente inválido.');
      cancel();
      cursor = null;
      visited = new Set();
      state = { clientId: clientId || null, orders: [], loading: false, error: null, hasMore: !!clientId };
      emit();
      return clientId ? loadMore() : Promise.resolve(getState());
    }
    function loadMore() {
      if (disposed || !state.clientId || !state.hasMore) return Promise.resolve(getState());
      if (pending) return pending;
      const currentGeneration = generation;
      const clientId = state.clientId;
      const requestedCursor = cursor;
      controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const signal = controller ? controller.signal : undefined;
      state = Object.assign({}, state, { loading: true, error: null });
      // Defer the repository invocation so pending is installed before a view
      // callback can request another page (including synchronous repositories).
      pending = Promise.resolve().then(function () {
        return options.repository.listCustomerOrders({ clientId: clientId, cursor: requestedCursor, limit: limit, signal: signal });
      }).then(function (page) {
        if (disposed || currentGeneration !== generation) return getState();
        if (!page || !Array.isArray(page.orders) || page.orders.length > limit || !Object.prototype.hasOwnProperty.call(page, 'nextCursor') ||
            (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor))) throw new TypeError('Página inválida.');
        if (page.nextCursor !== null && (page.nextCursor === requestedCursor || visited.has(page.nextCursor))) throw new TypeError('Paginação não avançou.');
        const normalized = cloneOrders(page.orders, clientId);
        const ids = new Set(state.orders.map(function (order) { return order.id; }));
        const nextOrders = state.orders.slice();
        normalized.forEach(function (order) { if (!ids.has(order.id)) { ids.add(order.id); nextOrders.push(order); } });
        if (requestedCursor !== null) visited.add(requestedCursor);
        cursor = page.nextCursor;
        state = Object.assign({}, state, { orders: nextOrders, loading: false, error: null, hasMore: cursor !== null });
        pending = null;
        emit();
        return getState();
      }).catch(function () {
        if (disposed || currentGeneration !== generation) return getState();
        state = Object.assign({}, state, { loading: false, error: 'Não foi possível carregar os pedidos. Tente novamente.' });
        pending = null;
        emit();
        return getState();
      });
      emit();
      return pending;
    }
    function openOrder(id) {
      if (disposed) return false;
      const order = state.orders.find(function (entry) { return entry.id === id; });
      if (!order || typeof options.onOpenOrder !== 'function') return false;
      options.onOpenOrder(id, normalizeOrder(order, state.clientId));
      return true;
    }
    function dispose() { cancel(); disposed = true; state = { clientId: null, orders: [], loading: false, error: null, hasMore: false }; }
    return Object.freeze({ selectClient: selectClient, loadMore: loadMore, refresh: function () { return selectClient(state.clientId); },
      openOrder: openOrder, getState: getState, dispose: dispose });
  }

  // Safe text-only optional view. Existing applications may render onState
  // themselves and retain their established modal/open-order implementation.
  function renderHistory(container, state, options) {
    options = options || {};
    const doc = container.ownerDocument;
    while (container.firstChild) container.removeChild(container.firstChild);
    function text(tag, value, parent) { const el = doc.createElement(tag); el.textContent = value; (parent || container).appendChild(el); return el; }
    if (!state.clientId) { text('p', 'Selecione um cliente para ver todos os pedidos.'); return; }
    const formatMoney = options.formatMoney || function (value) { return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); };
    const formatDate = options.formatDate || function (value) { return value; };
    text('p', state.orders.length + ' pedido(s) carregado(s)' + (state.hasMore ? ' — há mais pedidos.' : '.'));
    if (!state.orders.length && !state.loading && !state.error) text('p', 'Sem pedidos registrados.');
    state.orders.forEach(function (order) {
      const row = text('article', '');
      row.setAttribute('data-order-id', order.id);
      text('p', formatDate(order.date) + ' · ' + (order.paymentStatus || 'Situação não informada') + ' · Total ' + formatMoney(order.totalBruto), row);
      text('p', order.items.length + ' linha(s) de itens · ' + order.payments.length + ' pagamento(s)', row);
      const button = text('button', 'Ver pedido ' + order.id, row);
      button.type = 'button';
      button.disabled = typeof options.onOpenOrder !== 'function';
      button.addEventListener('click', function () { if (options.onOpenOrder) options.onOpenOrder(order.id); });
    });
    if (state.error) { const error = text('p', state.error); error.setAttribute('role', 'alert'); }
    if (state.loading) { const loading = text('p', 'Carregando pedidos…'); loading.setAttribute('role', 'status'); }
    if (state.hasMore) {
      const button = text('button', state.error ? 'Tentar novamente' : 'Carregar mais pedidos');
      button.type = 'button';
      button.disabled = state.loading || typeof options.onLoadMore !== 'function';
      button.addEventListener('click', function () { if (options.onLoadMore) options.onLoadMore(); });
    }
  }

  return Object.freeze({ createController: createController, createMemoryRepository: createMemoryRepository, renderHistory: renderHistory });
});
