# Prévia financeira local

Inicie com `npm ci --ignore-scripts` e `npm run preview`, então abra `http://127.0.0.1:8934`.
O servidor escuta apenas no computador local. A porta pode ser alterada com `VAIDOSA_PREVIEW_PORT`.

A prévia reaproveita o HTML e CSS do modal, o mapeamento da venda e o módulo `financial-corrections.js` da implementação. O restante da página é uma demonstração isolada, com uma venda fictícia de 60 peças, subtotal de R$ 3.000,00 e um pagamento PIX de R$ 3.000,00. O botão de exemplo preenche desconto de R$ 600,00 e recebimento de R$ 2.400,00 para conferência antes de salvar.

Não carrega o aplicativo de produção, sessão, chaves, CDNs ou dados da loja. O cliente Supabase é substituído por memória local. A política CSP bloqueia todas as conexões externas (`connect-src 'none'`), e o servidor aceita apenas GET para três caminhos conhecidos. Recarregar restaura a simulação. Isso também vale para o arquivo independente `vaidosa-previa.html`, que incorpora código e logo.

## Verificação

`node --test tests/financial-corrections.test.cjs` exercita o DOM real do formulário com jsdom e um cliente fictício. Inclui cancelamento, envio conjunto de desconto e pagamento, pagamentos parciais, sobrepagamento, forma e taxa, motivo, repetição, resposta perdida, conflito de revisão, migração ausente, histórico e cache atualizado.

Os testes usam o módulo de produção e o mapeamento real. Não executam o script principal do aplicativo nem chamadas de rede. O script principal inteiro também é compilado sem executar para verificar sintaxe. O histórico e a preservação dos 60 itens e estoque são conferidos na simulação; a integridade transacional de PostgreSQL depende dos testes SQL separados.

Limite explícito: a sessão de computador foi interrompida, portanto esta entrega não inclui inspeção visual em navegador real, screenshot ou teste responsivo renderizado. O servidor foi verificado por HTTP local e a interface foi exercitada em DOM simulado. Nenhum teste desta prévia demonstra o estado dos dados reais.
