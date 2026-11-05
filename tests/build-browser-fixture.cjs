'use strict';
// Build-only helper: reads versioned code and fictional fixture text; no app execution.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const runtime=require('./browser-fixture-runtime.cjs');
const root=path.resolve(__dirname,'..');
const policy="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'";
const inline=text=>'<script>'+text.replace(/<\/script/gi,'<\\/script')+'</script>';
function buildBrowserFixture() {
  const index=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const sources=[{path:'index.html',sha256:crypto.createHash('sha256').update(index).digest('hex')}];
  let html=index.replace(/<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi,(_whole,_before,src)=>{
    if(/^(?:https?:)?\/\//i.test(src))return '<!-- External library replaced with offline fixture -->';
    if(!/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.js$/.test(src))throw Error('Unexpected local script path');
    const filename=path.resolve(root,src);if(!filename.startsWith(root+path.sep))throw Error('Script escapes source tree');
    const text=fs.readFileSync(filename,'utf8');sources.push({path:src,sha256:crypto.createHash('sha256').update(text).digest('hex')});return inline(text);
  });
  // Sanitize markup only. A global src= regexp would corrupt img.src in JS.
  html=html.split(/(<script\b[^>]*>[\s\S]*?<\/script>)/gi).map(part=>{
    if(/^<script\b/i.test(part))return part;
    return part.replace(/<link\b[^>]*>/gi,'').replace(/@import\s+[^;]+;/gi,'')
      .replace(/\b(?:href|src|action|srcset)\s*=\s*(["'])(.*?)\1/gi,(whole,quote,value)=>value.startsWith('data:')||value.startsWith('#')?whole:'');
  }).join('');
  html=html.replace(/\bconst SUPABASE_URL\s*=\s*["'][^"']+["'];/,'const SUPABASE_URL = "https://fixture.invalid";')
    .replace(/\bconst SUPABASE_ANON_KEY\s*=\s*["'][^"']+["'];/,'const SUPABASE_ANON_KEY = "fixture-public-sentinel";')
    .replace(/\bconst TURNSTILE_SITE_KEY\s*=\s*["'][^"']+["'];/,'const TURNSTILE_SITE_KEY = "fixture-site-sentinel";')
    .replace(/https?:\/\/[^\s"'`<>\\)]+/g,'https://fixture.invalid');
  html=html.replace(/<head>/i,'<head><meta http-equiv="Content-Security-Policy" content="'+policy+'">'+inline(runtime.source()));
  const banner='<div id="browserFixtureBanner" role="note" style="position:relative;padding:10px;background:#fff4c6;color:#402e00;font-weight:700;z-index:1300">ENSAIO LOCAL · DADOS FICTÍCIOS · Nenhum acesso à loja ou aos serviços externos. As gravações afetam apenas esta simulação.</div>';
  html=html.replace(/(<main\b[^>]*>)/i,'$1'+banner);
  // Install peripheral stubs before authentication starts. A later script is too
  // late: microtasks can run initApp before the HTML parser reaches that script.
  const startup='  checkExistingSession();';
  if(html.split(startup).length!==2)throw Error('Authentication startup marker changed; review fixture');
  html=html.replace(startup,"  detectZebra=async()=>{zebraSetBadge('neutral','Impressora desativada no ensaio');}; initAutoBackup=async()=>{}; pushStockToNuvemshop=async()=>{};\n"+startup);
  if(/ysultkzfhgtyujbomfqz|supabase\.co|eyJ[a-zA-Z0-9_-]{30}/.test(html))throw Error('Production endpoint/key survived fixture generation');
  if(/<script[^>]+src\s*=/i.test(html))throw Error('External script survived generation');
  return {html,manifest:{fixture:true,interactive:true,databaseProof:false,sources,policy,peripheralOverrides:['detectZebra','initAutoBackup','pushStockToNuvemshop'],generatedAt:new Date().toISOString()}};
}
if(require.main===module) {
  const target=process.argv[2];
  if(!target||!path.isAbsolute(target)||!/^\/(?:private\/)?tmp\/vaidosa-browser-[^/]+\//.test(target))throw Error('Provide an explicit HTML path inside a private /tmp/vaidosa-browser-* scratch directory.');
  const artifact=buildBrowserFixture();fs.writeFileSync(target,artifact.html,{mode:0o600});fs.writeFileSync(target+'.manifest.json',JSON.stringify(artifact.manifest,null,2),{mode:0o600});
  console.log('Synthetic interactive fixture built; app/browser were not executed.');
}
module.exports={buildBrowserFixture,policy};
