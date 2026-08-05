# Sistema Vaidosa — contexto do projeto

Leia este arquivo inteiro antes de mexer em qualquer coisa. Ele existe para que uma sessão nova (sua ou de outra IA) não precise reler o `index.html` inteiro (5000+ linhas) nem repetir a auditoria já feita.

## Negócio

Loja de roupa feminina plus size ("Vaidosa Fashion Plus"). Uso interno por **3 pessoas**:
- **Kennedy** — ADM
- **Cristiane** — ADM e vendas
- **Tatiane** (cunhada do Kennedy) — vendas

**Correção (2026-08-05, confirmado pelo Kennedy): antes da migração, o sistema sempre rodou em UM computador só**, não em 3 aparelhos separados como a auditoria original assumiu (a suposição de "3 aparelhos com localStorage isolado" está em várias seções abaixo e no histórico do plano — mantida por registro histórico, mas era uma suposição, não um fato confirmado, e se revelou errada na prática). Na prática isso significa: só existe **um** backup/histórico de `localStorage` de verdade pra migrar, sem risco de conflito entre cópias divergentes do mesmo cliente/produto/venda feitas em aparelhos diferentes — o cenário de "colisão de barcode entre 3 aparelhos" descrito abaixo era um risco teórico que nunca se concretizou.

Vendas hoje são presenciais (loja) e por WhatsApp/Instagram/tráfego. Objetivo declarado: abrir canais de **marketplace (Mercado Livre, TikTok Shop)** em breve, o que exige estoque sincronizado de verdade.

O dono não escreve código — todo o sistema até aqui foi construído descrevendo o que precisava para IAs generativas. Funciona, mas isso já causou bugs reais e uma segunda "gambiarra" separada (ver abaixo).

## Estado atual (antes desta reforma)

**Dois sistemas HTML separados, sem framework, sem backend:**

1. **Sistema principal** — `index.html`, publicado em `https://vaidosafashion.github.io/sistema-vaidosa/` (repo `VaidosaFashion/sistema-vaidosa`, branch `main`, única página). 100% client-side: lê/grava tudo em `localStorage` (chave `vaidosa_lite_v4`, ver `loadDB()`/`saveDB()`) e `IndexedDB` (auto-backup de arquivo via File System Access API). Módulos/abas: Home, Venda (PDV com leitor de código de barras), Produtos (grade de tamanho G1–G5), Estoque, Clientes, Vendedores, Financeiro (contas a pagar/receber + fluxo de caixa, usa Chart.js), Relatórios, Backup. Gera PDF de recibo (jsPDF) e abre link `wa.me` pra WhatsApp. O rodapé do PDF já diz "Este documento não é nota fiscal" — não há nenhuma emissão fiscal hoje.

2. **Gerador de etiqueta Zebra** — arquivo separado `ETIQUETAS.HTML` (cópia salva em `docs/etiquetas-legado/` neste repo, veio do Google Drive do usuário). Lê o estoque direto de `localStorage.getItem("vaidosa_lite_v4")` — **a mesma chave do sistema principal**. Isso só funciona porque os dois arquivos são abertos localmente (`file://`) no mesmo navegador, que por implementação (não por design) compartilha esse `localStorage` entre arquivos locais. Frágil: outro navegador, outra máquina, ou uma mudança de comportamento do Chrome quebra sem aviso. O design da etiqueta em si (CODE128 via JsBarcode, dimensão de rolo 32×50mm, impressão via `window.print()` com CSS `@media print`) está bom e deve ser reaproveitado — só a forma de pegar o dado do produto é que precisa mudar.

   **Correção importante:** o texto na tela de Produtos diz "Todas as grades compartilham o mesmo código de barras" — isso é **falso**, não é o que o código faz. Em `btnAddProduct` (index.html:2167-2188), cada tamanho (G1–G5) chama `generateNextCode()` individualmente e recebe um barcode **único e distinto por tamanho**, não compartilhado. Além disso esse contador (`vaidosa_code_counter`) é por dispositivo — os 3 aparelhos gerando produtos separadamente podiam gerar o mesmo código `VF000042` apontando pra produtos diferentes (colisão real, silenciosa até os dados serem unificados num banco só).

**Infra:**
- Projeto Supabase `vaidosa-sistema` (org "VaidosaFashion's Org", plano Free, região `sa-east-1`, ref `ysultkzfhgtyujbomfqz`). **Schema já aplicado em 2026-08-03** — ver "Step 1 — status" abaixo.
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

## Step 1 — status (2026-08-03)

