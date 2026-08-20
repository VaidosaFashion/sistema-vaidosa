## Auditoria 2026-08-20 — bugs reais corrigidos

Pedido do Kennedy depois da auditoria completa (segurança + bugs + o que falta na NFC-e): **corrigir os bugs reais primeiro**, antes de emitir nota. Publicado no `main` em 2026-08-20 ~10:40 -03.

**SQL (obrigatório, cole no SQL Editor do Supabase — `db push` continua quebrado neste projeto):** `supabase/migrations/20260820124800_fix_auditoria_bugs.sql`. Sem esse SQL: entrada de estoque e exclusão de venda ainda funcionam (frontend tem fallback), mas **Misto continua recusado pelo banco** e `create_sale` não agrega o mesmo produto duas vezes. Com o SQL, as RPCs `apply_stock_entry` e `delete_sale` passam a ser a trilha principal (atômicas, `FOR UPDATE`).

| Bug | O que era | O que ficou |
|---|---|---|
| Pagamento **Misto** | A tela oferecia; `sales.pay` só aceitava PIX/Dinheiro/CartaoAVista/CartaoParcelado. Finalizar quebrava. | Check constraint inclui `Misto`. |
| Relatórios / dashboard / histórico do cliente | `loadSalesFromSupabase()` cortava em 200. Faturamento/lucro saíam **errados em silêncio** quando passasse disso. | Pagina tudo via `fetchAllRows()` (blocos de 200 com embed de itens/pagamentos). |
| Entrada de estoque em corrida | `stock = cache + qtd` sem trava. Duas pessoas lançando a mesma peça: uma entrada sumia. | RPC `apply_stock_entry` com `FOR UPDATE`. Fallback: optimistic lock (grava só se o `stock` ainda for o lido) + retry. |
| Editar produto sobrescrevia estoque | O formulário mandava `stock` do campo. Venda no caixa no mesmo momento voltava o número velho. | Edição **não grava estoque**. Campos de grade ficam travados, com aviso pra usar a aba Estoque. |
| Excluir venda não era transação | Devolvia estoque e depois tentava apagar. Falha no meio = estoque inflado. | RPC `delete_sale` faz os dois na mesma transação. Fallback desfaz o que já devolveu se o delete falhar. Produto já apagado do cadastro é pulado (não tem pra onde devolver). Trava de NFC-e autorizada agora vive **no banco** (e só consulta `nfce_emissions` se a tabela existir). Excluir venda também empurra o estoque de volta pra Nuvemshop. |
| NCM com ponto | Placeholder `6104.42.00` gravava com pontuação. SEFAZ recusa. | `normalizeNcm()` tira tudo que não é dígito. Se preencheu e não deu 8 dígitos, bloqueia o save com toast. Vazio continua permitido (cadastro ainda sem nota). |
| `create_sale` com o mesmo produto duas vezes no JSON | Cada qty era conferida contra o estoque original — a soma podia passar. A tela já juntava; a RPC furava. | Agrega `qty` por `product_id` **antes** do `FOR UPDATE`. |
| Loaders sem paginação | `clients`/`vendedores`/`cores`/`categorias`/`v_contas` — mesma classe do bug das 1000 linhas. | Todos usam `fetchAllRows()`. |
| XSS no preview de estoque | Barcode batendo em mais de um produto injetava `name` sem escape. | `escapeHtml` nos dois campos. |
| Data-só depois das 21h | `new Date().toISOString().split("T")[0]` (UTC). No Brasil, pagar uma conta ou registrar pagamento depois das 21h gravava **o dia seguinte**. | `hojeISOLocal()` — ano/mês/dia do relógio local. |
| Recorrência de conta a pagar | `addWeeks/addMonths(new Date("YYYY-MM-DD"))` + `toISOString()`. Fim de mês estourava (31/01 + 1 mês virava 03/03). | `addDiasDataSo` / `addMesesDataSo` (prende no último dia do mês alvo). |
| Histórico financeiro um dia atrás | `new Date(h.dataPagamento).toLocaleDateString("pt-BR")` — o mesmo fuso já documentado em `fmtDataBR()`. | `fmtDataSo()`. |
| Data do pagamento no modal | Saía crua (`2026-08-01`). | `fmtDataBR()`. |
| Cor some no caixa / WhatsApp / drawer | Mesma reclamação do PDF (13/08): o carrinho não gravava `colorName` e a tela não mostrava. PDF já buscava no cadastro; o resto não. | `corDoItem()` único, usado nos 4 lugares. Item do carrinho agora carrega a cor. |
| Botão Limpar da venda | Dois handlers no mesmo botão: o primeiro **não** limpava o cliente do combobox. | Sobrou só o handler completo (`setSaleClient("")`). |
| Finalizar / registrar pagamento | Se a rede caísse no meio, o botão ficava travado pra sempre. | `try/finally` reabilita sempre. |

**Como aplicar o SQL:** no painel do Supabase → SQL Editor → cola o conteúdo de `supabase/migrations/20260820124800_fix_auditoria_bugs.sql` → Run. Confirma com `select proname from pg_proc where proname in ('apply_stock_entry','delete_sale');` (tem que voltar as duas) e tentando finalizar uma venda de teste como Misto.

**Não feito nesta leva (era segurança / produto, não bug de operação):** repo público, PIN de 4 dígitos, RLS full access, módulo NFC-e (XML/SEFAZ). Branch `feature/nfce-emissao` continua fora do GitHub.
