#!/usr/bin/env node
'use strict';
// Execute only under the documented offline OS sandbox. Does not bind a port.
const {createFixtureHttpHandler,RESOURCE}=require('./http-fixture.cjs');
const handler=createFixtureHttpHandler();
(async()=>{
 const headers={'authorization':'Bearer fixture_seller_token','content-type':'application/json','accept':'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'};
 for(const message of [
  {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'in-memory-fixture',version:'1'}}},
  {jsonrpc:'2.0',method:'notifications/initialized'},
  {jsonrpc:'2.0',id:2,method:'tools/list'},
  {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'vaidosa_stock_list',arguments:{limit:2}}}
 ]){const response=await handler(new Request(RESOURCE,{method:'POST',headers,body:JSON.stringify(message)}));console.log(JSON.stringify({fixture:true,httpStatus:response.status,body:response.status===202?null:await response.json()}));}
})().catch(()=>{console.error('Fixture demo failed');process.exitCode=1;});
