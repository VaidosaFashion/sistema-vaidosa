'use strict';
// Fixture process defense in depth. No remote adapters or listening transports are enabled.
const deny = () => { throw new Error('Network disabled in Vaidosa fixture mode'); };
for (const [moduleName, methods] of [
  ['node:http', ['request', 'get', 'createServer']],
  ['node:https', ['request', 'get', 'createServer']],
  ['node:net', ['connect', 'createConnection', 'createServer']],
  ['node:tls', ['connect', 'createServer']],
  ['node:dgram', ['createSocket']],
  ['node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6']]
]) {
  const module = require(moduleName);
  for (const method of methods) module[method] = deny;
}
require('node:net').Socket.prototype.connect = deny;
require('node:net').Server.prototype.listen = deny;
for (const method of ['lookup', 'resolve', 'resolve4', 'resolve6']) require('node:dns').promises[method] = async () => deny();
globalThis.fetch = async () => deny();
require('node:module').syncBuiltinESMExports();
