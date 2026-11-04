(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VaidosaCartDrafts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = 1;
  const TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_ITEMS = 500;
  const MAX_RAW_LENGTH = 262144;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const CHANNELS = ['Loja', 'Trafego', 'WhatsApp', 'Instagram', 'Indicacao', 'Outro'];
  const DRAFT_KEYS = ['items', 'clientId', 'vendedorId', 'channel', 'kind', 'priceTier', 'discount', 'overrideTroca'];
  const REQUEST_KEYS = ['p_client_request_id', 'p_client_id', 'p_vendedor_id', 'p_channel', 'p_kind', 'p_pay', 'p_installments', 'p_discount', 'p_note', 'p_items', 'p_price_tier'];

  class DraftStoreError extends Error {
    constructor(code, message) { super(message); this.name = 'DraftStoreError'; this.code = code; }
  }
  function fail(code, message) { throw new DraftStoreError(code, message); }
  function plain(value) {
    return value !== null && typeof value === 'object' &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  }
  function object(value) { if (!plain(value)) fail('INVALID_DATA', 'Registro local inválido.'); }
  function field(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail('INVALID_DATA', 'Campos calculados não são permitidos.');
    return descriptor.value;
  }
  function exactKeys(value, required, optional) {
    object(value);
    const allowed = required.concat(optional || []);
    if (Object.keys(value).some(key => !allowed.includes(key)) ||
        required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
      fail('INVALID_DATA', 'Formato do registro local não reconhecido.');
    }
  }
  function id(value, nullable) {
    if (nullable && (value === null || value === undefined)) return null;
    if (typeof value !== 'string' || !UUID.test(value)) fail('INVALID_DATA', 'Identificador inválido.');
    return value.toLowerCase();
  }
  function oneOf(value, choices) {
    if (!choices.includes(value)) fail('INVALID_DATA', 'Opção inválida no carrinho.');
    return value;
  }
  function money(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 99999999.99 ||
        value !== Number(value.toFixed(2))) fail('INVALID_DATA', 'Desconto deve ser válido e ter no máximo dois decimais.');
    return value === 0 ? 0 : value;
  }
  function items(value, productKey, allowEmpty, strict) {
    if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > MAX_ITEMS) {
      fail('INVALID_DATA', 'Quantidade de itens inválida.');
    }
    const seen = new Set();
    const result = [];
    for (let index = 0; index < value.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(value, String(index));
      if (!entry || !Object.prototype.hasOwnProperty.call(entry, 'value')) fail('INVALID_DATA', 'Lista de itens incompleta ou calculada.');
      const item = entry.value;
      object(item);
      if (strict) exactKeys(item, [productKey, 'qty']);
      const product = id(field(item, productKey));
      const qty = field(item, 'qty');
      if (!Number.isSafeInteger(qty) || qty <= 0 || qty > 2147483647 || seen.has(product)) {
        fail('INVALID_DATA', 'Produto repetido ou quantidade inválida.');
      }
      seen.add(product);
      result.push({ [productKey]: product, qty });
    }
    return result;
  }
  function draft(value, strict) {
    object(value);
    if (strict) exactKeys(value, DRAFT_KEYS);
    const override = field(value, 'overrideTroca');
    if (override !== undefined && typeof override !== 'boolean') fail('INVALID_DATA', 'Exceção de troca inválida.');
    return {
      items: items(field(value, 'items'), 'productId', true, strict),
      clientId: id(field(value, 'clientId'), true), vendedorId: id(field(value, 'vendedorId'), true),
      channel: oneOf(field(value, 'channel'), CHANNELS), kind: oneOf(field(value, 'kind'), ['Venda', 'Troca']),
      priceTier: oneOf(field(value, 'priceTier'), ['Atacado', 'Varejo']),
      discount: money(field(value, 'discount')), overrideTroca: override === true
    };
  }
  function request(value, requestId, strict) {
    object(value);
    if (strict) {
      exactKeys(value, REQUEST_KEYS);
      if (value.p_note !== null || value.p_pay !== 'Pendente' || value.p_installments !== 0) fail('INVALID_DATA', 'Tentativa armazenada fora do formato permitido.');
    }
    const note = field(value, 'p_note');
    if (note !== undefined && note !== null && note !== '') fail('NOTE_NOT_ALLOWED', 'Retire a observação antes de preparar esta venda.');
    const pay = field(value, 'p_pay'), installments = field(value, 'p_installments');
    if ((pay !== undefined && pay !== 'Pendente') || (installments !== undefined && installments !== 0)) {
      fail('INVALID_DATA', 'A venda deve ser preparada como Pendente, sem parcelas.');
    }
    return {
      p_client_request_id: id(field(value, 'p_client_request_id') || requestId),
      p_client_id: id(field(value, 'p_client_id'), true), p_vendedor_id: id(field(value, 'p_vendedor_id'), true),
      p_channel: oneOf(field(value, 'p_channel'), CHANNELS), p_kind: oneOf(field(value, 'p_kind'), ['Venda', 'Troca']),
      p_pay: 'Pendente', p_installments: 0, p_discount: money(field(value, 'p_discount')), p_note: null,
      p_items: items(field(value, 'p_items'), 'product_id', false, strict),
      p_price_tier: oneOf(field(value, 'p_price_tier'), ['Atacado', 'Varejo'])
    };
  }
  function fromRequest(value) {
    return {
      items: value.p_items.map(item => ({ productId: item.product_id, qty: item.qty })),
      clientId: value.p_client_id, vendedorId: value.p_vendedor_id, channel: value.p_channel,
      kind: value.p_kind, priceTier: value.p_price_tier, discount: value.p_discount, overrideTroca: false
    };
  }
  function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function frozenCopy(value) {
    const copy = JSON.parse(JSON.stringify(value));
    function freeze(object) {
      if (object && typeof object === 'object') { Object.values(object).forEach(freeze); Object.freeze(object); }
    }
    freeze(copy); return copy;
  }
  function timestamp(value) {
    if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_DATA', 'Data do registro local inválida.');
    return value;
  }
  function scopeValue(value) {
    exactKeys(value, ['store', 'userId']);
    const store = field(value, 'store');
    if (typeof store !== 'string' || store.length > 253 ||
        !store.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
      fail('INVALID_SCOPE', 'Identificação da loja inválida.');
    }
    return { store: store.toLowerCase(), userId: id(field(value, 'userId')) };
  }

  class DraftStore {
    constructor(options) {
      object(options);
      const storage = field(options, 'storage');
      if (!storage || !['getItem', 'setItem', 'removeItem'].every(key => typeof storage[key] === 'function')) {
        fail('INVALID_STORAGE', 'Armazenamento local indisponível.');
      }
      this._storage = storage;
      this._scope = scopeValue(field(options, 'scope'));
      Object.defineProperty(this, 'scope', { value: frozenCopy(this._scope), enumerable: true });
      this._now = field(options, 'now') || Date.now;
      this._uuid = field(options, 'uuid') || (() => globalThis.crypto.randomUUID());
      if (typeof this._now !== 'function' || typeof this._uuid !== 'function') fail('INVALID_DATA', 'Configuração inválida.');
      Object.defineProperty(this, 'key', { value: 'vaidosa:cart:v1:' + this._scope.store + ':' + this._scope.userId, enumerable: true });
      this._guard = null;
      this._terminalRaw = null;
      this._freshPendingId = null;
    }
    _time() { return timestamp(this._now()); }
    _raw() {
      try {
        const raw = this._storage.getItem(this.key);
        if (raw !== null && typeof raw !== 'string') fail('STORAGE_READ', 'Leitura local não confirmou o registro.');
        return raw;
      } catch (_) { this._freshPendingId = null; fail('STORAGE_READ', 'Não foi possível ler o carrinho local. Nenhuma venda deve ser enviada.'); }
    }
    _record(raw) {
      if (raw === null) return null;
      if (raw.length > MAX_RAW_LENGTH) fail('INVALID_DATA', 'Registro local excede o limite.');
      let value;
      try { value = JSON.parse(raw); } catch (_) { fail('INVALID_DATA', 'Registro local corrompido.'); }
      object(value);
      if (value.version !== VERSION || !equal(scopeValue(value.scope), this._scope)) fail('INVALID_DATA', 'Registro local de outra conta ou versão.');
      value.scope = scopeValue(value.scope);
      const base = ['version', 'scope', 'status'];
      if (value.status === 'draft') {
        exactKeys(value, base.concat(['savedAt', 'draft']), ['rejectedRequestId', 'rejection']);
        timestamp(value.savedAt); value.draft = draft(value.draft, true);
        if ('rejectedRequestId' in value || 'rejection' in value) {
          value.rejectedRequestId = id(value.rejectedRequestId); exactKeys(value.rejection, ['code', 'constraint', 'at']);
          if (value.rejection.code !== '23514' || value.rejection.constraint !== 'sales_pay_check') fail('INVALID_DATA', 'Rejeição local inválida.');
          timestamp(value.rejection.at);
        }
      } else if (value.status === 'pending') {
        exactKeys(value, base.concat(['preparedAt', 'request'])); timestamp(value.preparedAt);
        value.request = request(value.request, null, true);
      } else if (value.status === 'confirmed') {
        exactKeys(value, base.concat(['confirmedAt', 'sale'])); timestamp(value.confirmedAt);
        exactKeys(value.sale, ['id', 'client_request_id']);
        value.sale = { id: id(value.sale.id), client_request_id: id(value.sale.client_request_id) };
      } else fail('INVALID_DATA', 'Estado local desconhecido.');
      return value;
    }
    _read() {
      const raw = this._raw();
      if (this._guard && raw !== this._guard.pendingRaw) {
        if (this._terminalRaw !== null && raw === this._terminalRaw) {
          this._guard = null; this._terminalRaw = null; this._freshPendingId = null;
        } else return { raw, corrupt: 'Gravação pendente não confirmada. Verifique antes de continuar.' };
      }
      try { return { raw, record: this._record(raw) }; }
      catch (_) { this._freshPendingId = null; return { raw, corrupt: 'Registro local inválido. Ele foi preservado para conferência.' }; }
    }
    _view(record) {
      if (!record) return frozenCopy({ status: 'empty' });
      const view = { status: record.status };
      if (record.status === 'draft') {
        view.savedAt = record.savedAt; view.draft = record.draft;
        view.ageMs = Math.max(0, this._time() - record.savedAt);
        if (view.ageMs >= TTL_MS) view.status = 'expired';
        if (record.rejectedRequestId) { view.rejectedRequestId = record.rejectedRequestId; view.rejection = record.rejection; }
      } else if (record.status === 'pending') {
        view.preparedAt = record.preparedAt; view.request = record.request;
        view.ageMs = Math.max(0, this._time() - record.preparedAt); view.aged = view.ageMs >= TTL_MS;
      } else { view.confirmedAt = record.confirmedAt; view.sale = record.sale; }
      return frozenCopy(view);
    }
    load() {
      const value = this._read();
      return value.corrupt ? frozenCopy({ status: 'corrupt', reason: value.corrupt }) : this._view(value.record);
    }
    get() { return this.load(); }
    _usable() {
      const value = this._read();
      if (value.corrupt) fail('CORRUPT', value.corrupt);
      return value;
    }
    _write(record) {
      const raw = JSON.stringify(record);
      try { this._storage.setItem(this.key, raw); }
      catch (_) { this._freshPendingId = null; fail('STORAGE_WRITE', 'Não foi possível salvar o carrinho local. Nenhuma venda deve ser enviada.'); }
      if (this._raw() !== raw) {
        this._freshPendingId = null;
        fail('STORAGE_VERIFY', 'A gravação local não foi confirmada. Nenhuma venda deve ser enviada.');
      }
      return raw;
    }
    _base(status) { return { version: VERSION, scope: this._scope, status }; }
    _editable(value) {
      if (value.record && value.record.status === 'pending') fail('PENDING', 'Há uma tentativa de venda pendente de verificação.');
      if (value.record && value.record.status === 'confirmed') fail('CONFIRMED', 'Esta tentativa já foi confirmada. Inicie um novo carrinho.');
      if (value.record && this._view(value.record).status === 'expired') fail('EXPIRED', 'Revise ou descarte o rascunho antigo antes de continuar.');
    }
    saveDraft(input) {
      const value = this._usable(); this._editable(value);
      const record = { ...this._base('draft'), savedAt: this._time(), draft: draft(input, false) };
      if (value.record && value.record.rejectedRequestId) {
        record.rejectedRequestId = value.record.rejectedRequestId; record.rejection = value.record.rejection;
      }
      this._write(record); return this._view(record);
    }
    prepare(input) {
      object(input);
      // A tentative write may have failed after the browser accepted it. Retry
      // only this exact request/UUID, never replace an ambiguous pending sale.
      if (this._guard) {
        this._freshPendingId = null;
        const proposed = request(input, this._guard.record.request.p_client_request_id, false);
        if (!equal(proposed, this._guard.record.request)) fail('PENDING', 'A tentativa pendente não pode ser alterada.');
        const raw = this._raw();
        if (raw !== this._guard.pendingRaw && raw !== this._guard.baseRaw) fail('CORRUPT', 'O registro local mudou durante a tentativa.');
        this._write(this._guard.record); return frozenCopy(this._guard.record.request);
      }
      const value = this._usable();
      if (value.record && value.record.status === 'pending') {
        this._freshPendingId = null;
        const proposed = request(input, value.record.request.p_client_request_id, false);
        if (!equal(proposed, value.record.request)) fail('PENDING', 'A tentativa pendente não pode ser alterada.');
        return frozenCopy(value.record.request);
      }
      this._editable(value);
      const rejectedId = value.record && value.record.rejectedRequestId;
      let requestId = field(input, 'p_client_request_id');
      if (requestId === undefined || requestId === null || requestId === '') {
        for (let tries = 0; tries < 8; tries++) {
          requestId = id(this._uuid());
          if (requestId !== rejectedId) break;
        }
      }
      requestId = id(requestId);
      if (requestId === rejectedId) fail('REJECTED_ID', 'Uma nova tentativa precisa de um identificador novo.');
      const prepared = request(input, requestId, false);
      if (value.record) {
        const expected = { ...value.record.draft, overrideTroca: false };
        if (!equal(expected, fromRequest(prepared))) fail('DRAFT_MISMATCH', 'O carrinho mudou. Salve o rascunho atual antes de finalizar.');
      }
      const record = { ...this._base('pending'), preparedAt: this._time(), request: prepared };
      this._guard = { record, baseRaw: value.raw, pendingRaw: JSON.stringify(record) };
      this._terminalRaw = null; this._freshPendingId = null;
      this._write(record);
      this._freshPendingId = prepared.p_client_request_id;
      return frozenCopy(prepared);
    }
    confirmed(input) {
      object(input);
      const sale = { id: id(field(input, 'id')), client_request_id: id(field(input, 'client_request_id')) };
      const value = this._usable();
      if (value.record && value.record.status === 'confirmed') {
        if (!equal(sale, value.record.sale)) fail('CONFIRMATION_MISMATCH', 'A confirmação não corresponde à venda local.');
        return this._view(value.record);
      }
      if (!value.record || value.record.status !== 'pending' || sale.client_request_id !== value.record.request.p_client_request_id) {
        fail('CONFIRMATION_MISMATCH', 'A confirmação não corresponde à tentativa pendente.');
      }
      this._guard = this._guard || { record: value.record, pendingRaw: value.raw, baseRaw: value.raw };
      const record = { ...this._base('confirmed'), confirmedAt: this._time(), sale };
      this._terminalRaw = JSON.stringify(record); this._freshPendingId = null;
      this._write(record);
      this._guard = null; this._terminalRaw = null;
      return this._view(record);
    }
    rejectKnown(requestId, evidence) {
      requestId = id(requestId); exactKeys(evidence, ['code', 'constraint', 'verifiedAbsent', 'firstAttemptInThisPage']);
      if (evidence.code !== '23514' || evidence.constraint !== 'sales_pay_check' || evidence.verifiedAbsent !== true ||
          evidence.firstAttemptInThisPage !== true || this._freshPendingId !== requestId) {
        fail('REJECTION_UNPROVEN', 'A tentativa precisa permanecer pendente até a verificação.');
      }
      const value = this._usable();
      if (!value.record || value.record.status !== 'pending' || value.record.request.p_client_request_id !== requestId) {
        fail('REJECTION_UNPROVEN', 'A rejeição não corresponde à primeira tentativa desta página.');
      }
      const at = this._time();
      const record = { ...this._base('draft'), savedAt: at, draft: fromRequest(value.record.request),
        rejectedRequestId: requestId, rejection: { code: '23514', constraint: 'sales_pay_check', at } };
      this._terminalRaw = JSON.stringify(record); this._freshPendingId = null;
      this._write(record);
      this._guard = null; this._terminalRaw = null;
      return this._view(record);
    }
    restoreExpired() {
      const value = this._usable();
      if (!value.record || this._view(value.record).status !== 'expired') fail('NOT_EXPIRED', 'Não há rascunho antigo para revisar.');
      const record = { ...value.record, savedAt: this._time() };
      this._write(record); return this._view(record);
    }
    discard() {
      const value = this._usable();
      if (value.record && value.record.status === 'pending') fail('PENDING', 'Uma tentativa pendente não pode ser descartada.');
      if (!value.record) return this._view(null);
      try { this._storage.removeItem(this.key); }
      catch (_) { fail('STORAGE_WRITE', 'Não foi possível descartar o rascunho local.'); }
      if (this._raw() !== null) fail('STORAGE_VERIFY', 'O descarte local não foi confirmado.');
      return this._view(null);
    }
    reset() { return this.discard(); }
  }
  return Object.freeze({ DraftStore, DraftStoreError, TTL_MS, MAX_ITEMS });
});