**Schema aplicado e testado.** Migrações em `supabase/migrations/`:
- `20260803214619_core_schema.sql` — tabelas: `profiles` (login+papel: `is_admin`/`is_vendedora`/`vendedor_id`), `vendedores`, `clients`, `categorias`, `products` (barcode com sequência **do servidor**, corrige a colisão por dispositivo), `sales`, `sale_items`, `sale_payments`, `stock_moves`, `contas`, `movimentacoes` (registro de cada pagamento/recebimento contra uma conta — existia em `db.movimentacoes`, não estava documentado antes aqui), `store_settings` (singleton, substitui o `blockSecondSwap` por-aparelho), view `v_contas`.
- `20260803214620_rls_policies.sql` — RLS habilitada em todas as tabelas de negócio, policy única `authenticated full access` (modelo de confiança compartilhado, não multi-tenant — as 3 pessoas veem/editam os mesmos dados). `profiles` é a exceção: legível por `anon` (só pra listar nomes na tela de login), sem policy de escrita pelo app.
- `20260803214621_rpc_functions.sql` — `create_sale`/`create_conta`, idempotentes via `client_request_id` (retry com a mesma chave retorna o registro já criado, não duplica) + `for update` na linha do produto em `create_sale` (fecha a corrida entre dois aparelhos vendendo o último item ao mesmo tempo). Trigger `recalc_sale_totals` mantém `fee_value`/`net_received`/`profit`/`payment_status` sincronizados quando `sale_payments` muda, reproduzindo a fórmula exata de `btnAddPayment` (index.html:4397-4459) e `getSalePaymentStatus` (index.html:4258-4264).

**Verificado por teste real (depois limpo, banco vazio de novo):** duas chamadas de `create_sale` com o mesmo `client_request_id` retornam a mesma venda sem duplicar; venda com quantidade maior que o estoque é rejeitada; duas chamadas **simultâneas** (via curl em paralelo) para o último item em estoque — só uma teve sucesso, a outra recebeu "Estoque insuficiente", estoque final ficou em 0 (não negativo); `create_conta` idempotente confirmado da mesma forma.

**Nota técnica importante — `supabase db push`/`supabase migration list` não funcionam neste projeto.** O CLI tenta provisionar uma "login role" própria (`cli_login_postgres`) e falha com `permission denied to alter role` — não é erro de SQL nosso, é uma limitação de permissão no projeto/token atual (não investigado a fundo, pode ser algo a resolver com o suporte do Supabase depois). **Workaround usado e que funciona:** aplicar SQL diretamente via Management API (`POST https://api.supabase.com/v1/projects/ysultkzfhgtyujbomfqz/database/query`, header `Authorization: Bearer <personal access token>`, body `{"query": "<sql>"}`), autenticado com um Personal Access Token (prefixo `sbp_`, gerado em Account → Access Tokens). A tabela de histórico de migração do CLI (`supabase_migrations.schema_migrations`) foi criada e populada manualmente pra manter o controle de versão consistente, caso o `db push` volte a funcionar no futuro.

**Login "nome + PIN" implementado e testado (2026-08-03).** Adiantado do Step 3 pro Step 1 por necessidade técnica: RLS exige usuário autenticado pra qualquer leitura/escrita nas tabelas de negócio, então login tinha que existir antes de qualquer módulo poder falar com o Supabase.

- 3 contas reais criadas no Supabase Auth (email sintético + PIN de 4 dígitos como senha, definido pelo Kennedy): `kennedy@vaidosa.internal` (is_admin), `cristiane@vaidosa.internal` (is_admin + is_vendedora, ligada a um novo registro em `vendedores`), `tatiane@vaidosa.internal` (is_vendedora, ligada a outro registro em `vendedores`). Linhas correspondentes em `profiles` já criadas. **Os PINs em si não estão documentados aqui de propósito** — este repositório é público, e qualquer coisa escrita em `CLAUDE.md` fica visível pra qualquer pessoa no GitHub. Se precisar resetar/trocar um PIN, use `auth.admin.updateUserById` (Admin API) ou o painel do Supabase — nunca escreva a senha real em nenhum arquivo deste repo.
- `password_min_length` do projeto foi reduzido de 6 pra 4 via Management API (`PATCH /v1/projects/{ref}/config/auth`) pra aceitar o PIN de 4 dígitos. `disable_signup` também setado (sem self-signup público).
- **Captcha (Turnstile) habilitado em 2026-08-04** — ver seção "Turnstile — status" mais abaixo pra detalhe completo. A proteção contra força-bruta no PIN que faltava aqui já está resolvida.
- Frontend: `index.html` agora tem uma tela de login (nome → PIN) que bloqueia o resto do app até autenticar. `supabase-js` incluído via CDN (`@supabase/supabase-js@2`), client inicializado com a URL do projeto e a **anon key** (essa key é pública por design, protegida pelo RLS — não é segredo, pode ficar no HTML). Sessão persiste via localStorage do próprio supabase-js (recarregar a página não desloga). Bloco de inicialização do app antigo (`setTab("venda"); renderHome(); ...`) virou a função `initApp()`, chamada só depois do login bem-sucedido — antes rodava direto ao carregar a página.
- Testado de ponta a ponta no navegador (login Kennedy e Cristiane, PIN errado mostra erro, PIN certo entra, logout volta pra tela de login, sessão sobrevive a reload). Ver `enterApp()`/`checkExistingSession()`/`doLogin()` no topo do `<script>` principal.
- **Para rodar localmente**: `npx serve -l 8934 -s ~/ZCodeProject/vaidosa-sistema` (o pacote `serve` já está instalado globalmente nesta máquina) — `python3 -m http.server` **não funciona** neste ambiente sandboxed (erro de permissão em `os.getcwd()`), por isso usamos `serve`.

