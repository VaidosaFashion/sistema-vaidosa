(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AccountsRepository = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const signatures = {
    create_account_v2: ['p_values'],
    settle_account: ['p_account_id','p_expected_revision','p_paid_on'],
    edit_account: ['p_account_id','p_expected_revision','p_changes'],
    reverse_account_settlement: ['p_account_id','p_movement_id','p_expected_revision','p_reason'],
    archive_account: ['p_account_id','p_expected_revision','p_reason']
  };
  const rejections = new Set(['22023','22P02','23502','23503','23505','23514','42501','40001','40P01','P0002']);
  function fail(message, code) { const error = new Error(message); error.code = code; return error; }
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
  function canonical(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.prototype.toString.call(value) !== '[object Object]') throw fail('Dados da operação inválidos.', 'INVALID_REQUEST');
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (['__proto__','constructor','prototype'].includes(key)) throw fail('Campo inválido.', 'INVALID_REQUEST');
      out[key] = canonical(value[key]);
    }
    return out;
  }
  function normalize(input) {
    if (!input || !Object.hasOwn(signatures, input.operation)) throw fail('Operação de conta não permitida.', 'INVALID_REQUEST');
    const args = canonical(input.args), fields = signatures[input.operation];
    if (!args || Object.keys(args).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(args, key))) throw fail('Argumentos da operação incompletos ou inválidos.', 'INVALID_REQUEST');
    if (Object.hasOwn(args, 'p_account_id') && !uuid.test(args.p_account_id)) throw fail('Conta inválida.', 'INVALID_REQUEST');
    if (Object.hasOwn(args, 'p_movement_id') && !uuid.test(args.p_movement_id)) throw fail('Movimentação inválida.', 'INVALID_REQUEST');
    if (Object.hasOwn(args, 'p_expected_revision') && (!Number.isSafeInteger(args.p_expected_revision) || args.p_expected_revision < 0)) throw fail('Atualize a conta antes de continuar.', 'INVALID_REQUEST');
    if (JSON.stringify(args).length > 60000) throw fail('Operação muito extensa.', 'INVALID_REQUEST');
    return {operation: input.operation, args};
  }
  function message(error) { return typeof error?.message === 'string' ? error.message : 'Não foi possível confirmar o resultado. Confira antes de reenviar.'; }
  function createController({client, journal, withLock, createId} = {}) {
    if (!client || typeof client.rpc !== 'function' || !journal || ['read','write','clear'].some(key => typeof journal[key] !== 'function') || typeof withLock !== 'function' || typeof createId !== 'function') throw fail('Dependências de operações de contas indisponíveis.', 'INVALID_ADAPTER');
    let state = {status: 'idle', request: null};
    function getState() { return freeze(copy(state)); }
    function output(ok, result) { return {ok, status: state.status, requestId: state.request?.requestId || null, ...(result ? {result: copy(result)} : {}), ...(state.error ? {error: state.error} : {})}; }
    function restore(record) {
      if (!record) { state = {status:'idle',request:null}; return null; }
      try {
        if (record.version !== 1 || record.kind !== 'account-operation' || !uuid.test(record.requestId) ||
            typeof record.attempted !== 'boolean' || typeof record.uncertain !== 'boolean' || typeof record.confirmed !== 'boolean' ||
            !['prepared','checking','sending','uncertain','completed','rejected'].includes(record.status)) throw new Error();
        normalize(record);
      } catch (_) { throw fail('Registro de conta inválido. Preserve o registro para revisão.', 'INVALID_JOURNAL'); }
      if (record.status === 'sending') record = {...record,uncertain:true};
      state = {status: ['checking','sending'].includes(record.status) ? 'uncertain' : record.status, request: copy(record)};
      return copy(record);
    }
    async function save(record, status, code) {
      const next = {...record,status};
      if (code) next.errorCode = code; else delete next.errorCode;
      await journal.write(next);
      if (JSON.stringify(await journal.read()) !== JSON.stringify(next)) throw fail('Não foi possível confirmar a gravação local.', 'JOURNAL_WRITE');
      state = {status,request:copy(next)};
      return next;
    }
    async function lookup(record) {
      const payload = {...record.args,p_request_id:record.requestId};
      const response = await client.rpc('get_account_request_status', {
        p_request_id:record.requestId,p_expected_operation:record.operation,p_expected_payload:payload
      });
      if (response?.error) throw response.error;
      if (!response?.data || !['not_found','completed'].includes(response.data.status) ||
          (response.data.status === 'completed' && (!response.data.result || !response.data.result.account?.id))) throw fail('Resposta de conferência inválida. Não envie outra operação.', 'INVALID_RESPONSE');
      return response.data;
    }
    async function complete(record, result) {
      if (!result || !result.account?.id || !uuid.test(result.account.id) || (record.args.p_account_id && result.account.id !== record.args.p_account_id)) throw fail('Resultado de conta inválido. Preserve a operação para conferência.', 'INVALID_RESPONSE');
      record = {...record,confirmed:true};
      try { record = await save(record,'completed'); }
      catch (error) { state = {status:'completed',request:copy(record),error:message(error)}; }
      state.result = copy(result);
      return output(true,result);
    }
    async function uncertain(record, error, knownCode) {
      const status = knownCode ? 'rejected' : 'uncertain';
      if (!knownCode) record = {...record,uncertain:record.uncertain || record.attempted};
      try { record = await save(record,status,knownCode); }
      catch (storageError) { state = {status:'uncertain',request:copy(record),error:message(storageError)}; return output(false); }
      state.error = message(error);
      return output(false);
    }
    async function drive(record) {
      const wasCompleted = record.confirmed || record.status === 'completed', hadUncertainty = record.uncertain;
      try {
        record = await save(record,'checking');
        const check = await lookup(record);
        if (check.status === 'completed') return complete(record,check.result);
        if (wasCompleted) return uncertain({...record,uncertain:true},fail('Uma operação antes confirmada não foi localizada. É necessária revisão antes de continuar.', 'MISSING_CONFIRMED_REQUEST'));
        record = await save({...record,attempted:true},'sending');
      } catch (error) { return uncertain(record,error); }
      let rpcRejected = false;
      try {
        const response = await client.rpc(record.operation,{...record.args,p_request_id:record.requestId});
        if (response?.error) { rpcRejected = true; throw response.error; }
        return await complete(record,response?.data);
      } catch (error) {
        // A mensagem de erro não prova que a gravação falhou. Conferir primeiro.
        try {
          const check = await lookup(record);
          if (check.status === 'completed') return await complete(record,check.result);
          return uncertain(record,error,!hadUncertainty && rpcRejected && rejections.has(error?.code) ? error.code : null);
        } catch (lookupError) { return uncertain(record,lookupError); }
      }
    }
    async function guarded(callback) {
      try { return await withLock(callback); }
      catch (error) { state.error = message(error); return output(false); }
    }
    async function ready() {
      try { restore(await journal.read()); }
      catch (error) { state = {status:'error',request:null,error:message(error)}; }
      return getState();
    }
    async function submit(input) {
      let normalized;
      try { normalized = normalize(input); } catch (error) { state.error = message(error); return output(false); }
      return guarded(async () => {
        let record = restore(await journal.read());
        if (record) {
          if (record.operation !== normalized.operation || JSON.stringify(canonical(record.args)) !== JSON.stringify(normalized.args)) throw fail('Há outra operação pendente. Confira o pedido original antes de alterar os dados.', 'PENDING_REQUEST');
          if (record.status === 'rejected') { state.error = 'A tentativa foi rejeitada. Confira e libere o pedido antes de corrigi-lo.'; return output(false); }
          return drive(record);
        }
        const requestId = createId();
        if (typeof requestId !== 'string' || !uuid.test(requestId)) throw fail('Não foi possível criar identificador seguro.', 'INVALID_REQUEST_ID');
        record = {version:1,kind:'account-operation',requestId,...normalized,createdAt:new Date().toISOString(),status:'prepared',attempted:false,uncertain:false,confirmed:false};
        record = await save(record,'prepared'); // Sem confirmação desta escrita, nenhuma chamada RPC.
        return drive(record);
      });
    }
    async function retry() {
      return guarded(async () => {
        const record = restore(await journal.read());
        if (!record) throw fail('Não há operação pendente para conferir.', 'NO_REQUEST');
        return drive(record);
      });
    }
    async function acknowledge() {
      return guarded(async () => {
        const result = state.result, knownId = state.request?.requestId;
        const record = await journal.read();
        if (!record || record.requestId !== knownId || state.status !== 'completed' || !result) throw fail('Confira o resultado concluído antes de liberar a operação.', 'NOT_CONFIRMED');
        await journal.clear(record.requestId);
        if (await journal.read() !== null) throw fail('O registro local ainda não foi liberado.', 'JOURNAL_CLEAR');
        state = {status:'idle',request:null};
        return output(true);
      });
    }
    async function discardRejected() {
      return guarded(async () => {
        const record = restore(await journal.read());
        if (!record || record.status !== 'rejected' || record.uncertain || !rejections.has(record.errorCode)) throw fail('Resultado incerto: esta operação não pode ser descartada.', 'NOT_REJECTED');
        const check = await lookup(record);
        if (check.status === 'completed') return complete(record,check.result);
        await journal.clear(record.requestId);
        if (await journal.read() !== null) throw fail('O registro local ainda não foi liberado.', 'JOURNAL_CLEAR');
        state = {status:'idle',request:null};
        return output(true);
      });
    }
    return Object.freeze({ready,getState,submit,retry,acknowledge,discardRejected});
  }
  return Object.freeze({createController});
});
