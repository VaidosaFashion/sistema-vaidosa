/* Browser composition layer. Repositories own retries; SQL owns mutations.
 * No initialization/network at import time. Loaded before the legacy shell. */
let businessControllers = new Map();
let customerOrdersController = null;
const dataLoadIssues = new Map();

function setDataIssue(source, error) {
  if (error) dataLoadIssues.set(source, String(error.message || error));
  else dataLoadIssues.delete(source);
  const el = document.getElementById('dataFreshness');
  if (!el) return;
  el.classList.toggle('hide', !dataLoadIssues.size);
  el.textContent = dataLoadIssues.size ? 'Não foi possível atualizar: ' + [...dataLoadIssues.keys()].join(', ') + '. Os valores exibidos podem estar desatualizados. Use Atualizar dados; o carrinho será mantido.' : '';
}

async function refreshBusinessData() {
  const button = document.getElementById('refreshBusinessData');
  if (button) button.disabled = true;
  try {
    await Promise.all([loadProductsFromSupabase(), loadSalesFromSupabase(), loadContasFromSupabase(), loadMovimentacoesFromSupabase(), loadStockMovesFromSupabase(), loadClientsFromSupabase()]);
    renderStock(); renderHome(); renderSalesTable(); renderClients(); renderFinanceiro();
    if (customerOrdersController && selectedClientId) await customerOrdersController.refresh();
  } catch (error) { setDataIssue('atualização', error); }
  finally { if (button) button.disabled = false; }
}

async function businessController(area) {
  if (!currentProfile?.id) throw Error('Entre na sua conta antes de enviar.');
  const scope = currentProfile.id + ':' + area;
  if (!businessControllers.has(scope)) {
    const userId=currentProfile.id;
    const ready=(async()=>{
      const storage = VaidosaOperationJournal.create({storage:localStorage,locks:navigator.locks,projectId:SUPABASE_URL,userId,area});
      const client={rpc:async(name,args)=>{
        const {data,error}=await sb.auth.getSession();
        const session=data?.session;
        if(error || currentProfile?.id!==userId || session?.user?.id!==userId || !session.access_token) throw Error('A sessão mudou. Entre novamente na mesma conta para conferir a operação guardada.');
        // Pin this call to the captured user's token; never store it in the journal.
        const bound=supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{
          auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
          global:{headers:{Authorization:'Bearer '+session.access_token}}
        });
        const response=await bound.rpc(name,args);
        const after=await sb.auth.getSession();
        if(after.error || after.data?.session?.user?.id!==userId || currentProfile?.id!==userId) throw Error('A sessão mudou durante o envio. O resultado precisa ser conferido na conta original.');
        return response;
      }};
      const factory=area==='accounts'?AccountsRepository:StockRepository;
      const controller=factory.createController({client,journal:storage.journal,withLock:storage.withLock,createId:()=>crypto.randomUUID()});
      await controller.ready(); return controller;
    })();
    businessControllers.set(scope,ready);
    ready.catch(()=>{if(businessControllers.get(scope)===ready) businessControllers.delete(scope);});
  }
  return businessControllers.get(scope);
}

async function renderOperationRecovery(area) {
  const el = document.getElementById(area + 'Recovery');
  if (!el) return;
  el.replaceChildren();
  try {
    const controller = await businessController(area);
    const state = controller.getState();
    const pending = state.status && !['idle','empty'].includes(state.status);
    el.classList.toggle('hide', !pending);
    if (!pending) return;
    const text = document.createElement('p');
    text.textContent = 'Existe uma operação guardada neste navegador. Confira o resultado antes de iniciar outra. Nenhum novo valor será usado nessa conferência.';
    el.append(text);
    const button = document.createElement('button'); button.className = 'btn';
    button.textContent = 'Conferir operação guardada';
    button.onclick = async () => {
      button.disabled = true;
      try {
        const result = await controller.retry();
        if (result.ok) { await finishBusinessOperation(area, controller, result); toast('Confirmado', 'Operação conferida.'); }
        else toast('Operação pendente', String(result.error?.message || result.error || 'Não foi possível confirmar o resultado.'));
      } catch (error) { toast('Não foi possível conferir', error.message); }
      finally { await renderOperationRecovery(area); }
    };
    el.append(button);
    if (state.status === 'rejected') {
      const discard = document.createElement('button'); discard.className = 'btn';
      discard.textContent = 'Liberar tentativa rejeitada';
      discard.onclick = async () => {
        discard.disabled = true;
        try { const result=await controller.discardRejected(); if(result && result.ok===false) throw Error(result.error||'A tentativa permanece guardada.'); }
        catch(error) { toast('Mantida para conferência', error.message); }
        finally { await renderOperationRecovery(area); }
      };
      el.append(discard);
    }
  } catch (error) { el.classList.remove('hide'); el.textContent = 'Envio protegido indisponível: ' + error.message; }
}

