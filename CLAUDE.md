# Sistema Vaidosa — contexto do projeto

Leia este arquivo inteiro antes de mexer em qualquer coisa. Ele existe para que uma sessão nova (sua ou de outra IA) não precise reler o `index.html` inteiro (5000+ linhas) nem repetir a auditoria já feita.

## Negócio

Loja de roupa feminina plus size ("Vaidosa Fashion Plus"). Uso interno por **3 pessoas**: o dono (Kennedy), Cristiane e a cunhada dele — cada uma normalmente num aparelho diferente. Vendas hoje são presenciais (loja) e por WhatsApp/Instagram/tráfego. Objetivo declarado: abrir canais de **marketplace (Mercado Livre, TikTok Shop)** em breve, o que exige estoque sincronizado de verdade.

O dono não escreve código — todo o sistema até aqui foi construído descrevendo o que precisava para IAs generativas. Funciona, mas isso já causou bugs reais e uma segunda "gambiarra" separada (ver abaixo).

## Estado atual (antes desta reforma)

**Dois sistemas HTML separados, sem framework, sem backend:**

1. **Sistema principal** — `index.html`, publicado em `https://vaidosafashion.github.io/sistema-vaidosa/` (repo `VaidosaFashion/sistema-vaidosa`, branch `main`, única página). 100% client-side: lê/grava tudo em `localStorage` (chave `vaidosa_lite_v4`, ver `loadDB()`/`saveDB()`) e `IndexedDB` (auto-backup de arquivo via File System Access API). Módulos/abas: Home, Venda (PDV com leitor de código de barras), Produtos (grade de tamanho G1–G5), Estoque, Clientes, Vendedores, Financeiro (contas a pagar/receber + fluxo de caixa, usa Chart.js), Relatórios, Backup. Gera PDF de recibo (jsPDF) e abre link `wa.me` pra WhatsApp. O rodapé do PDF já diz "Este documento não é nota fiscal" — não há nenhuma emissão fiscal hoje.

2. **Gerador de etiqueta Zebra** — arquivo separado `ETIQUETAS.HTML` (não está no GitHub, só numa cópia no Google Drive do usuário e num arquivo local). Lê o estoque direto de `localStorage.getItem("vaidosa_lite_v4")` — **a mesma chave do sistema principal**. Isso só funciona porque os dois arquivos são abertos localmente (`file://`) no mesmo navegador, que por implementação (não por design) compartilha esse `localStorage` entre arquivos locais. Frágil: outro navegador, outra máquina, ou uma mudança de comportamento do Chrome quebra sem aviso. O design da etiqueta em si (CODE128 via JsBarcode, dimensão de rolo 32×50mm, impressão via `window.print()` com CSS `@media print`) está bom e deve ser reaproveitado — só a forma de pegar o dado do produto é que precisa mudar.

**Infra já provisionada, ainda não usada:**
- Projeto Supabase `vaidosa-sistema` (org "VaidosaFashion's Org", plano Free, região `sa-east-1`, hoje pausado por inatividade, sem tabelas). Esse é o banco central que vai substituir o `localStorage`.
- GitHub: conta `VaidosaFashion` tem push access configurado nesta máquina (`gh auth login` já trocado de `Voecomkennedy` pra `VaidosaFashion`).

## Bugs confirmados (auditados em 2026-08-03, linhas do `index.html` publicado nesse momento)

1. **`btnFinalize` (linha ~4066)** não desabilita o botão durante o processamento. Duplo clique/toque cria duas vendas idênticas e baixa o estoque duas vezes. **Causa mais provável dos "lançamentos duplicados" que o usuário relatou.**
2. **`btnSalvarPagar` (linha ~2683) e `btnSalvarReceber` (linha ~2910)** têm exatamente a mesma falta de trava contra duplo clique.
3. **Import de backup é destrutivo** (`btnImport`, linha ~5042: `db = obj`) — substitui o banco inteiro em vez de mesclar. Tentar sincronizar dois aparelhos manualmente hoje é escolher qual lado perde dado.
4. **Sem autenticação** — não existe conceito de usuário logado; impossível saber quem lançou o quê.
5. **Sem CI/teste** — os 7 commits do repo são todos "Update index.html"/"Add files via upload" via upload manual pela interface web do GitHub, não um fluxo `git commit` real.

Nenhuma função ou ID de HTML duplicado foi encontrado (verificado por grep) — a base não está "quebrada", está mal fundamentada (armazenamento local por dispositivo).

