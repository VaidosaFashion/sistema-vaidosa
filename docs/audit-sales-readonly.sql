-- Auditoria somente de leitura — Sistema Vaidosa
-- Projeto esperado: ysultkzfhgtyujbomfqz (confirmar no painel antes de executar).
-- Preparado em 2026-11-04 a partir do schema versionado no repositório.
-- NÃO EXECUTADO EM PRODUÇÃO: a sessão do navegador foi interrompida pelo usuário.
-- Nenhum resultado abaixo deve ser apresentado como achado do banco real.
--
-- Execute UM bloco SELECT/WITH por vez e confira as linhas retornadas.
-- Conforme CLAUDE.md, "Success. No rows returned" sozinho não prova execução.
-- Este arquivo não chama RPCs de negócio, não altera dados/schema e não lê
-- auth.users, credenciais, nomes, contatos, documentos, notas ou IDs de vendas.
-- As saídas de negócio são contagens agregadas; definições são metadados.
-- Execute com acesso de leitura que permita ver toda a base. RLS pode limitar
-- resultados de uma sessão comum; zero linhas não comprova integridade global.
-- O editor pode salvar automaticamente o texto da consulta; isso não é DDL/DML.
-- Consulte o schema primeiro: se produção diferir do repo, adapte só as SELECTs.

-- 1. Contexto da sessão. Fuso do negócio usado nas consultas diárias: São Paulo.
select current_database() as banco,
       current_user as papel_da_sessao,
       current_setting('TimeZone') as fuso_da_sessao,
       current_setting('transaction_read_only') as transacao_somente_leitura,
       now() as consultado_em;

-- 2. Colunas presentes, incluindo a migração nova quando aplicada.
-- Não exige que sale_financial_audit/finance_revision já existam.
select c.table_name, c.ordinal_position, c.column_name,
       c.data_type, c.udt_name, c.is_nullable,
       c.numeric_precision, c.numeric_scale
from information_schema.columns c
where c.table_schema = 'public'
  and c.table_name in (
    'sales', 'sale_items', 'sale_payments', 'stock_moves', 'products',
    'sale_financial_audit'
  )
order by c.table_name, c.ordinal_position;

-- 3. Constraints reais. As flags permanecem legíveis se a definição for cortada.
select t.relname as tabela, c.conname as restricao, c.contype as tipo,
       c.convalidated as validada,
       pg_get_constraintdef(c.oid, true) as definicao,
       pg_get_constraintdef(c.oid, true) like '%Pendente%' as menciona_pendente,
       pg_get_constraintdef(c.oid, true) like '%Misto%' as menciona_misto,
       pg_get_constraintdef(c.oid, true) like '%Debito%' as menciona_debito,
       pg_get_constraintdef(c.oid, true) like '%Credito%' as menciona_credito
from pg_constraint c
join pg_class t on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and t.relname in ('sales', 'sale_items', 'sale_payments', 'stock_moves',
                   'products', 'sale_financial_audit')
order by t.relname, c.conname;

-- 4. Índices, especialmente qualquer unicidade indevida por dia.
-- O schema versionado tem UNIQUE(client_request_id), não UNIQUE(sold_at/dia).
select t.relname as tabela, i.relname as indice,
       x.indisunique as unico, x.indisvalid as valido,
       pg_get_indexdef(x.indexrelid) as definicao
from pg_index x
join pg_class t on t.oid = x.indrelid
join pg_class i on i.oid = x.indexrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and t.relname in ('sales', 'sale_payments', 'sale_financial_audit')
order by t.relname, i.relname;

-- 5. Funções existentes e assinaturas: identifica overload antigo de create_sale.
select p.proname as funcao,
       pg_get_function_identity_arguments(p.oid) as assinatura,
       pg_get_function_result(p.oid) as retorno,
       p.prosecdef as security_definer,
       p.proconfig as configuracao,
       md5(pg_get_functiondef(p.oid)) as hash_da_definicao,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_pode_executar,
       has_function_privilege('authenticated', p.oid, 'EXECUTE')
         as authenticated_pode_executar
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and p.proname in ('create_sale', 'recalc_sale_totals', 'edit_sale_financials',
                   'apply_stock_entry', 'delete_sale', 'set_updated_at')