async function finishBusinessOperation(area, controller, response) {
  if (area === 'accounts') {
    await Promise.all([loadContasFromSupabase(true), loadMovimentacoesFromSupabase(true)]);
    const acknowledgement=await controller.acknowledge();
    if(acknowledgement?.ok===false) throw Error(acknowledgement.error||'A operação permanece guardada.');
    renderFinanceiro();
  } else {
    // A replay may be older than another operation: always read canonical stock.
    await Promise.all([loadProductsFromSupabase(true), loadStockMovesFromSupabase(true)]);
    const canonical=await controller.acknowledge();
    if(canonical?.product) db.products=StockDomain.mergeCanonicalProducts(db.products,[canonical.product],[canonical.product.id]);
    else if(canonical?.product_deleted) db.products=db.products.filter(p=>p.id!==response.result?.product?.id && p.id!==canonical.move?.product_id);
    renderStock(); renderHome();
  }
  await renderOperationRecovery(area);
}

async function executeAccountOperation(operation, args) {
  try {
    const controller = await businessController('accounts');
    const response = await controller.submit({operation, args});
    if (!response.ok) throw Error(String(response.error?.message || response.error || 'Resultado pendente. Use Conferir operação guardada.'));
    await finishBusinessOperation('accounts', controller, response);
    return true;
  } catch (error) { toast('Conta preservada para conferência', error.message); return false; }
  finally { await renderOperationRecovery('accounts'); }
}

async function settleAccountFromUI(id) {
  const account = db.contas.find(c => c.id === id);
  if (!account || account.archivedAt) return;
  if(account.status!=='ativo') return toast('Conta concluída','Confira o histórico antes de registrar outro movimento.');
  if (await executeAccountOperation('settle_account', {p_account_id:id, p_expected_revision:account.operationRevision, p_paid_on:hojeISOLocal()})) toast('Registrado', 'A conta e o movimento foram salvos juntos.');
}

async function reverseAccountFromUI(id, movementId) {
  const account = db.contas.find(c => c.id === id);
  const movement = db.movimentacoes.find(m => m.id === movementId && m.contaId === id);
  if (!account || !movement || !movement.operationRequestId || movement.reversedAt) return toast('Reversão indisponível', 'Selecione no histórico uma operação protegida. Lançamentos antigos precisam de revisão específica.');
  const reason = prompt('Motivo para reverter este movimento de ' + fmtBRL(movement.valor) + '? O registro ficará no histórico.');
  if (!reason?.trim()) return;
  if (await executeAccountOperation('reverse_account_settlement', {p_account_id:id,p_movement_id:movementId,p_expected_revision:account.operationRevision,p_reason:reason.trim()})) toast('Revertido', 'A conta foi restaurada e o movimento continua no histórico.');
}

async function archiveAccountFromUI(id) {
  const account = db.contas.find(c => c.id === id);
  if (!account) return;
  if (account.status !== 'concluido') return toast('Conta ativa', 'Arquivamento disponível somente para conta concluída. Cancelar uma obrigação ativa precisa de uma regra específica.');
  const reason = prompt('Motivo para arquivar esta conta? Os movimentos serão preservados.');
  if (!reason?.trim()) return;
  await executeAccountOperation('archive_account', {p_account_id:id,p_expected_revision:account.operationRevision,p_reason:reason.trim()});
}

