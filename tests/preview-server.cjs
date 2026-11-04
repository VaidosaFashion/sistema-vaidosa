const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {root,readSource,functionSource,modalSource,previewRuntimeSource} = require('./financial-fixture.cjs');

const policy = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; font-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'";
const bootstrap = `
renderDemo();
document.getElementById('demoOpen').addEventListener('click',()=>openFinancialCorrection(demoSale.id));
document.getElementById('demoScenario').addEventListener('click',async()=>{
  await openFinancialCorrection(demoSale.id);
  document.getElementById('fc_discount').value='600';
  document.getElementById('fc_value_'+demoSale.sale_payments[0].id).value='2400';
  document.getElementById('fc_reason').value='Desconto de 20% combinado após finalizar (exemplo fictício)';
  updateFinancialCorrectionPreview();
});
`;

function buildPreview() {
  const css=readSource().match(/<style>([\s\S]*?)<\/style>/)[1];
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<title>Vaidosa — prévia local de correção</title>
<style>${css}
body{padding:24px;display:block}.demo-wrap{max-width:900px;margin:0 auto}.demo-banner{background:#fff4c6;color:#614600;padding:14px 18px;border-radius:12px;margin-bottom:24px;font-weight:600}.demo-card{padding:24px;background:white;border:1px solid var(--line);border-radius:16px;margin-top:18px}.demo-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin:20px 0}.demo-grid strong{display:block;font-size:28px}.demo-head{display:flex;align-items:center;gap:16px}.demo-head img{max-width:150px}.demo-card p{margin:12px 0}#demoToast{padding:12px 0;min-height:50px;color:#065f46;font-weight:600}@media(max-width:500px){body{padding:12px}.demo-grid{grid-template-columns:1fr}.demo-head img{max-width:100px}}
</style></head><body>
<main class="demo-wrap">
  <div class="demo-banner">PRÉVIA LOCAL · Dados fictícios · Nenhuma conexão com a loja ou o Supabase</div>
  <div class="demo-head"><img src="/logo.png" alt="Vaidosa"><div><h1>Corrigir sem refazer o pedido</h1><p>Uma venda de 60 peças para conferir o novo fluxo.</p></div></div>
  <section class="demo-card">
    <h2>Venda demonstrativa</h2><div class="demo-grid"><div>Total da venda<strong id="demoTotal"></strong></div><div>Recebido<strong id="demoPaid"></strong></div></div>
    <p><b id="demoCount"></b><br><span id="demoStock"></span><br><span id="demoAuditCount"></span></p>
    <p>Exemplo: o pedido foi lançado por R$ 3.000,00. Depois foi combinado desconto de 20%, e o valor correto recebido foi R$ 2.400,00.</p>
    <div class="btns"><button id="demoOpen" class="btn">Abrir correção</button><button id="demoScenario" class="btn ok">Conferir exemplo com 20% de desconto</button></div>
    <div id="demoToast" role="status"></div>
    <p class="small muted">Salvar nesta prévia altera apenas dados temporários na memória desta página. Recarregar restaura o exemplo. A validação real do banco é coberta por testes SQL separados; esta tela demonstra o formulário.</p>
  </section>
</main>
<button id="btnReviewFinancials" class="hide" type="button">Corrigir pagamento</button>
<button id="btnReviewSaleFinancials" class="hide" type="button">Corrigir desconto</button>
${modalSource()}
<script>${functionSource('mapSaleFromDb')}\n${functionSource('isMissingRpc')}\n${previewRuntimeSource()}</script>
<script src="/financial-corrections.js"></script>
<script>${bootstrap}</script>
</body></html>`;
}

function createPreviewServer() {
  return http.createServer((req,res)=>{
    res.setHeader('Content-Security-Policy',policy);
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    if(req.method !== 'GET') {res.writeHead(405);return res.end('Somente leitura');}
    const route=new URL(req.url,'http://localhost').pathname;
    if(route==='/') {res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(buildPreview());}
    if(route==='/financial-corrections.js') {res.setHeader('Content-Type','text/javascript; charset=utf-8');return res.end(fs.readFileSync(path.join(root,'financial-corrections.js')));}
    if(route==='/logo.png') {res.setHeader('Content-Type','image/png');return res.end(fs.readFileSync(path.join(root,'assets/logo.png')));}
    res.writeHead(404);res.end('Página não encontrada');
  });
}

function buildStandalonePreview() {
  const logo=fs.readFileSync(path.join(root,'assets/logo.png')).toString('base64');
  const correction=fs.readFileSync(path.join(root,'financial-corrections.js'),'utf8');
  return buildPreview()
    .replace('src="/logo.png"',`src="data:image/png;base64,${logo}"`)
    .replace('<script src="/financial-corrections.js"></script>',`<script>${correction}</script>`);
}

if(require.main===module) {
  const port=Number(process.env.VAIDOSA_PREVIEW_PORT||8934);
  const server=createPreviewServer();
  server.on('error',error=>{console.error(error.message);process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log(`Prévia isolada: http://127.0.0.1:${port} — dados fictícios, sem Supabase`));
}

module.exports={buildPreview,buildStandalonePreview,createPreviewServer,policy,bootstrap};