order by p.proname, pg_get_function_identity_arguments(p.oid);

-- 6. Inspeção das definições de negócio, sem EXECUTAR nenhuma delas.
-- O SQL Editor pode truncar a célula: abrir/expandir o valor, não inferir
-- ausência de validação a partir de um trecho cortado.
select p.proname as funcao,
       pg_get_function_identity_arguments(p.oid) as assinatura,
       pg_get_functiondef(p.oid) as definicao
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and p.proname in ('create_sale', 'recalc_sale_totals', 'edit_sale_financials',
                   'apply_stock_entry', 'delete_sale')
order by p.proname, pg_get_function_identity_arguments(p.oid);

-- 7. Triggers instalados e habilitados; incluir triggers desconhecidos.
select t.relname as tabela, g.tgname as trigger,
       g.tgenabled as habilitado, p.proname as funcao,
       pg_get_triggerdef(g.oid, true) as definicao
from pg_trigger g
join pg_class t on t.oid = g.tgrelid
join pg_namespace n on n.oid = t.relnamespace
join pg_proc p on p.oid = g.tgfoid
where n.nspname = 'public'
  and not g.tgisinternal
  and t.relname in ('sales', 'sale_items', 'sale_payments', 'stock_moves',
                   'products', 'sale_financial_audit')
order by t.relname, g.tgname;

-- 8. RLS e policies do fluxo, sem ler perfis ou usuários.
select t.relname as tabela, t.relrowsecurity as rls_ativo,
       t.relforcerowsecurity as rls_forcado,
       p.policyname, p.roles, p.cmd, p.qual, p.with_check
from pg_class t
join pg_namespace n on n.oid = t.relnamespace
left join pg_policies p on p.schemaname = n.nspname and p.tablename = t.relname
where n.nspname = 'public'
  and t.relname in ('sales', 'sale_items', 'sale_payments', 'stock_moves',
                   'products', 'sale_financial_audit')
order by t.relname, p.policyname;

