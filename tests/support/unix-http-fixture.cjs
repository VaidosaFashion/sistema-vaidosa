'use strict';
// Test-only real HTTP over one private AF_UNIX socket. No TCP, DNS or TLS client.
const http=require('node:http'),fs=require('node:fs');
const SOCKET='/scratch/mcp-http.sock',MAX=65536;
async function createUnixHttpFixture({authorities,handler}){
 if(process.platform!=='linux'||process.getuid()!==10001||process.cwd()!=='/scratch'||fs.readdirSync('/sys/class/net').join()!=='lo'||typeof handler!=='function'||!Array.isArray(authorities)||authorities.length!==2||authorities.some(x=>!/^https:\/\/[a-z0-9.-]+\.invalid$/.test(x)))throw Error('Private fixture required');
 const allowed=new Set(authorities),counts={requests:0,responses:0,rejected:0};let active=0,closed=false;
 const server=http.createServer({maxHeaderSize:8192},async(req,res)=>{
  let counted=false;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3000);req.once('aborted',()=>controller.abort());res.once('close',()=>{if(!res.writableEnded)controller.abort();});
  try{
   if(active>=4||closed)throw Error('Capacity');active++;counted=true;
   const authority='https://'+req.headers.host;if(!allowed.has(authority)||!req.url.startsWith('/')||req.url.startsWith('//')||req.rawHeaders.length>64)throw Error('Authority');
   const chunks=[];let size=0;for await(const b of req){size+=b.length;if(size>16384)throw Error('Input limit');chunks.push(b);}
   const headers=new Headers();for(let i=0;i<req.rawHeaders.length;i+=2)headers.append(req.rawHeaders[i],req.rawHeaders[i+1]);
   const request=new Request(authority+req.url,{method:req.method,headers,signal:controller.signal,...(chunks.length?{body:Buffer.concat(chunks)}:{})});counts.requests++;
   const response=await handler(request);controller.signal.throwIfAborted();const data=Buffer.from(await response.arrayBuffer());if(data.length>MAX)throw Error('Output limit');
   res.statusCode=response.status;for(const [k,v]of response.headers)res.setHeader(k,v);res.setHeader('content-length',data.length);res.end(data);counts.responses++;
  }catch{counts.rejected++;if(!res.headersSent){res.statusCode=503;res.setHeader('content-type','application/json');res.end('{"error":"fixture_unavailable"}');}else res.destroy();}
  finally{if(counted)active--;clearTimeout(timer);}
 });
 server.maxConnections=4;server.requestTimeout=3000;server.headersTimeout=3000;server.keepAliveTimeout=1;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(SOCKET,resolve);});fs.chmodSync(SOCKET,0o600);
 if(server.address()!==SOCKET||!fs.statSync(SOCKET).isSocket()||fs.statSync(SOCKET).uid!==10001)throw Error('Socket mismatch');
 async function fetchUnix(input,init={}){
  if(closed||typeof input!=='string'&&!(input instanceof URL))throw Error('Fixed fixture URL required');const url=new URL(input);
  if(!allowed.has(url.origin)||url.username||url.password||url.hash)throw Error('Fixed fixture URL required');
  const method=init.method??'GET',body=init.body==null?null:Buffer.from(String(init.body));if(!['GET','POST','DELETE'].includes(method)||body&&body.length>16384)throw Error('Input limit');init.signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
   const headers=new Headers(init.headers);headers.set('host',url.host);if(body)headers.set('content-length',String(body.length));
   const req=http.request({socketPath:SOCKET,path:url.pathname+url.search,method,headers:Object.fromEntries(headers),agent:false,maxHeaderSize:8192},res=>{
    let bytes=0;const chunks=[];res.on('data',b=>{bytes+=b.length;if(bytes>MAX)req.destroy(Error('Response limit'));else chunks.push(b);});res.once('error',()=>reject(Error('Fixture transport unavailable')));
    res.once('end',()=>{try{const data=Buffer.concat(chunks);resolve(new Response([202,204,304].includes(res.statusCode)?null:data,{status:res.statusCode,headers:res.headers}));}catch{reject(Error('Fixture transport unavailable'));}});
   });
   const abort=()=>req.destroy(Error('Fixture request aborted')),timer=setTimeout(abort,3500);init.signal?.addEventListener('abort',abort,{once:true});req.once('close',()=>{clearTimeout(timer);init.signal?.removeEventListener('abort',abort);});req.once('error',()=>reject(Error('Fixture transport unavailable')));if(init.signal?.aborted)abort();else req.end(body);
  });
 }
 return Object.freeze({fetch:fetchUnix,stats:()=>({...counts,active,socket:SOCKET,tcp:false}),async close(){closed=true;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(fs.existsSync(SOCKET))fs.unlinkSync(SOCKET);}});
}
module.exports={createUnixHttpFixture};
