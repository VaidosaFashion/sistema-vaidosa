(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports ? require('./stock-domain.js') : root.StockDomain);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StockRepository = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (domain) {
  'use strict';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const DEFINITE_REJECTION = new Set(['22023','22003','23514','23503','42501','P0002']);
  const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
  function error(code, message) { return Object.assign(new Error(message), {code}); }
  function createController({client, createId, journal, withLock}) {
    if (!client || typeof client.rpc !== 'function' || typeof createId !== 'function' ||
      !journal || !['read','write','clear'].every(k => typeof journal[k] === 'function') || typeof withLock !== 'function') {
      throw error('SETUP_REQUIRED','Estoque exige cliente, identificador, registro persistente e trava entre abas.');
    }
    let pending = null, busy = false, confirmed = null;
    function validate(record) {
      if (!record || record.version !== 1 || !UUID.test(record.requestId) ||
        !['prepared','submitting','uncertain','rejected','applied'].includes(record.phase) ||
        typeof record.attempted !== 'boolean' || typeof record.uncertain !== 'boolean') throw error('INVALID_JOURNAL','Registro de entrada não reconhecido. Não envie novamente antes de conferir.');
      return {...record, payload:domain.normalizeEntry(record.payload)};
    }
    async function sync() {
      const stored = await journal.read();
      pending = stored == null ? null : validate(stored);
      if (pending && pending.phase === 'submitting') { pending.phase = 'uncertain'; pending.uncertain = true; }
      if (!pending || !confirmed || confirmed.request_id !== pending.requestId) confirmed = null;
    }
    async function persist(record) {
      await journal.write(clone(record));
      const saved = await journal.read();
      if (JSON.stringify(saved) !== JSON.stringify(record)) throw error('STORAGE_UNAVAILABLE','Não foi possível confirmar o registro local. Nenhum novo envio foi iniciado.');
      pending = record;
    }
    function state() { return {busy, status:pending ? pending.phase : 'idle', pending:clone(pending)}; }
    async function locked(fn) {
      if (busy) throw error('BUSY','Aguarde a conferência da entrada em andamento.');
      busy = true;
      try { return await withLock(async () => { await sync(); return fn(); }); }
      finally { busy = false; }
    }
    async function lookup() {
      const {data, error:rpcError} = await client.rpc('get_stock_entry_request', {
        p_request_id:pending.requestId, p_expected_payload:domain.rpcPayload(pending.payload)
      });
      if (rpcError) throw rpcError;
      if (!data || data.request_id !== pending.requestId || !['applied','not_found'].includes(data.status)) throw error('INVALID_RESPONSE','Não foi possível confirmar a situação da entrada.');
      return data;
    }
    async function applied(result) {
      confirmed = result;
      pending = {...pending, phase:'applied'};
      let warning;
      try { await persist(pending); } catch (_) { warning = 'Entrada confirmada no banco. Mantenha esta tela aberta para concluir a conferência do registro local.'; }
      return {ok:true, status:'applied', requestId:pending.requestId, result:clone(result), warning};
    }
    async function uncertain(cause, attempted) {
      pending = {...pending, phase:'uncertain', uncertain:pending.uncertain || attempted};
      try { await persist(pending); } catch (_) { /* Existing persisted UUID remains the recovery anchor. */ }
      return {ok:false,status:'uncertain',requestId:pending.requestId,error:{code:cause.code || 'UNCONFIRMED',message:cause.message || 'Resultado não confirmado. Confira a mesma tentativa antes de continuar.'}};
    }
    async function send() {
      let before;
      try { before = await lookup(); }
      catch (e) { return uncertain(e, pending.attempted); }
      if (before.status === 'applied') return applied(before);
      if (pending.phase === 'applied') return uncertain(error('MISSING_CONFIRMED_REQUEST','Uma entrada antes confirmada não foi localizada. Conferência manual necessária.'), true);
      if (pending.phase === 'rejected' && !pending.uncertain) return {ok:false,status:'rejected',requestId:pending.requestId,error:{code:'REJECTED',message:'A tentativa foi rejeitada. Revise antes de iniciar outra entrada.'}};
      const hadUncertainty = pending.uncertain;
      const payload = domain.rpcPayload(pending.payload);
      // Persist AND read back the immutable request before invoking a mutating RPC.
      try { await persist({...pending,phase:'submitting',attempted:true}); }
      catch (e) { return {ok:false,status:pending.phase,requestId:pending.requestId,error:{code:'STORAGE_UNAVAILABLE',message:e.message}}; }
      let response;
      try {
        response = await client.rpc('apply_stock_entry_v2', {p_request_id:pending.requestId,
          p_product_id:payload.product_id,p_qty:payload.qty,p_type:payload.type,p_note:payload.note,p_new_cost:payload.new_cost});
      } catch (e) {
        pending = {...pending,uncertain:true};
        try { const result = await lookup(); if (result.status === 'applied') return applied(result); } catch (_) { /* Keep frozen request. */ }
        return uncertain(e,true);
      }
      if (!response.error && response.data && response.data.status === 'applied' && response.data.request_id === pending.requestId) return applied(response.data);
      const cause = response.error || error('INVALID_RESPONSE','Resposta de entrada não confirmada.');
      const definite = !hadUncertainty && !!response.error && DEFINITE_REJECTION.has(response.error.code);
      if (!definite) pending = {...pending,uncertain:true};
      try {
        const result = await lookup();
        if (result.status === 'applied') return applied(result);
        if (definite) {
          await persist({...pending,phase:'rejected'});
          return {ok:false,status:'rejected',requestId:pending.requestId,error:{code:cause.code,message:cause.message}};
        }
      } catch (_) { /* No proof of rejection: never free the UUID. */ }
      return uncertain(cause,true);
    }
    return Object.freeze({
      getState:state,
      ready:() => locked(async () => ({...state(),busy:false})),
      submit:input => locked(async () => {
        const payload = domain.normalizeEntry(input);
        if (pending && JSON.stringify(pending.payload) !== JSON.stringify(payload)) throw error('PENDING_REQUEST','Existe uma entrada pendente com outros dados. Confira a mesma tentativa antes de editar.');
        if (!pending) {
          const requestId = createId();
          if (typeof requestId !== 'string' || !UUID.test(requestId)) throw error('INVALID_REQUEST_ID','Não foi possível criar o identificador da entrada.');
          await persist({version:1,requestId:requestId.toLowerCase(),payload,phase:'prepared',attempted:false,uncertain:false});
        }
        return send();
      }),
      retry:() => locked(async () => { if (!pending) throw error('NO_PENDING_REQUEST','Não há entrada pendente.'); return send(); }),
      acknowledge:() => locked(async () => {
        if (!pending) return;
        const result = await lookup();
        if (result.status !== 'applied') throw error('NOT_CONFIRMED','Confirme a entrada antes de encerrar a tentativa.');
        await journal.clear();
        if (await journal.read() != null) throw error('STORAGE_UNAVAILABLE','O registro local ainda não foi encerrado.');
        pending = null; confirmed = null;
        return clone(result);
      }),
      discardRejected:() => locked(async () => {
        if (!pending || pending.phase !== 'rejected' || pending.uncertain) throw error('NOT_REJECTED','Um envio incerto não pode ser descartado.');
        const result = await lookup();
        if (result.status !== 'not_found') throw error('ALREADY_APPLIED','A entrada foi aplicada. Confira o saldo antes de encerrar.');
        await journal.clear();
        if (await journal.read() != null) throw error('STORAGE_UNAVAILABLE','O registro local ainda não foi encerrado.');
        pending = null; confirmed = null;
      })
    });
  }
  return Object.freeze({createController});
});