-- 9. Integridade financeira agregada, sem expor vendas individuais.
-- Não somar joins de itens e pagamentos diretamente: isso multiplica valores.
-- Valores arredondados a centavos conforme o schema; diferenças >= R$0,01.
-- payment_status esperado reproduz recalc_sale_totals histórico (inclusive
-- total zero). pay legado não é classificado automaticamente como corrupção.
-- Venda sem pagamento pode ter profit=0 do INSERT antigo, antes do primeiro
-- trigger de recálculo: investigar essa contagem, não corrigir automaticamente.
with itens as (
  select sale_id, count(*) as linhas, sum(qty * price) as subtotal,
         sum(qty * cost) as custo
  from public.sale_items group by sale_id
), pagamentos as (
  select sale_id, count(*) as linhas,
         sum(value) as pago, sum(fee_value) as taxas, sum(net_value) as liquido,
         count(distinct method) as formas, min(method) as forma_unica
  from public.sale_payments group by sale_id
), comparacao as (
  select s.discount, s.subtotal, s.total_bruto, s.cost_total,
         s.fee_value, s.net_received, s.profit, s.payment_status, s.pay,
         coalesce(i.linhas, 0) as itens_count,
         coalesce(i.subtotal, 0) as subtotal_itens,
         coalesce(i.custo, 0) as custo_itens,
         coalesce(p.linhas, 0) as pagamentos_count,
         coalesce(p.pago, 0) as pago,
         coalesce(p.taxas, 0) as taxas,
         coalesce(p.liquido, 0) as liquido,
         case when coalesce(p.pago, 0) >= s.total_bruto and s.total_bruto > 0
                then 'Pago'
              when coalesce(p.pago, 0) > 0 then 'Parcial'
              else 'Aberto' end as status_esperado,
         case when coalesce(p.linhas, 0) = 0 then 'Pendente'
              when p.formas = 1 then p.forma_unica else 'Misto' end as forma_esperada
  from public.sales s
  left join itens i on i.sale_id = s.id
  left join pagamentos p on p.sale_id = s.id
)
select count(*) as vendas_analisadas,
       count(*) filter (where itens_count = 0) as sem_itens,
       count(*) filter (where discount < 0 or discount > subtotal)
         as desconto_fora_do_intervalo,
       count(*) filter (where abs(subtotal - subtotal_itens) >= 0.01)
         as subtotal_diverge_dos_itens,
       count(*) filter (where abs(cost_total - custo_itens) >= 0.01)
         as custo_diverge_dos_itens,
       count(*) filter (where abs(total_bruto - greatest(0, subtotal - discount)) >= 0.01)
         as total_diverge_do_desconto,
       count(*) filter (where pago >= total_bruto + 0.01) as pagamento_acima_do_total,
       count(*) filter (where abs(fee_value - taxas) >= 0.01) as taxas_divergentes,
       count(*) filter (where abs(net_received - liquido) >= 0.01) as liquido_divergente,
       count(*) filter (where abs(profit - (liquido - cost_total)) >= 0.01)
         as lucro_divergente,
       count(*) filter (where payment_status <> status_esperado)
         as status_divergente_da_regra_historica,
       count(*) filter (where pay in ('CartaoAVista', 'CartaoParcelado'))
         as formas_legadas_para_revisao,
       count(*) filter (where pay not in ('CartaoAVista', 'CartaoParcelado')
                              and pay <> forma_esperada)
         as forma_divergente_dos_pagamentos,
       count(*) filter (where pagamentos_count = 0) as sem_pagamentos,
       count(*) filter (where total_bruto = 0) as total_zero_para_revisao
from comparacao;

-- 10. Integridade de cada pagamento, apenas contagens.
-- Usa taxa HISTÓRICA salva no pagamento, nunca a configuração atual da maquininha.
select count(*) as pagamentos_analisados,
       count(*) filter (where value <= 0) as valor_nao_positivo,
       count(*) filter (where fee_pct < 0 or fee_pct > 100) as taxa_fora_do_intervalo,
       count(*) filter (where abs(fee_value - round(value * fee_pct / 100, 2)) >= 0.01)
         as taxa_calculada_divergente,
       count(*) filter (where abs(net_value - (value - fee_value)) >= 0.01)
         as liquido_calculado_divergente,
       count(*) filter (where installments < 0) as parcelas_negativas,
       count(*) filter (where method = 'Credito' and installments < 1)
         as credito_sem_parcela_para_revisao,
       count(*) filter (where method in ('PIX', 'Dinheiro') and fee_value <> 0)
         as pix_dinheiro_com_taxa_para_revisao,
       count(*) filter (where paid_on > (now() at time zone 'America/Sao_Paulo')::date)
         as datas_futuras_para_revisao
from public.sale_payments;

-- 11. Relações órfãs e snapshots legados, apenas contagens.
-- Itens históricos importados têm product_id NULL por decisão documentada.
-- Isso não é perda de histórico nem falha de estoque por si só.
select
  (select count(*) from public.sale_items i
     left join public.sales s on s.id = i.sale_id where s.id is null)
    as itens_sem_venda,
  (select count(*) from public.sale_payments p
     left join public.sales s on s.id = p.sale_id where s.id is null)
    as pagamentos_sem_venda,
  (select count(*) from public.sale_items where product_id is null)
    as itens_sem_vinculo_produto_incluindo_legado,
  (select count(*) from public.sales where client_request_id is null)
    as vendas_sem_chave_idempotencia_incluindo_legado,
  (select count(*) from (
     select client_request_id from public.sales where client_request_id is not null
     group by client_request_id having count(*) > 1
   ) repetidas) as chaves_idempotencia_repetidas;

