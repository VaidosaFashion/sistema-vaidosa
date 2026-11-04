# Revisão de vendas — 04/11/2026

Implementação local no branch `fix/sale-payment-corrections`, partindo de `ee4b5e8` do repositório `VaidosaFashion/sistema-vaidosa`. **Não publicada. Nenhuma venda, pagamento, estoque ou configuração de produção foi alterado.**

## Resultado

- **Corrigir pagamento / desconto**, acessível em Editar venda e em Pagamentos, permite corrigir desconto total e os valores, datas, formas, parcelas e observações dos recebimentos existentes numa única operação.
- A tela busca uma cópia atual da venda antes de editar. Informa total, taxas, líquido e saldo previstos; exige motivo. Não diminui automaticamente o valor recebido ao aumentar o desconto. Pagamentos acima do novo total devem ser conferidos pelo operador. A correção não realiza estorno bancário.
- O banco conserva IDs de venda/pagamentos, itens, preços históricos, criador/data original e estoque. Registra autor, motivo, antes e depois em histórico que o cliente não pode modificar ou apagar. A lista de pagamentos deve conservar exatamente os IDs existentes; esta entrega não exclui parcelas nem refaz pedidos.
- Alteração concorrente invalida o formulário. Reenvio da mesma tentativa retorna o estado atual e não gera outra correção. Cancelar/no-op não escreve valores. A nova função não tem fallback de várias escritas independentes.
- Taxas históricas são preservadas em correções apenas de data/observação; mudança de valor usa a taxa registrada, mudança de forma/parcelas usa a configuração atual. Os totais efetivos retornados pelo banco substituem o cache da tela.
- Vendas com emissão fiscal autorizada, pendente ou de resultado incerto são bloqueadas. A tabela fiscal é opcional no schema versionado.

## Causas demonstradas no código e testes locais

1. **A segunda venda falhava após a primeira, não por limite diário:** o campo oculto `sale_pay` tem somente a opção `Pendente`; os dois resets atribuíam `PIX`. O DOM passa a retornar string vazia e a RPC antiga tenta gravar `pay=''`, rejeitado por `sales_pay_check`. Os resets foram corrigidos e o envio usa `Pendente` explicitamente. O teste reproduz o comportamento real de um `<select>` e salva duas vendas na mesma data.
2. A limpeza com timer de 1,5 segundo podia apagar um novo carrinho. A limpeza agora ocorre assim que a venda é confirmada, antes de atualizações auxiliares. O snapshot e o UUID são preservados quando a resposta é incerta.
3. Pagamento novo não tinha chave estável no cliente. Agora recebe UUID explícito; o reenvio ignora conflito em vez de inserir outra linha, confirma o registro e busca a venda completa. Falha de atualização após confirmação repete somente leituras. A data usa o calendário local.
4. As RPCs antigas `create_sale`, `delete_sale`, `apply_stock_entry` eram `SECURITY DEFINER` sem verificar perfil, e o código não revogava o EXECUTE padrão de PUBLIC. A migração exige perfil ativo da loja e revoga acesso anônimo. **A exposição efetiva em produção depende de grants reais, que não foram acessados.**
5. `delete_sale` verificava a existência sem travar a venda; duas exclusões podiam ler os mesmos itens e devolver estoque duas vezes. A função agora trava a venda antes de ler os itens e trata reenvio sem uma segunda devolução.
6. O desconto de nova venda aceitava números negativos ou maiores que o subtotal. Agora cliente e servidor validam os limites; o servidor usa o subtotal calculado dos produtos travados. Totais iniciais e status também seguem a mesma regra financeira dos recebimentos.

## Banco e publicação

As duas migrações são necessárias, **antes** de publicar `index.html` e `financial-corrections.js`:

1. `20261104133207_edit_sale_financials.sql`: revisão financeira, histórico, controle de tentativas, RPC transacional, serialização/validação dos pagamentos e totais derivados.
2. `20261104134055_harden_sale_stock_rpcs.sql`: autorização explícita, validação de venda/desconto, criação idempotente concorrente e exclusão com trava da venda.

Não há backfill financeiro nem correção automática de dados históricos. A coluna de revisão começa em zero. As migrações substituem funções/triggers utilizados pelo app e obtêm travas de schema; aplicar em transação durante janela tranquila, após backup e comparação do schema real. O schema `vaidosa_private` não pode estar na lista de schemas expostos do PostgREST.

