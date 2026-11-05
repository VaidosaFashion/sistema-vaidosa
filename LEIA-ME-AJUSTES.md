# ADENDO DE PREPARAÇÃO — NÃO VALIDADO EM EXECUÇÃO

Esta branch adiciona transporte/autorização MCP, ensaios de navegador e guard SQL ainda sem teste de execução. O último pacote testado é `d439679`, preservado em sua branch/ZIP anterior. Leia primeiro [docs/followup-validation.md](docs/followup-validation.md) e [preparação MCP](docs/mcp-transport-preparation.md). Os resultados históricos abaixo não validam o adendo.

---

# Vaidosa — ajustes locais por blocos

Cópia isolada em `sistema-vaidosa-ajustes-2026-11-05`, branch `fix/audited-blocks-20261105`, baseada em `502e33d7490a3f1e6ded5dd55deb86af118db58f`. Esta entrega é para revisão; o site publicado continua nessa revisão. Não houve push, deploy, migração real ou alteração de venda/estoque/conta.

| Bloco | Resultado na cópia |
| --- | --- |
| Contas/recebimentos | Criação, liquidação, edição, reversão e arquivamento via transação, UUID/revisão e histórico preservado; cliente mantido na edição. |
| Estoque | Entrada v2 idempotente, conferência canônica por variante, cache atualizado antes de rejeição do caixa e após exclusão; movimentos completos carregados com paginação. |
| Financeiro/relatórios | Rateio exato de descontos em centavos; histórico inclui parcelas/reversões e pagamentos de vendas com cliente/origem; totais manuais e de vendas separados para evitar soma ambígua. |
| Clientes | Histórico paginado completo, itens/pagamentos, detalhes e cancelamento de respostas antigas. |
| Layout/navegação | Drawer fecha ao trocar aba, feedback acima de diálogos, campos se ajustam ao espaço, avisos de carga falha e botão de atualização que preserva o carrinho. |
| MCP | Servidor stdio executável somente com fixtures, cinco ferramentas limitadas, escopo/limites/auditoria minimizada e rede bloqueada. Nenhuma conexão real ativa. |

## Conferir agora

- Abra `preview/blocks.html`: prévia offline renderizada da tela real com dados inventados; permite navegar, salvamentos desativados.
- Execute `npm test` com as dependências de desenvolvimento já disponíveis: suíte offline JavaScript, incluindo a tela inteira. `npm run preview:blocks` regenera a prévia.
- `sh tests/run-sql-tests.sh` exige PostgreSQL 17 local; cria/apaga apenas um cluster descartável por socket, sem TCP/URLs/senhas remotas. Os dados são fictícios. Não use esse comando para apontar a um banco existente.
- `node mcp/server.cjs --fixture`: servidor aguarda JSON-RPC em stdin, não é menu. O teste subprocesso demonstra o protocolo. [Uso/contratos MCP](mcp/README.md).

## Instalação futura

Leia [roteiro de implantação](docs/blocks-deployment.md) e [arquitetura/contratos](docs/architecture.md). O pacote exige conferência de metadata real e recuperação validada de contas/movimentações, que não estavam no checkpoint anterior. Não rodar o bundle na loja ainda. Migração + frontend precisam de janela coordenada e autorização futura. Depois de novas operações, rollback para a tela antiga pode interpretar reversões incorretamente; o roteiro prioriza recuperação à frente e não apaga histórico.

O MCP de negócio e seus adaptadores futuros são independentes do MCP administrativo Supabase. Não existe compatibilidade automática com Codex/Claude ou marketplaces: transporte real, autenticação, adapter autorizado e ensaio por versão permanecem futuros, com autorização específica para ativação/credenciais.

## Decisões e limitações

- Não há vínculo de venda/conta que prove conciliação. Os totais ficam separados; não se deduz vínculo por valor/data/cliente.
- Reversão de legado sem snapshot, cancelamento de dívida ativa e regra comercial de troca/devolução requerem decisão própria, sem exclusão de registros para forçar resultado.
- Web Locks e localStorage funcionando são necessários para novos comandos protegidos. Sem eles o envio é bloqueado. Payload local é mínimo por comando, porém descrições/observações de contas podem conter texto inserido pelo operador; não há criptografia adicional nem expiração automática de envio incerto. UUID, dados congelados e journal devem ser preservados para conferir o resultado. Dados do browser não acompanham automaticamente outro aparelho.
- A entrada antiga e alguns grants diretos de produtos/estoque continuam compatíveis; este pacote não afirma bloquear todos os canais legados. Fiscal/CPF e carrinho publicados foram preservados, emissão fiscal não foi concluída.
- Banco real atual, login/Turnstile/CDNs, SEFAZ, impressora, canais e clientes MCP reais não foram exercitados. A evidência é de código, fixtures, regressão e PostgreSQL descartável; não é certificação de produção.

Veja `docs/blocks-validation.md` para evidência final e revisão independente.
