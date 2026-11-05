'use strict';
/* Prepared real-browser harness. It is intentionally NOT runnable from the CLI:
 * the required OS sandbox launcher is not yet available in this environment.
 * Network mocks/CDP/CSP are secondary barriers, not a substitute for that launcher.
 * A future reviewed launcher must invoke runInVerifiedSandbox with its spawn API. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {buildBrowserFixture}=require('./build-browser-fixture.cjs');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PLAN=Object.freeze([
 'Real Chrome startup, synthetic authenticated session, native Web Locks and localStorage',
 '40-piece cart survives reload and requires explicit restore',
 'Known sales_pay_check rejection preserves cart; retry and next sale use Pendente with distinct IDs',
 'Financial correction preserves sold item IDs, active cart and canonical stock',
 'Receivable edit preserves client; lost response reconciles one settlement using durable journal',
 'Canonical stock refresh precedes rejected cart; variant filters and idempotent entry',
 'Customer history loads more than 20 orders and opens the selected order',
 'Drawer and navigation at 1440 and 390 CSS pixels; no page overflow; zero external requests'
]);

async function runInVerifiedSandbox({scratch,launcher}) {
  // Only a code adapter that owns OS process creation may be supplied. No flag,
  // environment variable, JSON attestation or user consent can satisfy this gate.
  if(!launcher || launcher.kind!=='os-enforced-browser-sandbox' || typeof launcher.spawnChrome!=='function' || typeof launcher.verifyActiveControls!=='function'||typeof launcher.ownsAssignedScratch!=='function')throw Error('OS-enforced sandbox launcher required; no browser was started.');
  const proof=await launcher.verifyActiveControls();
  for(const key of ['readonlyTargetAndToolchain','noExternalNetwork','emptyAllowlistedEnvironment','scratchOnlyWrites','cpuLimit','memoryLimit','processLimit','fileSizeLimit','diskLimit','wallClockLimit','wholeHarnessConfined','noSharedServices'])if(proof?.[key]!==true)throw Error('Required enforced control missing: '+key);
  const scratchReal=fs.realpathSync(scratch);
  if(await launcher.ownsAssignedScratch(scratchReal)!==true)throw Error('Launcher-assigned private scratch required');
  const profile=path.join(scratchReal,'profile');fs.mkdirSync(profile,{mode:0o700});
  const {html,manifest}=buildBrowserFixture(),fixtureFile=path.join(scratchReal,'interactive-fixture.html');
  fs.writeFileSync(fixtureFile,html,{mode:0o600});fs.writeFileSync(fixtureFile+'.manifest.json',JSON.stringify(manifest,null,2),{mode:0o600});
  const child=launcher.spawnChrome(CHROME,[
    '--headless','--remote-debugging-pipe','--disable-gpu','--disable-background-networking','--disable-extensions',
    '--disable-sync','--disable-component-update','--disable-default-apps','--disable-domain-reliability',
    '--no-first-run','--no-default-browser-check','--metrics-recording-only','--mute-audio',
    '--host-resolver-rules=MAP * ~NOTFOUND','--user-data-dir='+profile
  ],{stdio:['ignore','ignore','ignore','pipe','pipe'],cwd:scratchReal,env:{PATH:'/usr/bin:/bin',HOME:scratchReal,TMPDIR:scratchReal,LANG:'en_US.UTF-8',LC_ALL:'en_US.UTF-8',TZ:'America/Sao_Paulo'}});
  let sequence=0,buffer='',closed=false;const pending=new Map(),events=[],results=[];
  const maxTimer=setTimeout(()=>{closed=true;child.kill('SIGKILL');},90000);
  child.stdio[4].on('data',bytes=>{
    buffer+=bytes.toString();
    if(buffer.length>8*1024*1024){child.kill('SIGKILL');return;}
    let end;while((end=buffer.indexOf('\0'))>=0){const raw=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!raw)continue;const message=JSON.parse(raw),request=pending.get(message.id);
      if(request){pending.delete(message.id);clearTimeout(request.timer);message.error?request.reject(Error(JSON.stringify(message.error))):request.resolve(message.result);}
      else {events.push(message);if(events.length>5000)events.shift();if(message.method==='Page.javascriptDialogOpening'&&message.params.type==='beforeunload')void rpc('Page.handleJavaScriptDialog',{accept:true},message.sessionId).catch(()=>{});}
    }
  });
  child.on('exit',()=>{closed=true;for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(Error('Isolated Chrome exited'));}pending.clear();});
  function rpc(method,params={},sessionId){if(closed)return Promise.reject(Error('Chrome unavailable'));return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},7000);pending.set(id,{resolve,reject,timer});child.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');});}
  let sessionId;
  const evaluate=async expression=>{const r=await rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const wait=async expression=>{const deadline=Date.now()+5000;while(Date.now()<deadline){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,35));}throw Error('UI condition timed out: '+expression);};
  async function click(selector){
    await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Control absent or disabled');e.scrollIntoView({block:'center'});})()`);
    await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e?.getBoundingClientRect();if(!r||!r.width||!r.height)return false;const x=r.x+r.width/2,y=r.y+r.height/2;return x>=0&&x<innerWidth&&y>=0&&y<innerHeight&&e.contains(document.elementFromPoint(x,y));})()`);
    const box=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await rpc('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box},sessionId);
    await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box},sessionId);
  }
  async function clickText(selector,text){
    const key=await evaluate(`(()=>{const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})];const n=nodes.find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!n)throw Error('Button text absent');n.setAttribute('data-browser-flow-button','selected');return '[data-browser-flow-button="selected"]';})()`);
    try{await click(key);}finally{await evaluate(`document.querySelector(${JSON.stringify(key)})?.removeAttribute('data-browser-flow-button')`);}
  }
  const fill=async(selector,value)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Input absent/disabled');e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  async function barcode(){await fill('#sale_barcode','TEST-004');await evaluate("document.getElementById('sale_barcode').focus()");await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},sessionId);await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},sessionId);}
  async function nav(tab){const mobile=await evaluate('innerWidth<=900');if(mobile)await click('#btnMobileMenu');await click('nav button[data-tab="'+tab+'"]');}
  async function checkpoint(name,detail={}){assert.deepEqual(await evaluate('__fixture.errors()'),[]);results.push({name,passed:true,...detail});}
  async function screen(name){const shot=await rpc('Page.captureScreenshot',{format:'png'},sessionId);fs.writeFileSync(path.join(scratchReal,name+'.png'),Buffer.from(shot.data,'base64'),{mode:0o600});}
  try {
    const target=await rpc('Target.createTarget',{url:'about:blank'});({sessionId}=await rpc('Target.attachToTarget',{targetId:target.targetId,flatten:true}));
    await rpc('Page.enable',{},sessionId);await rpc('Runtime.enable',{},sessionId);await rpc('Network.enable',{},sessionId);
    // Intentionally no weaker retry if this also blocks local file navigation.
    await rpc('Network.setBlockedURLs',{urls:['*']},sessionId);
    await rpc('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false},sessionId);
    const navigation=await rpc('Page.navigate',{url:'file://'+fixtureFile},sessionId);if(navigation.errorText)throw Error('Local fixture blocked: '+navigation.errorText);
    await wait("typeof cartDraftController!=='undefined'&&cartDraftController?.canEdit()===true");
    assert.equal(await evaluate("!!navigator.locks&&!!crypto.randomUUID"),true);
    await checkpoint('authenticated startup with native browser storage and locks');

    await fill('#sale_clientBusca','Cliente');await click('#sale_clientLista .comboItem[data-cid]');await barcode();await fill('#saleItems input[data-qty]',40);
    assert.equal(await evaluate('currentSale.items[0].qty'),40);
    await rpc('Page.reload',{ignoreCache:true},sessionId);await wait("typeof cartDraftController!=='undefined'&&cartDraftController?.status==='restore'");
    assert.equal(await evaluate('__fixture.snapshot().stats.saleCreates'),0);
    await clickText('#cartDraftStatus button','Conferir e restaurar');await wait("cartDraftController.canEdit()&&currentSale.items[0]?.qty===40");
    assert.equal(await evaluate("document.getElementById('sale_client').value===__fixture.ids.client"),true);
    await checkpoint('reload preserves 40-piece draft; explicit restore and client preserved');

    await evaluate("__fixture.fault('rejectPayOnce',true)");await click('#btnFinalize');
    await wait("cartDraftController.canEdit()&&document.getElementById('cartDraftStatus').textContent.includes('pagamento inválido')");
    assert.equal(await evaluate('__fixture.snapshot().stats.saleCreates'),0);assert.equal(await evaluate('currentSale.items[0].qty'),40);
    await click('#btnFinalize');await wait("cartDraftController.status==='confirmed'");
    await clickText('#cartDraftStatus button','Nova venda');await barcode();await click('#btnFinalize');await wait("cartDraftController.status==='confirmed'");
    const sales=await evaluate("Object.values(__fixture.snapshot().requests).filter(r=>r.operation==='create_sale').map(r=>r.args)");
    assert.equal(sales.length,2);assert.ok(sales.every(s=>s.p_pay==='Pendente'));assert.notEqual(sales[0].p_client_request_id,sales[1].p_client_request_id);
    assert.equal(await evaluate('__fixture.snapshot().stats.saleCreates'),2);
    await checkpoint('known rejection then retry and second sale; distinct IDs and Pendente');

    await clickText('#cartDraftStatus button','Nova venda');await barcode();await fill('#saleItems input[data-qty]',2);
    const before=await evaluate('JSON.stringify({cart:currentSale.items,stock:__fixture.snapshot().tables.products,items:__fixture.snapshot().tables.sales.find(s=>s.id===__fixture.ids.sale).sale_items})');
    await click('.saleRow[data-sale="00000000-0000-4000-8000-000000000050"]');await click('#sd_pgto');await click('#btnReviewFinancials');
    await wait("!!financialCorrection&&!document.getElementById('modalFinancialCorrection').classList.contains('hide')");
    await fill('#fc_discount',600);await fill('#fc_value_00000000-0000-4000-8000-000000000051',2400);await fill('#fc_reason','Desconto fictício após finalizar');await click('#btnSaveFinancialCorrection');
    await wait("document.getElementById('modalFinancialCorrection').classList.contains('hide')");
    const after=await evaluate('JSON.stringify({cart:currentSale.items,stock:__fixture.snapshot().tables.products,items:__fixture.snapshot().tables.sales.find(s=>s.id===__fixture.ids.sale).sale_items})');assert.equal(after,before);
    assert.equal(await evaluate('__fixture.snapshot().stats.corrections'),1);assert.equal(await evaluate('__fixture.snapshot().tables.sales.find(s=>s.id===__fixture.ids.sale).total_bruto'),2400);
    await checkpoint('financial correction keeps 60 sale items, active cart and stock');
    await evaluate("closePaymentModal();closeSaleDrawer()");

    await nav('financeiro');await click('#fin_tabelaReceber button[onclick^="editarContaReceber"]');
    assert.equal(await evaluate("document.getElementById('receberCliente').value===__fixture.ids.client"),true);
    await fill('#receberDescricao','Recebível corrigido fictício');await click('#btnSalvarReceber');await wait("document.getElementById('modalContaReceber').style.display==='none'");
    await evaluate("__fixture.fault('loseAccountResponse',true)");await click('#fin_tabelaReceber button[onclick^="receberConta"]');
    await wait("document.querySelector('#accountsRecovery button')&&!document.querySelector('#accountsRecovery button').disabled");
    assert.equal(await evaluate('__fixture.snapshot().stats.settlements'),1);
    assert.equal(await evaluate("Object.keys(localStorage).some(k=>k.startsWith('vaidosa:operation:v1:')&&k.endsWith(':accounts'))"),true);
    await clickText('#accountsRecovery button','Conferir operação guardada');await wait("document.getElementById('accountsRecovery').classList.contains('hide')");
    assert.equal(await evaluate('__fixture.snapshot().stats.settlements'),1);assert.equal(await evaluate('__fixture.snapshot().tables.movimentacoes.length'),1);
    assert.equal(await evaluate('__fixture.snapshot().tables.v_contas[0].cliente_id===__fixture.ids.client'),true);
    await checkpoint('client preserved and lost receipt response reconciles one movement');

    await nav('venda');await evaluate('__fixture.setStock(__fixture.ids.product,0)');await click('#btnFinalize');
    await wait("document.getElementById('cartDraftStatus').textContent.includes('Estoque insuficiente')");
    assert.equal(await evaluate('currentSale.items[0].qty'),2);assert.equal(await evaluate('db.products.find(p=>p.id===__fixture.ids.product).stock'),0);
    await nav('estoque');await fill('#st_q','TEST-004');assert.equal(await evaluate("document.querySelectorAll('#stockVariants tr').length"),1);
    await fill('#s_barcode','TEST-004');await fill('#s_qty',5);await click('#btnStockIn');await wait('__fixture.snapshot().stats.stockEntries===1&&db.products.find(p=>p.id===__fixture.ids.product).stock===5');
    assert.equal(await evaluate('__fixture.snapshot().tables.stock_moves.length'),1);await checkpoint('canonical stock before rejection; exact variant filter and one stock entry');

    await nav('clientes');await click('#clientTable tr[data-cid="00000000-0000-4000-8000-000000000002"]');
    await wait("document.querySelectorAll('#clientHistory article').length===20");await clickText('#clientHistory button','Carregar mais pedidos');await wait("document.querySelectorAll('#clientHistory article').length===40");
    await clickText('#clientHistory button','Carregar mais pedidos');await wait("document.querySelectorAll('#clientHistory article').length>40");
    const count=await evaluate("document.querySelectorAll('#clientHistory article').length");await click('#clientHistory article button');await wait("document.getElementById('saleDrawer').getAttribute('aria-hidden')==='false'");
    await checkpoint('customer history pagination and detail',{ordersLoaded:count});await screen('desktop-drawer');
    await click('#btnCloseDrawer');
    for(const width of [1440,390]){
      await rpc('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false},sessionId);
      for(const tab of ['venda','estoque','clientes','financeiro']){
        await nav(tab);const layout=await evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})');assert.ok(layout.scroll<=width+1,'Page overflows '+tab+' at '+width);await screen(tab+'-'+width);
      }
    }
    await nav('clientes');await click('#clientTable tr[data-cid="00000000-0000-4000-8000-000000000002"]');await wait("document.querySelectorAll('#clientHistory article').length===20");await click('#clientHistory article button');
    const drawer=await evaluate("(()=>{const r=document.getElementById('saleDrawer').getBoundingClientRect();return {x:r.x,right:r.right,width:innerWidth};})()");assert.ok(drawer.x>=-1&&drawer.right<=drawer.width+1);await screen('mobile-drawer');await click('#btnCloseDrawer');
    await checkpoint('drawer and navigation at desktop/mobile dimensions');
    assert.deepEqual(await evaluate('__fixture.networkAttempts()'),[]);
    const remote=events.filter(e=>e.method==='Network.requestWillBeSent'&&/^(?:https?|wss?):/.test(e.params.request.url));assert.deepEqual(remote,[]);
    const report={status:'passed',fixture:true,databaseProof:false,browser:await rpc('Browser.getVersion'),sourceManifest:manifest,scenarios:results,networkRequests:remote.length,sandboxProof:proof};
    fs.writeFileSync(path.join(scratchReal,'browser-flow-results.json'),JSON.stringify(report,null,2),{mode:0o600});return report;
  } catch(error) {
    fs.writeFileSync(path.join(scratchReal,'browser-flow-results.json'),JSON.stringify({status:'failed',fixture:true,databaseProof:false,completed:results,error:error.message},null,2),{mode:0o600});throw error;
  } finally {clearTimeout(maxTimer);child.kill('SIGTERM');for(const entry of pending.values())clearTimeout(entry.timer);}
}
if(require.main===module){
  if(process.argv.includes('--plan'))console.log(JSON.stringify({status:'not_executed',reason:'Verified OS sandbox launcher unavailable',scenarios:PLAN},null,2));
  else {console.error('NOT EXECUTED: no verified OS sandbox launcher is installed. Flags or environment variables cannot enable execution. Read docs/browser-flow-validation.md.');process.exitCode=2;}
}
module.exports={PLAN,runInVerifiedSandbox};
