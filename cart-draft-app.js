/* Integração do caixa existente. Sem RPC ou migração nova. */
let cartDraftController = null;
let cartDraftApplying = false;
let cartDraftLocked = true;
let cartDraftAuthSubscription = null;
let cartDraftGeneration = 0;
const cartDraftFieldIds = ['sale_client','sale_clientBusca','sale_vendedor','sale_channel','sale_kind','sale_price_tier','sale_discount','sale_note','overrideTroca','sale_barcode','btnManualAdd','btnFinalize','btnClearSale'];
function cartDraftSetLocked(locked) {
  cartDraftLocked = locked;
  for (const id of cartDraftFieldIds) { const el = document.getElementById(id); if (el) el.disabled = locked; }
  document.querySelectorAll('#saleItems input, #saleItems button').forEach(el => { el.disabled = locked; });
  if (locked && typeof fecharComboCliente === 'function') fecharComboCliente();
}
function cartDraftChanged() {
  if (!cartDraftApplying) cartDraftController?.changed();
  cartDraftSetLocked(!cartDraftController?.canEdit());
}
function cartDraftCapture() {
  const value = id => document.getElementById(id).value;
  return { items:currentSale.items.map(it=>({productId:it.productId,qty:it.qty})),
    clientId:value('sale_client')||null,vendedorId:value('sale_vendedor')||null,
    channel:value('sale_channel'),kind:value('sale_kind'),priceTier:value('sale_price_tier'),
    discount:Number(value('sale_discount')),overrideTroca:document.getElementById('overrideTroca').checked };
}
function cartDraftItem(p, item, tier) {
  return {productId:item.productId,qty:item.qty,name:p?.name||'Produto indisponível — confira o cadastro',
    cat:p?.cat||'',fabric:p?.fabric||'',size:p?.size||'',barcode:p?.barcode||'',colorName:p?.colorName||'',
    price:p?priceForTier(p,tier):0,cost:p?toNum(p.cost):0};
}
function cartDraftApply(draft) {
  if (draft.clientId && !db.clients.some(c=>c.id===draft.clientId)) throw new Error('O cliente guardado não foi carregado. Confira a conexão/cadastro antes de restaurar.');
  if (draft.vendedorId && !db.vendedores.some(v=>v.id===draft.vendedorId)) throw new Error('O vendedor guardado não foi carregado. Confira a conexão/cadastro antes de restaurar.');
  cartDraftApplying = true;
  try {
    currentSale = {items:draft.items.map(it=>cartDraftItem(db.products.find(p=>p.id===it.productId),it,draft.priceTier)),finalizedSaleId:null};
    renderSaleClientSelect(); renderSaleVendedorSelect(); setSaleClient(draft.clientId||'');
    for (const [field,value] of Object.entries({sale_vendedor:draft.vendedorId||'',sale_channel:draft.channel,sale_kind:draft.kind,sale_price_tier:draft.priceTier,sale_discount:draft.discount,sale_pay:'Pendente',sale_note:''})) document.getElementById(field).value=value;
    document.getElementById('overrideTroca').checked=draft.overrideTroca;
    renderSale();
  } finally { cartDraftApplying = false; }
}
function cartDraftClear() {
  cartDraftApply({items:[],clientId:null,vendedorId:null,channel:'Loja',kind:'Venda',priceTier:'Atacado',discount:0,overrideTroca:false});
  document.getElementById('sale_barcode').value='';
}
async function cartDraftValidate(draft, stillActive = () => true) {
  const assertActive=()=>{if(!stillActive())throw new Error('A aba ativa mudou durante a conferência. Continue no caixa atual.');};
  assertActive();
  if (!draft.items.length) throw new Error('Adicione pelo menos um produto.');
  if (document.getElementById('sale_note').value.trim()) throw new Error('Observações livres não entram no rascunho protegido. Copie a observação, retire-a deste campo e inclua em Editar depois que a venda for confirmada.');
  const client = draft.clientId ? findClientById(draft.clientId) : null;
  if (draft.clientId && !client) throw new Error('Cliente não encontrado.');
  if (draft.kind==='Troca' && client && settings.blockSecondSwap && !draft.overrideTroca && toNum(client.trocaCount)>=1) throw new Error('Este cliente já tem troca registrada. Confira a regra de segunda troca.');
  const fresh=[];
  for (let i=0;i<draft.items.length;i+=100) {
    const {data,error}=await sb.from('products').select('id,name,cat,fabric,size,barcode,cost,stock,price_atacado,price_varejo').in('id',draft.items.slice(i,i+100).map(it=>it.productId));
    assertActive();
    if (error || !Array.isArray(data)) throw new Error('Não foi possível conferir o estoque atual. '+(error?.message||''));
    fresh.push(...data);
  }
  assertActive();
  for (const row of fresh) {
    const cached=db.products.find(p=>p.id===row.id);
    const product={...cached,...row,priceAtacado:row.price_atacado,priceVarejo:row.price_varejo};
    if (cached) Object.assign(cached,product); else db.products.push(product);
  }
  for (const item of draft.items) {
    const row=fresh.find(p=>p.id===item.productId);
    if (!row) throw new Error('Um produto do carrinho não está mais disponível. Confira os itens.');
    if (row.stock < item.qty) throw new Error('Estoque insuficiente: '+row.name+'. O carrinho foi preservado; o saldo exibido foi atualizado.');
  }
  cartDraftApplying=true;
  try { currentSale.items=draft.items.map(it=>cartDraftItem(db.products.find(p=>p.id===it.productId),it,draft.priceTier)); renderSale(); }
  finally { cartDraftApplying=false; }
  if (draft.discount > saleTotals(currentSale).sub) throw new Error('O desconto não pode ultrapassar o subtotal.');
}
function cartDraftPayload(draft) {
  if (document.getElementById('sale_note').value.trim()) throw new Error('Copie a observação e inclua em Editar após a confirmação.');
  // O select legado pode ter ficado vazio pelo reset antigo para PIX.
  document.getElementById('sale_pay').value='Pendente';
  return {p_client_id:draft.clientId,p_vendedor_id:draft.vendedorId,p_channel:draft.channel,p_kind:draft.kind,
    p_pay:'Pendente',p_installments:0,p_discount:draft.discount,p_note:null,
    p_items:draft.items.map(it=>({product_id:it.productId,qty:it.qty})),p_price_tier:draft.priceTier};
}
function cartDraftShow(model) {
  const box=document.getElementById('cartDraftStatus'); if (!box) return;
  box.replaceChildren(); box.dataset.status=model.status;
  const message=document.createElement('p'); message.textContent=model.message; box.append(message);
  const source=model.draft || (model.request ? {items:model.request.p_items.map(it=>({productId:it.product_id,qty:it.qty})),discount:model.request.p_discount,priceTier:model.request.p_price_tier,clientId:model.request.p_client_id,vendedorId:model.request.p_vendedor_id,channel:model.request.p_channel,kind:model.request.p_kind} : null);
  if (source) {
    const details=document.createElement('details');
    const summary=document.createElement('summary'); summary.textContent=source.items.reduce((n,it)=>n+it.qty,0)+' peças guardadas • '+source.priceTier+' • desconto '+fmtBRL(source.discount); details.append(summary);
    const list=document.createElement('ul');
    for (const it of source.items) { const p=db.products.find(p=>p.id===it.productId); const li=document.createElement('li'); li.textContent=it.qty+' × '+(p ? p.name+' / '+p.size+' / '+p.barcode : 'Produto indisponível: '+it.productId); list.append(li); }
    details.append(list); box.append(details);
    const context=document.createElement('p');
    context.textContent=(source.kind||'Venda')+' • '+(source.channel||'Loja')+' • Cliente: '+(source.clientId ? db.clients.find(c=>c.id===source.clientId)?.name||'cadastro não carregado' : 'não informado')+' • Vendedor: '+(source.vendedorId ? db.vendedores.find(v=>v.id===source.vendedorId)?.name||'cadastro não carregado' : 'não informado');
    box.append(context);
  }
  if (model.sale?.id) { const p=document.createElement('p');p.textContent='Venda #'+model.sale.id.slice(-6).toUpperCase();box.append(p); }
  const button=(label,fn)=>{const b=document.createElement('button');b.type='button';b.className='btn small';b.textContent=label;b.addEventListener('click',fn);box.append(b);};
  if(model.canRestore) button('Conferir e restaurar',()=>cartDraftController.restore());
  if(['restore','expired'].includes(model.status)) button('Descartar rascunho',()=>cartDraftController.discard());
  if(model.status==='pending') { button('Verificar se a venda foi salva',()=>cartDraftController.checkPending()); if(model.canRetry) button('Repetir a mesma tentativa',()=>cartDraftController.retryPending()); }
  if(model.status==='confirmed') button('Nova venda',()=>cartDraftController.startNew());
  if(model.status==='readonly') button('Assumir após fechar a outra aba',()=>initCartDraftApp());
}
async function initCartDraftApp() {
  const generation=++cartDraftGeneration;
  cartDraftController?.dispose(); cartDraftSetLocked(true);
  try {
    const store=new VaidosaCartDrafts.DraftStore({storage:window.localStorage,scope:{store:new URL(SUPABASE_URL).hostname,userId:currentProfile.id}});
    const controller=VaidosaCartUI.createController({store,locks:navigator.locks,
      getUserId:async()=>{const {data,error}=await sb.auth.getSession();if(error)throw error;return data?.session?.user?.id;},
      captureDraft:cartDraftCapture,
      applyDraft:draft=>{if(generation!==cartDraftGeneration || controller.disposed)throw new Error('O caixa ativo mudou.');return cartDraftApply(draft);},
      clearForm:()=>{if(generation!==cartDraftGeneration || controller.disposed)throw new Error('O caixa ativo mudou.');cartDraftClear();},
      makePayload:cartDraftPayload,
      validateDraft:draft=>cartDraftValidate(draft,()=>generation===cartDraftGeneration && !controller.disposed && controller.owner),
      findSale:async id=>{const {data,error}=await sb.from('sales').select('*, sale_items(*), sale_payments(*)').eq('client_request_id',id).maybeSingle();if(error)throw error;return data;},
      createSale:payload=>sb.rpc('create_sale',payload),
      onSaved:async row=>{
        const sale=mapSaleFromDb(row); db.sales=db.sales.filter(s=>s.id!==sale.id);db.sales.unshift(sale);
        renderSalesTable();renderHome();
        // Deriva o mínimo de trocas confirmadas; repetir a recuperação não soma +1.
        // O filtro impede rebaixar um contador legado maior ou alterado por outra aba.
        if(row.kind==='Troca' && row.client_id) {
          const {count,error}=await sb.from('sales').select('id',{count:'exact',head:true}).eq('client_id',row.client_id).eq('kind','Troca');
          if(error || !Number.isSafeInteger(count) || count<1) throw new Error('Venda salva; não foi possível conferir o contador de trocas.');
          const {error:updateError}=await sb.from('clients').update({troca_count:count}).eq('id',row.client_id).lt('troca_count',count);
          if(updateError) throw updateError;
          const c=findClientById(row.client_id);if(c)c.trocaCount=Math.max(toNum(c.trocaCount),count);
        }
        await loadProductsFromSupabase(); await loadStockMovesFromSupabase();
        pushStockToNuvemshop(sale.items.map(it=>it.barcode));
        if(generation===cartDraftGeneration && !controller.disposed)toast('Finalizado','Venda #'+sale.id.slice(-6).toUpperCase()+' confirmada. Use Nova venda para continuar.');
      },setLocked:locked=>{if(generation===cartDraftGeneration)cartDraftSetLocked(locked);},
      show:model=>{if(generation===cartDraftGeneration && !controller.disposed)cartDraftShow(model);},
      confirm:message=>window.confirm(message)});
    cartDraftController=controller;
    cartDraftAuthSubscription?.unsubscribe();
    cartDraftAuthSubscription=sb.auth.onAuthStateChange((_event,session)=>{
      if(generation===cartDraftGeneration && session?.user?.id!==store.scope.userId) {
        cartDraftController?.dispose();
        cartDraftShow({status:'account-changed',message:'A conta mudou. O carrinho está guardado para a conta original. Entre novamente nessa conta para continuar.'});
      }
    }).data.subscription;
    await cartDraftController.start();
  } catch(error) {if(generation!==cartDraftGeneration)return;cartDraftSetLocked(true);cartDraftShow({status:'error',message:'Não foi possível proteger o carrinho: '+error.message+'. Não recarregue um carrinho em uso.'});}
}
for(const id of cartDraftFieldIds) {
  const el=document.getElementById(id); if(el && !id.startsWith('btn') && id!=='sale_clientBusca' && id!=='sale_barcode' && id!=='sale_note') {
    el.addEventListener('change',cartDraftChanged);el.addEventListener('input',cartDraftChanged);
  }
}
cartDraftSetLocked(true);
window.addEventListener('beforeunload',event=>{if(cartDraftController && ['editing','pending'].includes(cartDraftController.status)){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',()=>cartDraftController?.dispose());
window.addEventListener('pageshow',event=>{if(event.persisted && cartDraftController)initCartDraftApp();});
