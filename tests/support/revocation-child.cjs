'use strict';
// Bounded fresh-process check; accepts fictitious token/public key on stdin only.
const {createLocalJwtVerifier}=require('../../mcp/local-jwt-verifier.cjs');
const {createSharedRevocationStore,revocationNamespace}=require('../../mcp/shared-revocation-store.cjs');
const {fixtureRevocationPort}=require('./revocation-executor.cjs');
(async()=>{
 let size=0,parts=[];for await(const b of process.stdin){size+=b.length;if(size>12000)throw Error('Input limit');parts.push(b);}
 const q=JSON.parse(Buffer.concat(parts).toString('utf8')),jose=await import('jose');
 const store=createSharedRevocationStore({namespace:revocationNamespace(q.issuer,q.resource),incarnation:q.incarnation,executeRead:fixtureRevocationPort('read')});
 const verifier=await createLocalJwtVerifier({jose,issuer:q.issuer,resource:q.resource,publicKeys:[q.publicKey],maxTokenAgeSeconds:300,now:()=>q.now,checkShared:store.check});
 try{await verifier.verifyAccessToken(q.token,{issuer:q.issuer,audience:q.resource});process.stdout.write('{"accepted":true}\n');}catch{process.stdout.write('{"accepted":false}\n');}
})().catch(()=>{process.stdout.write('{"accepted":false,"unavailable":true}\n');process.exitCode=1;});