**Todos os 6 módulos migrados e testados (2026-08-03/04): Produtos, Estoque, Vendas, Clientes, Vendedores, Financeiro.** Step 1 está funcionalmente completo. Trabalho feito inteiro no branch **`feature/supabase-migration`** — ver nota de git abaixo antes de mexer em qualquer coisa.

**Padrão usado em todo módulo (repetir se algo mais precisar ser convertido):**
- `db.x` continua existindo como **cache local em memória**, preenchido por um `loadXFromSupabase()` chamado no início de `initApp()`, em vez de vir do `localStorage`. Todo código que só *lê* `db.x` (render, busca, filtros) não precisou mudar — só os pontos de **mutação** (criar/editar/excluir) viraram chamadas Supabase.
- Nomes de coluna no Postgres são `snake_case`; o app usa `camelCase`. Cada loader mapeia explicitamente (ver `mapContaFromDb`, `mapSaleFromDb`, ou inline nos loaders mais simples como produtos/vendedores onde por coincidência os nomes já batiam).
- Todo botão de salvar/excluir agora desabilita durante o request (trava contra duplo clique/toque em qualquer tela de mutação, não só nos 3 originalmente identificados no bug).
- Onde já existia RPC idempotente (`create_sale`, `create_conta`), o frontend chama ela em vez de montar o registro local — é isso que corrige o bug de duplo lançamento na origem, não só o botão desabilitado.

**Detalhes por módulo:**
- **Produtos** — criação em lote por grade não manda `barcode` (Postgres gera pela sequência do servidor). Exclusão checa uso em `sale_items` direto no Supabase. `generateNextCode()`/`getLastGeneratedCode()`/"Redefinir contador" no Backup ficaram **vestigiais** (nada mais lê esse contador) — não removidos, só inofensivos.
- **Estoque** — `applyStockEntry(produto, qtd, custoNovo, nota, tipo="ENTRADA")` é o helper compartilhado entre a entrada por barcode, a entrada manual, **e** `deleteSale()` (com `tipo="DEVOLUCAO"`) — um único lugar que atualiza `products.stock` + insere `stock_moves`.
- **Vendas (PDV)** — `btnFinalize` chama a RPC `create_sale` com um `client_request_id` (`crypto.randomUUID()`) gerado uma vez por clique. `btnAddPayment` insere em `sale_payments`; o trigger `recalc_sale_totals` já recalcula tudo no servidor, espelhado localmente pra não precisar refetch. Venda "Troca" agora também persiste `clients.troca_count` no Supabase, não só local.
- **Clientes** — CRUD simples (o app nunca teve exclusão de cliente, então não foi adicionada aqui). `troca_count` ↔ `trocaCount` é o único mapeamento de nome.
- **Vendedores** — CRUD simples. Cristiane e Tatiane já existem como vendedoras (criadas junto com o login) — confirmado aparecendo certo na tela.
- **Financeiro** — `categorias` semeia as 11 categorias padrão só na primeira visita à aba (checa se a tabela está vazia, não semeia toda vez). `contas` carrega da **view `v_contas`** (join ao vivo com categoria/cliente, substitui o texto congelado antigo). Criação de conta usa a RPC `create_conta`; pagar/receber insere uma `movimentacao` e atualiza a conta (o "parcelamento" sempre foi 1 registro avançando em campo `parcela_atual`/`proximo_vencimento`, nunca N registros — preservado assim).
- **Backup** — "Importar backup" e "Zerar tudo" foram **removidos** (2026-08-04, a pedido do Kennedy: deixar botão desativado sem função era confuso). Só mexiam no `localStorage`/cache local, que já era irrelevante desde a migração pro Supabase. "Baixar backup (JSON)" continua funcionando normalmente, é só um snapshot do que está carregado.
- **Decisão sobre dados históricos (2026-08-04/05, refinada):** **produtos** — Kennedy vai recadastrar do zero (grade de tamanho bagunçada nos dados antigos foi o motivo original da reforma; cadastrar de novo já entra com SKU e campos fiscais corretos). **Vendas e clientes** — depois de esclarecido que o sistema sempre rodou num computador só (não 3 aparelhos, ver correção no topo do arquivo), não existe risco de conflito entre cópias divergentes — Kennedy quer preservar esse histórico. Import ainda **não construído**: falta ele mandar o arquivo de backup JSON (botão "Baixar backup (JSON)" na aba Backup & Dados) pra eu escrever o script de importação (vendas/sale_items/sale_payments/stock_moves + clientes, produtos ficam de fora de propósito).

