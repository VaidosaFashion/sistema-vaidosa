// Correções financeiras usam uma única transação. Nenhum fallback de UPDATEs
// separados: banco sem a migração deve falhar fechado, sem corrigir pela metade.
let financialCorrection = null;
let financialCorrectionOpening = false;
const moneyCents = value => Math.round((Number(value) + Number.EPSILON) * 100);

function correctionPayments(sale) {
  return (sale.payments || []).map(p => ({
    id: p.id, paid_on: p.date, value: Number(p.value), method: p.method,
    installments: Number(p.installments || 0), note: p.note || ''
  })).sort((a,b) => a.id.localeCompare(b.id));
}

function readFinancialCorrection() {
  const payments = financialCorrection.original.map(p => {
    const row = document.getElementById('fc_payment_' + p.id);
    const method = row.querySelector('[data-field="method"]').value;
    return {
      id: p.id,
      paid_on: row.querySelector('[data-field="date"]').value,
      value: Number(row.querySelector('[data-field="value"]').value),
      method,
      installments: method === 'Credito' ? Number(row.querySelector('[data-field="installments"]').value) : 0,
      note: row.querySelector('[data-field="note"]').value.trim()
    };
  });
  return {discount: Number(document.getElementById('fc_discount').value), payments};
}

function financialCorrectionPreview(sale, draft) {
  const subtotal = moneyCents(sale.subtotal);
  const discount = moneyCents(draft.discount);
  if(!Number.isFinite(draft.discount) || draft.discount < 0 || discount > subtotal) {
    throw new Error('O desconto deve estar entre zero e o subtotal da venda.');
  }
  let paid = 0, fees = 0;
  for(const p of draft.payments) {
    if(!Number.isFinite(p.value) || p.value <= 0 || moneyCents(p.value) <= 0) {
      throw new Error('Cada pagamento deve ter um valor maior que zero.');
    }
    if(!/^\d{4}-\d{2}-\d{2}$/.test(p.paid_on)) throw new Error('Confira a data de cada pagamento.');
    if(!['PIX','Dinheiro','Debito','Credito'].includes(p.method)) throw new Error('Confira a forma de pagamento.');
    if(p.method === 'Credito' && (!Number.isInteger(p.installments) || p.installments < 1 || p.installments > 24)) {
      throw new Error('Informe de 1 a 24 parcelas para crédito.');
    }
    const old = sale.payments.find(x => x.id === p.id);
    const sameTerms = old.method === p.method && Number(old.installments || 0) === p.installments;
    const pct = sameTerms ? Number(old.feePct || 0) : taxaDoPagamento(p.method, p.installments);
    paid += moneyCents(p.value);
    fees += sameTerms && moneyCents(p.value) === moneyCents(old.value)
      ? moneyCents(old.feeValue || 0) : Math.round(moneyCents(p.value) * pct / 100);
  }
  const total = subtotal - discount;
  return {total, paid, fees, net: paid - fees, remaining: total - paid,
    status: paid >= total ? 'Pago' : paid > 0 ? 'Parcial' : 'Aberto'};
}

function updateFinancialCorrectionPreview() {
  if(!financialCorrection) return;
  const sale = financialCorrection.sale;
  try {
    const draft = readFinancialCorrection();
    const preview = financialCorrectionPreview(sale, draft);
    const line = (label, value) => `<div class="sdLinha"><span>${label}</span><b>${value}</b></div>`;
    document.getElementById('fc_summary').innerHTML =
      line('Total da venda', `${fmtBRL(sale.totalBruto)} → ${fmtBRL(preview.total/100)}`) +
      line('Recebido após a correção', fmtBRL(preview.paid/100)) +
      line('Taxas previstas', fmtBRL(preview.fees/100)) +
      line('Líquido previsto', fmtBRL(preview.net/100)) +
      line('Restante', fmtBRL(Math.max(0,preview.remaining)/100)) +
      line('Situação', preview.status) +
      '<p class="muted" style="margin-top:8px">A taxa original é mantida ao corrigir o valor. Ao trocar forma ou parcelas, vale a taxa atual do Financeiro.</p>';
    document.getElementById('fc_error').textContent = preview.remaining < 0
      ? `Os pagamentos ultrapassam o novo total em ${fmtBRL(-preview.remaining/100)}. Confira e corrija os valores recebidos antes de salvar. Esta tela não faz estorno bancário.` : '';
  } catch(error) {
    document.getElementById('fc_error').textContent = error.message;
  }
}

