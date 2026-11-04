(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VaidosaCartUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  function createController(options) { return new Controller(options); }
  class Controller {
    constructor(options) {
      this.o = options; this.store = options.store; this.owner = false;
      this.busy = false; this.status = 'loading'; this.disposed = false;
      this.freshRequest = null; this.release = null;
    }
    view(status, message, extra = {}) {
      this.status = status;
      this.o.setLocked(!this.canEdit());
      this.o.show({ status, message, ...extra });
    }
    canEdit() { return this.owner && !this.busy && ['empty','editing'].includes(this.status); }
    async identity() {
      if (!this.owner || this.disposed) throw new Error('Este caixa está aberto em outra aba. Use a aba original.');
      const id = await this.o.getUserId();
      if (!this.owner || this.disposed) throw new Error('Este caixa não mantém mais a trava de envio. Continue na aba ativa.');
      if (id !== this.store.scope.userId) {
        this.view('account-changed','A conta mudou. O carrinho permanece guardado para a conta original.');
        throw new Error('Entre novamente na conta original para continuar este carrinho.');
      }
    }
    async start() {
      if (!this.o.locks?.request) {
        this.view('unsupported','Este navegador não oferece a trava necessária para proteger o envio entre abas. O caixa está bloqueado.'); return;
      }
      await new Promise(resolve => {
        this.o.locks.request(this.store.key, { ifAvailable: true }, async lock => {
          if (!lock || this.disposed) { this.view('readonly','Outra aba está usando este caixa. Continue nela ou feche-a antes de assumir aqui.'); resolve(); return; }
          this.owner = true;
          try { await this.identity(); this.load(); }
          catch (error) { this.view('error',error.message); }
          resolve();
          await new Promise(release => { this.release = release; if (this.disposed) release(); });
          this.owner = false;
        }).catch(error => { this.view('error','Não foi possível proteger o caixa: '+error.message); resolve(); });
      });
    }
    load() {
      const record = this.store.load();
      this.freshRequest = null;
      if (record.status === 'empty') {
        // BFCache pode manter um carrinho que outra aba já confirmou. A memória
        // antiga nunca vira um pedido novo quando o registro durável está vazio.
        this.o.clearForm();
        this.view('empty','Caixa pronto. Rascunho protegido neste navegador e nesta conta.');
      }
      else if (record.status === 'draft') this.view('restore','Há um carrinho guardado. Confira antes de restaurar; nada será enviado automaticamente.',{draft:record.draft,canRestore:true});
      else if (record.status === 'expired') this.view('expired','Rascunho com mais de 7 dias. É necessário conferir novamente produtos, preços e estoque.',{draft:record.draft,canRestore:true});
      else if (record.status === 'pending') this.view('pending','Há um envio sem confirmação. Primeiro verifique se a venda já foi salva.',{request:record.request,aged:record.aged});
      else if (record.status === 'confirmed') this.view('confirmed','Venda confirmada. Confira os recentes antes de iniciar outro pedido.',{sale:record.sale});
      else this.view('error','O rascunho não pôde ser lido com segurança. Não reenvie a venda; preserve esta aba e procure suporte.');
    }
    changed() {
      if (!this.canEdit()) return false;
      try {
        const draft = this.o.captureDraft();
        if (!draft.items.length && this.store.load().status === 'empty') return true;
        this.store.saveDraft(draft);
        this.view('editing','Rascunho salvo neste navegador. Observações livres não são guardadas.');
        return true;
      } catch (error) {
        // Mantém o carrinho visível para copiar; o envio sempre tentará persistir de novo.
        this.view('editing','Rascunho NÃO salvo: '+error.message+' Não recarregue esta aba.',{storageError:true});
        return false;
      }
    }
    async restore() {
      if (this.busy || !this.owner) return;
      this.busy = true; this.o.setLocked(true);
      try {
        await this.identity();
        let record = this.store.load();
        if (!['draft','expired'].includes(record.status)) return;
        if (!await this.o.confirm('Restaurar o carrinho para conferência? Preços e estoque serão conferidos novamente. Observações livres não foram guardadas.')) return;
        await this.o.applyDraft(record.draft);
        await this.identity();
        if (record.status === 'expired') this.store.restoreExpired();
        this.busy = false;
        this.view('editing','Carrinho restaurado. Confira todos os itens, quantidades, preços e estoque antes de finalizar.');
      } catch (error) { this.view('error','Não foi possível restaurar: '+error.message); }
      finally { this.busy = false; this.o.setLocked(!this.canEdit()); }
    }
    async finalize() {
      if (!this.canEdit() || this.busy) return;
      this.busy = true; this.o.setLocked(true);
      let prepared = false;
      try {
        await this.identity();
        let draft = this.o.captureDraft();
        this.store.saveDraft(draft);
        if (this.o.validateDraft) await this.o.validateDraft(draft);
        await this.identity();
        draft = this.o.captureDraft();
        this.store.saveDraft(draft);
        const payload = this.o.makePayload(draft);
        if (!await this.o.confirm('Conferiu produtos, quantidades, preços e desconto? Confirmar o envio desta venda?')) return;
        await this.identity();
        const request = this.store.prepare(payload);
        prepared = true; this.freshRequest = request.p_client_request_id;
        this.view('pending','Enviando. O pedido está guardado; não monte outra venda nesta aba.',{request});
        await this.send(request, true);
      } catch (error) {
        if (prepared) this.pendingError(error);
        else if (this.status !== 'account-changed') {
          let record;
          try { record = this.store.load(); } catch (_) { /* Cannot establish an editable state without storage. */ }
          if (!record || ['pending','corrupt'].includes(record.status)) this.pendingError(error);
          else this.view('editing','Envio bloqueado: '+error.message+' O carrinho foi mantido.');
        }
      } finally { this.busy = false; this.o.setLocked(!this.canEdit()); }
    }
    pendingError(error) {
      this.freshRequest = null;
      let record;
      try { record = this.store.load(); } catch (_) { /* Storage can fail while handling a network error. Keep sending blocked. */ }
      if (record?.status === 'confirmed') {
        this.view('confirmed','Venda confirmada. A atualização local falhou; confira os recentes e use Nova venda quando estiver pronto. Não reenvie.',{sale:record.sale});
        return;
      }
      this.view('pending','Não foi possível confirmar o envio. Não altere ou refaça o pedido. '+error.message,{request:record?.request});
    }
    async lookup(request) {
      await this.identity();
      const row = await this.o.findSale(request.p_client_request_id);
      await this.identity();
      if (row && row.client_request_id !== request.p_client_request_id) throw new Error('A venda encontrada não corresponde a esta tentativa.');
      return row;
    }
    async complete(row) {
      this.store.confirmed(row); // Falha de persistência mantém pending e impede novo UUID.
      this.freshRequest = null;
      this.o.clearForm();
      this.view('confirmed','Venda confirmada. Confira os recentes; depois use Nova venda.',{sale:{id:row.id}});
      try { await this.o.onSaved(row); }
      catch (_) { this.view('confirmed','Venda salva. A atualização da tela falhou; confira os recentes em outra aba. Não reenvie.',{sale:{id:row.id}}); }
    }
    async send(request, firstFreshAttempt) {
      await this.identity();
      // Confere novamente a cópia durável imediatamente antes de qualquer RPC.
      const durable = this.store.load();
      if (durable.status !== 'pending' || JSON.stringify(durable.request) !== JSON.stringify(request)) throw new Error('A cópia guardada do envio mudou.');
      let result, communicationError;
      try { result = await this.o.createSale(request); }
      catch (error) { communicationError = new Error('Falha de comunicação: '+error.message); }
      const row = await this.lookup(request); // Nunca usa erro/retorno da RPC como única prova.
      if (row) { await this.complete(row); return; }
      if (communicationError) throw communicationError;
      const error = result?.error;
      if (firstFreshAttempt && this.freshRequest === request.p_client_request_id &&
          error?.code === '23514' && /\bsales_pay_check\b/.test(String(error.message||''))) {
        // Só a primeira chamada criada nesta página, sem resultado incerto anterior,
        // resposta SQL explícita + consulta concluída sem venda. Um retry não entra aqui.
        this.store.rejectKnown(request.p_client_request_id,{code:'23514',constraint:'sales_pay_check',verifiedAbsent:true,firstAttemptInThisPage:true});
        this.freshRequest = null;
        this.busy = false;
        this.view('editing','O banco rejeitou esta primeira tentativa por pagamento inválido e a consulta não encontrou venda. Confira o carrinho antes de tentar novamente.');
        return;
      }
      throw new Error(error?.message || 'A confirmação da venda ainda não apareceu.');
    }
    async checkPending() {
      if (this.busy || !this.owner) return;
      this.busy = true; this.o.setLocked(true); this.freshRequest = null;
      try {
        const record = this.store.load();
        if (record.status === 'confirmed') { this.view('confirmed','Venda já confirmada. Confira os recentes; depois use Nova venda.',{sale:record.sale}); return; }
        if (record.status !== 'pending') return;
        const row = await this.lookup(record.request);
        if (row) await this.complete(row);
        else this.view('pending','A consulta não encontrou a venda. Isso não prova que o envio anterior parou. Você pode repetir somente a mesma tentativa.',{request:record.request,canRetry:true});
      } catch (error) { this.pendingError(error); }
      finally { this.busy = false; this.o.setLocked(!this.canEdit()); }
    }
    async retryPending() {
      if (this.busy || !this.owner) return;
      this.busy = true; this.o.setLocked(true); this.freshRequest = null;
      try {
        const record = this.store.load();
        if (record.status !== 'pending') return;
        if (!await this.o.confirm('Conferiu este pedido? Os preços do catálogo podem ter mudado. Verificar novamente e, se não houver confirmação, reenviar a mesma tentativa com os mesmos itens e desconto?')) return;
        const row = await this.lookup(record.request);
        if (row) await this.complete(row);
        else await this.send(record.request, false);
      } catch (error) { this.pendingError(error); }
      finally { this.busy = false; this.o.setLocked(!this.canEdit()); }
    }
    async discard() {
      if (this.busy || !this.owner) return;
      this.busy = true;
      try {
        await this.identity();
        const record = this.store.load();
        if (record.status === 'pending') throw new Error('Primeiro resolva a tentativa de envio.');
        if (!await this.o.confirm('Descartar este rascunho local? Isso não exclui nenhuma venda salva.')) return;
        this.store.discard(); this.o.clearForm();
        this.busy = false; this.view('empty','Caixa pronto para um novo carrinho.');
      } catch (error) {
        let record;
        try { record = this.store.load(); } catch (_) { /* Preserve a locked UI when the local state cannot be checked. */ }
        if (!record || ['pending','confirmed'].includes(record.status)) this.pendingError(error);
        else this.view('error',error.message);
      }
      finally { this.busy = false; this.o.setLocked(!this.canEdit()); }
    }
    async startNew() {
      if (this.busy || !this.owner) return;
      this.busy = true;
      try {
        await this.identity();
        if (this.store.load().status !== 'confirmed') return;
        this.o.clearForm(); this.store.reset(); this.busy=false; this.view('empty','Caixa pronto para a próxima venda.');
      }
      catch (error) { this.view('confirmed','Não foi possível liberar outro pedido: '+error.message); }
      finally { this.busy=false; this.o.setLocked(!this.canEdit()); }
    }
    dispose() { this.disposed=true; this.owner=false; if(this.release) this.release(); this.o.setLocked(true); }
  }
  return { createController };
});
