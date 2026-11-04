const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const readSource = () => fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const saleId = '11111111-1111-4111-8111-111111111111';
const paymentId = '22222222-2222-4222-8222-222222222222';

function fixtureSale() {
  return {
    id: saleId, sold_at: '2026-11-04T12:00:00.000Z', client_id: null,
    vendedor_id: null, channel: 'Loja', kind: 'Venda', pay: 'PIX',
    installments: 0, discount: 0, subtotal: 3000, total_bruto: 3000,
    cost_total: 1500, fee_pct: 0, fee_value: 0, net_received: 3000,
    profit: 1500, note: 'VENDA FICTÍCIA — 60 peças', payment_status: 'Pago',
    price_tier: 'Atacado', finance_revision: 4,
    sale_items: Array.from({length:60}, (_,i) => ({
      id: `item-ficticio-${i+1}`, product_id: `produto-ficticio-${i+1}`,
      name: `Peça demonstrativa ${i+1}`, cat: 'Demonstração', fabric: '',
      size: 'G1', price: 50, cost: 25, qty: 1, barcode: `DEMO${i+1}`
    })),
    sale_payments: [{id:paymentId, sale_id:saleId, paid_on:'2026-11-04',
      value:3000, method:'PIX', installments:0, fee_pct:0,
      fee_value:0, net_value:3000, note:'Recebimento fictício',
      created_at:'2026-11-04T12:00:00.000Z', created_by:null}]
  };
}

function functionSource(name) {
  const html = readSource();
  const start = html.indexOf(`  function ${name}(`);
  if(start < 0) throw new Error(`Function ${name} not found`);
  const end = html.indexOf('\n  }', start);
  return html.slice(start, end+4);
}

function modalSource() {
  const html = readSource();
  const start = html.indexOf('<div id="modalFinancialCorrection"');
  return html.slice(start, html.indexOf('<div id="modalStockManual"',start));
}

// This runtime is ONLY served by the offline preview. It has no credentials,
// session storage, production endpoints, fetch implementation or network client.
function previewRuntimeSource() {
  return `
const demoClone = value => JSON.parse(JSON.stringify(value));
let demoSale = ${JSON.stringify(fixtureSale())};
let demoAudit = [];
const demoRequests = new Map();
const db = {sales:[mapSaleFromDb(demoSale)], products:demoSale.sale_items.map(x=>({id:x.product_id,stock:10}))};
let currentPaymentSaleId = demoSale.id;
let editandoVendaId = demoSale.id;
function escapeHtml(value){return String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function fmtBRL(value){return Number(value).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});}
function fmtDataBR(value){return String(value).slice(0,10).split('-').reverse().join('/');}
function taxaDoPagamento(method,n){return method==='Debito'?2.99:method==='Credito'?(n===1?4.99:6.99):0;}
function fecharEdicaoVenda(){}
function closePaymentModal(){}
function toast(title,message){document.getElementById('demoToast').textContent=title+' — '+message;}
function renderSalesTable(){renderDemo();}
function renderHome(){}
function renderDemo(){
  const sale=db.sales[0];
  document.getElementById('demoTotal').textContent=fmtBRL(sale.totalBruto);
  document.getElementById('demoPaid').textContent=fmtBRL(sale.payments.reduce((a,p)=>a+p.value,0));
  document.getElementById('demoCount').textContent=sale.items.reduce((a,p)=>a+p.qty,0)+' peças preservadas';
  document.getElementById('demoStock').textContent=db.products.reduce((a,p)=>a+p.stock,0)+' unidades no estoque fictício';
  document.getElementById('demoAuditCount').textContent=demoAudit.length+' correção(ões) nesta prévia';
}
const sb={
  from(table){
    const query={select(){return query},eq(){return query},order(){return query},
      single:async()=>({data:demoClone(demoSale),error:null}),
      limit:async()=>({data:demoClone(demoAudit),error:null})};
    if(!['sales','sale_financial_audit'].includes(table)) throw new Error('Operação fora da prévia');
    return query;
  },
  async rpc(name,payload){
    if(name!=='edit_sale_financials') throw new Error('Operação fora da prévia');
    if(demoRequests.has(payload.p_request_id)) return {data:demoClone(demoSale),error:null};
    if(payload.p_expected_revision!==demoSale.finance_revision) return {data:null,error:{message:'A venda mudou. Feche e abra novamente para conferir os valores atuais.'}};
    const before=demoClone(demoSale);
    demoSale.discount=payload.p_discount;
    demoSale.total_bruto=demoSale.subtotal-payload.p_discount;
    demoSale.sale_payments=payload.p_payments.map(p=>{
      const old=demoSale.sale_payments.find(x=>x.id===p.id);
      const same=old.method===p.method && old.installments===p.installments;
      const pct=same?old.fee_pct:taxaDoPagamento(p.method,p.installments);
      const fee=Math.round(p.value*pct)/100;
      return {...old,...p,fee_pct:pct,fee_value:fee,net_value:Math.round((p.value-fee)*100)/100};
    });
    demoSale.fee_value=demoSale.sale_payments.reduce((a,p)=>a+p.fee_value,0);
    demoSale.net_received=demoSale.sale_payments.reduce((a,p)=>a+p.net_value,0);
    demoSale.profit=demoSale.net_received-demoSale.cost_total;
    const paid=demoSale.sale_payments.reduce((a,p)=>a+p.value,0);
    demoSale.payment_status=paid>=demoSale.total_bruto?'Pago':paid>0?'Parcial':'Aberto';
    const methods=[...new Set(demoSale.sale_payments.map(p=>p.method))];
    demoSale.pay=methods.length>1?'Misto':methods[0]||'Pendente';
    demoSale.finance_revision++;
    demoRequests.set(payload.p_request_id,true);
    demoAudit.unshift({created_at:new Date().toISOString(),actor_name:'Operador fictício',reason:payload.p_reason,before_data:before,after_data:demoClone(demoSale)});
    return {data:demoClone(demoSale),error:null};
  }
};
// Explicit replacement: even if a CDN/client is accidentally added, preview
// only exposes this in-memory client. CSP connect-src 'none' is another barrier.
window.supabase={createClient:()=>sb};
`;
}

module.exports = {root, clone, saleId, paymentId, fixtureSale, readSource, functionSource, modalSource, previewRuntimeSource};
