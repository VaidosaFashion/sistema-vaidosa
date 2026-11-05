(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AccountsDomain = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function requireUUID(value) {
    if (typeof value !== 'string' || !uuid.test(value)) throw new Error('Identificador inválido.');
    return value.toLowerCase();
  }
  function requireDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Data inválida.');
    const date = new Date(value + 'T12:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || value < '0001-01-01') throw new Error('Data inválida.');
    return value;
  }
  function moneyToCents(value) {
    if (typeof value !== 'number' && typeof value !== 'string') throw new Error('Valor inválido.');
    if (typeof value === 'string' && !/^\d+(\.\d{1,2})?$/.test(value)) throw new Error('Valor inválido.');
    const number = Number(value), cents = Math.round(number * 100);
    if (!Number.isFinite(number) || cents <= 0 || cents > 9999999999 || Math.abs(number * 100 - cents) > 0.000001) throw new Error('Valor inválido.');
    return cents;
  }
  function revisionOf(account) {
    const value = account.operation_revision ?? account.operationRevision;
    if (value === '' || value == null || !Number.isSafeInteger(Number(value)) || Number(value) < 0) throw new Error('Atualize a conta antes de continuar.');
    return Number(value);
  }
  function settleRequest(account, requestId, paidOn) {
    if (account.archived_at || account.archivedAt || account.status !== 'ativo') throw new Error('A conta não está ativa.');
    return Object.freeze({p_account_id: requireUUID(account.id), p_request_id: requireUUID(requestId), p_expected_revision: revisionOf(account), p_paid_on: requireDate(paidOn)});
  }
  // A ausência de cliente_id preserva o vínculo; null significa remoção explícita.
  function editRequest(account, requestId, changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Alterações inválidas.');
    const allowed = new Set(['descricao','valor','proximo_vencimento','obs','categoria_id','cliente_id','forma_recebimento']);
    const result = {};
    for (const [key, value] of Object.entries(changes)) {
      if (!allowed.has(key) || value === undefined) throw new Error('Campo inválido: ' + key);
      if (key === 'valor') result[key] = moneyToCents(value) / 100;
      else if (key === 'proximo_vencimento') result[key] = requireDate(value);
      else if (key === 'cliente_id' || key === 'categoria_id') result[key] = value === null ? null : requireUUID(value);
      else if (key === 'descricao') {
        if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new Error('Descrição inválida.');
        result[key] = value.trim();
      } else if (key === 'obs') {
        if (value !== null && (typeof value !== 'string' || value.length > 4000)) throw new Error('Observação inválida.');
        result[key] = value;
      } else {
        if (value !== null && !['PIX','Cartão Crédito','Cartão Débito','Dinheiro'].includes(value)) throw new Error('Forma de recebimento inválida.');
        result[key] = value;
      }
    }
    return Object.freeze({p_account_id: requireUUID(account.id), p_request_id: requireUUID(requestId), p_expected_revision: revisionOf(account), p_changes: Object.freeze(result)});
  }
  function isEffectiveMovement(movement) { return movement.pago === true && !movement.reversed_at && !movement.reversedAt; }
  return Object.freeze({requireUUID, requireDate, moneyToCents, revisionOf, settleRequest, editRequest, isEffectiveMovement});
});
