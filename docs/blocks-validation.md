# Evidência da homologação local — 05/11/2026

Base local e `main` remoto conferidos: `502e33d7490a3f1e6ded5dd55deb86af118db58f`. Branch de trabalho `fix/audited-blocks-20261105`; a revisão permanece local. Nenhum push/deploy ou acesso de banco real foi executado. Logs incluem somente fixtures e metadata da instância descartável.

- **220/220 testes JavaScript passaram**, incluindo 11 testes novos da tela real/composição + 1 da prévia, além de domínio, repositories, journal, carrinho/correção financeira e MCP. Comando: `node --require ./tests/network-guard.cjs --test --test-concurrency=1 tests/*.test.cjs` com jsdom 26.1.0 já existente. [Log](validation/node-tests.txt).
- **Bundle SQL final passou em PostgreSQL 17 descartável**, reconstruído da base versionada e metadata conhecida. Inclui queries de pre/postcheck, reversão sem apagar movimento, cliente preservado/remoção explícita, arquivamento, privilégios, falha forçada entre movimento e conta, estoque intacto na edição financeira, proteção fiscal/CPF e regressões anteriores. [Log](validation/postgres-tests.txt).
- **Rejeição transacional do instalador comprovada**: grant inesperado por coluna provoca aborto; novas colunas/auditoria/função não sobrevivem ao rollback. O grant da fixture é removido antes da instalação válida.
- **Concorrência real em conexões distintas**: UUID igual em contas → um movimento/revisão/auditoria; UUID diferente com mesma revisão → um sucesso; reversão versus liquidação em ambas as ordens → nenhum histórico perdido; estoque UUID igual → um incremento; UUIDs distintos → soma canônica. Cinco cenários de regressão financeira/venda/exclusão anteriores também passaram.
- **Prévia em Chrome local com perfil temporário e pipe sem porta TCP**: 1440 px → scrollWidth 1425; 390 px → scrollWidth 375, sem transbordamento horizontal. [Métricas](validation/layout.json). Foram inspecionadas imagens apenas internamente. A captura CLI com janela de 390px foi descartada como evidência de viewport porque o Chrome impôs largura mínima; a medição final usa emulação explícita de viewport por CDP pipe.
- **Revisão independente de código**: transação/revisão/idempotência/ledger/RLS, fronteira MCP, composição UI. Achados tratados: rejeições 40001/P0002, sessão e token efêmero, retorno de confirmação false, seleção de cliente antiga, filtros sincronizados, JSON-RPC id:null e anos do histórico incluindo vendas. A última correção de anos tem regressão específica e passou na suíte final.

Uma rodada paralela sob carga teve timeouts de inicialização dos subprocessos MCP (não falha de regra demonstrada). A suíte MCP isolada passou 16/16, e o comando reproduzível final executa arquivos em série com os mesmos limites; a suíte completa final passou sem aumentar timeout nem remover testes. Os logs finais acima são os resultados terminais.

## Isolamento

- JS: preload nega saídas HTTP/HTTPS, DNS, Socket.connect/TLS/fetch; JSDOM usa `runScripts:outside-only`, sem loader e sem scripts externos. Supabase/Auth/canais/impressora são stubs explícitos. Tentativa de probe da impressora é interceptada, nunca enviada.
- SQL: `initdb` local, fixtures, socket `/tmp/vaidosa-sql.*`, `listen_addresses=''`; concorrência e ensaio de grants verificam servidor/diretório antes de escrever. Sem URL, senha, pooler ou produção. Cleanup encerra e remove o cluster.
- Prévia: render gerado da tela real, recursos externos removidos, CSP `connect-src 'none'`, todas as gravações desativadas. Só navegação é habilitada. Chrome usa perfil temporário, DNS externo bloqueado e background networking desativado. Não usa abas operacionais.
- MCP: flag `--fixture` obrigatória, adapter de dados inventados, guard de rede próprio, escopos sintéticos e nenhuma credencial real/integração persistente. Prova de subprocesso e contrato, não ensaio nas versões reais de Codex/Claude.

## Cobertura limitada

A produção atual de contas/movimentações/view/policies/grants por coluna não foi inspecionada; precisa do preflight futuro antes de instalação. O checkpoint privado antigo não foi lido, copiado ou exportado para este pacote. Não há backup real novo/restauração real neste ensaio. Preservação demonstrada usa dados fictícios. Auth/CDNs/SEFAZ/maquininha/impressora/canais reais não foram exercitados. Não há certificação de segurança ou conciliação automática.