**Os 4 fluxos com `confirm()` (excluir venda, reabrir conta, excluir conta, excluir categoria) foram testados manualmente pelo Kennedy em 2026-08-04 — confirmados funcionando.** (Não puderam ser testados por automação nesta sessão porque o `confirm()` nativo do navegador é suprimido pela ferramenta de teste usada.)

**Merge feito e publicado (2026-08-04).** `feature/supabase-migration` foi mesclado no `main` (merge commit, sem conflito) e já está no ar em `https://vaidosafashion.github.io/sistema-vaidosa/` — confirmado via `curl` que o HTML publicado tem a tela de login. Decisão do Kennedy: ir pro ar mesmo com Turnstile pendente. Ele testou os 4 fluxos com `confirm()` manualmente e confirmou que estão OK.

## Step 4 — status (2026-08-04)

**Gerador de etiqueta Zebra trazido pra dentro do sistema único, como aba "Etiquetas".** Feito no branch `feature/etiquetas-zebra`, mesclado no `main` depois de testado.

- HTML/CSS/JS portados de `docs/etiquetas-legado/ETIQUETAS.HTML` quase sem mudança — o **design da etiqueta em si** (CODE128 via JsBarcode, rolo 32×50mm, `.eti-topo`/`.eti-tarja`/`.eti-tam` etc.) é o mesmo de antes, só a "moldura" ao redor (busca, botões) passou a seguir os estilos do sistema principal (`.card`, `.btn`).
- **A mudança que importa**: em vez de `localStorage.getItem("vaidosa_lite_v4")` (o truque frágil de dois arquivos abertos no mesmo navegador), a aba lê `db.products` direto — o mesmo cache já carregado do Supabase que todo o resto do app usa. Isso mata a gambiarra descrita no topo deste arquivo por completo.
- Impressão usa o truque padrão de "imprimir só um elemento": `@media print { body * { visibility:hidden } #folha-impressao, #folha-impressao * { visibility:visible } ... }` — esconde a sidebar/resto do app e imprime só a fila de etiquetas, sem precisar enumerar cada seção.
- **Bug real encontrado e corrigido durante o teste**: a aba nova ficava com o conteúdo em branco ao clicar — esqueci de adicionar `"etiquetas"` no array `tabs` que `setTab()` usa pra decidir quais seções mostrar/esconder (`index.html`, variável `const tabs = [...]` perto de `setTab`). Se algum dia adicionar outra aba nova, **lembrar desse array** — é o erro mais fácil de repetir.
- Testado no navegador: busca por nome encontra produto, seleciona, adiciona 3 etiquetas na fila com barcode real renderizado, "Limpar fila" funciona, "Imprimir" com fila vazia mostra aviso em vez de abrir o diálogo de impressão. Não dá pra verificar visualmente o resultado impresso em papel por este canal — vale um teste físico numa impressora Zebra de verdade antes de confiar 100%.
- `ETIQUETAS.HTML` original (Google Drive) e a cópia legada dentro do repo (`docs/etiquetas-legado/`) ficam obsoletos a partir de agora — não precisam mais ser usados, mas não foram apagados.

## Turnstile — status (2026-08-04)

**Habilitado e testado.** Kennedy criou o widget na Cloudflare (conta dele, gratuita) com domínios `vaidosafashion.github.io` e `localhost` (esse segundo só pra permitir teste local). Modo **Managed** (majoritariamente invisível pro usuário).