## Decisão de arquitetura (já validada com o usuário)

**Reformar, não recriar do zero.** A lógica de negócio (grade de tamanho, categorias, cálculo de custo/lucro/taxa de cartão, fluxo de caixa) já é real e testada por uso — só o alicerce (onde o dado mora) precisa trocar. Manter a mesma cara/fluxo que os 3 usuários já conhecem.

### Roteiro aprovado (nessa ordem)

1. Migrar produtos, estoque, vendas, clientes, vendedores e financeiro do `localStorage` para o Supabase (`vaidosa-sistema`, banco Postgres real com API pronta) — os 3 aparelhos passam a ler/escrever no mesmo lugar.
2. Corrigir a trava de duplo clique nas 3 telas identificadas (Venda, Contas a Pagar, Contas a Receber) — desabilitar botão durante o envio.
3. Adicionar login simples para os 3 usuários (Kennedy, Cristiane, cunhada) — cada lançamento passa a registrar quem fez.
4. Trazer o gerador de etiqueta Zebra pra dentro do sistema único, como mais uma aba, lendo o banco central diretamente (sem depender do truque de `localStorage` compartilhado entre arquivos locais). Reaproveitar o design/CSS da etiqueta que já funciona.
5. Só depois disso: conector de sincronização de estoque com Mercado Livre / TikTok Shop.

Auditoria completa (pontos fortes, todos os achados com evidência, diagrama antes/depois) está publicada como artifact — pedir o link ao usuário se precisar do documento visual completo; o resumo técnico relevante já está acima.

## Convenções de código a preservar na migração

- `toast(title, msg)` — notificação simples, um único `#toast` no DOM, timeout de 3.4s. Reaproveitar para feedback de rede também.
- Modais: padrão dominante é `classList.add/remove("hide")` (ex: `openPaymentModal`/`closePaymentModal`). Um segundo padrão minoritário usa `style.display`, existe só nos modais de Contas a Pagar/Receber — não replicar esse segundo padrão, convergir pro primeiro.
- Ações em linha de tabela: renderiza HTML com `data-*` carregando o id, depois `querySelectorAll("button[data-x]").forEach(...)` religando os handlers a cada render. Manter esse padrão para novas ações (ex: emitir etiqueta, ver histórico).
- `escapeHtml()` já é usado consistentemente ao injetar dado do usuário em `innerHTML` — manter.
- Hoje o app é 100% síncrono; a migração pro Supabase introduz o primeiro `fetch`/rede real do projeto — todo handler de "salvar" precisa virar `async` e ganhar estado de loading (não existe padrão de loading/disable reaproveitável ainda, precisa ser criado do zero).

## Onde as coisas estão

- Código (este repo): `~/ZCodeProject/vaidosa-sistema` — clonado de `git@github.com:VaidosaFashion/sistema-vaidosa.git`, branch `main`.
- Publicação atual: `https://vaidosafashion.github.io/sistema-vaidosa/`.
- Pasta de referência/documentos do usuário (iCloud, **não usar para código/git** — iCloud sync corrompe `.git`): `~/Library/Mobile Documents/com~apple~CloudDocs/Arquivo do Cartão de memoria/Sistema | Vaidosa/`. Tem uma cópia deste `CLAUDE.md` e uma cópia local antiga do sistema (desatualizada em relação ao GitHub — não usar como fonte).
- Gerador de etiqueta (`ETIQUETAS.HTML`) e material relacionado: Google Drive do usuário, pasta "Projetos". Arquivos: `ETIQUETAS.HTML` (a versão em uso), `Sistema atual de etiquetas` (Google Doc com histórico de prompts/versão V9), `Etiqueta Vaidosa Base FINAL.lbl.nlbl` (template de outro formato, não-HTML, provavelmente obsoleto — confirmar com usuário antes de descartar).
- Supabase: projeto `vaidosa-sistema`, ref `ysultkzfhgtyujbomfqz`, org `tbwshziystprxrwrebqk` (região `sa-east-1`). CLI já logado e linkado localmente neste repo (`supabase link` feito em 2026-08-03). Acesso confirmado via `supabase projects list`.

## Pendências antes de codar o passo 1

- Desenhar o schema Postgres (tabelas: products, clients, vendedores, sales, sale_items, stock_moves, contas, categorias, users) e política de RLS antes de migrar dado real de venda/estoque. Ainda não desenhado — próximo passo.
