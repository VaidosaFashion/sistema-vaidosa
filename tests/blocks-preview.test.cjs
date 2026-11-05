'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {buildPreview}=require('./build-block-preview.cjs');
test('preview is rendered from actual app with fictional data and contains no real URLs, keys, network sources or write handlers',async()=>{
 const html=await buildPreview();assert.match(html,/DADOS FICTÍCIOS/);assert.doesNotMatch(html.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/g,''),/ysultkzfhgtyujbomfqz|supabase\.co|eyJ[A-Za-z0-9_-]{20}|service_role/);
 const dom=new JSDOM(html,{runScripts:'outside-only'});try{
  const d=dom.window.document;assert.match(d.querySelector('meta[http-equiv="Content-Security-Policy"]').content,/connect-src 'none'/);
  assert.equal(d.querySelectorAll('script[src]').length,0);assert.equal(d.querySelectorAll('[onclick],[onchange],[onsubmit]').length,0);
  assert.match(d.getElementById('fin_tabelaHistorico').textContent,/Cliente fictício/);
  assert.ok([...d.querySelectorAll('button')].every(b=>b.disabled||b.closest('nav')||b.id==='btnMobileMenu'));
 }finally{dom.window.close();}
});
