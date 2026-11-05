# Ensaio de fluxos em navegador real — preparado, não executado

Estado desta entrega: **NÃO EXECUTADO**. Não há resultado de aprovação, captura nova de tela ou confirmação de compatibilidade com Chrome. A revisão de sintaxe/fonte não substitui o ensaio abaixo.

O ambiente não demonstrou os controles de isolamento exigidos para executar o alvo e o navegador. O teste de `sandbox-exec` aninhado falhou com `Operation not permitted`; uma verificação separada sem executar o alvo também não demonstrou um perfil utilizável. Não foi iniciado Chrome por estes arquivos. A prévia estática antiga e os testes JSDOM anteriores são evidências distintas.

## Arquivos preparados

- `tests/browser-fixture-runtime.cjs`: cliente Supabase/Auth e banco **fictícios**, isolados no perfil temporário. Reproduz respostas normais e falhas controladas, incluindo `sales_pay_check` e resposta perdida após recebimento.
- `tests/build-browser-fixture.cjs`: gera uma página interativa com o `index.html` e scripts locais reais. Não executa o sistema ao construir o texto. Registra SHA-256 dos arquivos de origem; remove recursos remotos, URL/chave do projeto e aplica CSP `connect-src 'none'`.
- `tests/browser-flows.cjs`: controlador Chrome CDP por pipes, sem servidor HTTP/porta de depuração. CLI recusa execução; `--plan` apenas lista cenários. Não há flag ou variável de ambiente que substitua o isolamento.

As únicas funções periféricas substituídas na página gerada são `detectZebra`, `initAutoBackup` e `pushStockToNuvemshop`, antes de `checkExistingSession()` iniciar; esses serviços ficam fora do ensaio. Supabase, Auth, Chart.js, jsPDF, JsBarcode e Turnstile são simulados ou indisponíveis de propósito. `fetch`, XHR, WebSocket, EventSource, beacon, janelas externas, impressão e seletores de arquivos são bloqueados. **O mock não prova atomicidade, RLS, SQL, taxas reais ou comportamento de serviços externos.**

O estado fictício permanece em uma chave específica do localStorage do perfil novo para permitir recarregar o carrinho. Nenhum dado de cliente real, CPF, credencial ou checkpoint privado é importado. O perfil e todos os artefatos devem ficar no scratch exclusivo atribuído pelo launcher, fora do repositório; não há fallback para diretório compartilhado.

## Pré-requisito de execução

Antes de ativar o controlador, um launcher revisado precisa **impor pelo sistema operacional**, ao processo completo e descendentes:

1. alvo/repositório e ferramentas somente leitura;
2. negação de rede externa;
3. ambiente vazio com allowlist explícita e HOME/TMP/cache dentro do scratch;
4. escrita apenas no scratch atribuído;
5. limites de CPU, memória, processos, tamanho de arquivos, espaço de disco e tempo total;
6. nenhum socket/serviço compartilhado ou credencial do host acessível.

O launcher confiável deve iniciar **toda a Node harness, inclusive geração da fixture e processamento das fontes**, já dentro desses controles; confinar somente o Chrome é insuficiente. Deve testar seus limites e então fornecer `verifyActiveControls()`, `ownsAssignedScratch()` e `spawnChrome()` ao controlador exportado `runInVerifiedSandbox`. O objeto de prova retornado não é mecanismo de contenção: ele registra os controles **já impostos** pelo launcher. Não aceitar arquivo JSON, flag ou aprovação humana como implementação desses controles. O repositório ainda não contém esse launcher, portanto o comando normal continua bloqueado.

Barreiras adicionais do controlador, que não substituem o requisito anterior: Chrome instalado com perfil exclusivo, `--disable-background-networking`, DNS bloqueado, CDP `Network.setBlockedURLs(['*'])`, CSP e bloqueios de APIs. A comunicação de teste usa pipes locais. Se o bloqueio CDP também impedir `file://`, o ensaio deve falhar e ser revisado; não existe fallback que libere URLs. O navegador não usa o perfil diário nem abre/recicla abas operacionais.

## Cenários preparados

1. Inicialização da página real com sessão fictícia, Web Locks e localStorage nativos do navegador.
2. Carrinho com 40 peças, recarga e restauração explícita; nenhuma venda automática.
3. Rejeição conhecida `sales_pay_check`, nova tentativa e venda seguinte com `Pendente`, UUIDs distintos e nenhum efeito duplicado.
4. Correção financeira de uma venda fictícia com 60 itens, preservando IDs dos itens, estoque e carrinho ativo.
5. Edição de conta preservando cliente; resposta perdida após recebimento, journal durável e conferência de um único movimento.
6. Atualização canônica do estoque antes de rejeitar o envio; filtros por variante e entrada única.
7. Histórico de cliente com mais de 20 pedidos, paginação e abertura do detalhe selecionado.
8. Navegação/drawer em 1440 e 390 pixels, contenção do layout, nenhuma solicitação externa.

O futuro ensaio gravará `browser-flow-results.json`, manifesto das fontes e PNGs somente no scratch. Uma falha registra os cenários concluídos e encerra o navegador; não publica, não aplica SQL e não altera produção. O processo supervisor deve impor o limite total, inclusive contra falha/travamento do controlador. Os limites internos de 90 s e timeout CDP são apenas defesa adicional.

## Limites ainda pendentes

Os quatro arquivos foram preparados para revisão, mas seletores, navegação `file://`, comportamento do bloqueio CDP, Web Locks em origem de arquivo, descarte de diálogo `beforeunload`, layout e fluxo de captura **ainda precisam ser exercitados**. Podem exigir correções de fixture/controlador antes de validar o produto. Não substituir esses passos por uma afirmação de sucesso.
