# Revogação compartilhada — preparação isolada

Esta etapa estende o perfil JWT offline de `fc356b2`. Não ativa MCP, OAuth, identidade, banco ou permissões reais. `tests/sql/mcp_revocation_fixture.sql` é infraestrutura de teste para um banco descartável específico, **não uma migração de produção**. A assinatura é validada por JOSE 6.2.15; chaves, emissor, usuários e concessões continuam fictícios.

## Contrato e fronteiras

- `createSharedJwtVerifier` exige uma porta de leitura de revogações. Não permite autorização local como alternativa quando essa porta falha. O verificador local anterior mantém seu contrato para consumidores offline.
- `createSharedRevocationStore` recebe portas explícitas; não abre conexão, descobre URLs, lê ambiente, guarda JWT nem executa SQL. Cada consulta usa um nonce e valida namespace, incarnation e revisão inteira não decrescente observada. Não há cache positivo de autorização.
- Namespace deriva do emissor e recurso configurados pelo operador. Token, usuário e chave recebem identificadores SHA-256 separados por namespace/tipo. Esses hashes são pseudônimos; não equivalem a dados anônimos.
- A porta de leitura só consulta `check_state`. Uma porta administrativa separada pode executar `record/lookup`. Ela não é uma ferramenta MCP e não é entregue ao servidor de leitura. As funções SQL fictícias conferem SESSION_USER, banco, cluster e incarnation e não concedem acesso direto às tabelas.
- `requireVerifiedPrincipalAsync` revalida prova local, estado compartilhado e prova local novamente. O boundary verifica antes/depois dos grants; service, adapter, gateway e executor verificam antes/depois dos dados, inclusive páginas em cache. `requireVerifiedPrincipal` síncrono sozinho permanece apenas uma prova local. Novos consumidores compartilhados devem usar o caminho assíncrono.
- `listTools` mantém resultado síncrono no perfil local e retorna Promise no perfil compartilhado; consumidores desse perfil precisam aguardar o resultado. O transporte HTTP existente já o aguarda. O stdio legado continua fixture separada; não comprova essa integração assíncrona.
- `revokeToken/revokeSubject/revokeKey` do controlador local continuam **locais**. Revogação compartilhada exige `record/lookup` no escritor administrativo separado.

## Escrita, concorrência e resultado incerto

O chamador deve guardar uma intenção imutável `{requestId, kind, target, cutoff}` antes de enviá-la. `requestId` é um UUID da operação, separado de qualquer JTI. Reutilizar a intenção em uma tentativa usa o mesmo UUID e conteúdo.

Na fixture PostgreSQL, advisory lock do UUID e lock da linha de namespace serializam operações. Tombstone, revisão e journal entram na mesma transação. O mesmo UUID/conteúdo retorna replay; conteúdo diferente é recusado. Cutoff de usuário nunca diminui. Tombstones de token/chave não expiram nem são removidos automaticamente.

`applied/replayed` só é devolvido depois de confirmar o término bem-sucedido da transação. Falta de confirmação retorna `uncertain`; isso não confirma nem desfaz a revogação. `lookup` usa a mesma intenção e lock. `not_found` não prova que uma chamada atrasada nunca chegará: o próximo envio deve manter o mesmo UUID/conteúdo. Não há retry automático nem geração de outra intenção.

Cada instância admite até oito consultas pendentes e prazo de 1 s. Timeout/abort não libera a vaga enquanto trabalho que ignorou cancelamento não terminou. A porta fictícia limita SQL a 800 ms, lock a 500 ms e processo a 900 ms. Erros não contêm token, claims, consulta ou dados de negócio.

## Semântica e limites

A revogação lineariza no COMMIT. Uma nova checagem iniciada depois do COMMIT observa o estado confirmado; uma checagem iniciada antes pode ler o snapshot anterior. Checagens antes/depois retêm respostas se perceberem revogação durante grants/dados. Não há cancelamento retroativo de operação concluída ou recolhimento de dados entregues. Não foi combinada a consulta de negócio e o registro de revogação em uma única transação distribuída.

Indisponibilidade, perda de permissão, epoch incorreta, resposta atrasada, estrutura inesperada e revisão inferior causam negativa. A falta de confirmação de uma escrita não significa que todos os leitores já estejam bloqueados: só o estado confirmado é autoritativo.

Os limites da fixture são 128 tombstones e 256 eventos por namespace. Exaustão confirma `disabled` no banco, bloqueando leitores em vez de esquecer revogações. Não há desbloqueio/limpeza automática; operação real exigirá política explícita de retenção, capacidade e recuperação.

Durabilidade significa preservação no **mesmo datadir/cluster/incarnation efêmero** durante reinício do PostgreSQL ou de processos Node. O scratch inteiro é removido ao terminar. Isso não é serviço persistente, backup, recuperação de desastre nem garantia contra restauração administrativa antiga. Nonce e maior revisão observada por processo não detectam todo rollback de snapshot após reiniciar todas as instâncias. Uma solução real precisa recuperar estado, tombstones e journal de forma coerente e estabelecer nova incarnation/invalidação de tokens quando apropriado, sem prometer recuperação já implementada.

## Validação e futura ativação

Os casos em `tests/support/shared-revocation-cases.cjs` usam PostgreSQL real descartável e JOSE com chaves em memória. Cobrem duas instâncias, novo processo, restart do banco, concorrência/replay, perda de confirmação após COMMIT, rollback por falha parcial, cutoff, revogação durante grants/dados, perda de permissão/indisponibilidade, segregação de papéis, limite/lockdown e respostas antigas. O relatório externo registra o resultado terminal e os hashes efetivamente ensaiados.

Execução somente pelo supervisor contido aprovado: rede negada, fonte/toolchain somente leitura, ambiente mínimo, scratch limitado, limites CPU/RAM/PID/arquivos/tempo e destruição do contêiner pelo supervisor externo. Não executar diretamente no Mac ou contra Supabase.

Antes de qualquer ativação futura faltam decisões e autorização específicas de emissor/chaves reais, serviço administrativo, mapeamento confiável usuário/fonte, concessões, transporte, recuperação/retenção/monitoramento e ambiente operacional. Nenhum cliente Codex/Claude real foi configurado/testado nesta etapa. Navegador real continua pendente e não foi iniciado.
