# Adapter MCP de negócio — preparação sem conexão real

Esta etapa acrescenta um adapter assíncrono de leitura e seu serviço de ferramentas,
testados com um gateway fictício. Não cria cliente Supabase, listener, OAuth,
credencial, permissão, consulta real ou configuração de Codex/Claude. Importar os
módulos não ativa I/O. É independente do bundle de alterações financeiras/estoque.

## Componentes e fronteiras

```text
Request/Response MCP existente
  → verificador de token e autorizador explicitamente injetados
  → principal com proveniência local, audiência, emissor, validade e escopos
  → business-service.cjs (ferramentas, argumentos, cursores, DTO v2)
  → business-adapter.cjs (planos fixos, invariantes e projeção)
  → gateway.readSnapshot(plan, {signal}) [somente mock fornecido]
  → futuro backend canônico autorizado [não implementado/ativado aqui]
```

`http-identity.cjs` registra os principais autenticados em um WeakMap do processo:
copiar/congelar um objeto não o autentica. Emissor/audiência/validade são conferidos
antes e depois da leitura. O transporte reautentica cada request e passa o principal
novo ao serviço em cache; alteração de loja, permissões ou clientes não reaproveita
essa sessão. A lista de clientes é ordenada/deduplicada para que a mesma autorização
em outra ordem preserve a paginação. Uma revogação durante uma leitura em curso
ainda exige política de backend: o grant é reavaliado na requisição seguinte, não
continuamente. Nesta etapa original o verificador era somente injetado. A
[preparação JWT posterior](mcp-jwt-offline.md) acrescenta verificação criptográfica
offline com chaves de teste; nenhum provedor real foi configurado.

O modelo só escolhe uma das cinco ferramentas e seus argumentos declarados.
`role`, loja, URL, SQL, filtros livres e credenciais são rejeitados. O token nunca
chega ao adapter, gateway ou auditoria. O gateway recebe sujeito e escopo obtidos no
boundary confiável; não pode tratá-los como autorização sem validá-los no servidor.
O schema atual representa um projeto/loja, sem coluna `store_id`: vincular a loja ao
projeto correto é responsabilidade de configuração confiável futura, não um filtro
inventado no banco nem suporte multiempresa demonstrado.

## Contrato do gateway

O construtor exige `contractVersion: "vaidosa-business-read-v1"`, loja explícita,
`fixture` booleano e `readSnapshot`. A flag fixture é metadado de configuração, não
prova da origem. Não há implementação remota fornecida. O gateway real deverá
implementar exatamente os planos imutáveis exportados pelo comportamento do adapter:

| Operação | Fonte canônica e campos mínimos | Consistência exigida |
| --- | --- | --- |
| `stock_variants` | produto por ID, nome, tamanho, cor normalizada, estoque | ID ascendente; zero é saldo válido; não somar famílias para autorizar variante |
| `customer_orders` | vendas do cliente exato, ID, vínculo, `sold_at`, status, subtotal/desconto/total | `sold_at` desc com microssegundos, ID asc; conservar vínculo de cliente |
| `sale_detail` | cabeçalho acima e IDs/quantidades/preços dos itens | itens completos e não vazios; soma exata = subtotal; subtotal − desconto = total |
| `sale_receipts` | pagamento, venda, vínculo de cliente, `paid_on`, valor/taxa/líquido | janela por data civil inclusiva; IDs únicos; valor − taxa = líquido |
| `manual_accounts` | conta, cliente, tipo, valor, vencimento, status, recorrência/parcela, `archived_at`, movimentos mínimos | somente não arquivadas; movimentos completos, sem IDs duplicados/de outra conta; reversões excluídas da soma efetiva |

`color_name` e as coleções `items`/`movimentacoes` são projeções canônicas a resolver
por joins no gateway; não se afirma que sejam colunas diretas do schema.

Cada resposta deve conter exatamente `{version, subject, store, snapshot, next,
complete, data}`. Identidade/loja precisam coincidir, `complete` deve ser true e o
snapshot deve permanecer o mesmo entre páginas. O gateway deve produzir snapshot
coerente (incluindo joins e movimentos), aplicar autorização por usuário/recurso,
limitar bytes **antes** de parsear e recusar truncamento. Seleções independentes
paginas/joins sem transação não demonstram esse contrato. Echo de sujeito/snapshot
não substitui RLS ou autorização real. Não se utiliza MCP administrativo, SQL livre,
service role no navegador/modelo, DOM, cache do caixa ou localStorage como fonte.

Limites: página 20 por padrão/50 máximo; até 200 itens por venda, 100 movimentos por
conta, 1.000 recebimentos por agregado e 2.000 linhas por cadeia de paginação.
Acima disso há recusa explícita, não total parcial. O plano solicita teto de 256 KiB
na origem; sua imposição física depende do gateway futuro. O adapter aceita somente
objetos simples sem getters/campos extras, UUIDs, datas reais e centavos exatos
seguros, sem arredondar precisão desconhecida. `sold_at` vira data civil no fuso
explícito da loja; recebimentos usam `paid_on` sem conversão de fuso.

