# Sistema Vaidosa — contexto do projeto

Leia este arquivo inteiro antes de mexer em qualquer coisa. Ele existe para que uma sessão nova (sua ou de outra IA) não precise reler o `index.html` inteiro (5000+ linhas) nem repetir a auditoria já feita.

## Negócio

Loja de roupa feminina plus size ("Vaidosa Fashion Plus"). Uso interno por **3 pessoas**, cada uma normalmente num aparelho diferente:
- **Kennedy** — ADM
- **Cristiane** — ADM e vendas
- **Tatiane** (cunhada do Kennedy) — vendas

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
- **Captcha (Turnstile) ainda NÃO foi habilitado** — era a proteção planejada contra força-bruta no PIN (10.000 combinações possíveis num site público). Ficou de fora porque exige criar uma conta Cloudflare/site key, fora do escopo desta sessão. **Isso é uma pendência de segurança real, não cosmética** — tratar como próximo passo antes de expor o sistema pra uso real, ou aceitar o risco conscientemente (site pequeno, 3 contas, dado não é cartão/financeiro sensível).
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
- **Backup** — "Importar backup" e "Zerar tudo" foram **desativados** (só mexiam no `localStorage`/cache local, que agora é irrelevante — deixariam a UI mentir por alguns segundos até o próximo reload desfazer tudo sozinho). "Baixar backup (JSON)" continua funcionando normalmente, é só um snapshot do que está carregado.

**Limitação de teste conhecida:** o `confirm()` nativo do navegador é suprimido por essa ferramenta de automação (sempre retorna `false`) — `deleteSale`, `cancelarPagamento`, `excluirConta` e `deleteCategoria` não foram clicados de ponta a ponta por causa disso, só o código foi revisado (todos reusam padrões Supabase já testados em outros fluxos). **Vale um teste manual real** desses 4 fluxos específicos antes de confiar neles peso-pesado.

**Nota de git importante:** todo o trabalho do Step 1 (login + 6 módulos) está no branch `feature/supabase-migration`, **não no `main`**. Só os primeiros 3 commits (doc inicial, confirmação de acesso Supabase) foram direto pro `main` antes de eu perceber que isso publicava automaticamente no GitHub Pages ao vivo — arriscado com um sistema pela metade. A partir daí, tudo foi feito no branch separado pra só ir pro ar quando estiver pronto de verdade (é o "corte único" que o plano original pedia). **Antes do merge pro `main`**, revisar com o Kennedy: Turnstile habilitado ou risco aceito conscientemente, e os 4 fluxos com `confirm()` testados manualmente pelo menos uma vez.

**Ainda faltando pra fechar o Step 1 de vez:**
- Habilitar Turnstile no login (ver nota de segurança acima) — ou decisão consciente de aceitar o risco por enquanto.
- Testar manualmente os 4 fluxos com `confirm()` (ver acima).
- Migração dos dados históricos dos 3 aparelhos (exportar backup de cada um, unir vendas/estoque por id, mas reconciliar clientes/produtos/categorias manualmente — provável colisão de barcode entre aparelhos, ver acima). O Kennedy já sinalizou que pretende fazer um balanço físico e relançar tudo do zero quando o sistema estiver pronto — pode ser que isso substitua essa migração inteira, confirmar antes de investir tempo nela.
- Merge de `feature/supabase-migration` pro `main` (dispara publicação automática no GitHub Pages) — fazer só depois dos dois pontos acima, e avisar os 3 usuários pra não usar o sistema durante a troca.
- Depois do merge: Step 4 do roteiro original (trazer o gerador de etiqueta Zebra pra dentro do sistema único) e Step 5 (conector de marketplace) continuam de pé como próximos passos.
