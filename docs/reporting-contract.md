# Relatórios e histórico do cliente — contratos locais

Base de integração: versão publicada `502e33d`. Estes módulos são preparação local: não executam SQL, não abrem conexões, não alteram pagamentos, estoque, clientes ou permissões. A integração da tela e a implantação ficam em blocos separados.

## 1. Domínio de relatórios

`modules/reporting-domain.js` exporta `window.VaidosaReporting` no navegador e `module.exports` no Node. Não depende de DOM, Supabase ou relógio global.

### Rateio do líquido

```js
const allocations = VaidosaReporting.allocateSaleNet(sale);
// [{ item, index, key, grossCents, netCents }], na ordem original dos itens
const products = VaidosaReporting.aggregateProductSales(sales);
// [{ key, it, qty, brutoCents, liquidoCents, bruto, liquido }]
```

Entradas seguem o mapeamento camelCase da tela: `sale.items`, `sale.netReceived`; em cada item: `id` opcional, `productId`, `price`, `qty`. `netReceived` ausente/nulo significa zero conforme o comportamento atual. Preço unitário e valores monetários devem ter no máximo duas casas decimais; quantidade deve ser um inteiro positivo. Valores inválidos são recusados, em vez de desaparecerem no relatório como zero. `moneyToCents(value)` aceita número ou string decimal e verifica o limite de inteiro seguro.

O peso de cada linha é `preço unitário × quantidade / soma dos valores dos itens`. O denominador **não é o total após desconto**. O líquido já registrado na venda é a única origem do valor distribuído; taxa, desconto, status e recebimento não são recalculados nem modificados pelo módulo. O método dos maiores restos distribui os centavos faltantes. Empates usam `item.id`, ou `productId`, ou índice original. Linhas de mesmo produto sem ID próprio usam o índice como desempate. A soma de `netCents` é exatamente igual ao líquido da venda em centavos.

Exemplo demonstrado: itens de R$ 60 + R$ 40, desconto de R$ 10, líquido de R$ 90 → R$ 54 + R$ 36; antes o denominador de R$ 90 fazia o rateio somar R$ 100. Taxas já cobradas continuam refletidas no `netReceived` original. Um desconto de 100% com líquido zero distribui zero. Líquido não zero sem base de itens provoca erro explícito: não se inventa peso. O suporte matemático a valores líquidos negativos apenas conserva a entrada; não cria uma regra de estorno.

`aggregateProductSales` ordena por quantidade decrescente e chave estável, sem truncar a lista. Agrupa apenas pelo ID canônico da variante (`productId`). Produto excluído/sem ID mantém uma chave por venda e linha, evitando unir históricos distintos por nome ou código reutilizado. `brutoCents` é o valor dos itens **antes do desconto**, enquanto `liquidoCents` é o líquido rateado. `bruto`/`liquido` são conveniências de apresentação em reais, derivadas dos inteiros. Os objetos `item`/`it` são referências para apresentação; os módulos não os modificam. A tela deve capturar erros e sinalizar inconsistência, sem exibir totais parciais como se fossem completos.

### Data de venda e data de recebimento

```js
const bySaleDate = VaidosaReporting.selectSalesByMonth(sales, {
  month: '2026-11', timeZone: 'America/Sao_Paulo', pay: '', channel: ''
});
const byReceiptDate = VaidosaReporting.selectReceiptsByMonth(sales, { month: '2026-11' });
```

- `sale.date` vem de `sales.sold_at`: é um instante. Aceita ISO com `Z`/offset explícito ou epoch **em milissegundos**. `saleDay(sale,timeZone)` exige o fuso configurado da loja; nunca usa silenciosamente o fuso do computador. `selectSalesByMonth` filtra por esse dia e preserva os filtros de forma da venda e canal (canal ausente mantém o padrão existente `Loja`).
- `payment.date` vem de `sale_payments.paid_on`: é uma data de calendário `YYYY-MM-DD`. `calendarDay` valida a data e não a converte em instante. `selectReceiptsByMonth` filtra pelo mês dessa data, independentemente de quando a venda ocorreu. Retorna somente `source:'sale_payment'`, IDs da venda/recebimento, data, método e valores bruto/taxa/líquido em centavos.
- Um relatório selecionado por **data da venda** inclui o líquido atualmente associado àquelas vendas. Isso não equivale ao dinheiro recebido no mês. Um recebimento de novembro de uma venda de outubro pertence a novembro somente no critério de recebimento. A interface precisa nomear explicitamente o critério usado.
- `separateFinancialSources({saleReceipts,manualMovements})` mantém duas coleções e marca a origem. Não soma nem deduplica fontes por semelhança de data, cliente, valor ou descrição. Movimentações manuais podem representar o mesmo fato econômico; a ligação explícita e a eventual reconciliação exigem contrato próprio, fora desta função.

Não há nova regra de competência, conciliação, imposto, taxa de cartão ou estorno. A UI preserva os dados originais e torna o critério visível.

## 2. Histórico completo e paginado do cliente

`modules/customer-orders.js` exporta `window.VaidosaCustomerOrders`/CommonJS.

```js
const controller = VaidosaCustomerOrders.createController({
  repository, pageSize: 15,
  onState(state) { /* renderizar sem fazer escrita */ },
  onOpenOrder(id, minimalOrder) { /* abrir detalhe já existente */ }
});
await controller.selectClient(clientId); // primeira página
await controller.loadMore();             // páginas seguintes, até hasMore=false
await controller.refresh();              // refaz consulta do cliente selecionado
controller.openOrder(orderId);           // somente IDs já carregados
controller.getState();                   // cópia dos dados mínimos
controller.dispose();                   // aborta e limpa referências
```

