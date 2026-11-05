'use strict';
// In-memory wire demonstrator only. No listener, real verifier or data adapter.
require('./offline-guard.cjs');
const {createStreamableHttpHandler}=require('./streamable-http.cjs');
const {createReadService}=require('./service.cjs');
const {createFixtureAdapter,fixturePrincipal}=require('./fixture-adapter.cjs');
const RESOURCE='https://vaidosa-fixture.invalid/mcp',ISSUER='https://identity-fixture.invalid/';
function createFixtureHttpHandler({now=Date.now,audit=()=>{}}={}){
 const fixed={fixture_manager_token:fixturePrincipal('manager'),fixture_seller_token:fixturePrincipal('seller')};
 return createStreamableHttpHandler({resource:RESOURCE,issuer:ISSUER,now,audit,
  verifyAccessToken:async token=>{const p=fixed[token];if(!p)throw Error('Fixture token rejected');return {verified:true,issuer:ISSUER,audiences:[RESOURCE],subject:p.id,expiresAt:Math.floor(now()/1000)+300,scopes:['mcp:read',...p.permissions]};},
  authorizePrincipal:async claims=>{const p=Object.values(fixed).find(p=>p.id===claims.subject);if(!p)throw Error('Unknown fixture subject');return {...p,active:true};},
  createService:async principal=>createReadService({adapter:createFixtureAdapter(),principal,now})
 });
}
module.exports={createFixtureHttpHandler,RESOURCE,ISSUER};
