# Recuperação direcionada pelo SQL Editor — roteiro privado

Estado conhecido: Free sem backups nativos; senha PostgreSQL desconhecida. Não pedir nova conferência nem reset. O SQL Editor já autenticado é a rota de leitura/aplicação manual pelo próprio operador. Este roteiro não usa o acesso remoto negado ao agente.

## Cobertura e decisão

A proposta é guardar fora do banco uma cópia coerente dos dados e definições afetados pela migração e ensaiar sua leitura/recuperação específica. Não é backup completo do projeto. A instalação financeira continua pendente e depende de aceite explícito dessa cobertura reduzida, da conferência do checkpoint real e de autorização específica para migrar/publicar.

A migração não recalcula saldos nem executa INSERT/UPDATE/DELETE/TRUNCATE nas linhas de negócio durante a instalação. Os comandos de escrita estão nos corpos das funções para uso futuro. Nas vendas antigas, a mudança lógica é a coluna finance_revision com default zero. Substitui quatro funções, cria auditoria/requisições/revisão e reduz permissões. Antes do COMMIT um erro reverte o conjunto. Depois do COMMIT, a transação não oferece um botão de desfazer: correção progressiva é preferível.

## Arquivos e exportação pelo usuário

1. Separar uma pasta privada fora do repositório e do chat. O resultado pode conter CPF, contatos, emails de profiles, observações e XML fiscal. Não enviar para chat, Library, GitHub, preview público ou auditoria de metadados. O pacote entregue contém somente a consulta/verificador e fixtures fictícias, nunca um checkpoint real.
2. Combinar uma janela sem escritores: caixas, pagamentos, edição de vendas, estoque, integrações, jobs e requisições incertas. Parar somente vendas novas não basta. Não modificar políticas/credenciais para simular essa pausa. Se não houver como controlar escritores, interromper o plano e avaliar outra janela/rota.
3. No projeto Vaidosa correto (ysultkzfhgtyujbomfqz), executar **00_checkpoint_somente_leitura.sql inteiro** no SQL Editor. É um único SELECT, sem criar tabela, alterar RLS, função ou dado. Todas as tabelas/metadados são lidos no mesmo snapshot. O retorno possui uma linha com checkpoint_json, bytes e md5. Não dividir a consulta ou juntar exports obtidos enquanto ocorrem escritas.
4. Usar a opção de baixar CSV do resultado completo para a pasta privada. Não copiar a prévia/célula exibida no painel como se fosse o arquivo integral. Erro/timeout, limite de tamanho, ausência de linha ou download incompleto não produzem checkpoint utilizável. Não tratar CSV parcial como backup.
5. No próprio computador, executar o verificador sem rede:

   `python3 "00_validar_checkpoint.py" "/caminho/privado/checkpoint.csv"`

   Ele só imprime validade, contagens e limites, nunca linhas, identificadores, nomes, caminho ou trechos do arquivo. Aceita o envelope CSV; JSON simples sem tamanho/hash é recusado. Exige UTF-8, tamanho em bytes e MD5 exatos, 11 tabelas, colunas/contagens coerentes, cinco funções, RLS não filtrando o executor e ausência dos objetos da nova migração. Também exige o inventário ambiental/metadados. MD5 detecta alteração/truncamento acidental; não autentica a origem.
6. Se retornar valid=false: **parar**, preservar o arquivo privado e diagnosticar localmente. Não enviar o conteúdo ao chat. Se retornar true: guardar segunda cópia privada, registrar projeto, horário, número de linhas, resultado e origem. Isso valida integridade/formato declarado, não certifica restauração do projeto. Conferir também o 01_preflight.sql e as assinaturas/hashes antes de instalar. O JSON não prova sozinho qual projeto do Dashboard foi selecionado.
7. Antes de uma migração autorizada, revisar o inventário real (event triggers, ACLs e alterações desde o export auditado). O processo de recuperação deve considerar esses objetos. Se ocorrer qualquer escrita entre checkpoint e instalação, a cópia pode precisar ser renovada. Não usar apenas auditoria vazia/revisão zero como prova de ausência de operações.

## Conteúdo e exclusões

Dados completos de sales, sale_items, sale_payments, products, stock_moves, profiles, store_settings, nfce_emissions e dependências clients, vendedores, colors. Inclui definições de colunas/defaults/constraints/índices/triggers/policies, RLS, proprietários e ACLs de tabela/coluna; cinco funções (quatro substituídas e set_updated_at), seus owners/ACLs/configurações; roles sem senhas, memberships, default ACLs, event triggers e flags do schema privado/objetos novos.

Não exporta auth.users, senhas/tokens, demais schemas/tabelas, estado de sequências, arquivos Storage, chaves/Vault, configurações externas ou código de Edge Functions. Profiles/created_by continuam dependentes do Auth existente. O arquivo sozinho não permite reconstruir um projeto vazio nem recuperar perda integral do serviço. Cópia dentro do próprio banco não substitui este arquivo externo. Exportar dados da venda isolada também não cobre a mudança das funções/grants compartilhados.

## O que foi ensaiado localmente

A consulta é executada sobre o schema reconstruído dos metadados fornecidos, em PostgreSQL descartável, com ao menos uma linha fictícia em cada uma das 11 tabelas, incluindo valores monetários, datas, JSONB, nulos, acentos e quebras de linha. O verificador testa truncamento, encoding, contagens e campos obrigatórios. O roundtrip reconstitui os registros em 11 tabelas temporárias com os tipos originais e compara os valores; após a migração, recompõe as cinco definições originais dentro de uma transação local que é revertida.

Isso não é restauração integral de produção, não restaura automaticamente ACLs/owners/policies, não reconstrói Auth e não prova saldos históricos reais. Os scripts tests/* são exclusivamente para o cluster de ensaio e NÃO devem ser executados no SQL Editor de produção. Não existe neste pacote um restaurador automático de produção, DROP/CASCADE/TRUNCATE ou reposição cega de permissões vulneráveis.

## Sequência posterior, ainda dependente de autorização

Checkpoint real validado e cobertura limitada aceita → preflight sem divergências e pausa dos escritores → autorização explícita → 02_instalar_transacao.sql inteiro → 03_pos_instalacao.sql conferido → publicar os cinco arquivos do frontend integrado. Não aplicar simultaneamente as três migrações individuais. Sem publicação antecipada nem venda fictícia em produção.

Para falha só da interface, desabilitar a edição financeira mantendo carrinho e os novos handlers de recebimento/exclusão. Se a falha estiver nas funções/triggers, suspender também operações afetadas e preparar correção progressiva. Não voltar cegamente ao frontend 931b28c após os novos grants. Depois de qualquer escrita, recuperação exige reconciliar alterações posteriores; preservar auditoria, revisões e IDs de requisição. Backup completo é uma alternativa de maior cobertura, não um requisito absoluto imposto a esta rota limitada — e não foi realizado.
