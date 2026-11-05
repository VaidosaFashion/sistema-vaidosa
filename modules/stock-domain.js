(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StockDomain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function fail(message) { const e = new Error(message); e.code = 'INVALID_STOCK_ENTRY'; throw e; }
  function normalizeEntry(input) {
    if (!input || typeof input !== 'object') fail('Entrada de estoque inválida.');
    const productId = input.productId;
    if (typeof productId !== 'string' || !UUID.test(productId)) fail('Selecione um produto válido.');
    if (!Number.isInteger(input.qty) || input.qty === 0 || Math.abs(input.qty) > 2147483647) fail('Informe uma quantidade inteira diferente de zero.');
    if (!['ENTRADA', 'SAIDA', 'DEVOLUCAO'].includes(input.type)) fail('Tipo de movimento inválido.');
    const newCost = input.newCost == null ? null : input.newCost;
    if (newCost !== null && (typeof newCost !== 'number' || !Number.isFinite(newCost) || newCost < 0 ||
      newCost > 99999999.99 || Number(newCost.toFixed(2)) !== newCost)) fail('O custo deve ser válido e ter até dois decimais.');
    if (input.note != null && typeof input.note !== 'string') fail('Observação inválida.');
    const note = (input.note || '').trim() || null;
    if (note && note.length > 2000) fail('A observação pode ter até 2.000 caracteres.');
    // qty keeps its signed meaning from the existing stock RPC. This layer does
    // not invent a new return/exchange accounting rule based on the label.
    return Object.freeze({productId: productId.toLowerCase(), qty: input.qty, type: input.type, note, newCost});
  }
  function rpcPayload(entry) {
    const p = normalizeEntry(entry);
    return {product_id: p.productId, qty: p.qty, type: p.type, note: p.note, new_cost: p.newCost};
  }
  function mapProduct(row) {
    if (!row || typeof row.id !== 'string' || !row.id) throw new Error('Produto canônico sem identificação.');
    const mapped = {...row};
    for (const [db, ui] of [['price_atacado','priceAtacado'], ['price_varejo','priceVarejo'], ['color_id','colorId'], ['family_key','familyKey']]) {
      if (Object.prototype.hasOwnProperty.call(row, db)) mapped[ui] = row[db];
    }
    if (Object.prototype.hasOwnProperty.call(row, 'colors')) mapped.colorName = row.colors ? row.colors.nome : null;
    return mapped;
  }
  function mergeCanonicalProducts(cached, rows, requestedIds) {
    if (!Array.isArray(cached) || !Array.isArray(rows)) throw new Error('Lista de produtos inválida.');
    const seen = new Set();
    const fresh = rows.map(row => {
      if (seen.has(row.id)) throw new Error('Resposta canônica contém produto duplicado.');
      seen.add(row.id); return mapProduct(row);
    });
    const requested = requestedIds == null ? null : new Set(requestedIds);
    if (requested && fresh.some(row => !requested.has(row.id))) throw new Error('Resposta contém produto fora da consulta.');
    const byId = new Map(fresh.map(row => [row.id, row]));
    const result = [];
    for (const old of cached) {
      const row = byId.get(old.id);
      if (row) { result.push({...old, ...row}); byId.delete(old.id); }
      else if (!requested || !requested.has(old.id)) result.push({...old});
      // A requested ID absent from a successful canonical query was deleted or
      // is no longer visible; it must not remain sellable using stale stock.
    }
    result.push(...byId.values());
    return result;
  }
  function groupByVariant(products) {
    const groups = new Map();
    for (const raw of products) {
      const p = mapProduct(raw);
      const family = p.familyKey || JSON.stringify([p.name || '', p.cat || '', p.fabric || '']);
      const color = p.colorId || p.colorName || ('unknown:' + p.id);
      const key = JSON.stringify([family, color, p.size || '']);
      if (!groups.has(key)) groups.set(key, {key, name:p.name, size:p.size, colorId:p.colorId || null, colorName:p.colorName || null, stock:0, records:[]});
      const group = groups.get(key);
      if (!Number.isInteger(Number(p.stock)) || Number(p.stock) < 0) throw new Error('Saldo canônico inválido.');
      group.stock += Number(p.stock);
      group.records.push(p);
    }
    return [...groups.values()].map(group => ({...group, ambiguous:group.records.length > 1,
      records:group.records.sort((a,b) => String(a.barcode || '').localeCompare(String(b.barcode || '')) || a.id.localeCompare(b.id))}));
  }
  return Object.freeze({normalizeEntry, rpcPayload, mapProduct, mergeCanonicalProducts, groupByVariant});
});
