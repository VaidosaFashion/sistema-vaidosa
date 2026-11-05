# Pacote local: implantação futura e recuperação

**Estado: preparado e testado localmente; não instalar nem publicar sem nova revisão/autorização.** Base publicada comparada: 502e33d. Nenhuma migração desta revisão foi aplicada na loja. A validação anterior de novembro tratava vendas/estoque e não demonstrou o schema atual de contas/movimentações.

## Sequência mínima futura

1. Confirmar o HEAD remoto e comparar quaisquer mudanças novas. Preservar proteções do carrinho, `Pendente`, correções de pagamentos, CPF e guardas fiscais. Nunca sobrescrever um HEAD diferente por força.
2. Executar `docs/blocks-preflight-readonly.sql` pelo próprio usuário no projeto correto e revisar o único resultado de metadata: tipos/ordem de `v_contas`, constraints/FKs, triggers, expressões de policies, privilégios explícitos por coluna e assinatura/hash de `create_conta`. Conferir `vaidosa_private` fora de Exposed Schemas. Não usar conexão cuja autorização foi negada. A migração bloqueia privilégios de escrita inesperados por coluna em vez de substituí-los silenciosamente.
3. Antes de qualquer alteração, preparar recuperação **também para contas**. Preferir backup lógico completo com restauração ensaiada. Se o usuário optar por cópia limitada via SQL Editor: exportação privada coerente de contas/movimentações/categorias e referências necessárias, definições antigas de `create_conta`, view, triggers, policies, grants e versões das funções afetadas; validar contagens, hashes/bytes e uma restauração tipada num banco descartável. Não compartilhar dados pessoais/CPF no chat. A cópia anterior não cobre este bloco e não é reutilizável como garantia. Não há dump ou checkpoint real novo neste pacote.
4. Revisar com usuário as decisões abertas: vínculo de venda/conta, cancelamento de dívida ativa, reversão legada sem snapshot, devoluções/trocas comerciais e integração de canais. Este pacote bloqueia essas mutações ambíguas e explica o motivo, sem definir baixas contábeis novas.
5. Obter autorização específica da instalação/publicação; pausar todas as abas antigas, caixas, recebimentos, edições, entradas e integrações que escrevam. Confirmar nenhum comando incerto pendente e salvar/revisar carrinhos. As migrações retiram escrita direta em contas/movimentações: clientes antigos serão incompatíveis. A RPC antiga de estoque fica disponível e continua sem UUID; canais antigos precisam de planejamento antes de uso concorrente amplo.
6. Na homologação e depois na janela autorizada, usar o bundle transacional `supabase/releases/20261105_install_blocks.sql`, **uma vez**, sobre o banco que já possui a migração financeira de novembro. O bundle contém apenas as duas migrações novas. Falha antes de COMMIT reverte a transação inteira. Não executar `supabase db push` indiscriminadamente, nem repetir os instaladores de novembro já aplicados; histórico de migração manual precisa de reconciliação própria.
7. Validar `docs/blocks-postcheck-readonly.sql` e comparar contagens/somas/hashes previamente preparados (sem mudar linhas reais para testar). Só após flags corretas publicar todos os arquivos de frontend compatíveis em conjunto, limpar/atualizar clientes sem carrinho/envio ativo e conferir arquivos/versão do Pages. O MCP fixture é independente e não é publicado/ativado como integração real por esse passo.
8. Retomar de forma controlada, com operador conferindo o resultado de uma operação real que já precisasse realizar. Nenhuma venda ou pagamento de teste deve ser criado em produção. Registrar evidência da conferência e observar conflitos de revisão/pendências locais, sem liberar UUID incerto por conta própria.

## Mudanças de banco/permissões

- `contas`: `operation_revision` e `archived_at`, trigger de revisão/guard de exclusão.
- `movimentacoes`: identificador de operação e marca/reason/autor de reversão; registros anteriores preservados.
- `account_audit` e ledgers privados `account_requests`/`stock_entry_requests`; RPCs versionadas de criação, edição, liquidação, reversão, arquivamento, entrada e consulta de tentativa.
- RLS de leitura de contas/movimentações/auditoria exige perfil ativo ADM/vendedora; INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER diretos de anon/authenticated são removidos das duas tabelas. `create_conta` mantém assinatura/retorno, mas passa a validar perfil e UUID/payload/autor. Service role/owner não são reconfigurados.
- Entrada de estoque v2 usa request + produto sob lock, grava saldo/custo/movimento/journal atomicamente. A RPC antiga permanece compatível; não foi alegado que toda escrita direta de produtos/estoque ficou impossível. Produtos CRUD e integrações antigas continuam pontos a restringir em um bloco futuro.
- Vendas, itens, pagamentos, campos fiscais e documentos não são alterados por essas migrações. O schema privado continua não exposto. As tabelas de contas existentes não foram auditadas remotamente nesta etapa.

## Recuperação/rollback

- Antes de COMMIT: erro/timeout provoca rollback integral; preservar mensagem e revisar, sem repetir uma execução de resultado incerto antes de verificar metadata.
- Após COMMIT, sem novas operações: pausar clientes, confirmar o estado e decidir reparo à frente. Uma restauração pontual só pode usar as definições exatas preservadas e ensaiadas e uma evidência de que nenhum novo movimento seria perdido.
- Depois de novas liquidações/reversões/entradas: **não reverter frontend para 502e33d nem remover colunas, ledger ou auditoria**. O frontend antigo desconhece reversões e seus totais poderiam incluí-las. Priorizar correção compatível, preservando UUID, revisão, metadados e restrição de DML. Não existe SQL destrutivo de rollback neste pacote.
- Dados de negócio não são descartados para desfazer uma migração. Restaurar backup completo é uma decisão operacional separada, com perda potencial de lançamentos posteriores que precisa ser avaliada e autorizada.

## Limites desta homologação

PostgreSQL 17 descartável reconstruído das migrações locais e metadata anteriormente fornecida, com contas da base versionada. Não comprova que contas/RLS/triggers do banco atual sejam iguais. Testes são de regressão e falhas simuladas, não certificação de segurança. Chart.js/CDN/Turnstile/login real, impressora, SEFAZ, Nuvemshop, Auth/OAuth e Codex/Claude reais não foram chamados. A prévia usa dados fictícios estáticos e permite apenas navegação.
