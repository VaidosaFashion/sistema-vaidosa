'use strict';
// Ephemeral test-only ports; writer is never supplied to the read verifier.
const fs=require('node:fs'),cp=require('node:child_process');
const {environment,DB,SOCKET,PSQL}=require('./mcp-postgres-executor.cjs');
function fixtureRevocationPort(kind){
 if(!['read','write'].includes(kind))throw Error('Fixture port required');
 const role=kind==='read'?'mcp_revocation_reader':'mcp_revocation_writer',fn=kind==='read'?'check_state':'apply';
 return async(q,{signal}={})=>{
  signal?.throwIfAborted();const status=fs.readFileSync('/proc/self/status','utf8');
  if(process.platform!=='linux'||process.getuid()!==10001||process.cwd()!=='/scratch'||!/^CapEff:\s+0+$/m.test(status)||!/^NoNewPrivs:\s+1$/m.test(status)||!/^Seccomp:\s+2$/m.test(status)||fs.readdirSync('/sys/class/net').join()!=='lo'||fs.realpathSync(SOCKET)!==SOCKET||fs.statSync(SOCKET).uid!==10001||DB!=='vaidosa_mcp_read_fixture')throw Error('Fixture required');
  const encoded=Buffer.from(JSON.stringify(q)).toString('base64');if(encoded.length>4096)throw Error('Request limit');
  const sql=(kind==='read'?'begin isolation level read committed read only;':'begin;')+"set local statement_timeout='800ms';set local lock_timeout='500ms';select mcp_revocation_fixture."+fn+"(convert_from(decode('"+encoded+"','base64'),'UTF8')::jsonb);commit;";
  return new Promise((resolve,reject)=>{
   const c=cp.spawn(PSQL,['-X','-w','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate'],{env:environment(role),cwd:'/scratch',stdio:['pipe','pipe','pipe']});
   let output=[],bytes=0,error='';const abort=()=>c.kill('SIGKILL'),timer=setTimeout(abort,900);signal?.addEventListener('abort',abort,{once:true});
   c.stdout.on('data',b=>{bytes+=b.length;if(bytes>4096)abort();else output.push(b);});c.stderr.on('data',b=>{error+=b.toString();if(error.length>4096)abort();});c.stdin.on('error',()=>{});c.once('error',()=>abort());
   c.once('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(code!==0||bytes>4096||signal?.aborted){const e=Error('Fixture authorization unavailable');e.sqlState=error.match(/(?:ERROR|FATAL):\s+([A-Z0-9]{5})/)?.[1]??null;reject(e);return;}try{resolve(JSON.parse(Buffer.concat(output).toString('utf8')));}catch{reject(Error('Fixture authorization unavailable'));}});
   if(signal?.aborted)abort();else c.stdin.end(sql);
  });
 };
}
module.exports={fixtureRevocationPort};