function renderFinancialCorrection(sale) {
  const esc = escapeHtml;
  document.getElementById('fc_info').textContent = `Venda nº ${sale.id.slice(-6).toUpperCase()} · ${fmtDataBR(sale.date)} · Subtotal ${fmtBRL(sale.subtotal)}`;
  document.getElementById('fc_discount').value = Number(sale.discount || 0).toFixed(2);
  document.getElementById('fc_reason').value = '';
  document.getElementById('fc_payments').innerHTML = financialCorrection.original.map((p,i) => `
    <fieldset id="fc_payment_${esc(p.id)}" style="border:1px solid var(--line);border-radius:10px;padding:12px;margin:10px 0;min-width:0">
      <legend class="small">Pagamento ${i+1} · ${fmtBRL(p.value)}</legend>
      <div class="row cols2">
        <div><label for="fc_value_${esc(p.id)}">Valor recebido (R$)</label><input id="fc_value_${esc(p.id)}" data-field="value" type="number" min="0.01" step="0.01" required value="${p.value.toFixed(2)}" /></div>
        <div><label for="fc_date_${esc(p.id)}">Data do recebimento</label><input id="fc_date_${esc(p.id)}" data-field="date" type="date" required value="${esc(p.paid_on)}" /></div>
      </div>
      <div class="row cols2" style="margin-top:8px">
        <div><label for="fc_method_${esc(p.id)}">Forma de pagamento</label><select id="fc_method_${esc(p.id)}" data-field="method">${[['PIX','PIX'],['Dinheiro','Dinheiro'],['Debito','Débito'],['Credito','Crédito']].map(([v,n]) => `<option value="${v}" ${p.method===v?'selected':''}>${n}</option>`).join('')}</select></div>
        <div><label for="fc_installments_${esc(p.id)}">Parcelas (crédito)</label><input id="fc_installments_${esc(p.id)}" data-field="installments" type="number" min="1" max="24" step="1" value="${p.installments || 1}" ${p.method!=='Credito'?'disabled':''} /></div>
      </div>
      <label for="fc_note_${esc(p.id)}">Observação</label><input id="fc_note_${esc(p.id)}" data-field="note" maxlength="1000" value="${esc(p.note)}" />
    </fieldset>`).join('') || '<p class="muted small">Nenhum pagamento registrado. Você pode corrigir o desconto e registrar o recebimento em Pagamentos.</p>';
  document.querySelectorAll('#fc_payments [data-field="method"]').forEach(el => el.addEventListener('change', () => {
    el.closest('fieldset').querySelector('[data-field="installments"]').disabled = el.value !== 'Credito';
  }));
  updateFinancialCorrectionPreview();
}

async function openFinancialCorrection(saleId) {
  if(financialCorrectionOpening || financialCorrection?.saving) return;
  if((typeof pendingPaymentSubmission !== 'undefined' && pendingPaymentSubmission) ||
     (typeof paymentSubmissionBusy !== 'undefined' && paymentSubmissionBusy)) {
    return toast('Pagamento pendente','Confirme o resultado do pagamento antes de iniciar uma correção.');
  }
  financialCorrectionOpening = true;
  try {
    const {data, error} = await sb.from('sales').select('*, sale_items(*), sale_payments(*)').eq('id',saleId).single();
    if(error) throw error;
    if(data.finance_revision == null) throw new Error('A atualização do banco ainda não está disponível. A venda foi preservada.');
    const sale = mapSaleFromDb(data);
    financialCorrection = {sale, original: correctionPayments(sale), saving:false, request:null};
    fecharEdicaoVenda();
    closePaymentModal();
    renderFinancialCorrection(sale);
    document.getElementById('modalFinancialCorrection').classList.remove('hide');
    document.getElementById('fc_discount').focus();
    loadFinancialCorrectionAudit(saleId);
  } catch(error) {
    toast('Não foi possível abrir a correção', error.message || 'Confira a conexão e tente novamente.');
  } finally { financialCorrectionOpening = false; }
}

