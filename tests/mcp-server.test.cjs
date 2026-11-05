'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');
const { createProtocol } = require('../mcp/protocol.cjs');
const { createReadService } = require('../mcp/service.cjs');
const { createFixtureAdapter, fixturePrincipal } = require('../mcp/fixture-adapter.cjs');
const server = path.resolve(__dirname, '../mcp/server.cjs');
const childEnv = { PATH: process.env.PATH || '', LANG: 'C.UTF-8' };

function client(t, args = ['--fixture', '--principal=manager']) {
  const child = spawn(process.execPath, [server, ...args], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [], pending = [], audit = [];
  let nextId = 1;
  const onClose = new Promise(resolve => child.on('close', code => resolve(code)));
  createInterface({ input: child.stdout }).on('line', line => {
    const waiting = pending.shift();
    if (waiting) waiting(line); else lines.push(line);
  });
  createInterface({ input: child.stderr }).on('line', line => audit.push(line));
  child.stdin.on('error', () => {});
  t.after(async () => { child.stdin.end(); const timer = setTimeout(() => child.kill('SIGKILL'), 500); await onClose; clearTimeout(timer); });
  async function response() {
    let timeout;
    try {
      const line = await Promise.race([lines.length ? Promise.resolve(lines.shift()) : new Promise(resolve => pending.push(resolve)), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('MCP response timeout')), 2000); })]);
      return JSON.parse(line);
    } finally { clearTimeout(timeout); }
  }
  function send(value) { child.stdin.write(JSON.stringify(value) + '\n'); }
  async function request(method, params) { send({ jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) }); return response(); }
  async function initialize(version = '2025-11-25') {
    const result = await request('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'isolated-test', version: '1.0' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return result;
  }
  return { child, audit, lines, send, request, response, initialize, onClose };
}

