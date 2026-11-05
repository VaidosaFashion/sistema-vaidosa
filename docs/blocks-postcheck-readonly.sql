-- Apenas metadata; não cria uma operação financeira de teste na loja.
begin transaction read only;
with rpc(signature) as (values
 ('public.create_account_v2(uuid,jsonb)'),('public.settle_account(uuid,uuid,bigint,date)'),
 ('public.edit_account(uuid,uuid,bigint,jsonb)'),('public.reverse_account_settlement(uuid,uuid,uuid,bigint,text)'),
 ('public.archive_account(uuid,uuid,bigint,text)'),('public.get_account_request_status(uuid,text,jsonb)'),
 ('public.apply_stock_entry_v2(uuid,uuid,integer,text,text,numeric)'),('public.get_stock_entry_request(uuid,jsonb)'))
select jsonb_build_object('rpc',(select jsonb_agg(jsonb_build_object('signature',signature,'exists',to_regprocedure(signature) is not null,
 'anon_blocked',case when to_regprocedure(signature) is null then false else not has_function_privilege('anon',to_regprocedure(signature),'EXECUTE') end,
 'staff_allowed',case when to_regprocedure(signature) is null then false else has_function_privilege('authenticated',to_regprocedure(signature),'EXECUTE') end)) from rpc),
 'accounts_revision',exists(select 1 from information_schema.columns where table_schema='public' and table_name='contas' and column_name='operation_revision'),
 'movement_reversal',exists(select 1 from information_schema.columns where table_schema='public' and table_name='movimentacoes' and column_name='reversed_at'),
 'audit_rls',(select relrowsecurity from pg_class where oid=to_regclass('public.account_audit')),
 'private_schema_exposure','Conferir no dashboard: vaidosa_private não pode estar em Exposed Schemas',
 'direct_account_writes_blocked',not has_table_privilege('authenticated','public.contas','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER'),
 'direct_movement_writes_blocked',not has_table_privilege('authenticated','public.movimentacoes','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
) as checks;
commit;
