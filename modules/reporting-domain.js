(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VaidosaReporting = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Monetary source columns have two decimal places. Reject greater precision
  // instead of silently choosing a new accounting/rounding rule for source data.
  function moneyToCents(value) {
    if (typeof value !== 'number' && typeof value !== 'string') throw new TypeError('Valor monetário inválido.');
    const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
    if (!match) throw new TypeError('Valor monetário deve ter no máximo duas casas decimais.');
    const cents = BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0'));
    return safeInteger(match[1] ? -cents : cents);
  }

  function safeInteger(value) {
    const result = Number(value);
    if (!Number.isSafeInteger(result)) throw new RangeError('Valor excede a precisão segura do relatório.');
    return result;
  }

  function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function lineKey(item, index) {
    return item.id != null ? 'item:' + item.id : item.productId != null ? 'product:' + item.productId : 'line:' + index;
  }

  function allocateSaleNet(sale) {
    if (!sale || !Array.isArray(sale.items)) throw new TypeError('Venda sem lista de itens.');
    const net = moneyToCents(sale.netReceived == null ? 0 : sale.netReceived);
    const rows = sale.items.map(function (item, index) {
      const quantity = Number(item.qty);
      const price = moneyToCents(item.price);
      if (!Number.isSafeInteger(quantity) || quantity <= 0 || price < 0) throw new RangeError('Preço ou quantidade de item inválido.');
      return { item: item, index: index, key: lineKey(item, index), grossCents: safeInteger(BigInt(price) * BigInt(quantity)), netCents: 0 };
    });
    const gross = rows.reduce(function (sum, row) { return sum + BigInt(row.grossCents); }, 0n);
    safeInteger(gross);
    if (gross === 0n) {
      if (net !== 0) throw new RangeError('Líquido sem base de itens para rateio.');
      return rows;
    }
    const magnitude = BigInt(Math.abs(net));
    const sign = net < 0 ? -1 : 1;
    let distributed = 0n;
    const remainders = rows.map(function (row) {
      const numerator = magnitude * BigInt(row.grossCents);
      const quotient = numerator / gross;
      row.netCents = Number(quotient) * sign;
      distributed += quotient;
      return { row: row, remainder: numerator % gross };
    }).sort(function (a, b) {
      return a.remainder === b.remainder ? compareText(a.row.key, b.row.key) || a.row.index - b.row.index : a.remainder > b.remainder ? -1 : 1;
    });
    const leftover = Number(magnitude - distributed);
    for (let i = 0; i < leftover; i++) remainders[i].row.netCents += sign;
    return rows;
  }

  function aggregateProductSales(sales) {
    const products = new Map();
    sales.forEach(function (sale, saleIndex) {
      allocateSaleNet(sale).forEach(function (row) {
        // Deleted products have no canonical variant ID: don't merge unrelated
        // historical lines by name/barcode, which can have been reused.
        const key = row.item.productId != null ? 'product:' + row.item.productId : 'sale:' + (sale.id || saleIndex) + ':' + row.index;
        const current = products.get(key) || { key: key, it: row.item, qty: 0, brutoCents: 0, liquidoCents: 0 };
        current.qty = safeInteger(BigInt(current.qty) + BigInt(Number(row.item.qty)));
        current.brutoCents = safeInteger(BigInt(current.brutoCents) + BigInt(row.grossCents));
        current.liquidoCents = safeInteger(BigInt(current.liquidoCents) + BigInt(row.netCents));
        current.bruto = current.brutoCents / 100;
        current.liquido = current.liquidoCents / 100;
        products.set(key, current);
      });
    });
    return Array.from(products.values()).sort(function (a, b) { return b.qty - a.qty || compareText(a.key, b.key); });
  }

  function calendarDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError('Data de calendário inválida.');
    const date = new Date(value + 'T00:00:00.000Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new TypeError('Data de calendário inválida.');
    return value;
  }

  function saleDay(sale, timeZone) {
    if (!timeZone) throw new TypeError('Informe o fuso horário da loja.');
    const value = sale.date;
    if (typeof value === 'string') {
      const timestamp = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.exec(value);
      if (!timestamp) throw new TypeError('Venda precisa de instante com fuso horário ou epoch em milissegundos.');
      calendarDay(timestamp[1]);
      if (Number(timestamp[2]) > 23 || Number(timestamp[3]) > 59 || Number(timestamp[4]) > 59) throw new TypeError('Horário de venda inválido.');
    } else if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError('Venda precisa de instante com fuso horário ou epoch em milissegundos.');
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError('Data de venda inválida.');
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const fields = Object.fromEntries(parts.map(function (p) { return [p.type, p.value]; }));
    return fields.year + '-' + fields.month + '-' + fields.day;
  }

  function monthKey(value) {
    if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new TypeError('Mês inválido.');
    return value;
  }

  function selectSalesByMonth(sales, options) {
    const month = monthKey(options.month);
    if (!options.timeZone) throw new TypeError('Informe o fuso horário da loja.');
    return sales.filter(function (sale) {
      return saleDay(sale, options.timeZone).slice(0, 7) === month &&
        (!options.pay || sale.pay === options.pay) && (!options.channel || (sale.channel || 'Loja') === options.channel);
    });
  }

  function selectReceiptsByMonth(sales, options) {
    const month = monthKey(options.month);
    const receipts = [];
    sales.forEach(function (sale) {
      (sale.payments || []).forEach(function (payment) {
        const date = calendarDay(payment.date);
        if (date.slice(0, 7) !== month) return;
        receipts.push({ source: 'sale_payment', saleId: sale.id, paymentId: payment.id, date: date,
          grossCents: moneyToCents(payment.value), feeCents: moneyToCents(payment.feeValue == null ? 0 : payment.feeValue),
          netCents: moneyToCents(payment.netValue), method: payment.method });
      });
    });
    return receipts;
  }

  // Explicit source partition, not a union/heuristic reconciliation. A manual
  // movement may or may not represent the same real-world money as a sale.
  function separateFinancialSources(input) {
    return { saleReceipts: input.saleReceipts.map(function (receipt) { return Object.assign({}, receipt, { source: 'sale_payment' }); }),
      manualMovements: input.manualMovements.map(function (movement) { return Object.assign({}, movement, { source: 'manual_movement' }); }) };
  }

  return Object.freeze({ moneyToCents: moneyToCents, allocateSaleNet: allocateSaleNet,
    aggregateProductSales: aggregateProductSales, calendarDay: calendarDay, saleDay: saleDay,
    selectSalesByMonth: selectSalesByMonth, selectReceiptsByMonth: selectReceiptsByMonth,
    separateFinancialSources: separateFinancialSources });
});