São até quatro leituras pendentes por adapter; timeout padrão 1,5 s/máximo 5 s.
Abort impede entrega e é passado ao gateway. Cancelamento físico é cooperativo:
uma fonte que ignore abort continua ocupando capacidade até terminar; não se libera
vaga para criar consultas ilimitadas. O backend real precisa impor statement timeout,
pool e quotas próprios. O transporte existente limita requisição/resposta e tem
supervisão de deadline; não é um proxy implantado nem defesa de ingress configurada.

Cursores aleatórios de 192 bits são locais à instância, usuário/loja/permissões,
filtros/ferramenta/tamanho de página. Expiram em cinco minutos; até 128 ficam vivos.
Não contêm cursor/ID da fonte. Snapshot trocado, duplicação ou falta de progresso
recusam a consulta. Reiniciar/evictar a instância exige reiniciar a pesquisa.

## DTO v2 e decisões comerciais

Os quatro contratos de estoque/vendas/recebimentos mantêm campos mínimos; contas
mudam explicitamente para DTO v2. A fixture stdio v1 continua disponível sem mudar
seu significado. Toda resposta informa versão, moeda BRL e flag fixture. Não retorna
nomes/contato/CPF de cliente, observações, XML/documentos fiscais, custo ou segredo.
IDs e totais ainda são dados sensíveis; acesso/retencão futuros precisam de decisão.

Contas v2 usam `recordedAmountCents` (valor registrado por parcela) e
`effectivePaidCents` (soma de todos os movimentos efetivos registrados), com status
original `ativo/concluido`, recorrência e número/total de parcelas. Não se subtrai
essa soma para inventar saldo da parcela atual: em conta recorrente ela pode exceder
o valor por parcela. Recusas de linhas arquivadas não removem seu histórico no banco.

| Decisão específica | Default conservador já viável | Quando passa a bloquear |
| --- | --- | --- |
| Vincular venda a conta manual | origens separadas; não deduplicar por nome/valor/data | antes de consolidar recebimentos ou criar conciliação automática |
| Pagamento parcial de conta | preservar liquidação integral existente; leitura mostra fatos sem saldo inferido | antes de oferecer nova baixa parcial/renegociação |
| Cancelar dívida ativa | bloqueado; arquivamento somente nos casos já definidos | antes de apagar/baixar obrigação pendente |
| Reverter movimento legado sem snapshot | histórico legível; reversão automática bloqueada | antes de reconstruir saldo/estado anterior por inferência |
| Trocas/devoluções/canais externos | ID da variante e origem/evento explícitos; nenhuma mutação MCP | antes de escrever pedidos/estoque de um canal ou definir devolução comercial |
| Taxas/custos | preservar fatos existentes, sem nova média/taxa/imposto | somente se a regra comercial realmente mudar |

Essas decisões não impedem testar leitura com mock. Ativação real é bloqueada por
implementação/ensaio do gateway e identidade, vínculo loja/projeto, autorização/RLS,
limites físicos, retenção/revogação e testes dos clientes reais. Não existe switch
para transformar este pacote em conexão real.

## Auditoria, testes e ativação futura

Auditoria do adapter emite operação conhecida e hash de ator com sal por processo;
não emite token, argumentos, IDs de vendas/clientes ou valores. Callback falhando
não vaza erro da fonte. Isso não é armazenamento durável/imutável: retenção, rotação,
resultado/duração, correlação e controle de acesso devem ser definidos para operação.

`tests/mcp-business-read.test.cjs` usa gateway, identidade e UUIDs inventados e
Requests `.invalid` em memória. Os testes de regressão existentes do MCP fixture e
HTTP permanecem separados. Execução somente no sandbox autorizado com rede negada,
fonte/toolchain somente leitura e recursos/supervisão limitados; as flags de rede do
protótipo não substituem esse isolamento. Resultado terminal e hashes constam do
relatório externo desta rodada. Nenhum ensaio usa clientes Codex/Claude reais.

Próxima ativação requer outra autorização específica. Primeiro implementar o gateway
limitado e verificador real em homologação autorizada; provar RLS/escopos, negações
cruzadas, snapshot/bytes/cancelamento e revogação; escolher transporte/SDK versionado,
ensaiar as versões dos clientes com fixtures e só depois acesso real minimizado.
Desligar MCP deve ser independente do caixa. Não instalar o bundle mutante só para
habilitar este mock. Ver [ativação](mcp-activation-plan.md) e
[recuperação por versão](recovery-version-boundaries.md).

Referências oficiais: [segurança da Data API](https://supabase.com/docs/guides/api/securing-your-api)
e [changelog](https://supabase.com/changelog), consultados em 06/11/2026. Grants/RLS
reais não foram exercitados nesta etapa. Nenhuma dependência foi instalada/adotada.
