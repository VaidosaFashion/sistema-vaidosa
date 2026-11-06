# Integração MCP por HTTP privado — ensaio isolado

Base `43c4a81`, branch `prepare/mcp-e2e-fixture-20261106`. Resultado: **141/141 testes da suíte MCP/PostgreSQL aprovados**, incluindo seis cenários integrados novos e 135 regressões anteriores. Não autoriza instalação, publicação, identidade real ou alterações de produção.

## Percurso e contratos preservados

O cliente oficial MCP/core `2.4.0` conversa por mensagens HTTP reais com um servidor Node efêmero. Cliente e servidor executam no mesmo processo de ensaio, atravessando o socket do sistema operacional; o reinício testado recria listener, handler e verificador, não um processo remoto. A conexão usa somente o socket Unix `/scratch/mcp-http.sock`, com modo 0600, no mesmo contêiner com `network=none`. Não há listener TCP, DNS ou TLS. O adaptador de fetch aceita apenas duas autoridades `.invalid` fixas e as traduz para esse socket; não é um proxy genérico ou transporte para uso público.

O servidor encaminha as mensagens ao `createStreamableHttpHandler` já existente. O boundary valida JWT ES256 com JOSE `6.2.15` e checagens de revogação compartilhadas no PostgreSQL privado. O serviço usa os contratos e adaptadores anteriores: principal comprovado → planos finitos → gateway → executor → função de projeção e RLS → DTO2. Nenhum SQL, role, fonte, URL ou filtro de autorização é escolhido pelo modelo.

O endpoint de autorização é uma fixture finita no servidor de teste: um ator fictício previamente escolhido é tratado como autenticado. SDK gera o pedido/PKCE e realiza a troca; `pkce-challenge 5.0.1` verifica o desafio; JOSE assina o token em memória. Não existe implementação de login, consentimento ou AS de produção. Callback e state são conferidos pelo coordenador de teste, sem navegador/cookie real.

Grants de aplicação e vínculo usuário/fonte são fixtures explícitas. O executor de teste mapeia principal comprovado para papéis efêmeros, e PostgreSQL confere SESSION_USER, fonte, grants e RLS. Isso testa a composição, sem demonstrar mapeamento criptográfico/credenciais operacionais de um serviço real. Não foi inventada coluna store_id no schema comercial.

As fronteiras de domínio, gateway, identidade e transporte não foram duplicadas ou reescritas. Este delta contém apenas infraestrutura/cenários de teste e documentação. O escritor de revogações permanece administrativo e separado das cinco ferramentas somente leitura. Não há ferramenta de mutação ou SQL arbitrário.

## Cenários integrados

O módulo `tests/support/mcp-e2e-cases.cjs` reutiliza o cluster, schema reconstruído, migrações preparadas e dados fictícios de `tests/mcp-postgres.test.cjs`. Não inicia outro banco nem depende do Supabase real.

1. Handshake oficial, pedido/troca de código fictícios com PKCE e JWT, cinco leituras reais de PostgreSQL e paginação/DTOs mínimos.
2. Segunda identidade com escopo de cliente, impossibilidade de reutilizar cursor alheio e recusas explícitas de ferramenta financeira/SQL.
3. Mudança de grants do banco invalidando uma página já materializada pelo HTTP.
4. Revogação confirmada no banco negando cliente já conectado antes de ler dados; token novo reutiliza o mesmo serviço com prova atual.
5. Barreira durante leitura efetiva do banco: uma revogação confirmada antes da liberação retém a resposta ao cliente. A negativa não tem código exclusivo de revogação; não prova causa exclusiva ou cancelamento retroativo.
6. Reinício do servidor HTTP/verificador, preservando revogação no mesmo banco, aceitando identidade nova e conferindo ausência de mudanças em sete tabelas comerciais e uma sequência.

Os negativos exigem eventos do servidor com status/códigos permitidos; simples erro de transporte não basta. Telemetria limitada guarda somente status, código RPC, classe de erro de autorização e código de erro de ferramenta, sem corpo, tokens, argumentos ou IDs pessoais. Reuso do serviço é contado. A barreira tem prazo e liberação em finally para não prender limpeza após falha de asserção.

Fingerprint cobre sales, products, contas, sale_payments, sale_items, stock_moves, movimentacoes e product_barcode_seq. Não é auditoria de todas as tabelas ou backup. Registro de revogações e códigos/tokens fictícios em memória mudam intencionalmente durante o teste.

Os 141 testes pertencem à suíte MCP/PostgreSQL desta linha. Testes DOM/layout e a suíte financeira inteira não foram reexecutados nesta rodada; código comercial e interface não foram alterados. Esse resultado não demonstra paridade com o banco atual de produção.

## Contenção e reprodução

Nenhuma dependência ou exceção nova. Runtime oficial completo de 389 arquivos foi recuperado do pacote anterior e conferido por hashes. Servidor e cliente só podem escrever no scratch; fonte/rootfs/toolchain somente leitura, ambiente mínimo, CPU/memória/PID/arquivos/disco/tempo limitados e supervisor externo encerrando todo o contêiner antes de reter resultados. A rede externa permanece negada durante todo o alvo; materialização do arquivo de software ocorreu fora dele pela rota autorizada da Library.

Executar somente pelo runner e supervisor já aprovados. Não rodar esse servidor diretamente no Mac, expor porta, trocar URLs ou apontar o executor para um banco real. O pacote não é instalador público.

## Gates restantes

- MCP real: escolher AS consolidado, registrar cliente/callback/origens, definir identidade e fonte confiáveis, grants mínimos, chaves/JWKS e revogação/recuperação operacionais. Validar TLS, ingress, redirect e clientes Codex/Claude em homologação autorizada. Não aceitar pedidos extras do GitHub App como atalho; este ensaio não depende deles.
- Banco/implantação: comparar schema atual ao bundle exato, obter captura privada coerente e validar a recuperação específica de tabelas, ledgers, auditoria e dependências antes de migrar. Os ensaios anteriores de recuperação são limitados; não constituem backup integral. Preflight, janela sem escritores, transação, pós-checagens e recuperação pós-COMMIT continuam gates próprios, sem rollback destrutivo automático.
- Interface: navegador real continua pendente no ambiente atual. Não houve novo lançamento, probe, alteração de sandbox ou exceção. DOM/estrutura podem apoiar regressão, mas não comprovam layout/renderização nativa. Um executor de navegador adequado teria de comprovar os controles completos antes de uso; sua disponibilidade não foi demonstrada nesta rodada.
- Produção: nenhum dado real, captura, credencial, concessão, OAuth externo, gateway público, push, publicação ou migração foi realizado. Fixture testada não equivale a serviço pronto para ativação.

Documentação relacionada: [arquitetura](architecture.md), [contas](accounts-contract.md), [estoque](stock-contract.md), [relatórios](reporting-contract.md), [gateway PostgreSQL fictício](mcp-postgres-fixture.md), [JWT](mcp-jwt-offline.md), [revogação](mcp-shared-revocation.md), [cliente OAuth fictício](mcp-oauth-client-fixture.md) e [implantação dos blocos](blocks-deployment.md).
