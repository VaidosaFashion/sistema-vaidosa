# Preparação adicional — NÃO VALIDADA EM EXECUÇÃO

Base e último pacote testado: `d4396796d4936be49d18c5e6e30537e6836a558c` (220 testesJS e suiteSQL local anteriores). Esta branch adicional altera transporte/contratos MCP, prepara navegador interativo e reforça guard SQL. Os logs em `docs/validation/` continuam pertencendo à base, não a estas alterações.

## Evidência desta etapa

- Inspeção estática, `node --check` dos arquivos novos (somente parsing, sem carregar aplicação/build/fixtures) e verificação de whitespace Git.
- Revisão independente de fonte, com relatório externo ao repositório. Leads, limites, gaps e estado formal da auditoria estão explícitos; ausência de achado confirmado não significa ausência de defeitos.
- 24 casos novos HTTP, concorrência/cancelamento/DTO, ensaio de privilégios herdados e controlador de fluxos no Chrome **preparados, não executados**. Não há nova contagem de testes aprovados nem captura de tela/fluxo aprovada.

## Bloqueio e controles faltantes

A skill [security-audit](</Users/kennedyrodrigues/.codex/skills/security-audit/SKILL.md>) exige: “If every control cannot be enforced, do not execute target code”. A checagem de sandbox macOS aninhado falhou `sandbox_apply: Operation not permitted` (código71). O único probe externo seguinte abortou Node com código134, sem carregar o alvo. Não foram repetidos probes nem utilizado outro caminho para executar o alvo.

Não há ambiente já autorizado **demonstrado** com todos estes controles:

1. alvo e ferramentas somente leitura por isolamentoOS;
2. rede externa negada peloOS; se necessário tráfego cliente/servidor, namespace loopback exclusivo, sem sockets/serviços compartilhados;
3. ambiente iniciado vazio com allowlist, HOME/TMP/caches exclusivos e nenhum segredo do host;
4. escrita somente no scratch atribuído, sem acesso a arquivos de outros agentes, credenciais, ambientes ou diretórios retidos;
5. limites efetivos de CPU, memória, processos, tamanho de arquivo, disco e tempo total para Node/build/Chrome/PostgreSQL e descendentes;
6. encerramento de todo o processo/job e promoção confiável dos poucos resultados permitidos, com limites e verificações no-follow/identidade quando aplicável.

Preloads JS, CSP, flagsChrome, mocks, timeouts internos ou um objeto declarando controles não substituem a imposição peloOS.

## Menor próximo passo seguro

Disponibilizar um worker/VM/container descartável **previamente aprovado e verificado** com esses controles e as ferramentas já necessárias; montar uma cópia do commit a testar como readonly, sem configurações/segredos, e um único scratch gravável. Não usar produção, sessão de navegador existente, host loopback ou nova credencial para testar. Primeiro o supervisor confiável comprova os limites sem executar o alvo. Depois executa os testes HTTP em memória (não exigem rede), seguido da harness Node+Chrome inteira confinada. O PostgreSQL continua descartável/local, com checagem do diretório e nenhum banco existente.

A aprovação de um novo ambiente/launcher não está presumida. Não instalar dependências durante o ensaio. Se browser/plataforma, origem file://, seletor ou mock falhar, registrar e corrigir em homologação; não afrouxar bloqueio de endpoints. Testes com clientes reais, OAuth ou dados reais só vêm em autorização futura própria.

## Diferenças materiais e compatibilidade

- MCP adicional é library HTTP WebRequest/Response, sem listener/activation; o executável stdio fixture antigo permanece. DTOs explícitos e identidade/grants obrigatórios prepararam a fronteira para adapter futuro, sem conectar um.
- Guards SQL agora detectam permissões efetivas de escrita/admin herdadas em contas/movimentações e preflight lista memberships/direitos. A migração/bundle mudou desde d439: **não foi reensaiada**. Exige nova revisão/recuperação/homologação antes de instalar. Compatibilidade de grants de backend/service_role continua exigindo comparação de metadata real; não presumir ausência de direitos herdados nem impacto de redução de PUBLIC.
- Não houve alteração funcional de UI/sales/stock em produção, aplicação de SQL, push, publicação, configuração de cliente, senha, OAuth ou permissão persistente.
