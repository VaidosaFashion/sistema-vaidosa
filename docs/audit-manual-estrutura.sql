-- Próximo passo manual: somente catálogos, sem executar funções de negócio.
-- Projeto: vaidosa-sistema (ysultkzfhgtyujbomfqz). Exportar resultado completo.
with alvos(tabela) as (
  values ('sales'), ('sale_payments'), ('sale_items'), ('products'),
         ('profiles'), ('stock_moves'), ('store_settings')
), tabelas as (
  select a.tabela, c.oid, c.relrowsecurity, c.relforcerowsecurity
  from alvos a left join pg_class c
    on c.oid = to_regclass(format('public.%I', a.tabela))
)
select t.tabela, t.oid is not null as existe,
  t.relrowsecurity as rls_ativo, t.relforcerowsecurity as rls_forcado,
  (select jsonb_agg(jsonb_build_object(
     'nome', p.policyname, 'papeis', p.roles, 'comando', p.cmd,
     'permissiva', p.permissive, 'using', p.qual, 'with_check', p.with_check
   ) order by p.policyname)
   from pg_policies p where p.schemaname='public' and p.tablename=t.tabela
  ) as politicas,
  (select jsonb_agg(jsonb_build_object(
     'nome', c.conname, 'validada', c.convalidated,
     'definicao', pg_get_constraintdef(c.oid, true)
   ) order by c.conname)
   from pg_constraint c where c.conrelid=t.oid
  ) as restricoes,
  (select jsonb_agg(jsonb_build_object(
     'nome', i.relname, 'unico', x.indisunique, 'valido', x.indisvalid,
     'definicao', pg_get_indexdef(x.indexrelid)
   ) order by i.relname)
   from pg_index x join pg_class i on i.oid=x.indexrelid where x.indrelid=t.oid
  ) as indices,
  (select jsonb_object_agg(r.papel, (
     select coalesce(jsonb_agg(p.privilegio order by p.privilegio), '[]'::jsonb)
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(privilegio)
     where has_table_privilege(r.papel, t.oid, p.privilegio)
   )) from (values ('anon'::text), ('authenticated'::text)) r(papel)
   where t.oid is not null
  ) as permissoes_de_tabela,
  (select jsonb_agg(a.attname order by a.attnum)
   from pg_attribute a where a.attrelid=t.oid and a.attnum>0
     and not a.attisdropped and a.attnotnull
  ) as colunas_not_null
from tabelas t order by t.tabela;
