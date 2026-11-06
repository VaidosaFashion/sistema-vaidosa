# Vaidosa MCP — demonstração local somente leitura

Componente executável com cinco ferramentas MCP e **dados inteiramente inventados**. Não está conectado à Vaidosa, não lê configuração do site, não usa credenciais e não modifica arquivos, vendas, contas ou estoque. É independente da implantação do frontend e das migrações.

Requer Node com `node:test`, `structuredClone` e `TextDecoder` (Node 20 ou superior). Não há instalação de dependências nem alteração do `package.json`.

Preparação adicional: `business-adapter.cjs` e `business-service.cjs` implementam a
fronteira assíncrona de leitura sobre um gateway explicitamente injetado, com
contratos UUID/DTO v2 e testes mock. Não fornecem gateway Supabase real nem nova
flag de ativação. O executável stdio abaixo continua fixture v1. Ver
[contrato e limites da preparação](../docs/mcp-business-read-preparation.md).

Etapa PostgreSQL: as mesmas cinco consultas foram ligadas a um banco descartável
com RLS, papéis efêmeros e identidade simulada. O gateway é injetável; o único
executor fornecido continua em `tests/support`, preso ao socket da fixture. Não é
conexão ativa à loja. Ver [escopo e reprodução](../docs/mcp-postgres-fixture.md).

Preparação JWT offline: [perfil e limites](../docs/mcp-jwt-offline.md). Assinaturas
JOSE com chaves inteiramente fictícias foram integradas ao boundary e aos testes
PG/HTTP. Isso não configura emissor, OAuth, JWKS remoto ou credencial real.

```sh
node mcp/server.cjs --fixture
node mcp/server.cjs --fixture --principal=manager
node --test tests/mcp-*.test.cjs
```

O primeiro comando usa `seller`, o menor escopo da demonstração. `manager` habilita os agregados financeiros fictícios. Esses nomes **não são autenticação de produção**: qualquer operador local pode escolher um deles, porque somente fixtures existem. Nenhuma configuração persistente de Codex, Claude ou outro cliente é criada.

O servidor aguarda mensagens JSON-RPC delimitadas por linha no stdin; não é um menu de terminal. Stdout contém somente respostas MCP. Stderr contém eventos de auditoria local com sequência, horário, método conhecido, ferramenta conhecida, resultado e contagem; não contém argumentos, IDs de clientes/vendas, valores, payloads, mensagens de erro recebidas nem ambiente. Para retenção, o operador pode capturar stderr em arquivo privado e definir rotação. A demonstração não fornece armazenamento de auditoria imutável.

## Ferramentas e contratos

| Ferramenta | Entrada | Saída mínima | Escopo fixture |
| --- | --- | --- | --- |
| `vaidosa_stock_list` | `limit?`, `cursor?` | ID, nome do produto, tamanho, cor, saldo da variante | seller, manager; loja da sessão |
| `vaidosa_customer_orders` | `customerId`, `limit?`, `cursor?` | ID da venda/cliente, data civil, status e valores em centavos | seller: cliente demo01; manager: clientes da loja |
| `vaidosa_sale_get` | `saleId` | resumo acima e itens com ID, quantidade e preço unitário | mesmo escopo de pedidos |
| `vaidosa_receipts_summary` | `from`, `to` | quantidade, recebido/taxa/líquido em centavos | manager; recebimentos de vendas da loja |
| `vaidosa_accounts_list` | `kind?`, `limit?`, `cursor?` | ID, pagar/receber, vencimento, status, valor/pago | manager; contas manuais da loja |

Exemplos inventados para o cliente de teste: `sale_demo01`, `customer_demo01`, período de `2026-11-01` a `2026-11-05`. Todos os resultados incluem `fixture: true`, `contractVersion: 1` e `currency: BRL`. A resposta de ferramenta traz o mesmo objeto em `structuredContent` e em texto JSON, para clientes que consumam qualquer dessas formas. Erros de execução trazem `isError: true`; parâmetros inválidos retornam erro de protocolo.

Todos os argumentos são validados contra o subconjunto de JSON Schema 2020-12 declarado nas próprias definições: objeto, campos obrigatórios, tipos string/integer, limites, enum e pattern. Não se aceita schema arbitrário do cliente. Campos adicionais são rejeitados, inclusive `role`, `user_role`, `store`, SQL e URL. `_meta` do protocolo não concede acesso e não é usado como identidade. Dados de venda/contato/observações/CPF/documentos fiscais não são retornados; o nome retornado no estoque é de produto, não de cliente.

Valores monetários permanecem centavos inteiros; não há estimativa ou alteração de taxa. `vaidosa_receipts_summary` inclui os dois extremos do período pela data civil **de recebimento** (`paid_on`), não pela data da venda. Ele exclui contas manuais e não representa conciliação bancária. `vaidosa_accounts_list` identifica explicitamente outra origem. A união futura depende do domínio canônico, sem somar registros que possam representar o mesmo fato financeiro.

## Limites verificáveis

