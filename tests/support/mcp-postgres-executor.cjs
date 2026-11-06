'use strict';
// Test-only executor. Fixed private socket/database; no URL, secrets or ambient PG.
const fs=require('node:fs'),cp=require('node:child_process');
const {requireVerifiedPrincipal}=require('../../mcp/http-identity.cjs');
const DB='vaidosa_mcp_read_fixture',SOCKET='/scratch/mcp-socket',PSQL='/usr/lib/postgresql/17/bin/psql';
const subject=n=>'77000000-0000-4000-8000-'+String(n).padStart(12,'0');
const ROLES=Object.freeze(Object.fromEntries(['manager','alice','bob','stock','inactive','finance'].map((x,i)=>[subject(i+1),'mcp_fixture_'+x])));
function environment(role){return {PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/scratch',TMPDIR:'/scratch',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',PGHOST:SOCKET,PGPORT:'55432',PGUSER:role,PGDATABASE:DB,PGAPPNAME:'mcp_fixture_read',PGCONNECT_TIMEOUT:'2'};}
function guard(){
 if(process.platform!=='linux'||process.getuid()!==10001||process.cwd()!=='/scratch')throw Error('Fixture sandbox required');
 const status=fs.readFileSync('/proc/self/status','utf8');if(!/^CapEff:\s+0+$/m.test(status)||!/^NoNewPrivs:\s+1$/m.test(status)||!/^Seccomp:\s+2$/m.test(status)||fs.readdirSync('/sys/class/net').join()!=='lo'||fs.realpathSync(SOCKET)!==SOCKET||fs.statSync(SOCKET).uid!==10001)throw Error('Fixture controls required');
}
async function fixtureReadAs(role,request,{signal}={}){
 guard();if(![...Object.values(ROLES),'mcp_fixture_unknown'].includes(role))throw Error('Fixture role required');signal?.throwIfAborted();
 const marker=fs.readFileSync('/scratch/mcp-cluster-id','utf8').trim();if(!/^\d{10,25}$/.test(marker))throw Error('Fixture cluster required');
 const encoded=Buffer.from(JSON.stringify(request)).toString('base64');if(encoded.length>16000)throw Error('Request limit');
 const sql="begin isolation level repeatable read read only;set local statement_timeout='1000ms';set local lock_timeout='250ms';select mcp_fixture.read_snapshot(convert_from(decode('"+encoded+"','base64'),'UTF8')::jsonb);commit;";
 return new Promise((resolve,reject)=>{
  const child=cp.spawn(PSQL,['-X','-w','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate'],{env:environment(role),cwd:'/scratch',stdio:['pipe','pipe','pipe']});
  let size=0,errorSize=0,out=[],err='',failure=null;const fail=()=>{failure=Error('Fixture source unavailable');child.kill('SIGKILL');};
  const abort=()=>fail(),timer=setTimeout(fail,1500);signal?.addEventListener('abort',abort,{once:true});
  child.stdout.on('data',b=>{size+=b.length;if(size>262144)fail();else out.push(b);});child.stderr.on('data',b=>{errorSize+=b.length;if(errorSize>4096)fail();else err+=b.toString();});
  child.stdin.on('error',()=>{});child.once('error',()=>{failure=Error('Fixture source unavailable');});
  child.once('close',code=>{
   clearTimeout(timer);signal?.removeEventListener('abort',abort);
   if(failure||code!==0||signal?.aborted){const e=Error('Fixture source unavailable');e.sqlState=err.match(/(?:ERROR|FATAL):\s+([A-Z0-9]{5})/)?.[1]??null;reject(e);return;}
   try{const result=JSON.parse(Buffer.concat(out).toString('utf8'));if(result.cluster!==marker)throw Error('Cluster mismatch');resolve(result);}catch{reject(Error('Fixture source unavailable'));}
  });
  if(signal?.aborted)fail();else child.stdin.end(sql);
 });
}
function createFixtureExecutor({resource,issuer,now=Date.now}={}){
 return async(request,context)=>{
  const principal=requireVerifiedPrincipal(context?.principal,{resource,issuer,now});const role=ROLES[principal.id];
  if(!role||request.subject!==principal.id||principal.store!=='fixture_store')throw Error('Fixture principal required');
  return fixtureReadAs(role,request,context);
 };
}
module.exports={createFixtureExecutor,fixtureReadAs,environment,DB,SOCKET,PSQL,ROLES,subject};
