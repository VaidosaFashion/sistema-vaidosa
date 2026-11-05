'use strict';
const { InputError, ToolError, plainObject } = require('./service.cjs');
const VERSION = '2025-11-25';
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const knownMethods = new Set(['initialize', 'notifications/initialized', 'notifications/cancelled', 'ping', 'tools/list', 'tools/call']);
const error = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
const hasId = value => Object.hasOwn(value, 'id');
const validId = id => (typeof id === 'string' && id.length <= 128) || Number.isSafeInteger(id);
function onlyKeys(obj, keys) { return plainObject(obj) && Object.keys(obj).every(key => keys.includes(key)); }

function createProtocol(service, { now = Date.now } = {}) {
  let state = 'new', windowStarted = now(), windowCount = 0, totalCount = 0;
  const ids = new Set();
  function handle(message) {
    const audit = { event: 'mcp_request', method: knownMethods.has(message?.method) ? message.method : 'unknown', outcome: 'rejected' };
    const notification = plainObject(message) && message.jsonrpc === '2.0' && typeof message.method === 'string' && !hasId(message);
    // Bound session lifetime as well as rate; restart creates a new isolated fixture session.
    if (++totalCount > 2000) return { reply: notification ? null : error(validId(message?.id) ? message.id : undefined, -32029, 'Limite da sessão atingido.'), audit, close: true };
    if (now() - windowStarted >= 60000) { windowStarted = now(); windowCount = 0; }
    if (++windowCount > 120) return { reply: notification ? null : error(validId(message?.id) ? message.id : undefined, -32029, 'Limite de solicitações atingido; tente após um minuto.'), audit };
    if (!plainObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (hasId(message) && !validId(message.id)) || Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) {
      return { reply: notification ? null : error(undefined, -32600, 'Requisição inválida.'), audit };
    }
    if (notification) {
      if (message.method === 'notifications/initialized' && state === 'initializing') state = 'ready';
      // All supported operations finish synchronously; no in-flight work to cancel.
      audit.outcome = 'notification';
      return { reply: null, audit };
    }
    if (ids.has(message.id)) return { reply: error(message.id, -32600, 'Identificador de requisição repetido.'), audit };
    ids.add(message.id);
    const params = Object.hasOwn(message, 'params') ? message.params : {};
    if (!plainObject(params)) return { reply: error(message.id, -32602, 'Parâmetros inválidos.'), audit };
    let result;
    try {
      if (message.method === 'initialize') {
        if (state !== 'new') throw new InputError();
        if (typeof params.protocolVersion !== 'string' || params.protocolVersion.length > 32 || !plainObject(params.capabilities) || !plainObject(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') throw new InputError();
        state = 'initializing';
        result = { protocolVersion: VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'vaidosa-fixture-readonly', version: '0.1.0' }, instructions: 'Demonstração somente com dados fictícios. Não representa o banco nem autoriza alterações reais.' };
      } else if (message.method === 'ping') {
        if (!onlyKeys(params, ['_meta'])) throw new InputError();
        result = {};
      } else if (state !== 'ready') {
        return { reply: error(message.id, -32002, 'Conclua initialize e notifications/initialized.'), audit };
      } else if (message.method === 'tools/list') {
        // Five finite definitions: a single complete page, therefore no nextCursor.
        if (!onlyKeys(params, ['_meta'])) throw new InputError();
        result = { tools: service.listTools() };
      } else if (message.method === 'tools/call') {
        if (!onlyKeys(params, ['name', 'arguments', '_meta']) || typeof params.name !== 'string' || !service.hasTool(params.name)) throw new InputError();
        audit.tool = params.name;
        try {
          const data = service.call(params.name, Object.hasOwn(params, 'arguments') ? params.arguments : {});
          result = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false };
          audit.rowCount = Array.isArray(data.items) ? data.items.length : 1;
        } catch (failure) {
          if (!(failure instanceof ToolError)) throw failure;
          result = { content: [{ type: 'text', text: JSON.stringify({ code: failure.toolCode, message: failure.message }) }], isError: true };
        }
      } else return { reply: error(message.id, -32601, 'Método não disponível.'), audit };
      const reply = { jsonrpc: '2.0', id: message.id, result };
      if (Buffer.byteLength(JSON.stringify(reply)) > MAX_RESPONSE_BYTES) return { reply: error(message.id, -32005, 'Resposta excede o limite permitido.'), audit };
      audit.outcome = result.isError ? 'tool_error' : 'ok';
      return { reply, audit };
    } catch (failure) {
      return { reply: error(message.id, failure instanceof InputError ? -32602 : -32603, failure instanceof InputError ? failure.message : 'Falha interna; nenhum dado foi alterado.'), audit };
    }
  }
  return { handle };
}
module.exports = { createProtocol, VERSION, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, error };
