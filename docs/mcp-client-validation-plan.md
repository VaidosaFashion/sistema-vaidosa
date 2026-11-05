# Plano de validação de clientes — sem configuração/ativação

Nenhuma configuração Codex/Claude, OAuth, credencial, permissão ou acesso persistente foi criada. O MCP de negócio preparado é diferente do MCP administrativo Supabase. Esta matriz descreve evidência ainda necessária; documentação do cliente não comprova compatibilidade desta implementação.

| Etapa | Preparado | Evidência ainda necessária |
| --- | --- | --- |
| stdio fixture d439 | Executável e16 testes de contrato antigos aprovados | Rodar com versão exata de cada cliente em ambiente isolado; negociar versão, listar/chamar ferramentas e verificar saída/escopo. |
| HTTP Request/Response | Handler stateless JSON, discovery resource metadata e fronteira identity/grants | Executar os testes HTTP novos em sandbox OS e provar contrato com cliente SDK oficial de versão fixa. |
| Transporte externo | Nenhum listener/deploy/TLS criado | Servidor de homologação aprovado, domínio/certificado, proxy/limites/CORS se necessário e comportamento de cancelamento/conexões. |
| OAuth/identidade real | Interfaces fail-closed, somente verifier de fixtures | Issuer aprovado, fluxo OAuth/PKCE e registro/metadata de cliente conforme plataforma, token com audiência MCP, autorização/revogação e contas de homologação. Nunca usar token de outro serviço por passthrough. |
| Dados da loja | Nenhum adapter real conectado | Adapter com fonte canônica/RLS/principal, contratos de DTO, provas negativas por usuário/loja/cliente, timeout e minimização. |
| Codex | Plano documental | Identificar produto e versão (CLI/app/outro), suporte efetivo ao transporte, discovery/OAuth, limite e reconexão. Não havia `codex` no PATH desta sessão; nenhum programa foi instalado. |
| Claude | Plano documental | Identificar Code/Desktop/web e versão, transporte/configuração, autenticação e resultado real. Encontrar executável no PATH não é teste nem prova de compatibilidade. |

As referências oficiais consultadas são [MCP no Codex](https://developers.openai.com/codex/mcp/) e [MCP no Claude Code](https://code.claude.com/docs/en/mcp). O plano começa por fixture, depois homologação sem dados reais; somente após autorização específica considera credenciais/configuração real. Não foram executados comandos de login/adicionar servidor nem lidos arquivos de configuração/credenciais dos clientes.

Critérios antes de ativação: versões registradas, bootstrap HTTPS/autorizador/verifier auditados, allowlist de ferramentas/DTO, rejeição uniforme de recurso alheio, expiração/revogação comprovada, nenhuma escrita ou SQL arbitrário, telemetria sem segredos, limites/timeout eficazes e remoção do acesso sem interromper caixa. Documentar os cenários aprovados e o que continua fora de escopo; não converter uma conexão bem-sucedida em prova de integridade de banco ou compatibilidade universal.
