#!/usr/bin/env node
'use strict';
require('./offline-guard.cjs');
const { once } = require('node:events');
const { createFixtureAdapter, fixturePrincipal } = require('./fixture-adapter.cjs');
const { createReadService } = require('./service.cjs');
const { createProtocol, MAX_REQUEST_BYTES, error } = require('./protocol.cjs');

async function write(stream, data) {
  if (!stream.write(JSON.stringify(data) + '\n')) await once(stream, 'drain');
}
async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--fixture') || args.filter(arg => arg === '--fixture').length !== 1 || args.some(arg => !['--fixture', '--principal=manager', '--principal=seller'].includes(arg)) || args.filter(arg => arg.startsWith('--principal=')).length > 1) {
    await write(process.stderr, { event: 'startup_rejected', reason: 'Use --fixture [--principal=manager|--principal=seller]. Apenas demonstração local disponível.' });
    process.exitCode = 2;
    return;
  }
  const principal = fixturePrincipal(args.find(arg => arg.startsWith('--principal='))?.split('=')[1] || 'seller');
  const protocol = createProtocol(createReadService({ adapter: createFixtureAdapter(), principal }));
  let buffer = Buffer.alloc(0), sequence = 0;
  async function frame(line) {
    let message;
    try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
    catch {
      const decision = protocol.handle(null); // Invalid frames also consume rate/session budgets.
      await write(process.stdout, decision.reply?.error?.code === -32029 ? decision.reply : error(undefined, -32700, 'Mensagem JSON UTF-8 inválida.'));
      await write(process.stderr, { event: 'parse_rejected', sequence: ++sequence });
      return !!decision.close;
    }
    const { reply, audit, close } = protocol.handle(message);
    if (reply) await write(process.stdout, reply);
    await write(process.stderr, { ...audit, sequence: ++sequence, at: new Date().toISOString() });
    return !!close;
  }
  async function tooLarge() {
    await write(process.stdout, error(undefined, -32005, 'Mensagem excede 16 KiB; sessão encerrada.'));
    await write(process.stderr, { event: 'input_limit', sequence: ++sequence });
    process.exitCode = 2;
  }
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, chunk]);
    let newline;
    while ((newline = buffer.indexOf(10)) !== -1) {
      if (newline > MAX_REQUEST_BYTES) { await tooLarge(); return; }
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (await frame(line)) return;
    }
    if (buffer.length > MAX_REQUEST_BYTES) { await tooLarge(); return; }
  }
  if (buffer.length) {
    await write(process.stdout, error(undefined, -32700, 'Mensagem incompleta: faltou delimitador de linha.'));
    await write(process.stderr, { event: 'incomplete_frame', sequence: ++sequence });
    process.exitCode = 2;
  }
}
main().catch(() => {
  // Never serialize exception messages, argv, environment or incoming data.
  process.stderr.write('{"event":"transport_failure"}\n');
  process.exitCode = 1;
});