Estado público: `{clientId,orders,loading,error,hasMore}`. `selectClient(null)` limpa a seleção. `pageSize` aceita 1–100; 15 é tamanho de página, não limite do histórico. Um cliente com 62 pedidos foi testado até a última página. Repetir `loadMore` durante carregamento reutiliza a consulta pendente. Falha mantém os pedidos já carregados, oferece erro genérico sem detalhes privados do servidor e permite tentar o mesmo cursor novamente. Mudar de cliente aborta a consulta anterior quando disponível e ignora sempre sua resposta tardia. IDs repetidos entre páginas não duplicam pedidos; pedidos de IDs diferentes com mesmo valor/data são preservados. Páginas de outro cliente, excesso de linhas, cursor ausente/inválido ou ciclo de cursor falham de forma explícita.

### Repositório injetado: somente leitura

```js
repository.listCustomerOrders({clientId, cursor, limit, signal})
// Promise<{ orders: CamelCaseOrder[], nextCursor: string | null }>
```

O adapter real deve consultar a coleção autorizada por `client_id`, ordenando **`sold_at DESC, id ASC`**, em todas as páginas, e usar um cursor para esse par. Para avançar: `sold_at < últimaData` ou (`sold_at = últimaData` e `id > últimoId`). Preserve o timestamp original do banco no cursor, inclusive fração de segundo; não reduza a milissegundos antes de consultar. Use `limit+1` para detectar a próxima página e devolva no máximo `limit` linhas ao controller. `nextCursor:null` é uma declaração explícita de fim, não resultado de falha ou limite silencioso de API. Valide IDs/timestamps antes de construir filtros; não aceite filtros SQL/PostgREST livres vindos da UI.

Projeção sugerida no adapter: `sales(id,client_id,sold_at,channel,kind,pay,installments,discount,subtotal,total_bruto,net_received,payment_status)`; itens `id,product_id,name,barcode,size,qty,price`; pagamentos `id,paid_on,value,method,installments,fee_pct,fee_value,net_value`. Converta para camelCase e **preserve `sale_items.id`** (o mapeador antigo da tela o omitia). O campo de data dos pedidos pode ser ISO ou epoch ms na UI; o cursor da consulta deve preservar a precisão original. Os IDs são para navegação e autorização, não prova autônoma de permissão: o adapter real depende da autenticação/RLS vigente.

O controller mantém apenas estes campos e descarta CPF fiscal, telefone, e-mail, notas livres, identificação do operador e custos internos. Preserva ID da venda, cliente selecionado, situação, datas, totais, itens e pagamentos para detalhe. Não registra esse estado em armazenamento persistente, log ou telemetria. O callback de abertura recebe uma cópia mínima; não há método de editar/excluir ou receber pagamento. A integração deve limpar/dispor o controller no logout/troca de usuário para não deixar a memória da sessão anterior visível.

`createMemoryRepository(arrayOuGetter)` serve para fixtures/testes ou uma fonte local comprovadamente completa. Não corrige um cache incompleto nem substitui a paginação do backend em produção. Seu cursor usa resolução de milissegundos do JavaScript; o adapter real deve conservar a precisão do banco. Nenhum mecanismo de paginação HTTP aqui oferece snapshot transacional entre páginas: novas vendas podem aparecer somente após `refresh`, e alterações no cliente/data de uma venda durante leitura podem deslocá-la. A tela deve informar “pedidos carregados”, sem afirmar um total completo até `hasMore:false`.

### View opcional

`renderHistory(container,state,{onOpenOrder,onLoadMore,formatMoney,formatDate})` usa exclusivamente `textContent`, cria botões de detalhe/carregar mais/repetir e estados vazio/carregando/erro. Aceita container/document injetados, foi testada com DOM fictício e não executa requests. `formatDate` deve usar o fuso explícito configurado; sem formatter, mostra o valor original. A aplicação pode renderizar o estado por conta própria para preservar layout e modal existentes.

## 3. Validação e limites de integração

Comando local sem instalações ou rede:

```sh
node --test tests/reporting-domain.test.cjs tests/customer-orders.test.cjs
```

30 testes aprovados: conservação de centavos em 250 cenários gerados, desconto total, líquido com taxas preservadas, precisão/overflow, produto sem ID, virada de mês em UTC e São Paulo, datas impossíveis recusadas, data calendário, separação de fontes, mais de 15 pedidos, ordenação/cursor, resposta atrasada, repetição, retry, privacidade e view com DOM fictício. A revisão independente identificou a normalização automática de datas impossíveis do JavaScript; a validação foi reforçada e esse caso ganhou regressão. A limitação de microssegundos do adapter de memória está documentada acima, sem afetar o contrato do adapter real. Estes testes verificam os módulos puros; não demonstram o estado atual do Supabase, integridade dos dados reais ou comportamento do adapter ainda não integrado. Nenhuma credencial, dado real, consulta de produção ou mutação foi usada.

A cobertura de carregamento integral de movimentos financeiros/estoque (limites antigos 300/200), os testes do adapter real com fixtures, os rótulos/erros e o teste de integração da tela pertencem ao bloco de integração. A revisão final deve confirmar que clientes não vinculados continuam sem histórico por identidade, sem associar por nome/documento de forma heurística. Migração não é necessária para estes dois módulos isolados; qualquer dependência trazida por outros blocos deve ser avaliada no pacote completo.