test('stdio initialization, version negotiation, tools and structured results', { timeout: 10000 }, async t => {
  const c = client(t); const init = await c.initialize('unsupported-version');
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.deepEqual((await c.request('ping')).result, {});
  const list = await c.request('tools/list');
  assert.equal(list.result.tools.length, 5);
  const result = await c.request('tools/call', { name: 'vaidosa_stock_list', arguments: { limit: 1 } });
  assert.equal(result.result.isError, false);
  assert.deepEqual(JSON.parse(result.result.content[0].text), result.result.structuredContent);
  assert.equal(result.result.structuredContent.items[0].available, 1);
  const next = await c.request('tools/call', { name: 'vaidosa_stock_list', arguments: { limit: 1, cursor: result.result.structuredContent.nextCursor } });
  assert.equal(next.result.structuredContent.items[0].available, 0);
  c.child.stdin.end(); assert.equal(await c.onClose, 0);
  assert.equal(c.lines.length, 0, 'notifications do not emit responses');
});
test('lifecycle rejects operations before initialization and repeat initialization', { timeout: 10000 }, async t => {
  const c = client(t);
  assert.equal((await c.request('tools/list')).error.code, -32002);
  assert.deepEqual((await c.request('ping')).result, {});
  assert.equal((await c.request('initialize', {})).error.code, -32602);
  await c.initialize();
  assert.equal((await c.request('ping', null)).error.code, -32602);
  assert.equal((await c.request('tools/call', { name: 'vaidosa_stock_list', arguments: null })).error.code, -32602);
  assert.equal((await c.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } })).error.code, -32602);
});
test('startup refuses missing fixture flag, production, URLs and credential arguments', () => {
  for (const args of [[], ['--production'], ['--fixture', '--adapter=supabase'], ['--fixture', '--url=https://fixture.invalid'], ['--fixture', '--key=PRIVATE_MARKER'], ['--fixture', '--principal=admin'], ['--fixture', '--fixture']]) {
    const run = spawnSync(process.execPath, [server, ...args], { encoding: 'utf8', timeout: 3000, env: childEnv });
    assert.equal(run.status, 2); assert.equal(run.stdout, '');
    assert.equal(run.stderr.includes('PRIVATE_MARKER'), false);
    assert.equal(JSON.parse(run.stderr).event, 'startup_rejected');
  }
});
test('seller cannot elevate permissions, query other customers or invoke writes/SQL', { timeout: 10000 }, async t => {
  const c = client(t, ['--fixture', '--principal=seller']); await c.initialize();
  assert.equal((await c.request('tools/list')).result.tools.length, 3);
  for (const name of ['vaidosa_receipts_summary', 'delete_sale', 'create_sale', 'execute_sql', 'update_sale_financials']) {
    assert.equal((await c.request('tools/call', { name, arguments: {} })).error.code, -32602);
  }
  assert.equal((await c.request('tools/call', { name: 'vaidosa_stock_list', arguments: { user_role: 'manager' } })).error.code, -32602);
  const result = await c.request('tools/call', { name: 'vaidosa_sale_get', arguments: { saleId: 'sale_demo03' } });
  assert.equal(result.result.isError, true); assert.equal(JSON.parse(result.result.content[0].text).code, 'NOT_AVAILABLE');
  assert.equal((await c.request('resources/read', { uri: 'file:///private' })).error.code, -32601);
});
test('malformed JSON, batch, invalid ID and duplicate IDs are rejected without echoing content', { timeout: 10000 }, async t => {
  const c = client(t); await c.initialize();
  c.child.stdin.write('{"PRIVATE_MARKER"\n'); const parseError=await c.response(); assert.equal(parseError.error.code,-32700);assert.equal(parseError.id,null);
  c.send([]); assert.equal((await c.response()).error.code, -32600);
  c.send({ jsonrpc: '2.0', id: null, method: 'ping' }); assert.equal((await c.response()).error.code, -32600);
  c.send({ jsonrpc: '2.0', id: 'duplicate', method: 'ping' }); assert.deepEqual((await c.response()).result, {});
  c.send({ jsonrpc: '2.0', id: 'duplicate', method: 'ping' }); assert.equal((await c.response()).error.code, -32600);
  c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'unrelated', reason: 'PRIVATE_MARKER' } });
  await c.request('tools/call', { name: 'vaidosa_sale_get', arguments: { saleId: 'sale_demo01' } });
  c.child.stdin.end(); await c.onClose;
  assert.equal(c.lines.length, 0);
  const audit = c.audit.join('\n');
  for (const privateText of ['PRIVATE_MARKER', 'sale_demo01', 'customer_demo01', '11000', 'duplicate']) assert.equal(audit.includes(privateText), false);
  for (const line of c.audit) {
    const record = JSON.parse(line);
    assert.ok(Object.keys(record).every(key => ['event', 'method', 'outcome', 'tool', 'rowCount', 'sequence', 'at'].includes(key)));
  }
});
test('message byte size, malformed UTF-8 and unfinished frames are bounded', { timeout: 10000 }, async t => {
  const c = client(t); c.child.stdin.write('x'.repeat(17000));
  assert.equal((await c.response()).error.code, -32005); assert.equal(await c.onClose, 2);
  const utf = client(t); utf.child.stdin.write(Buffer.from([0xc0, 0xaf, 0x0a]));
  assert.equal((await utf.response()).error.code, -32700);
  const incomplete = client(t); incomplete.child.stdin.end('{');
  assert.equal((await incomplete.response()).error.code, -32700); assert.equal(await incomplete.onClose, 2);
});
test('rate and lifetime limits cover requests and notifications; rate recovers after a minute', () => {
  let time = 0; const service = createReadService({ adapter: createFixtureAdapter(), principal: fixturePrincipal('seller') });
  const protocol = createProtocol(service, { now: () => time });
  for (let i = 0; i < 120; i++) assert.deepEqual(protocol.handle({ jsonrpc: '2.0', id: i, method: 'ping' }).reply.result, {});
  assert.equal(protocol.handle({ jsonrpc: '2.0', id: 120, method: 'ping' }).reply.error.code, -32029);
  assert.equal(protocol.handle({ jsonrpc: '2.0', method: 'unknown_notification' }).reply, null);
  time = 60000;
  assert.deepEqual(protocol.handle({ jsonrpc: '2.0', id: 121, method: 'ping' }).reply.result, {});
  let last;
  for (let i = 0; i < 1900; i++) last = protocol.handle({ jsonrpc: '2.0', method: 'unknown_notification' });
  assert.equal(last.close, true);
  assert.equal(last.reply, null);
});
test('oversize output and unexpected adapter failures are sanitized', () => {
  const service = { listTools: () => [], hasTool: () => true, call: () => ({ data: 'x'.repeat(70000) }) };
  const protocol = createProtocol(service);
  protocol.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  protocol.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(protocol.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'large' } }).reply.error.code, -32005);
  service.call = () => { throw new Error('PRIVATE_MARKER'); };
  const result = protocol.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'failure' } });
  assert.equal(result.reply.error.code, -32603); assert.equal(JSON.stringify(result).includes('PRIVATE_MARKER'), false);
});
test('fixture network guard rejects HTTP, sockets, listeners, DNS and fetch before I/O', () => {
  const guard = path.resolve(__dirname, '../mcp/offline-guard.cjs');
  const script = `(async()=>{const checks=[()=>require('node:http').get('http://fixture.invalid'),()=>require('node:https').request('https://fixture.invalid'),()=>require('node:net').connect(1),()=>new(require('node:net').Server)().listen(0),()=>require('node:dns').lookup('fixture.invalid'),()=>fetch('https://fixture.invalid')];let blocked=0;for(const f of checks){try{await f()}catch(e){if(e.message==='Network disabled in Vaidosa fixture mode')blocked++}}process.stdout.write(JSON.stringify({blocked}))})()`;
  const run = spawnSync(process.execPath, ['--require', guard, '-e', script], { encoding: 'utf8', timeout: 3000, env: childEnv });
  assert.equal(run.status, 0); assert.deepEqual(JSON.parse(run.stdout), { blocked: 6 });
});
