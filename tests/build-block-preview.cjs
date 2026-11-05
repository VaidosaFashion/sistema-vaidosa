'use strict';
// Render the actual application against the same wholly synthetic offline harness.
const fs=require('node:fs'),path=require('node:path');
const {fullPage,uuid,CLIENT}=require('./full-page-fixture.cjs');
const {fixtureSale}=require('./financial-fixture.cjs');
async function buildPreview(){
 const cleanup=[];
 const sale=fixtureSale();sale.client_id=CLIENT;
 const h=await fullPage({after:fn=>cleanup.push(fn)}, {}, {financial:true,noChart:true,sale,fixtures:{
  v_contas:[{id:uuid(30),tipo:'receber',descricao:'Pedido especial — exemplo',valor:250,status:'ativo',proximo_vencimento:'2026-11-10',cliente_id:CLIENT,cliente_nome:'Cliente fictício',forma_recebimento:'PIX',operation_revision:0}],
  movimentacoes:[{id:uuid(31),conta_id:uuid(30),tipo:'receber',descricao:'Parcela de exemplo',valor:100,data_pagamento:'2026-11-05',pago:true}]
 }});
 try{
  h.w.setTab('financeiro');await new Promise(r=>setImmediate(r));
  const d=h.w.document;
  for(const node of d.querySelectorAll('script,link,iframe,object,embed,form[action]'))node.remove();
  for(const node of d.querySelectorAll('*'))for(const attr of [...node.attributes]){
   if(/^on/i.test(attr.name)||['src','href','srcset'].includes(attr.name)&&/^(?:https?:)?\/\//.test(attr.value))node.removeAttribute(attr.name);
  }
  for(const node of d.querySelectorAll('input'))node.setAttribute('value',node.value);
  for(const node of d.querySelectorAll('textarea'))node.textContent=node.value;
  for(const node of d.querySelectorAll('option'))node.toggleAttribute('selected',node.selected);
  for(const node of d.querySelectorAll('canvas'))node.parentElement.remove();
  for(const node of d.querySelectorAll('button,input,select,textarea'))node.disabled=true;
  for(const node of d.querySelectorAll('nav button[data-tab]'))node.disabled=false;
  const status=d.createElement('p');status.textContent='PRÉVIA LOCAL · DADOS FICTÍCIOS · Navegue pelas abas. Salvamentos e serviços externos estão desativados nesta prévia.';
  status.setAttribute('style','background:#fff4c6;padding:14px;border-radius:10px;font-weight:600');d.querySelector('main').prepend(status);
  const policy="default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';img-src data:;connect-src 'none';font-src 'none';form-action 'none';frame-src 'none';base-uri 'none'";
  const csp=d.createElement('meta');csp.httpEquiv='Content-Security-Policy';csp.content=policy;d.head.prepend(csp);
  const logo=fs.readFileSync(path.join(__dirname,'../assets/logo.png')).toString('base64');
  for(const image of d.querySelectorAll('img'))image.src='data:image/png;base64,'+logo;
  d.getElementById('btnMobileMenu').disabled=false;
  const script=d.createElement('script');script.textContent=`document.getElementById('btnMobileMenu').onclick=()=>document.getElementById('appSidebar').classList.toggle('open');document.querySelectorAll('nav button[data-tab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('section[id^="tab-"]').forEach(s=>s.classList.toggle('hide',s.id!=='tab-'+b.dataset.tab));document.querySelectorAll('nav button[data-tab]').forEach(n=>n.classList.toggle('active',n===b));document.getElementById('appSidebar').classList.remove('open');});`;d.body.append(script);
  return ('<!doctype html>\n'+d.documentElement.outerHTML).split('\n').map(line=>line.trimEnd()).join('\n')+'\n';
 }finally{for(const fn of cleanup)fn();}
}
if(require.main===module)buildPreview().then(html=>{const target=path.join(__dirname,'../preview/blocks.html');fs.writeFileSync(target,html);console.log('Offline synthetic preview generated: preview/blocks.html');}).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={buildPreview};
