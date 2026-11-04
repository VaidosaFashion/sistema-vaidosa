**Roteiro operacional atual: ROTEIRO-CHECKPOINT.md. Este documento discute alternativas; não executar comandos de backup/restauração em produção sem autorização.**

# Vaidosa — backup restaurável e instalação financeira futura

Revisão de preparação, 04/11/2026. Nenhuma conexão ao banco, exportação, restauração, redefinição de senha ou migração foi executada nesta revisão.

## Estado confirmado e próximo passo mínimo

**Atualização confirmada por Kennedy:** projeto Free, sem backups do projeto disponíveis no Dashboard; senha direta PostgreSQL desconhecida. Não pedir nova conferência dessas informações nem sugerir redefinição da senha. Não houve nova conexão ao projeto, mudança de credencial, exportação ou restauração.

O pacote financeiro `f8651f39322f9dbc17c2dd1e025a17d80c74ad37` foi testado com dados sintéticos, mas backup integral e restauração real continuam não verificados. A autorização anterior publicou somente o frontend `931b28c2078c69cec617d5d0b6087c56fd393e99`; não autoriza aplicar migrações financeiras.

O SQL Editor usa a sessão autorizada do Dashboard e não exige a senha direta PostgreSQL. Assim, a senha desconhecida impede a rota de exportação por essa conexão, mas não impede preparar uma exportação limitada pelo SQL Editor nem aplicar SQL depois de autorização específica. A documentação oficial reserva backups diários gerenciados a Pro/Team/Enterprise; para Free recomenda exportação própria. [Supabase — backups](https://supabase.com/docs/guides/platform/backups).

Ferramentas locais conhecidas: `pg_dump`, `psql` e `pg_restore` 17.11 em `/opt/homebrew/bin`; Docker CLI instalado, mas daemon funcional não confirmado. Não instalar ou reconfigurar nada agora. Ter essas ferramentas não resolve a falta da credencial direta.

## Rota viável sem senha: checkpoint direcionado, não backup integral

É possível preparar uma consulta **somente leitura** que exporte para arquivo local um checkpoint desta intervenção: definições atuais de funções substituídas e dos objetos afetados; colunas/defaults, constraints, índices, triggers, policies/RLS, ownership/grants de tabela e coluna e privilégios efetivos; conteúdo das oito tabelas envolvidas (`sales`, `sale_items`, `sale_payments`, `products`, `stock_moves`, `store_settings`, `profiles`, `nfce_emissions`) e dependências que a recuperação escolhida precisar. O pacote deve declarar explicitamente se cobre apenas recuperação no mesmo projeto, com Auth/clients/vendedores/colors intactos. Guardar IDs referenciados não equivale a copiar todos esses objetos e dados.

Esse checkpoint deve sair do banco e ser salvo localmente, em local privado e com segunda cópia/checksum. Uma tabela de cópia dentro do mesmo banco não protege contra perda do projeto. Exportações de linhas, mesmo de todas as tabelas de negócio, não reproduzem automaticamente roles globais, senhas, extensão/configuração gerida, Auth completo, Vault, Storage binário ou configurações externas; não são um `pg_dump` completo nem uma solução demonstrada de recuperação de desastre. O SQL Editor não é um shell para executar `pg_dump` ou comandos `\copy` do psql. [Dump lógico PostgreSQL](https://www.postgresql.org/docs/17/backup-dump.html).

**Consistência:** concluir/confirmar envios, deixar o caixa sem carrinho ativo e suspender escritas durante o checkpoint final e a migração. Preferir uma única operação SELECT que monte o bundle e manifesto no mesmo snapshot, ou várias leituras em uma transação `REPEATABLE READ READ ONLY` realmente mantida no mesmo backend. Não presumir que abas ou execuções separadas do SQL Editor compartilham transação. Em `READ COMMITTED`, até SELECTs sucessivos dentro de uma transação podem ver snapshots diferentes. Sequências têm comportamento especial e exigem registro explícito se forem relevantes. [Isolamento PostgreSQL](https://www.postgresql.org/docs/17/transaction-iso.html).

**Integridade do arquivo:** incluir nomes/versão do formato, horário, contagens esperadas e marcador de conclusão; validar localmente que o JSON/CSV exportado é completo e parseável, que todas as tabelas/objetos esperados estão presentes e as contagens conferem. Não presumir que a grade do SQL Editor ou copiar o texto visível exporte tudo: verificar limites de linhas/tamanho, truncamento e timeout da interface na execução real. Se precisar dividir, estabelecer previamente um mecanismo de snapshot consistente; não gerar partes soltas enquanto a loja vende. Dados reais não devem ser colados no chat.

**Recuperação limitada precisa ser concreta:** preparar e revisar o procedimento que consome esse checkpoint e ensaiá-lo em ambiente isolado compatível antes de chamá-lo de restaurável, sem executar DELETE/TRUNCATE/DROP ou reimportação automática em produção. Um bundle JSON sem consumidor testado preserva evidência/cópia, mas não comprova capacidade de recuperação. Para o ensaio não usar integrações externas ativas.

**Decisão necessária:** o requisito anterior do pacote era backup integral com restauração comprovada. Um checkpoint limitado não atende silenciosamente esse requisito. Se Kennedy optar por prosseguir com esse alcance reduzido, explicar o que fica sem cobertura, obter autorização específica para a migração nesse cenário e atualizar juntos o roteiro e os avisos do instalador. A transação e os testes reduzem risco de instalação parcial; não tornam essa cópia equivalente a backup integral nem cobrem falha posterior ao COMMIT. A autorização atual ainda não existe.

Se a exigência continuar sendo recuperação integral, a aplicação segue bloqueada. Alternativas futuras são uma credencial dedicada de backup com privilégios revisados, ou plano/recurso de backup gerenciado; ambas exigem autorização própria e não foram criadas/contratadas. Upgrade, por si só, não demonstra que já há um snapshot recente disponível. Nenhuma dessas alternativas autoriza resetar a senha atual.

## Requisitos da rota de backup integral (atualmente bloqueada)

1. **Alvo certo e acesso já autorizado:** no Dashboard, projeto `vaidosa-sistema`, referência `ysultkzfhgtyujbomfqz`, organização `tbwshziystprxrwrebqk`. Copiar os parâmetros de Connect; não deduzir hostname de pooler pela região. Usar conexão direta ou Session pooler quando necessário por IPv4, não Transaction pooler para este trabalho. [Conexões oficiais](https://supabase.com/docs/guides/database/connecting-to-postgres).
2. **Versão compatível:** o major do `pg_dump` precisa ser igual ou maior que o major do servidor. Só temos cliente 17.11 confirmado; a versão real do servidor não apareceu nos metadados fornecidos. Não assumir compatibilidade. A documentação também não garante restaurar um dump em servidor de major anterior. [PostgreSQL pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html).
3. **Conteúdo suficiente:** schema e dados das tabelas de negócio; funções, triggers, RLS/policies, índices, constraints, sequências, grants e papéis necessários; dados de Auth referenciados por `profiles.id` e campos `created_by`; e dependências como clients, vendedores e colors. Incluir tabelas fiscais existentes mesmo que a emissão não esteja em uso. Exportar apenas vendas/pagamentos, apenas CSV, somente schema ou o JSON do app não satisfaz esse requisito.
4. **Arquivos completos e protegidos:** saída bem-sucedida sem erros ignorados, arquivos não vazios, data/hora, projeto de origem, versões e lista de arquivos registrados. Guardar SHA-256 e uma segunda cópia privada. Manter fora do GitHub público e do chat; o conteúdo inclui dados pessoais e pode incluir material sensível de autenticação.
5. **Restauração realmente executada:** reconstrução em alvo isolado compatível, sem apontar o app da loja para ele, sem serviços externos de email/webhook/Nuvemshop ativos; log final sem erros ignorados. Arquivo presente, checksum ou `pg_restore --list` sozinho não demonstram restauração.

## Rota integral Supabase como alternativa futura

O procedimento oficial separa `roles.sql`, `schema.sql` e `data.sql`. O CLI aplica filtros próprios para estruturas/papéis geridos pela plataforma; um dump bruto do `pg_dump` pode exigir adaptação ao restaurar em Supabase. Não tratar esses dois formatos como intercambiáveis sem ensaio. [Restauração em ambiente Supabase](https://supabase.com/docs/guides/self-hosting/restore-from-platform).

Para o operador, os três modos são: `--role-only`, schema padrão, e `--data-only --use-copy`. **Confirmar primeiro a sintaxe da versão instalada:** o guia atual mostra `--remote`, enquanto a referência CLI mostra `--db-url`; não copiar cegamente uma flag. Docker/daemon precisa funcionar para a rota CLI documentada. Sem isso, escolher e testar explicitamente outra rota; não instalar ou mudar credenciais às escondidas. [Guia backup/restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore), [referência CLI](https://supabase.com/docs/reference/cli/introduction).

O destino deve ter extensões e estruturas geridas compatíveis. Verificar que os dados necessários de `auth.users` e tabelas relacionadas foram incluídos/restaurados; não presumir pela existência de `data.sql`. Customizações em `auth`/`storage` e histórico `supabase_migrations`, se usados, exigem cobertura específica. Se houver Vault ou colunas criptografadas, seguir o procedimento oficial de chaves para aquele destino antes de chamar o backup de restaurável. Não compartilhar essas chaves no chat.

Objetos binários do Storage, configurações de provedores Auth, SMTP e código/configuração de Edge Functions não são substituídos por um dump do banco. Registrar essas dependências separadamente, sem ampliá-las para uma migração agora. [Limites do backup de banco](https://supabase.com/docs/guides/platform/backups).

## Prova de restauração

Usar somente o destino de ensaio. Com SQL plain, restaurar com parada em erro e transação única conforme o guia oficial; com archive custom, usar `pg_restore` e parada em erro. **Não usar `--clean`, DROP, TRUNCATE nem um comando apontando para produção neste roteiro.** [PostgreSQL pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html).

No ensaio, comparar com o manifesto do snapshot: contagens por tabela, totais agregados de vendas/pagamentos/estoque e presença dos objetos necessários. Verificar vínculos entre sale_items/sale_payments e sales, produtos/clientes/vendedores e referências a auth.users; conferir que constraints e triggers estão habilitados e que policies/grants equivalem aos originais. Ensaiar a migração e testes somente nessa cópia, mantendo a cópia anterior intacta.

A evidência mínima a compartilhar pode ser apenas: projeto, horário do backup, formatos, checksums, versões, destino isolado, restauração concluída sem erros e verificações aprovadas — sem linhas reais, credenciais ou dump. Para a aplicação, obter snapshot final recente em janela sem escritas concorrentes. Se a loja continuou operando depois do backup, documentar essa diferença; restaurá-lo integralmente poderia perder lançamentos posteriores.

## Ordem manual após a decisão de proteção e autorização específica

Antes de usar esta ordem, satisfazer o requisito integral do pacote ou formalizar a alternativa limitada acima com aceite explícito e documentação/instalador coerentes. Não interpretar o roteiro como autorização para executar agora.

Arquivos vigentes em `vaidosa-financeiro-integrado-2026-11-04/`; a revisão exata e a base auditada estão em `REVISAO.txt`:

1. Executar `01_preflight.sql` (somente metadados) no projeto correto. Exigir as quatro funções/assinaturas esperadas, sem linhas extras, todas com `igual_ao_export_auditado=true`. Divergência exige comparação, não sobrescrita automática. Confirmar `vaidosa_private` fora dos schemas expostos e ausência de carrinhos/envios em andamento.
2. Após autorização de implantação do banco, executar `02_instalar_transacao.sql` inteiro uma vez. O pacote reúne três migrações em um BEGIN/COMMIT, com lock timeout de 5s e statement timeout de 60s. Não executar também as migrações individuais. Em resultado incerto, conferir o estado antes de repetir.
3. Executar `03_pos_instalacao.sql`: primeira linha toda verdadeira; quatro RPCs com acesso esperado; dezesseis combinações de oito tabelas/papéis sem privilégios administrativos. “Success” sozinho não basta.
4. Só então publicar **os cinco arquivos da revisão financeira integrada sobre `931b28c`**, preservando os três `cart-draft-*.js`. **Não publicar `frontend/index.html` do pacote antigo sobre o site atual:** ele antecede a proteção do carrinho. O commit integrado consta em `REVISAO.txt`; os testes e seus limites, em `RELATORIO-INTEGRACAO.md`.

A migração reduz permissões em oito tabelas (sales, sale_items, sale_payments, products, stock_moves, store_settings, profiles, nfce_emissions). Não é somente uma nova tela. O roteiro precisa usar a interface compatível com as RPCs e manter as proteções fiscais existentes.

## Rollback sem apagar dados

Antes do COMMIT, falhas revertem a transação. Depois dele, suspender a interface de edição financeira e preparar correção progressiva; preservar histórico, revisão e registros de requisição. Se a falha envolver funções/triggers de outros fluxos, suspender também essas operações. Não restaurar acesso anônimo às RPCs ou o fallback inseguro, nem remover tabelas de auditoria.

O frontend de referência publicado é `931b28c`, mas não deve ser reposto integralmente após a migração: retomaria pagamentos sem UUID e o fallback de exclusão incompatível com os novos grants. Manter o carrinho e os novos handlers de recebimento/exclusão ao desabilitar a correção financeira. Restauração integral de backup em produção seria uma ação separada, autorizada e planejada, com reconciliação de vendas posteriores. Não é rollback automático e não deve ser usada para desfazer uma única correção financeira.