-- 12. Estoque contra o último movimento, preservando produtos SEM movimento.
-- Estoque inicial do cadastro não gera stock_moves: não comparar com SUM(qty).
-- Empates de moved_at+created_at com stock_after distintos são AMBÍGUOS;
-- não inventar ordem cronológica usando UUID e não declarar divergência certa.
with comparacao as (
  select p.stock, ultimo.quantidade, ultimo.menor_estoque, ultimo.maior_estoque
  from public.products p
  left join lateral (
    select count(*) as quantidade, min(m.stock_after) as menor_estoque,
           max(m.stock_after) as maior_estoque
    from (
      select sm.stock_after,
             dense_rank() over (order by sm.moved_at desc, sm.created_at desc) as posicao
      from public.stock_moves sm where sm.product_id = p.id
    ) m where m.posicao = 1
  ) ultimo on true
)
select count(*) as produtos_analisados,
       count(*) filter (where stock < 0) as estoque_negativo,
       count(*) filter (where coalesce(quantidade, 0) = 0) as sem_movimentacao,
       count(*) filter (where coalesce(quantidade, 0) = 0 and stock > 0)
         as estoque_positivo_sem_movimentacao_inicial,
       count(*) filter (where quantidade > 0 and menor_estoque <> maior_estoque)
         as ultimo_movimento_ambiguo_por_empate,
       count(*) filter (where quantidade > 0 and menor_estoque = maior_estoque
                              and stock <> menor_estoque)
         as estoque_diverge_do_ultimo_movimento
from comparacao;

-- 13. Sinais de movimentações inconsistentes, sem notas ou identificação.
select count(*) as movimentos_analisados,
       count(*) filter (where product_id is null) as sem_produto_incluindo_excluidos,
       count(*) filter (where stock_after < 0) as saldo_negativo,
       count(*) filter (where qty = 0) as quantidade_zero,
       count(*) filter (where type = 'SAIDA' and qty > 0) as saida_positiva,
       count(*) filter (where type in ('ENTRADA', 'DEVOLUCAO') and qty < 0)
         as entrada_devolucao_negativa
from public.stock_moves;

-- 14. Mais de uma venda por dia, últimos 90 dias, duas perspectivas.
-- A coluna created_at prova dias com mais de um registro criado; sold_at pode
-- representar uma data histórica importada. Ausência de linhas NÃO prova limite.
-- Nenhuma venda é criada para este teste; só são lidas as já existentes.
with dias as (
  select 'sold_at'::text as campo,
         (sold_at at time zone 'America/Sao_Paulo')::date as dia,
         count(*) as quantidade
  from public.sales where sold_at >= now() - interval '90 days'
  group by (sold_at at time zone 'America/Sao_Paulo')::date
  union all
  select 'created_at'::text,
         (created_at at time zone 'America/Sao_Paulo')::date,
         count(*)
  from public.sales where created_at >= now() - interval '90 days'
  group by (created_at at time zone 'America/Sao_Paulo')::date
)
select campo, dia, quantidade from dias
where quantidade > 1
order by dia desc, campo
limit 60;

-- 15. Verificação opcional de presença da migração nova, sem referenciar coluna
-- ou tabela inexistente. Não substitui testes da RPC em ambiente isolado.
select
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'edit_sale_financials'
            and p.prokind = 'f') as rpc_edicao_presente,
  to_regclass('public.sale_financial_audit') is not null as auditoria_presente,
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'sales'
            and column_name = 'finance_revision') as revisao_financeira_presente;

-- Limites: estas consultas não verificam requests HTTP recusadas, console do
-- navegador ou logs do Supabase. Não consultam nem exportam logs com PII.
-- Contagens divergentes exigem investigação e não autorizam reparo automático.
-- A tabela contas/movimentacoes tem fluxo independente das vendas neste repo;
-- não existe FK que permita afirmar correspondência contábil por venda.
