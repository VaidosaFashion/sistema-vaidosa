const test = require('node:test');
const assert = require('node:assert/strict');
const stock = require('../modules/stock-domain.js');
const one = '00000000-0000-4000-8000-000000000001';
const two = '00000000-0000-4000-8000-000000000002';
const base = {productId:one,qty:2,type:'ENTRADA',note:'  nota  ',newCost:12.35};
test('normalizes and freezes a minimal stock payload', () => {
  const value = stock.normalizeEntry({...base,cpf:'not copied'});
  assert.deepEqual(value,{productId:one,qty:2,type:'ENTRADA',note:'nota',newCost:12.35});
  assert.ok(Object.isFrozen(value));
  assert.deepEqual(stock.rpcPayload(value),{product_id:one,qty:2,type:'ENTRADA',note:'nota',new_cost:12.35});
});
test('rejects malformed IDs, quantities, costs and notes before any request', () => {
  for (const patch of [{productId:'x'},{qty:0},{qty:1.1},{qty:Infinity},{qty:2147483648},{type:'X'},
    {newCost:NaN},{newCost:-1},{newCost:1.001},{newCost:'12'},{newCost:1e8},{note:{}},{note:'x'.repeat(2001)}]) {
    assert.throws(() => stock.normalizeEntry({...base,...patch}),{code:'INVALID_STOCK_ENTRY'});
  }
});
test('keeps signed quantity semantics without inventing exchange rules', () => {
  assert.equal(stock.normalizeEntry({...base,type:'SAIDA',qty:-3,newCost:null,note:''}).qty,-3);
  assert.equal(stock.normalizeEntry({...base,type:'DEVOLUCAO',qty:3,newCost:null,note:''}).note,null);
});
test('canonical refresh preserves identity/fiscal data and updates aliases before consumers validate stock', () => {
  const old = [{id:one,stock:4,barcode:'001',ncm:'6204',priceAtacado:10,colorName:'Azul'}, {id:two,stock:5,barcode:'002'}];
  const updated = stock.mergeCanonicalProducts(old,[{id:one,stock:0,barcode:'001',price_atacado:20,cost:3}], [one]);
  assert.deepEqual(updated[0],{...old[0],stock:0,price_atacado:20,priceAtacado:20,cost:3});
  assert.equal(old[0].stock,4);
  assert.equal(updated[1].stock,5);
});
test('successful lookup removes missing requested IDs and rejects foreign or duplicate rows', () => {
  assert.deepEqual(stock.mergeCanonicalProducts([{id:one},{id:two}],[],[one]),[{id:two}]);
  assert.throws(() => stock.mergeCanonicalProducts([],[{id:two}],[one]));
  assert.throws(() => stock.mergeCanonicalProducts([],[{id:one},{id:one}]));
});
test('variant aggregation retains separate product IDs/barcodes including zero-stock record', () => {
  const products = [{id:one,name:'Blusa',size:'G1',color_id:'blue',stock:0,barcode:'001'},
    {id:two,name:'Blusa',size:'G1',color_id:'blue',stock:1,barcode:'002'}];
  const groups = stock.groupByVariant(products);
  assert.equal(groups.length,1); assert.equal(groups[0].stock,1); assert.equal(groups[0].ambiguous,true);
  assert.deepEqual(groups[0].records.map(p => [p.id,p.barcode,p.stock]),[[one,'001',0],[two,'002',1]]);
});
test('different size/color identity and unknown colors are never silently merged', () => {
  assert.equal(stock.groupByVariant([{id:one,name:'Blusa',size:'G1',color_id:'blue',stock:1},
    {id:two,name:'Blusa',size:'G2',color_id:'blue',stock:1}]).length,2);
  assert.equal(stock.groupByVariant([{id:one,name:'Blusa',size:'G1',stock:1},
    {id:two,name:'Blusa',size:'G1',stock:1}]).length,2);
  assert.throws(() => stock.groupByVariant([{id:one,stock:-1}]));
});
