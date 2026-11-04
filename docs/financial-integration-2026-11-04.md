# Financeiro integrado ao carrinho publicado — preparação local

Base publicada: 931b28c2078c69cec617d5d0b6087c56fd393e99. Pacote financeiro auditado de origem: f8651f39322f9dbc17c2dd1e025a17d80c74ad37. A revisão final integrada consta em REVISAO.txt do pacote. Nenhum frontend financeiro, migração, consulta ou alteração de venda real foi executado nesta revisão.

## Resultado funcional

A correção financeira altera desconto, valor/data/forma/parcelas/observação de pagamentos existentes através de uma única RPC, mantendo IDs, peças e estoque. Mostra prévia antes/depois, exige motivo e registra histórico financeiro. Não muda itens/quantidades da venda, não executa estorno bancário e não corrige o histórico inteiro automaticamente.

O merge preserva os três cart-draft-*.js byte a byte de 931b28c e o finalizador publicado: persistência local antes da RPC, UUID/payload estáveis, recuperação explícita, Web Locks, proteção de BFCache e Pendente na próxima venda. financial-corrections.js permanece igual ao pacote auditado. A integração recebe revisão financeira no mapeamento da venda, botões/modal, registro seguro de recebimentos e exclusão exclusivamente pela RPC.

## Falha adicional encontrada e corrigida

O pacote f8651f3 liberava um novo UUID de recebimento após qualquer erro SQL/PGRST, mesmo quando a primeira tentativa já podia ter gravado. Exemplo: parcial de 40 em venda de 100, resposta perdida, retry negado por sessão, novo clique poderia registrar mais 40.

Agora consulta ID do pagamento e ID da venda antes do retry e após resposta/erro da escrita. Encontrado: atualiza o resultado sem novo upsert. Consulta falhou: mantém UUID, payload congelado e formulário bloqueado. Ausente: só a mesma tentativa pode ser repetida; erro posterior a incerteza nunca libera outro UUID. Liberação por rejeição negocial fica limitada à primeira tentativa ainda sem incerteza, código permitido e ausência confirmada.

**Limite:** a tentativa de recebimento fica em memória da aba, não no rascunho persistente do carrinho. Não recarregar a página com recebimento incerto nem prometer recuperação desse formulário após reload. A proteção persistente publicada é de criação de venda, conforme PERSISTENCIA-CARRINHO.md.

## Evidência local

108/108 testes Node/jsdom: 67 do carrinho, 38 financeiros (incluindo seis regressões novas de retry), três de integração com a página inteira. Os sete testes do finalizador antigo foram substituídos pela cobertura do controlador publicado, com mapa em tests/sale-finalize-coverage.cjs. Cancelamento/salvamento/retry financeiro preservam carrinho de 40 peças, 60 itens vendidos e estoque fictício.

PostgreSQL 17.11 descartável, somente socket privado: instalador único, estrutura observada, regras financeiras, CPF preservado fora da auditoria, privilégios, idempotência e cinco cenários concorrentes. Checkpoint exportado em uma instrução, verificado localmente e reconstituído em 11 tabelas temporárias, com uma linha fictícia em cada tabela (dinheiro, datas, JSONB, nulos, acentos e quebras de linha); cinco definições originais recompostas após a migração dentro de uma transação local revertida. Logs em evidencias/.

O primeiro ensaio de exportação detectou um erro no validador: OIDs dos memberships foram serializados pelo PostgreSQL como strings decimais. O ajuste aceita a representação estrita correspondente, preservando exigência dos campos, bytes, hash, contagens e estrutura. Autotestes incluem metadados ausentes/incorretos, truncamento e versões compatíveis; resultados exatos em evidencias/verificador.txt.

Não é prova de restauração integral nem clone do banco real. A fixture foi reconstruída dos metadados fornecidos; saldos reais, usuários Auth completos, memberships/owners/extensões reais e demais serviços não foram exportados.

## SQL e compatibilidade

As três migrações auditadas continuam byte a byte iguais. O bundle muda somente comentários iniciais para explicitar o novo caminho de recuperação limitada aprovado como opção; não muda suas instruções SQL. Mantém uma transação, lock_timeout de 5s, statement_timeout de 60s e rejeição de reaplicação. Não há DML de negócio executado durante a instalação; nas vendas existentes adiciona finance_revision com zero. Os INSERT/UPDATE/DELETE dos arquivos pertencem às funções que serão chamadas depois.

Altera funções, triggers novos e grants de oito tabelas; não é apenas uma tela. A assinatura create_sale de 11 argumentos permanece compatível com o carrinho. sales UPDATE continua amplo por compatibilidade: acesso direto deliberado ainda pode contornar a auditoria financeira. O emissor fiscal incompleto não foi desenvolvido e sua proteção existente foi preservada. O bundle manual não registra automaticamente supabase_migrations.schema_migrations; conciliar esse histórico antes de futuros db push, sem reaplicar o bundle.

## Pronto versus pendente

Pronto localmente: integração, correção do retry, testes, exportador/verificador privados, ensaio limitado, pacote e roteiro manual. Não publicar o HTML antigo do pacote f8651f3 sobre o site.

Pendente real: exportação privada pelo próprio usuário, validação e análise do inventário atual, segundo exemplar privado, pausa de todos os escritores, aceite explícito da cobertura limitada, autorização da migração e publicação financeira. Free sem backups nativos e senha desconhecida são fatos já confirmados; não solicitar reset nem reconferência do plano. O SQL Editor autenticado não exige essa senha para as etapas manuais.

A cópia direcionada não inclui Auth completo, estado de sequências, todos os schemas/tabelas, Storage/segredos/configuração externa. Não reconstruirá um projeto vazio. Os ensaios locais provam recuperação de dados tipados e definições na fixture, não restauração de ACLs/owners reais ou do projeto inteiro. A consulta exporta dados pessoais/fiscais: resultado só em arquivo privado, nunca chat/Library/GitHub. Não há exportação real incluída neste pacote.

## Ordem e recuperação

00_checkpoint_somente_leitura.sql → download CSV privado → 00_validar_checkpoint.py e revisão de cobertura → aceite/autorização → 01_preflight.sql → 02_instalar_transacao.sql inteiro → 03_pos_instalacao.sql → cinco arquivos frontend juntos. Detalhes em ROTEIRO-CHECKPOINT.md e LEIA-ME.md.

Antes do COMMIT, erro reverte a instalação. Depois, suspender operações afetadas e preferir correção progressiva; preservar auditoria, revisões e requisições. Para falha só de UI, desabilitar correção financeira mantendo carrinho/novos handlers. Não retornar integralmente a 931b28c depois dos novos grants: pagamentos voltariam a não ter UUID e exclusão voltaria ao fallback sequencial. Não fornecer rollback destrutivo nem restaurar grants inseguros. Operações posteriores exigem reconciliação; auditoria vazia/revisão zero não provam ausência de escrita.