- Site key fica no `index.html` (`TURNSTILE_SITE_KEY`, é pública por design, igual a anon key do Supabase — não é segredo). Secret key foi configurada **só no lado do Supabase** via Management API (`PATCH /v1/projects/{ref}/config/auth`, campos `security_captcha_enabled`/`security_captcha_provider`/`security_captcha_secret`) — nunca fica no frontend nem neste repo.
- Frontend: widget renderiza (`turnstile.render`) só quando o usuário chega na etapa do PIN (depois de escolher o nome), não na tela inicial. Token capturado via callback (`turnstileToken`), mandado em `signInWithPassword({..., options:{captchaToken}})`, e resetado (`turnstile.reset`) depois de toda tentativa — sucesso ou erro — porque cada token só serve uma vez.
- **Cuidado de sequenciamento pra próxima vez que mexer nisso**: `security_captcha_enabled` no Supabase e o widget no frontend têm que ir ao ar **juntos**. Habilitar um sem o outro quebra o login de verdade (ou trava todo mundo achando token ausente, ou não bloqueia nada). Foi testado localmente com `security_captcha_enabled` ligado direto no projeto real antes de publicar, pra não ter esse hiato em produção.
- Testado de ponta a ponta: login com PIN certo passa (token válido aceito pelo Supabase), PIN errado é rejeitado e o widget reseta sozinho pra próxima tentativa gerar um token novo.

**Ainda pendente (não bloqueia o uso, mas vale voltar):**
- Migração dos dados históricos dos 3 aparelhos — o Kennedy sinalizou que pretende fazer um balanço físico e relançar tudo do zero quando confirmar que o sistema está bom, o que pode substituir essa migração inteira. Confirmar com ele antes de investir tempo nisso.
- Teste físico da etiqueta numa impressora Zebra real (ver acima).
- Step 5 do roteiro original: conector de marketplace Mercado Livre/TikTok Shop.

## Campos fiscais no cadastro de Produtos (2026-08-04)

Pedido direto do Kennedy: ele quer emitir NF-e futuramente via **integração direta com a SEFAZ** (não terceirizado tipo Focus NFe/eNotas — decisão explícita dele, "quero fazer o nosso mesmo, sem pegar de outra pessoa"). Esse é um projeto grande à parte, ainda não iniciado. O que foi adiantado agora é só a metade barata e de alto valor: **todo produto cadastrado a partir de hoje já nasce com a classificação fiscal certa**, em vez de precisar de um retrabalho em massa em toda a base quando o módulo de emissão existir.

- Migração `supabase/migrations/20260804135036_add_product_fiscal_fields.sql` — adiciona em `products`: `ncm` (sem default, varia por peça), `cfop` (sem default fixo — é só um valor de referência do produto, o módulo de emissão decide o CFOP final pelo destino da venda), `cest` (opcional, só se a categoria tiver ICMS-ST), `csosn` (default `'102'`, comum pra revenda no Simples/MEI), `origem` (default `'0'` nacional, check 0-8), `unidade` (default `'UN'`).
- Seção "Dados fiscais (NF-e)" no formulário de Produtos (`index.html`, entre Observação e Estoque por grade), com aviso visível de que os defaults são um ponto de partida comum — **CONFERIR com o contador antes de emitir nota de verdade, principalmente NCM (não tem default seguro, varia por tipo de peça) e CSOSN**.
- `btnAddProduct` (criação e edição), `clearProductForm()` e `btnEditProduct` foram atualizados pra ler/preencher/resetar esses 6 campos. `loadProductsFromSupabase()` não precisou mudar (`select("*")` já traz as colunas novas).
- Testado: produto de teste cadastrado com os 5 tamanhos (G1-G5), cada linha recebendo os valores fiscais corretos e default certo; depois removido do banco de produção (apagado via a própria tela de Produtos → Buscar e editar → Selecionar → Excluir selecionado, uma vez por grade, com autorização do Kennedy).
- **Não faz parte deste trabalho**: geração de XML, assinatura com o certificado A1, comunicação SOAP com a SEFAZ, DANFE, homologação. Isso é o próximo projeto grande, a ser planejado formalmente (mesmo rigor do plano da migração Supabase) antes de codar, dado o peso legal/fiscal de errar uma nota de verdade.

**Nota de ferramenta descoberta nessa sessão:** `supabase db query --linked "<sql>"` tromba no mesmo bug de permissão do `db push` (`permission denied to alter role` em `cli_login_postgres`) — **não usar** pra rodar SQL ad-hoc contra o projeto remoto. Pra consulta/escrita pontual sem passar pelo Management API com token manual, o caminho que funciona sem fricção é a própria tela do app (tem sessão autenticada com a mesma RLS "authenticated full access" que qualquer usuário real teria) — foi assim que o produto de teste foi removido desta vez.
