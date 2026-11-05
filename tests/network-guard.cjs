// Preload for all offline tests: no outbound sockets, DNS or HTTP, even on failure.
'use strict';
const deny=()=>{throw Error('OFFLINE_TEST: outbound network is prohibited');};
for(const name of ['node:http','node:https']){const m=require(name);m.request=deny;m.get=deny;}
const net=require('node:net');net.connect=deny;net.createConnection=deny;net.Socket.prototype.connect=deny;
require('node:tls').connect=deny;
const dns=require('node:dns');for(const name of ['lookup','resolve','resolve4','resolve6','reverse'])dns[name]=deny;
for(const name of ['lookup','resolve','resolve4','resolve6','reverse'])dns.promises[name]=async()=>deny();
globalThis.fetch=async()=>deny();
