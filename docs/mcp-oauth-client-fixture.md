# Ensaio OAuth do cliente — somente fixtures

Preparação sobre `0b854e3`, validada somente em ambiente contido com identidades e respostas fictícias. Não implementa nem ativa um servidor de autorização. SDK oficial MCP `@modelcontextprotocol/client@2.4.0` e `core@2.4.0` (Apache-2.0), `pkce-challenge@5.0.1` (MIT) e JOSE `6.2.15` (MIT). Versões fixadas, sem declaração de que continuarão sendo as mais recentes em futura ativação.

**Resultado: 135/135 registros de teste aprovados** — 17 cenários OAuth, seu grupo e 117 regressões anteriores. O bloqueio anterior por conteúdo local incompleto foi resolvido obtendo somente `zod@4.6.7` do registro oficial npm, conferindo SHA-512 do lockfile e os 259 arquivos esperados por SHA-256. Todos os 389 arquivos do runtime combinado foram conferidos. Nenhum hook ou instalação global; dependências de ensaio não foram acrescentadas ao bundle de produção. `tests/fixtures/oauth-sdk-runtime.json` registra versões, integridade e arquivos; o relatório externo registra controles, hashes e resultado terminal.

## Componente e escopo

`tests/support/oauth-session-fixture.cjs` é uma fixture de aplicação para correlacionar callback/sessão e chamar `startAuthorization/exchangeAuthorization` do SDK. O SDK gera PKCE e constrói/executa a troca; `pkce-challenge` confere PKCE no mock. Não se implementou criptografia nem servidor OAuth próprio.

Os únicos endpoints possíveis usam `.invalid` e são fixos. O endpoint de token é uma função injetada em memória que retorna respostas finitas; não há listener, HTTP real, discovery, registro de cliente, consentimento, login, concessão ou provedor externo. O cliente fictício é público e não possui secret.

A correlação mantém uma tentativa por instância, por até dois minutos: estado aleatório gerado com a primitiva padrão Node, sessão fictícia explícita, retorno exato, emissor fixo e consumo antes do primeiro await de troca. Duplicatas de parâmetros e callbacks repetidos/concomitantes são rejeitados. Cancelamento, relógio regressivo e vencimento invalidam a tentativa. Troca incerta/timeout não é repetida automaticamente: exige nova autorização fictícia. Trabalho que ignora cancelamento mantém a vaga ocupada até terminar.

O endpoint recebe `resource` na autorização e na troca, escopos somente de leitura, PKCE S256 e redirect fixo. O simples envio de `resource` **não comprova audience**: o teste valida o token retornado com JOSE e o perfil JWT existente, incluindo assinatura, issuer/audience e consistência de escopos. As chaves de assinatura são geradas somente em memória durante os testes.

O verificador de token é uma porta explícita e confiável da fixture. O resultado externo é apenas `{fixture: true, authorized: true}`: tokens, código, verifier, state e claims não são retornados nem gravados em log. Esta etapa usa o verificador local offline; não se declara que o OAuth esteja conectado a um serviço real de revogação/banco. A regressão de revogação compartilhada permanece separada e é executada junto.

## O que os testes demonstram

`tests/mcp-oauth-client.test.cjs` executou esses cenários com respostas em memória: request PKCE/state/resource/redirect, troca válida e assinatura, tentativas novas, state/sessão/issuer incorretos, callback alterado, autorização negada, consumo e concorrência, expiração/relógio, respostas inválidas, escopos extras, audience/issuer/assinatura falsos, PKCE incorreto, redirect de token, timeout e rede padrão bloqueada. O relatório externo contém resultado terminal, hashes, revisão estática independente e estado da VM.

Somente no supervisor com os controles já aprovados: rede negada, fonte/toolchain/rootfs somente leitura, ambiente mínimo, scratch e limites CPU/RAM/PID/arquivos/tempo. Não executar diretamente no Mac, no Supabase ou com endpoints reais. As dependências pertencem ao ensaio isolado; não foram adicionadas ao bundle de produção ou à configuração de clientes reais.

## O que falta antes de uma integração real

Para reproduzir somente o ensaio, recuperar a cópia completa do runtime versionado e conferir todos os arquivos contra o manifesto. Não usar stubs, versões flutuantes ou scripts de instalação. Executar somente na mesma contenção aprovada, não diretamente no Mac nem contra endpoints reais. O pacote externo inclui os bytes ensaiados e a evidência da aquisição, sem credenciais reais.

1. Selecionar serviço de autorização consolidado, com suporte verificado a authorization code + PKCE S256, issuer response e audience/resource exigidos pelo recurso. A implementação do AS não é objetivo desta fixture.
2. Definir cliente público/confidencial, cadastro real de callbacks e origens, descoberta confiável, consentimento e escopos por usuário/fonte. Não aceitar esses vínculos do modelo.
3. Implementar armazenamento operacional seguro das tentativas/sessões, correlação com o usuário autenticado, proteção de cookies/callback, segredo de cliente somente se o tipo exigir, chaves/JWKS e políticas de rotação/revogação/recuperação.
4. Integrar a identidade verificada com o boundary/gateway e grants reais minimizados; validar revogação compartilhada operacional, auditoria e falha fechada. Nunca usar o MCP administrativo Supabase como gateway de negócio nem fornecer SQL arbitrário ao modelo.
5. Autorizar especificamente credenciais, acesso, rede e configuração; então testar um ambiente de homologação e versões concretas de Codex/Claude. Nenhum cliente real ou navegador foi aberto neste ensaio.

Não há promessa de servidor OAuth pronto, conformidade integral, proteção de sessões/cookies reais, discovery, registro dinâmico, refresh, DPoP, multi-instância de tentativas ou interoperabilidade automática com aplicativos.

O caso de resposta 307 comprova somente a recusa da resposta simulada. Não é prova da política de redirects de fetch/browser real. Antes de conectar um transporte real, é necessário fixar/conferir essa política e ensaiá-la em homologação autorizada. Nesta etapa, o isolamento do sistema operacional mantém a rede negada independentemente do mock.

Referências primárias: [autorização MCP 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [PKCE — RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.html), [identificação do emissor — RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html). Consultadas em 06/11/2026; as APIs efetivas foram conferidas no SDK versionado local.
