(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VaidosaOperationJournal = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const MAX_BYTES = 98304;
  const forbidden = /^(?:__proto__|prototype|constructor|cpf|buyer_cpf_nfce|cnpj|password|senha|token|access_token|refresh_token|authorization|service_role|api_key)$/i;
  function fail(message, code) { const error = new Error(message); error.code = code; return error; }
  function jsonCopy(value) {
    const seen = new Set();
    function check(item, depth) {
      if (depth > 12) throw fail('Operação local muito complexa.', 'JOURNAL_INVALID');
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
      if (typeof item === 'number' && Number.isFinite(item)) return;
      if (!item || typeof item !== 'object' || seen.has(item)) throw fail('Operação local inválida.', 'JOURNAL_INVALID');
      seen.add(item);
      if (!Array.isArray(item) && Object.prototype.toString.call(item) !== '[object Object]') throw fail('Operação local inválida.', 'JOURNAL_INVALID');
      for (const [key, child] of Object.entries(item)) {
        if (forbidden.test(key)) throw fail('Campo não permitido no registro local.', 'JOURNAL_INVALID');
        check(child, depth + 1);
      }
      seen.delete(item);
    }
    check(value, 0);
    const text = JSON.stringify(value);
    if (text.length > MAX_BYTES) throw fail('Operação local excede o limite de armazenamento.', 'JOURNAL_TOO_LARGE');
    return JSON.parse(text);
  }
  function scopePart(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\x00-\x1f]/.test(value)) throw fail('Conta, loja ou módulo inválido para o registro local.', 'JOURNAL_SCOPE');
    return value;
  }
  function create({storage, locks, projectId, userId, area} = {}) {
    const scope = {projectId: scopePart(projectId), userId: scopePart(userId), area: scopePart(area)};
    if (!storage || ['getItem','setItem','removeItem'].some(name => typeof storage[name] !== 'function')) throw fail('Armazenamento local indisponível. Nenhum envio foi iniciado.', 'JOURNAL_UNAVAILABLE');
    if (!locks || typeof locks.request !== 'function') throw fail('Este navegador não permite coordenar operações entre abas. Use um navegador com Web Locks.', 'LOCK_UNAVAILABLE');
    const key = 'vaidosa:operation:v1:' + [scope.projectId, scope.userId, scope.area].map(encodeURIComponent).join(':');
    function read() {
      let text;
      try { text = storage.getItem(key); } catch (_) { throw fail('Não foi possível ler a operação local. Não envie outra operação.', 'JOURNAL_READ'); }
      if (text === null) return null;
      try {
        if (typeof text !== 'string' || text.length > MAX_BYTES) throw new Error();
        const envelope = JSON.parse(text);
        if (envelope.version !== 1 || !envelope.scope || Object.keys(envelope.scope).length !== 3 ||
            Object.keys(scope).some(name => envelope.scope[name] !== scope[name]) || !envelope.record || typeof envelope.record !== 'object') throw new Error();
        return jsonCopy(envelope.record);
      } catch (_) { throw fail('Registro local inválido. Preserve este navegador e peça revisão; nenhum pedido será reenviado automaticamente.', 'JOURNAL_CORRUPT'); }
    }
    function write(record) {
      const envelope = {version: 1, scope, record: jsonCopy(record)};
      const text = JSON.stringify(envelope);
      if (text.length > MAX_BYTES) throw fail('Operação local excede o limite de armazenamento.', 'JOURNAL_TOO_LARGE');
      try {
        storage.setItem(key, text);
        if (storage.getItem(key) !== text) throw new Error();
      } catch (_) { throw fail('Não foi possível confirmar a gravação local. Não inicie outro envio.', 'JOURNAL_WRITE'); }
      return jsonCopy(record);
    }
    function clear(expectedRequestId) {
      const current = read();
      if (expectedRequestId && current && current.requestId !== expectedRequestId) throw fail('Outra operação ocupa este registro local.', 'JOURNAL_CONFLICT');
      try {
        storage.removeItem(key);
        if (storage.getItem(key) !== null) throw new Error();
      } catch (_) { throw fail('Não foi possível liberar o registro local. Confira a operação antes de continuar.', 'JOURNAL_CLEAR'); }
    }
    async function withLock(callback) {
      if (typeof callback !== 'function') throw fail('Operação inválida.', 'LOCK_INVALID');
      return locks.request(key, {mode: 'exclusive', ifAvailable: true}, async lock => {
        if (!lock) throw fail('Outra aba está processando esta operação. Aguarde e confira o resultado.', 'LOCK_BUSY');
        return callback();
      });
    }
    return Object.freeze({key, journal: Object.freeze({read, write, clear}), withLock});
  }
  return Object.freeze({create, MAX_BYTES});
});
