-- Somente metadados. Todas as verificações devem retornar true.
select
  to_regprocedure('public.edit_sale_financials(uuid,uuid,bigint,numeric,jsonb,text)') is not null as rpc_presente,
  to_regclass('public.sale_financial_audit') is not null as historico_presente,
  exists(select 1 from information_schema.columns where table_schema='public'
    and table_name='sales' and column_name='finance_revision') as revisao_presente,
  exists(select 1 from information_schema.columns where table_schema='public'
    and table_name='sales' and column_name='buyer_cpf_nfce') as cpf_preservado,
  exists(select 1 from pg_trigger where tgrelid='public.sale_payments'::regclass
    and tgname='sale_payments_lock_sale' and tgenabled='O') as serializacao_ativa,
  exists(select 1 from pg_trigger where tgrelid='public.sales'::regclass
    and tgname='sales_finance_revision' and tgenabled='O') as revisao_ativa,
  exists(select 1 from pg_constraint where conrelid='public.nfce_emissions'::regclass
    and conname='nfce_emissions_sale_id_fkey' and confdeltype='c') as relacao_fiscal_preservada,
  not has_table_privilege('authenticated','public.sale_payments','UPDATE,DELETE') as pagamento_direto_bloqueado,
  not has_any_column_privilege('authenticated','public.sale_payments','UPDATE') as pagamento_por_coluna_bloqueado,
  not has_table_privilege('authenticated','public.sales','INSERT,DELETE') as criacao_exclusao_so_rpc,
  has_table_privilege('anon','public.profiles','SELECT') as lista_login_preservada;

with esperado(assinatura) as (values
  ('public.create_sale(uuid,uuid,uuid,text,text,text,smallint,numeric,text,jsonb,text)'),
  ('public.delete_sale(uuid)'),
  ('public.apply_stock_entry(uuid,integer,text,text,numeric)'),
  ('public.edit_sale_financials(uuid,uuid,bigint,numeric,jsonb,text)')
)
select assinatura, to_regprocedure(assinatura) is not null as existe,
  coalesce(not has_function_privilege('anon',to_regprocedure(assinatura),'EXECUTE'),false) as anon_bloqueado,
  coalesce(has_function_privilege('authenticated',to_regprocedure(assinatura),'EXECUTE'),false) as funcionario_pode_chamar
from esperado order by assinatura;

with esperado(tabela) as (values ('sales'),('sale_items'),('sale_payments'),
  ('products'),('stock_moves'),('profiles'),('store_settings'),('nfce_emissions'))
select e.tabela, r.papel, c.oid is not null as existe,
  coalesce(not has_table_privilege(r.papel,c.oid,'TRUNCATE,TRIGGER,REFERENCES')
    and not has_any_column_privilege(r.papel,c.oid,'REFERENCES'),false) as privilegios_administrativos_removidos
from esperado e left join pg_class c on c.oid=to_regclass(format('public.%I',e.tabela))
cross join (values('anon'::text),('authenticated'::text)) r(papel)
order by e.tabela,r.papel;
