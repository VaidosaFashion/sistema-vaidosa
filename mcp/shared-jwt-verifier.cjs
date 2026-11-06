'use strict';
const {createLocalJwtVerifier}=require('./local-jwt-verifier.cjs');
async function createSharedJwtVerifier({store,...options}={}){
 if(typeof store?.check!=='function')throw Error('Mandatory shared authorization store required');
 return createLocalJwtVerifier({...options,checkShared:store.check});
}
module.exports={createSharedJwtVerifier};