Antes da aplicação, executar `docs/audit-sales-readonly.sql`, revisar os resultados e comparar as definições reais com o repositório. O script contém somente SELECT/WITH, retorna contagens/metadados sem listar clientes, inclui estoque sem movimentos e separa empates de horário de divergências comprovadas. Não interpretar resultados vazios da base fictícia como prova sobre produção. Verificar também que o SQL Editor executou o bloco completo; o histórico deste projeto registra mensagens de sucesso sem aplicação efetiva.

Após aplicar, conferir funções, revisão, triggers e grants com a última consulta do script; publicar os dois arquivos do frontend juntos. Verificar visualmente uma venda existente abrindo e cancelando a correção, sem alterar dados para teste. Uma correção real deve usar valores confirmados pelo operador.

Rollback do frontend pode manter as adições no banco. **Não apagar histórico ou tabelas de tentativas** para reverter a UI. Caso seja necessário reverter funções/triggers, preparar migração específica após analisar operações ocorridas desde a publicação; não restaurar silenciosamente as falhas de concorrência ou permissões antigas.

## Evidências reproduzíveis

- Resultado desta entrega: **33/33 testes Node/DOM passaram**, scripts JavaScript compilados e `git diff --check` limpo. A suíte PostgreSQL 17.11 também passou, com transações reais em base descartável e cinco cenários concorrentes entre sessões. Os 15 blocos da auditoria foram executados somente nessa base de teste.
- `npm ci --ignore-scripts` e `npm test`: DOM simulado (jsdom), dados e RPCs fictícios, sem chamadas ao Supabase. Incluem cancelamento, desconto, forma/parcelas, envio repetido, respostas perdidas, conflito de revisão, migração ausente, estoque/itens intactos e duas vendas no mesmo dia.
- `sh tests/run-sql-tests.sh`: PostgreSQL descartável, socket privado em `/tmp`, sem TCP e sem aceitar URL/credencial remota. Aplica todo o histórico de migrações, testa a lógica SQL real, RLS/grants, concorrência e as consultas da auditoria. Encerra e remove o cluster ao sair.
- `npm run preview`: prévia em `http://127.0.0.1:8934`, com 60 peças fictícias. CSP `connect-src 'none'`; não carrega sessão, credencial ou endpoint de produção. Demonstra o formulário real com um banco em memória. Não substitui os testes SQL.
- A interface foi validada por DOM, sem uma nova inspeção visual em navegador após a interrupção da sessão do Opera.

## Limites e bloqueios

- O conector Supabase lista somente a organização VCK (`izepnrcyqkapoxwogtzg`). Uma consulta de leitura no projeto Vaidosa (`ysultkzfhgtyujbomfqz`) retornou `MCP error -32600: You do not have permission to perform this action`. **Negada; nenhuma consulta SQL executada.**
- A aba autenticada de Usage da organização Vaidosa foi identificada no Opera. A tentativa de acesso por um subagente foi impedida por posse de aba; a alternativa pelo aplicativo retornou sessão explicitamente interrompida pelo usuário. O uso do computador foi parado, sem SQL ou mutação e sem resultado incerto.
- Não foi possível confirmar funções, RLS, grants, triggers, versões aplicadas ou integridade dos registros reais. A reconexão correta do Supabase ou nova sessão autorizada da Vaidosa é pré-requisito para fechar essa auditoria e publicar com segurança.
- As tabelas antigas mantêm o modelo de confiança compartilhada (políticas amplas para usuários autenticados). Escritas diretas na API fora do fluxo novo podem não gerar o histórico de correção. Transformar todo o acesso legado em RPCs auditadas é uma mudança adicional de autorização, não incluída nesta entrega.
- Tentativas pendentes de criação de venda/pagamento são mantidas na memória da aba. Recarregar/fechar a aba durante resposta incerta perde a chave; antes de reenviar manualmente, conferir se o lançamento já apareceu. A correção existente tem revisão e log no servidor para evitar sobrescrever silenciosamente.
- Os testes não cobrem Nuvemshop, Zebra, emissão fiscal externa ou transações bancárias; não houve comunicação com esses serviços.

Referência de implementação: [funções de banco Supabase](https://supabase.com/docs/guides/database/functions) e [RPC no cliente JavaScript](https://supabase.com/docs/reference/javascript/rpc). O changelog oficial foi consultado; o CLI instalado foi inspecionado antes de gerar os arquivos de migração.