async function loadFinancialCorrectionAudit(saleId) {
  const target = document.getElementById('fc_audit');
  target.textContent = 'Carregando histórico…';
  try {
    const {data,error} = await sb.from('sale_financial_audit').select('created_at, actor_name, reason, before_data, after_data').eq('sale_id',saleId).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(20);
    if(financialCorrection?.sale.id !== saleId) return;
    if(error) throw error;
    const snapshot = s => `Desconto: ${fmtBRL(s?.discount || 0)} · Total: ${fmtBRL(s?.total_bruto || 0)}<br>` +
      (s?.sale_payments || []).map(p => `${escapeHtml(p.method)}${p.installments>1?` ${p.installments}x`:''}: ${fmtBRL(p.value)} em ${fmtDataBR(p.paid_on)} · Taxa ${fmtBRL(p.fee_value)}${p.note?` · ${escapeHtml(p.note)}`:''}`).join('<br>');
    target.innerHTML = data.length ? data.map(a => `<div style="border-bottom:1px solid var(--line);padding:8px 0"><b>${escapeHtml(new Date(a.created_at).toLocaleString('pt-BR'))}</b><br>${escapeHtml(a.reason)}<br><span class="muted">Responsável: ${escapeHtml(a.actor_name || 'não informado')}</span><details><summary>Antes e depois</summary><p><b>Antes</b><br>${snapshot(a.before_data)}</p><p><b>Depois</b><br>${snapshot(a.after_data)}</p></details></div>`).join('') + '<p class="muted">Até 20 correções mais recentes.</p>' : 'Nenhuma correção registrada.';
  } catch { target.textContent = 'Histórico indisponível no momento. Tente abrir a venda novamente.'; }
}

function closeFinancialCorrection() {
  if(financialCorrection?.saving) return;
  financialCorrection = null;
  document.getElementById('modalFinancialCorrection').classList.add('hide');
}

document.getElementById('btnReviewFinancials').addEventListener('click', () => openFinancialCorrection(currentPaymentSaleId));
document.getElementById('btnReviewSaleFinancials').addEventListener('click', () => openFinancialCorrection(editandoVendaId));
document.getElementById('btnCancelFinancialCorrection').addEventListener('click', closeFinancialCorrection);
document.getElementById('financialCorrectionForm').addEventListener('input', updateFinancialCorrectionPreview);
document.getElementById('financialCorrectionForm').addEventListener('change', updateFinancialCorrectionPreview);
document.getElementById('financialCorrectionForm').addEventListener('submit', async event => {
  event.preventDefault();
  const ctx = financialCorrection;
  if(!ctx || ctx.saving) return;
  const errorBox = document.getElementById('fc_error');
  try {
    const draft = readFinancialCorrection();
    const preview = financialCorrectionPreview(ctx.sale,draft);
    if(preview.remaining < 0) throw new Error('Os pagamentos ultrapassam o novo total. Confira os valores recebidos.');
    if(moneyCents(draft.discount) === moneyCents(ctx.sale.discount) && JSON.stringify(draft.payments) === JSON.stringify(ctx.original)) {
      closeFinancialCorrection();
      return toast('Sem alterações','Nenhum valor foi modificado.');
    }
    const reason = document.getElementById('fc_reason').value.trim();
    if(reason.length < 3) throw new Error('Descreva o motivo da correção (ao menos 3 caracteres).');
    const payload = {p_sale_id:ctx.sale.id, p_expected_revision:ctx.sale.financeRevision, p_discount:draft.discount, p_payments:draft.payments, p_reason:reason};
    const signature = JSON.stringify(payload);
    if(!ctx.request || ctx.request.signature !== signature) ctx.request = {signature,id:crypto.randomUUID()};
    ctx.saving = true;
    document.querySelectorAll('#financialCorrectionForm input, #financialCorrectionForm select, #financialCorrectionForm button').forEach(el => el.disabled = true);
    document.getElementById('btnSaveFinancialCorrection').textContent = 'Salvando…';
    errorBox.textContent = '';
    const {data,error} = await sb.rpc('edit_sale_financials',{...payload,p_request_id:ctx.request.id});
    if(error) throw error;
    if(!data?.id) throw new Error('Não foi possível confirmar a correção. Tente salvar novamente para consultar o mesmo pedido.');
    const updated = mapSaleFromDb(data);
    const index = db.sales.findIndex(s => s.id === updated.id);
    if(index >= 0) db.sales[index] = updated;
    else db.sales.unshift(updated);
    ctx.saving = false;
    closeFinancialCorrection();
    renderSalesTable();
    renderHome();
    toast('Correção salva','Desconto e pagamentos atualizados com histórico.');
  } catch(error) {
    errorBox.textContent = isMissingRpc(error)
      ? 'A atualização do banco ainda não foi aplicada. Nenhuma correção foi feita.'
      : error.message || 'Não foi possível confirmar. Confira a conexão e tente salvar novamente; a mesma correção não será duplicada.';
  } finally {
    ctx.saving = false;
    document.querySelectorAll('#financialCorrectionForm input, #financialCorrectionForm select, #financialCorrectionForm button').forEach(el => el.disabled = false);
    document.querySelectorAll('#fc_payments fieldset').forEach(row => {
      row.querySelector('[data-field="installments"]').disabled = row.querySelector('[data-field="method"]').value !== 'Credito';
    });
    document.getElementById('btnSaveFinancialCorrection').textContent = 'Salvar correção';
  }
});
