# Contrato do módulo de contas — versão 2

Preparado localmente a partir de `502e33d`. Não aplicado em produção. A migração é
`supabase/migrations/20261105120000_accounts_integrity.sql`. O schema de contas foi
obtido das migrações versionadas: os metadados reais fornecidos na auditoria anterior
cobriam vendas e estoque, mas **não comprovam o schema atual de contas/movimentações**.

## Limites e fonte de verdade

`contas` representa obrigações a pagar ou receber; `movimentacoes` representa suas
liquidações integrais. Esses registros não são a mesma entidade que `sales` e
`sale_payments`. Este módulo não cria vínculo automático entre venda e conta, não
inventa taxas, não deduplica valores legados e não reconcilia caixa histórico.

O servidor determina valor, tipo e avanço de parcela usando a linha bloqueada da
conta. O cliente envia a intenção e uma revisão, nunca o valor do movimento. As
regras publicadas foram preservadas: recebimento integral conclui a conta; pagamento
único ou última parcela conclui; outro pagamento avança uma parcela e sete dias ou
um mês, limitando o dia ao último dia do mês. O avanço mensal continua baseado no
vencimento anterior (31/01 → 28/02 → 28/03), sem criar uma nova regra de dia âncora.

Campos legados insuficientes para determinar a parcela bloqueiam o pagamento.
Não se adivinha o saldo nem se reconstrói histórico a partir de contagens.

## Camadas e extensão

- `modules/accounts-domain.js`: validação pura de UUID, data literal, valor em
  centavos, revisão e construção de comandos; funciona em navegador e Node, sem rede.
- Repositório de operações do frontend: mantém intenção congelada e UUID por
  tentativa; resolve resultado incerto; traduz resposta para o cache canônico.
- RPCs públicas: contrato de transporte com nomes/argumentos abaixo.
- `vaidosa_private.account_operation`: transação, autorização, validação, bloqueio,
  efeitos e registro da tentativa. O schema privado não pode ser exposto no PostgREST.
- `account_audit`: trilha de eventos; `contas`/`movimentacoes`: estado operacional.

Nova integração deve chamar os mesmos comandos, preservar UUID/payload durante
retentativas e consultar a situação antes de refazer um envio incerto. Não se permite
SQL arbitrário nem escrita direta em contas/movimentos pelo cliente autenticado.

## API

Todas as mutações retornam `{account, movement, replayed}`. `account` usa nomes SQL e
inclui `operation_revision` e `archived_at`. `movement` pode ser `null`; quando existe,
inclui os dados de reversão. Replay retorna o **estado atual** da conta e do movimento,
sem fazer o cache voltar a uma versão antiga.

| RPC | Argumentos |
| --- | --- |
| `create_account_v2` | `p_request_id uuid`, `p_values jsonb` |
| `settle_account` | `p_account_id uuid`, `p_request_id uuid`, `p_expected_revision bigint`, `p_paid_on date` |
| `edit_account` | `p_account_id uuid`, `p_request_id uuid`, `p_expected_revision bigint`, `p_changes jsonb` |
| `reverse_account_settlement` | `p_account_id uuid`, `p_movement_id uuid`, `p_request_id uuid`, `p_expected_revision bigint`, `p_reason text` |
| `archive_account` | `p_account_id uuid`, `p_request_id uuid`, `p_expected_revision bigint`, `p_reason text` |
| `get_account_request_status` | `p_request_id uuid`, `p_expected_operation text`, `p_expected_payload jsonb` |

`p_values` aceita `tipo`, `descricao`, `valor`, `proximo_vencimento`, `obs`,
`categoria_id`, `recorrencia`, `parcelas`, `data_inicio`, `cliente_id`,
`forma_recebimento`. Os quatro primeiros são obrigatórios; contas a pagar também
exigem categoria, recorrência e quantidade positiva de parcelas. Criação mantém
`parcela_atual=1`, autoria autenticada e revisão 0. A função legada `create_conta`
mantém assinatura/retorno, delegando ao mesmo mecanismo. Um UUID usado antes desta
migração não ganha retrospectivamente um snapshot: a restrição única continua
protegendo a criação e pode rejeitar a tentativa legada.

`p_changes` permite apenas `descricao`, `valor`, `proximo_vencimento`, `obs`,
`categoria_id`, `cliente_id`, `forma_recebimento`. Campos ausentes são preservados;
`cliente_id: null` é remoção explícita. Categoria pertence à conta a pagar; cliente e
forma à conta a receber. Não são editáveis tipo, recorrência, parcela, status,
autoria, UUID ou revisão. Conta concluída deve ter sua liquidação elegível revertida
antes de editar. Uma edição sem mudanças não avança revisão nem duplica auditoria.

O lookup recebe o nome exato da RPC em `p_expected_operation` e todos os argumentos
congelados dessa RPC (inclusive `p_request_id`) em `p_expected_payload`. Retorna
`{status:"not_found"}` ou `{status:"completed",result:{account,movement,replayed:true}}`.
Confere autor e payload; payload divergente é erro, nunca uma confirmação.
O lookup espera o mesmo bloqueio da mutação: se ela estiver em curso, só observa
o resultado após commit/rollback. Timeout/erro no lookup mantém a intenção incerta.
O lookup não recupera tentativas pertencentes a outro operador.

## Atomicidade, concorrência e recuperação

1. Verificar perfil ativo administrador ou vendedora.
2. Bloquear UUID da tentativa com advisory lock transacional.
3. Havendo tentativa finalizada do mesmo autor/payload, retornar estado atual.
4. Bloquear a conta e conferir revisão esperada.
5. Aplicar movimento + alteração da conta + auditoria + journal na mesma transação.

