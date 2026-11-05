'use strict';
// Optional visual QA: existing local Chrome, temporary profile, pipe only, fixture file only.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'vaidosa-visual-'));
const child=spawn(chrome,['--headless','--remote-debugging-pipe','--disable-gpu','--disable-background-networking','--disable-extensions','--disable-sync','--no-first-run','--no-default-browser-check','--host-resolver-rules=MAP * ~NOTFOUND','--user-data-dir='+profile],{stdio:['ignore','ignore','ignore','pipe','pipe']});
let sequence=0,buffer='';const pending=new Map();
child.stdio[4].on('data',bytes=>{buffer+=bytes.toString();let end;while((end=buffer.indexOf('\0'))>=0){const raw=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!raw)continue;const m=JSON.parse(raw),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timeout);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}}});
function rpc(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++sequence,timeout=setTimeout(()=>{pending.delete(id);reject(Error('Local Chrome timeout: '+method));},12000);pending.set(id,{resolve,reject,timeout});child.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');});}
(async()=>{try{
 const target=await rpc('Target.createTarget',{url:'about:blank'}),{sessionId}=await rpc('Target.attachToTarget',{targetId:target.targetId,flatten:true});
 await rpc('Page.enable',{},sessionId);
 const results=[];
 for(const width of [1440,390]){
  await rpc('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false},sessionId);
  await rpc('Page.navigate',{url:'file://'+path.resolve(__dirname,'../preview/blocks.html')},sessionId);
  for(let i=0;i<60;i++){const r=await rpc('Runtime.evaluate',{expression:'document.readyState',returnByValue:true},sessionId);if(r.result.value==='complete')break;await new Promise(r=>setTimeout(r,50));}
  const metric=await rpc('Runtime.evaluate',{expression:'JSON.stringify({width:innerWidth,scroll:document.documentElement.scrollWidth,main:document.querySelector("main").getBoundingClientRect().width})',returnByValue:true},sessionId);
  const layout=JSON.parse(metric.result.value);results.push(layout);
  const screenshot=await rpc('Page.captureScreenshot',{format:'png'},sessionId);fs.writeFileSync(path.join(os.tmpdir(),'vaidosa-preview-'+width+'.png'),Buffer.from(screenshot.data,'base64'));
  if(layout.scroll>width+1)throw Error('Preview horizontal overflow '+JSON.stringify(layout));
 }
 console.log(JSON.stringify({passed:true,fixture:true,layouts:results}));
}finally{child.kill('SIGTERM');for(const p of pending.values())clearTimeout(p.timeout);}})().catch(e=>{console.error(e.message);process.exitCode=1;});
