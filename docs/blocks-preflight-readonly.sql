-- NÃO instala nada. Executar futuramente no projeto correto, para revisão de metadata.
-- O checkpoint anterior não contém contas/movimentacoes. Nenhum dado de cliente é lido.
begin transaction read only;
select jsonb_build_object(
 'captured_at',clock_timestamp(),'server_version',current_setting('server_version'),
 'tables',(select jsonb_agg(jsonb_build_object('table',t.table_name,'columns',(
   select jsonb_agg(jsonb_build_object('name',c.column_name,'type',c.data_type,'udt',c.udt_name,'nullable',c.is_nullable) order by c.ordinal_position)
   from information_schema.columns c where c.table_schema='public' and c.table_name=t.table_name)))
   from information_schema.tables t where t.table_schema='public' and t.table_name in ('contas','movimentacoes','v_contas','categorias')),
 'constraints',(select jsonb_agg(jsonb_build_object('table',c.conrelid::regclass::text,'name',c.conname,'definition',pg_get_constraintdef(c.oid)))
   from pg_constraint c where c.conrelid in ('public.contas'::regclass,'public.movimentacoes'::regclass)),
 'policies',(select jsonb_agg(to_jsonb(p)) from pg_policies p where p.schemaname='public' and p.tablename in ('contas','movimentacoes')),
 'table_grants',(select jsonb_agg(to_jsonb(g)) from information_schema.table_privileges g where table_schema='public' and table_name in ('contas','movimentacoes','v_contas')),
 'explicit_column_grants',(select jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,'grantee',x.grantee::regrole::text,'privilege',x.privilege_type))
   from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid
   cross join lateral aclexplode(a.attacl) x where n.nspname='public' and c.relname in ('contas','movimentacoes') and a.attnum>0),
 'triggers',(select jsonb_agg(jsonb_build_object('table',t.tgrelid::regclass::text,'name',t.tgname,'definition',pg_get_triggerdef(t.oid)))
   from pg_trigger t where t.tgrelid in ('public.contas'::regclass,'public.movimentacoes'::regclass) and not t.tgisinternal),
 'view_definition',pg_get_viewdef('public.v_contas'::regclass,true),
 'create_conta',(select jsonb_agg(jsonb_build_object('signature',pg_get_function_identity_arguments(p.oid),'hash',md5(pg_get_functiondef(p.oid)),'security_definer',p.prosecdef))
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_conta'),
 'already_installed',to_regprocedure('public.settle_account(uuid,uuid,bigint,date)') is not null
) as metadata;
commit;