Dois UUIDs para a mesma revisão não liquidam duas vezes: somente a primeira operação
avança. O mesmo UUID/payload pode ser reenviado sem duplicar efeitos, mesmo após uma
resposta perdida. UUID com payload/autor diferente é rejeitado. O UUID é global ao
ledger deste projeto, não uma chave baseada em dia ou computador.

O cliente deve persistir a intenção antes de enviar, bloquear sua edição durante
resultado incerto e usar o lookup. `not_found` autoriza somente reenvio da mesma
intenção congelada; não prova que uma chamada anterior jamais chegará ao servidor.
O advisory lock, revisão e idempotência também protegem essa chegada tardia.

Erros `40001` indicam revisão obsoleta e exigem atualização explícita, nunca retry
automático com revisão nova. `22023` indica payload/regra inválida; `42501`, falta de
autorização; `P0002`, conta ausente. Erros de rede, timeout e respostas não confirmadas
continuam incertos. Não se conclui rollback apenas pela mensagem de erro genérica.

## Reversão e preservação de histórico

A interface deve selecionar um movimento específico, mostrar valor/data e coletar
motivo. A reversão exige movimento criado pelo novo RPC, auditoria anterior íntegra,
mesma revisão imediatamente posterior à liquidação e nenhum evento posterior.
Restaura somente status, parcela atual e próximo vencimento daquele snapshot.
Não apaga movimento, não cria valor negativo e não altera vendas ou estoque.

O movimento fica com `reversed_at`, `reversed_by` e `reversal_reason`. Deve continuar
visível no histórico e ser excluído de valores efetivos: `pago=true AND reversed_at
IS NULL`. Totais/relatórios que ignoram esse predicado precisam ser atualizados no
mesmo pacote. Conta e auditoria também avançam, conservando autoria.

Movimentos legados permanecem legíveis, mas não podem ser revertidos automaticamente:
não há snapshot anterior confiável. Mesmo uma reversão de operação nova bloqueia a
reversão de uma operação mais antiga; desfazer uma sequência inteira requer análise
específica, não uma inferência silenciosa.

Exclusão não faz parte da API. Arquivar uma conta concluída preserva conta, movimentos
e totais históricos; a interface pode ocultar arquivadas da lista operacional, com
acesso explícito ao histórico. Arquivar conta ativa é bloqueado: cancelar uma dívida
ou parcela pendente é uma decisão de produto/negócio ainda não definida. Não existe
desarquivamento implícito. Essa limitação deve aparecer claramente ao usuário.

## Autorizações e privacidade

RLS permite leitura de contas, movimentos e auditoria somente a perfis ativos com
papel administrador ou vendedora. Permissões diretas de escrita, TRUNCATE e TRIGGER
de `anon`, `authenticated` e `PUBLIC` são retiradas de contas/movimentos. RPCs negam
anon/PUBLIC e conferem perfil no servidor. Acesso de serviço privilegiado não é uma
API autorizada para o navegador. Ainda não há isolamento multiempresa: projeto
representa uma loja, conforme modelo existente.

O histórico público não copia descrição livre, observações, nome/telefone/CPF do
cliente nem documentos fiscais. Mantém IDs de conta/cliente/categoria e campos
financeiros necessários à rastreabilidade. O ledger privado contém o payload da
tentativa (incluindo descrição/observação quando editadas) para comparação exata:
não possui acesso direto do frontend e não tem limpeza automática, pois eliminá-lo
invalidaria idempotência. Retenção futura exige política explícita.

`operation_revision` é incrementada por trigger em qualquer UPDATE da conta,
inclusive operação privilegiada ou `ON DELETE SET NULL` de relacionamento; essas
mudanças bloqueiam reversões antigas. Um administrador do banco continua podendo
modificar estrutura e dados: isto não é uma trilha imutável contra o proprietário.

## Homologação e futura implantação

Testes puros: `node --test tests/accounts-domain.test.cjs`. Testes SQL isolados:
`tests/sql/accounts_integrity.sql`, pelo runner central; inserem dados fictícios,
injetam falha depois da inserção do movimento e terminam com rollback das fixtures.
Não executar a suíte SQL num projeto real. Resultado e concorrência em duas sessões
devem constar da evidência central do pacote, não inferidos dos testes puros.

Antes da instalação futura, conferir o schema real de contas/movimentos, view,
políticas, grants de tabela/coluna, triggers, overloads de create_conta e dependências
externas. A migração recusa políticas inesperadas e usa timeout de lock. Ela precisa
da base de funções/perfis existente; não é instalador independente. Conferir
`vaidosa_private` fora dos schemas expostos. Preparar recuperação privada coerente de
definições, permissões e dados afetados, verificando integridade e cobertura.

Parar escritores, inclusive abas antigas e integrações, antes da transação. A
migração não altera valores financeiros legados, mas acrescenta campos/tabelas,
substitui a criação, adiciona triggers/RPCs e restringe acesso. Aplicar SQL e frontend
compatível na mesma janela; testar primeiro com fixtures numa cópia. Pós-checagens:
funções/assinaturas/grants, RLS, view, revisão, contagens e totais efetivos preservados.
Não criar contas reais apenas para testar.

Antes do COMMIT, falha reverte a migração inteira. Depois do COMMIT não existe desfazer
automático. O frontend anterior não é rollback compatível: tenta escrita direta e
ignora marcações de reversão. Após uso do módulo, preferir correção adiante ou modo de
leitura com operações pausadas. Não restaurar snapshot anterior descartando movimentos
novos nem remover ledger/auditoria. Uma recuperação de dados exige reconciliação dos
eventos posteriores e autorização específica.
