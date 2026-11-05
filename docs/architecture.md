# Arquitetura progressiva — revisão local de 05/11/2026

Base publicada: `502e33d7490a3f1e6ded5dd55deb86af118db58f`. A cópia desta revisão não foi publicada. O shell `index.html` ainda coordena os módulos legados; esta entrega extrai as fronteiras onde havia defeitos demonstrados, sem substituir o sistema inteiro.

| Camada | Responsabilidade e fonte de verdade |
| --- | --- |
| UI (`index.html`, `modules/business-ui.js`) | Formulários, navegação, estados de carga, composição e feedback. Cache não autoriza saldo nem pagamento. |
| Domínio (`accounts-domain`, `stock-domain`, `reporting-domain`) | Validação, identidade de variante, centavos e semântica de datas. Funções sem rede. |
| Repositórios (`accounts-repository`, `stock-repository`) | Comandos congelados, UUID, lookup antes de retry e erros incertos. Cliente/journal/trava injetados. |
| Infra (`operation-journal`) | Persistência local verificada, por projeto/usuário/módulo, Web Locks. Nenhum token no payload. |
| Banco (RPCs SQL versionadas) | Autorização ativa, revisão, locks, transação e trilha. É a fonte canônica das mutações. |
| Histórico (`customer-orders`) | Leitura paginada por cliente, projeção mínima, cancelamento e descarte de respostas antigas. |
| MCP (`mcp/`) | Transporte e ferramentas de leitura com adapter de fixtures. Sem conexão real. |

## Invariantes e pontos de extensão

- Venda, item e pagamento têm IDs persistentes; correção financeira preserva itens/estoque e CPF fiscal. As correções publicadas em 502e33d e a proteção de carrinho continuam presentes.
- Contas usam operação idempotente + revisão esperada; movimento, conta, journal e auditoria confirmam ou falham juntos. Reverter marca o movimento e restaura somente o snapshot conhecido da última liquidação. Nunca apaga todo o histórico. Dívida ativa não é arquivada como se tivesse sido cancelada.
- Estoque existe por ID/código/tamanho/cor; o resumo por modelo é uma soma de registros. Entrada v2 é atômica e idempotente. Um replay retorna o produto atual; produto excluído não renasce. O cliente atualizado não usa o fallback antigo em duas gravações.
- Relatórios alocam o líquido recebido pelos pesos brutos dos itens em centavos, com resíduo determinístico. Não recalculam taxas históricas. Vendas usam instante convertido para Brasília; recebimentos usam `paid_on` civil.
- Contas avulsas e pagamentos de vendas não têm vínculo canônico no schema conhecido. O dashboard mostra seus totais separados; o saldo e gráfico de contas avulsas não somam recebimentos de vendas. O histórico identifica ambas as origens sem deduzir equivalência por cliente/data/valor. Conciliação exige decisão de produto e vínculo explícito futuro, com teste que prove uma única inclusão por fato financeiro.
- Adaptadores de canais futuros devem mapear `(origem,event_id)` para um comando idempotente canônico e conferir versão. Não podem escrever saldo absoluto usando cache do navegador. Fila/outbox, estorno bancário, devolução comercial e conciliação não foram inventados nesta revisão.
- MCP administrativo Supabase é diferente deste MCP de negócio. A ativação real exige identidade confiável, escopo por usuário/loja, adapter autorizado, auditoria e transporte versionado. O protótipo não tem SQL genérico nem mutações. Contratos de saída podem ser reaproveitados, não duplicar regras financeiras no transporte.

## Contratos/regressão

`npm test` usa preload que bloqueia saídas HTTP/DNS/socket/fetch e fixtures JSDOM sem recursos externos. SQL usa somente cluster descartável, TCP desativado e socket privado; a suíte de concorrência verifica o diretório real do servidor antes de escrever. A prévia é gerada da tela real com dados sintéticos, remove scripts/URLs externos e impede conexão pela CSP. A prévia é estática e não comprova consistência de banco.

Consulte [contas](accounts-contract.md), [estoque](stock-contract.md), [relatórios/histórico](reporting-contract.md), [journal](operation-journal.md), [MCP](../mcp/README.md) e [implantação futura](blocks-deployment.md). Cada mudança futura deve atualizar o contrato afetado e executar os testes de regressão, incluindo os fluxos já publicados de carrinho, desconto e recebimento.

## Reaproveitamento/dependências

Nenhuma dependência nova foi instalada. Mantidos Node e jsdom já presentes (devDependency fixa 26.1.0). BigInt/centavos cobrem o rateio, portanto decimal.js não é necessário neste bloco. Zod e Tabulator não foram adicionados: os contratos pequenos já são validados e trocar tabelas ampliaria o risco sem resolver as invariantes. Playwright é uma opção futura; nesta entrega o ensaio visual usa Chrome local em perfil temporário e o comportamento é testado em JSDOM. O SDK MCP TypeScript oficial é o candidato preferido para um transporte real; verificar release/licença/lockfile/manutenção/avisos de segurança antes de adotá-lo, conforme avaliação no README. O stdio mínimo atual é restrito ao protótipo de fixtures.
