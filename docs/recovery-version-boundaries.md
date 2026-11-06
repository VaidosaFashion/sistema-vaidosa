# Recuperação necessária antes do bundle mutante

Este documento delimita a preparação existente. Não executa captura, restauração,
migração ou publicação. O adapter MCP mock é independente desse bundle e não precisa
alterar o banco para funcionar com fixtures.

## O que já foi ensaiado

O exportador/verificador/recuperador externo de contas foi ensaiado em PostgreSQL
17.11 descartável com dados fictícios: **24 casos + grupo principal = 25 registros
aprovados**. Captura dados de `categorias`, `contas` e `movimentacoes` com catálogo
delimitado de colunas/defaults, constraints, índices, triggers, RLS/policies,
owners/ACLs, schemas, funções selecionadas, cinco roles/memberships diretos/default
ACLs e inventário de event triggers. Não é backup completo de projeto/Auth.

Verificador limitado a 8 MiB; recuperador a 1 MiB. A restauração importa somente nas
três tabelas **vazias e com schema compatível preexistente**; não executa DDL capturado,
não reconstrói Auth/roles/dependências transitivas e não é rollback de produção.
`clients` e `auth.users` e as referências necessárias devem preexistir. Checksums
detectam corrupção/truncamento; não autenticam sozinhos projeto/origem.

Metadados reais de contas/movimentos foram obtidos posteriormente por leitura
autorizada e confirmam pontos de compatibilidade/permissão; não houve captura nova
de linhas reais ou prova de recuperação do bundle novo. Os avisos históricos dos
contratos sobre ausência de metadata descrevem sua data original. Um preflight
atual ainda é obrigatório antes de qualquer instalação futura.

## Cobertura adicional exigida pela versão nova

Uma cópia coerente e privada compatível com `20261105_install_blocks.sql` precisa
preservar, além das três tabelas antigas:

- `contas.operation_revision/archived_at`, `account_revision_guard` e helper privado;
  colunas, CHECKs/uniques, identificador de operação e reversão de `movimentacoes`.
- Dados e definições de `public.account_audit`,
  `vaidosa_private.account_requests` e `vaidosa_private.stock_entry_requests`.
  Histórico e UUID/payload/autor são essenciais à idempotência, não lixo descartável.
- View `v_contas` (ordem/projeção/security_invoker), RPCs/helpers públicos e privados
  de contas/estoque, owners, grants de schema/tabela/coluna/função, policies e triggers.
- Dependências efetivas de `profiles`, `auth.uid`/`auth.users`, `clients`, `categorias`
  e referências de estoque. Após entradas novas, `products` e `stock_moves` devem
  corresponder ao ledger no mesmo ponto de captura.
- Objetos financeiros preexistentes no schema privado devem ser preservados. Nunca
  recriar/remover o schema privado inteiro como atalho.

O ensaio antigo não cobre esses objetos novos. Antes da instalação é necessário
preparar captura/recuperação da versão pretendida, validar integridade/contagens/
limites e ensaiar dependências em cópia descartável. Arquivos reais ficam privados
no computador do usuário, sem envio de dados pessoais/CPF/segredos ao chat.

## Gates e retorno operacional

1. Comparar HEAD remoto e preflight atual, sem sobrescrever mudanças; conferir
   `vaidosa_private` fora dos schemas expostos e consumidores externos.
2. Ter recuperação privada coerente e ensaio compatível com o bundle/versão, com
   limites/cobertura aceitos. Checkpoint antigo não é garantia para objetos novos.
3. Obter autorização específica; pausar todos os escritores/integrações, conferir
   comandos incertos e preservar carrinhos. Clientes antigos usam DML removido.
4. Ensaiar instalação e pós-checagens em banco descartável com fixtures; depois
   aplicar transação e frontend compatível apenas na janela autorizada.
5. Validar metadados/contagens/totais sem criar transação real de teste. Retomar com
   operador conferindo uma operação que já precisasse realizar.

Antes de COMMIT um erro reverte a transação. Depois de novas operações não restaurar
snapshot anterior perdendo eventos, não remover auditoria/ledgers e **não voltar o
frontend completo para 502e33d**: ignora reversões e tenta escrita direta retirada.
Pausar escritas e corrigir à frente mantendo revisão/UUID/histórico. Uma recuperação
real exige conciliar eventos posteriores e autorização específica; não há botão
automático de desfazer nem script destrutivo proposto.

Referências versionadas: [contrato de contas](accounts-contract.md),
[estoque](stock-contract.md), [implantação](blocks-deployment.md) e bundle
`supabase/releases/20261105_install_blocks.sql`. O relatório independente externo
`REVIEW-decisions-recovery.md` registra a conferência de cobertura desta rodada.