function populateReceivableClients(selected) {
  const select = document.getElementById('receberCliente');
  const filter = document.getElementById('fin_filtroReceberCliente');
  const previous = selected === undefined ? select.value : selected;
  const previousFilter = filter.value;
  const rows = db.clients.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
  select.innerHTML = '<option value="">Nenhum</option>' + rows;
  // Keep the reference when the client list is unavailable/incomplete.
  if (previous && !db.clients.some(c => c.id === previous)) {
    const missing = document.createElement('option'); missing.value = previous;
    missing.textContent = 'Cliente vinculado — cadastro não carregado'; select.append(missing);
  }
  select.value = previous || '';
  filter.innerHTML = '<option value="">Todos</option>' + rows;
  if ([...filter.options].some(o => o.value === previousFilter)) filter.value = previousFilter;
}

function getCustomerOrdersController() {
  if (!customerOrdersController) customerOrdersController = VaidosaCustomerOrders.createController({
    pageSize:20,
    repository:{listCustomerOrders:async ({clientId,cursor,limit,signal}) => {
      if (!/^[a-f\d-]{36}$/i.test(clientId)) throw Error('Cliente inválido.');
      let query = sb.from('sales').select('id,sold_at,client_id,channel,kind,pay,installments,discount,subtotal,total_bruto,net_received,payment_status,sale_items(id,product_id,name,barcode,size,qty,price),sale_payments(id,paid_on,value,method,installments,fee_pct,fee_value,net_value)')
        .eq('client_id',clientId).order('sold_at',{ascending:false}).order('id',{ascending:true}).limit(limit+1);
      if (cursor) {
        const after = JSON.parse(cursor);
        if (after.clientId!==clientId || !/^[a-f\d-]{36}$/i.test(after.id) || !/^\d{4}-\d\d-\d\dT[\d:.+-]+Z?$/.test(after.date) || !Number.isFinite(Date.parse(after.date))) throw Error('Página inválida. Atualize o histórico.');
        query = query.or(`sold_at.lt.${after.date},and(sold_at.eq.${after.date},id.gt.${after.id})`);
      }
      if (signal && query.abortSignal) query = query.abortSignal(signal);
      const {data,error} = await query;
      if (error || !Array.isArray(data)) throw Error(error?.message || 'Não foi possível carregar o histórico.');
      const page = data.slice(0,limit); const last=page.at(-1);
      return {orders:page.map(mapSaleFromDb),nextCursor:data.length>limit ? JSON.stringify({clientId,date:last.sold_at,id:last.id}) : null};
    }},
    onState:state => VaidosaCustomerOrders.renderHistory(document.getElementById('clientHistory'),state,{
      onOpenOrder:id=>getCustomerOrdersController().openOrder(id),onLoadMore:()=>getCustomerOrdersController().loadMore(),formatMoney:fmtBRL,
      formatDate:date=>new Date(date).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})
    }),
    onOpenOrder:async id => {
      try {
        const {data,error}=await sb.from('sales').select('*,sale_items(*),sale_payments(*)').eq('id',id).single();
        if(error || !data) throw Error(error?.message||'Venda indisponível.');
        const sale=mapSaleFromDb(data); const index=db.sales.findIndex(s=>s.id===id);
        if(index<0) db.sales.push(sale); else db.sales[index]=sale;
        openSaleDrawer(id);
      }catch(error){toast('Não foi possível abrir',error.message);}
    }
  });
  return customerOrdersController;
}

function renderStockVariants() {
  const body=document.getElementById('stockVariants');
  if(!body) return;
  const query=(document.getElementById('st_q')?.value||'').trim().toLocaleLowerCase('pt-BR');
  const size=document.getElementById('st_size')?.value||'';
  const color=document.getElementById('st_color')?.value||'';
  const category=document.getElementById('st_cat')?.value||'';
  const products=db.products.filter(p=>(!query || [p.name,p.barcode,p.sku].some(v=>String(v||'').toLocaleLowerCase('pt-BR').includes(query))) && (!size||p.size===size) && (!color||p.colorName===color) && (!category||p.cat===category));
  body.innerHTML=products.map(p=>`<tr><td>${escapeHtml(p.barcode)}</td><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.colorName||'')}</td><td>${escapeHtml(p.size)}</td><td class="right">${toNum(p.stock)}</td></tr>`).join('');
}