- Somente `--fixture`, opcionalmente `--principal=seller|manager`. URLs, chaves, adapter de produção e flags desconhecidas interrompem a inicialização; não se lê `.env`.
- Guard local bloqueia os caminhos usuais de rede Node (HTTP/HTTPS, sockets, listeners, DNS e fetch). Não é sandbox contra código hostil do próprio operador; este componente não carrega plugins ou código fornecido por ferramentas.
- Entrada: 16 KiB por linha UTF-8; saída: 64 KiB por resposta; requisição de tamanho excedido encerra a sessão. Escrita respeita backpressure de stdout/stderr.
- 120 mensagens/minuto e 2.000 mensagens/sessão. Erros de parse e notificações também contam. Reiniciar o processo abre nova sessão; esse limite não substitui quotas por usuário em um serviço real.
- Página: padrão 20, máximo 50. Cursor aleatório de 192 bits, sem IDs/dados embutidos, válido só nesta instância, ferramenta, principal, filtro e tamanho de página; validade 10 minutos e até 128 cursores vivos. Um cursor evicto, expirado ou de outra sessão requer reiniciar a consulta. Fixtures são imutáveis; um adapter futuro exige snapshot/keyset consistente.
- Agregado: período máximo de 366 datas civis inclusivas. Datas inexistentes e invertidas são rejeitadas. Detalhe de venda: até 200 itens.
- O processo encerra quando o stdin fecha. Notificações não recebem resposta. Métodos não anunciados, tarefas assíncronas, resources/prompts e execução de mutações não existem.

## Fronteiras do código

`server.cjs` cuida do stdin/stdout e modo fixture; `protocol.cjs` cuida do ciclo MCP; `service.cjs` valida ferramentas, permissões e projeções; `fixture-adapter.cjs` implementa o contrato de leitura e o filtro por loja/recurso. `offline-guard.cjs` impede I/O de rede no processo fixture.

Contrato de adapter v1 (síncrono nesta demonstração):

```text
mode = fixture; contractVersion = 1
listStock(principal, { offset, limit }) -> { rows, hasMore }
listCustomerOrders(principal, { customerId, offset, limit }) -> { rows, hasMore } | null
getSale(principal, saleId) -> row | null
summarizeReceipts(principal, { from, to }) -> { count, receivedCents, feeCents, netCents }
listAccounts(principal, { kind, offset, limit }) -> { rows, hasMore }
```

O adapter é responsável por aplicar o principal confiável ao escopo de cada consulta. O serviço controla autorização por ferramenta e projeta campos permitidos. Um adapter real não pode ser ligado por flag: requer implementação/revisão, contrato assíncrono com timeout/cancelamento e confirmação de ativação. Os IDs legíveis acima são exclusivos das fixtures; o domínio real deverá validar seus UUIDs, sem expor SQL ou delegar filtro de loja ao modelo.

Domínio/repos/API/UI permanecem fora do transporte MCP. Evolução recomendada: regras e agregados pertencem ao domínio canônico; repositórios implementam leitura autorizada; API/UI/MCP chamam os mesmos serviços de aplicação. Adaptadores de novos canais normalizam IDs externos e eventos; não recalculam saldos por conta própria. Contratos versionados e fixtures de conformidade devem acompanhar cada adapter.

## Protocolo e ensaio de compatibilidade

Implementação mínima deliberada de **MCP 2025-11-25 via stdio**: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`; notificações desconhecidas são ignoradas, cancelamento é inócuo porque as consultas fixture são síncronas. A negociação oferece 2025-11-25 se o cliente pedir versão diferente; o cliente precisa aceitar essa versão ou desconectar. A lista finita de até cinco ferramentas cabe em uma página, sem cursor de `tools/list`.

Testes usam cliente JSON-RPC próprio em processo separado e verificam as mensagens reais de stdio, não só funções internas. **Codex e Claude não foram configurados nem ensaiados nesta entrega**; suporte a stdio pelo cliente e aprovação da conexão precisam ser verificados por versão. Não é certificação completa de conformidade MCP, nem promessa de compatibilidade automática com toda implementação do protocolo.

Referências primárias consultadas em 05/11/2026: [transporte stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [ciclo/negociação](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [base JSON-RPC](https://modelcontextprotocol.io/specification/2025-11-25/basic), [ferramentas](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). A versão foi fixada para o ensaio; não se declara que será a versão mais recente em futuras ativações.

## Reutilização avaliada

O candidato preferencial para o transporte de produção é o [SDK TypeScript oficial](https://github.com/modelcontextprotocol/typescript-sdk): evita manter manualmente recursos extensos de transporte, validação e evolução do protocolo. O repositório foi apenas consultado; nenhum código/dependência foi baixado, instalado ou executado. Antes de adotá-lo: escolher release estável exata compatível com cliente/Node, verificar lockfile e dependências transitivas, avisos de segurança, política de atualização e os contratos deste módulo. O [arquivo de licença consultado](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE) descreve transição de MIT para Apache-2.0; verificar a licença e avisos do artefato versionado escolhido, não assumir que o texto de `main` cobre toda versão histórica.

O transporte mínimo sem dependências foi mantido **para este protótipo isolado**, com superfície pequena e testes reproduzíveis offline. Isso transfere a manutenção de protocolo para o projeto e não deve justificar expansão artesanal para OAuth/HTTP/integrações complexas. Migrar o transporte para SDK deve preservar as ferramentas/DTOs, autorização e testes existentes, sem alterar as regras de negócio.

Atualização posterior ao texto original de reutilização: o ensaio externo isolado
`vaidosa-mcp-cliente-oficial-2026-11-05/terminal-summary.json` registra 12 testes
aprovados (11 cenários e grupo), usando cliente/core oficiais `2.4.0` por stdio
contra a fixture desta base. Não adicionou dependências ao aplicativo e não valida
o adapter de negócio v2 nem clientes Codex/Claude reais. A etapa atual acrescenta
seu próprio ensaio mock/HTTP em memória, documentado separadamente.
