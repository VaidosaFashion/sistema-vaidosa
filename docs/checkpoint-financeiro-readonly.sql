-- CONTEM DADOS PESSOAIS COMPLETOS: possiveis CPF, contatos, notas e XML fiscal.
-- Nunca enviar resultado ao chat, Library ou repositorio.
-- CHECKPOINT DIRECIONADO PRIVADO; NAO E BACKUP COMPLETO nem restauracao comprovada.
-- Executar este UNICO SELECT inteiro no SQL Editor, antes da migracao, com as
-- escritas do aplicativo/integracoes suspensas. Nenhum objeto/dado e alterado.
-- Baixar o resultado CSV localmente: checkpoint_json, bytes, md5. Nao copiar
-- dados ao chat/repositorio. Validar: python3 tests/verify-financial-checkpoint.py ARQUIVO
-- O verificador confere formato/integridade/completude declarada, nao restauracao.
-- RLS ativa ou objetos novos existentes invalidam o checkpoint PRE-migracao.
-- Uma tabela ausente causa erro SQL (falha fechada). Nao dividir esta consulta:
-- todos os dados/catalogos sao lidos no mesmo snapshot de uma unica instrucao.
-- auth.users, senhas, tokens, Storage, secrets, demais schemas/tabelas e estado
-- de sequencias NAO sao exportados. FKs para auth.users continuam dependencia
-- externa; estes arquivos nao permitem recriar o projeto inteiro.
with
required(name) as (values
  ('sales'),('sale_items'),('sale_payments'),('products'),('stock_moves'),
  ('profiles'),('store_settings'),('nfce_emissions'),('clients'),('vendedores'),('colors')
),
data(name, row_count, rows) as (
  select 'sales',count(*),coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from public.sales t
  union all select 'sale_items',count(*),coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from public.sale_items t
  union all select 'sale_payments',count(*),coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from public.sale_payments t
  union all select 'products',count(*),coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from public.products t
  union all select 'stock_moves',count(*),coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from public.stock_moves t
  union all select 'profiles',count(*),coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from public.profiles t
  union all select 'store_settings',count(*),coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from public.store_settings t
  union all select 'nfce_emissions',count(*),coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from public.nfce_emissions t
  union all select 'clients',count(*),coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from public.clients t
  union all select 'vendedores',count(*),coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from public.vendedores t
  union all select 'colors',count(*),coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from public.colors t
),
table_objects as (
  select r.name,c.oid,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,
    (pt.tablename is not null and c.relkind='r') as present
  from required r left join pg_namespace n on n.nspname='public'
  left join pg_class c on c.relnamespace=n.oid and c.relname=r.name
  left join pg_tables pt on pt.schemaname='public' and pt.tablename=r.name
),
table_export as (
  select o.name,jsonb_build_object(
    'exists',o.present,'owner',pg_get_userbyid(o.relowner),'acl',to_jsonb(o.relacl),
    'rls_enabled',o.relrowsecurity,'rls_forced',o.relforcerowsecurity,
    'row_security_active',row_security_active(o.oid),'count',d.row_count,'rows',d.rows,
    'columns',coalesce((select jsonb_agg(jsonb_build_object(
      'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
      'not_null',a.attnotnull,'default',pg_get_expr(ad.adbin,ad.adrelid),
      'acl',to_jsonb(a.attacl),'identity',a.attidentity,'generated',a.attgenerated
    ) order by a.attnum) from pg_attribute a left join pg_attrdef ad
      on ad.adrelid=a.attrelid and ad.adnum=a.attnum
      where a.attrelid=o.oid and a.attnum>0 and not a.attisdropped),'[]'),
    'constraints',coalesce((select jsonb_agg(jsonb_build_object(
      'name',k.conname,'type',k.contype,'definition',pg_get_constraintdef(k.oid,true),
      'validated',k.convalidated,'referenced_table',k.confrelid::regclass::text
    ) order by k.conname) from pg_constraint k where k.conrelid=o.oid),'[]'),
    'indexes',coalesce((select jsonb_agg(jsonb_build_object(
      'name',ic.relname,'definition',pg_get_indexdef(i.indexrelid),
      'valid',i.indisvalid,'ready',i.indisready
    ) order by ic.relname) from pg_index i join pg_class ic on ic.oid=i.indexrelid
      where i.indrelid=o.oid),'[]'),
    'triggers',coalesce((select jsonb_agg(jsonb_build_object(
      'name',t.tgname,'definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled,
      'internal',t.tgisinternal,'function',t.tgfoid::regprocedure::text
    ) order by t.tgname) from pg_trigger t where t.tgrelid=o.oid),'[]'),
    'policies',coalesce((select jsonb_agg(jsonb_build_object(
      'name',p.policyname,'permissive',p.permissive,'roles',to_jsonb(p.roles),
      'command',p.cmd,'using',p.qual,'with_check',p.with_check
    ) order by p.policyname) from pg_policies p where p.schemaname='public' and p.tablename=o.name),'[]')
  ) as value from table_objects o join data d on d.name=o.name
),
function_names(signature) as (values
  ('public.create_sale(uuid,uuid,uuid,text,text,text,smallint,numeric,text,jsonb,text)'),
  ('public.delete_sale(uuid)'),('public.apply_stock_entry(uuid,integer,text,text,numeric)'),
  ('public.recalc_sale_totals()'),('public.set_updated_at()')
),
payload as (
  select jsonb_build_object(
    'format','vaidosa-financial-checkpoint-v1','full_backup',false,
    'snapshot',pg_current_snapshot()::text,'captured_at',statement_timestamp(),
    'context',jsonb_build_object('database',current_database(),'current_user',current_user,
      'session_user',session_user,'server_version',current_setting('server_version'),
      'server_encoding',current_setting('server_encoding')),
    'external_dependencies',jsonb_build_array(
      'auth.users: IDs referenciados; usuarios, senhas e tokens nao exportados',
      'Demais tabelas/schemas, sequencias, Storage, secrets e configuracao do projeto nao exportados',
      'Formato validado nao significa recuperacao integral testada; MD5 detecta dano, nao autentica origem',
      'O snapshot nao impede escritas posteriores; manter pausa e comparar antes da instalacao'),
    'tables',(select jsonb_object_agg(name,value order by name) from table_export),
    'functions',(select coalesce(jsonb_agg(jsonb_build_object(
      'schema',n.nspname,'name',p.proname,'identity_args',pg_get_function_identity_arguments(p.oid),
      'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),
      'acl',to_jsonb(p.proacl),'config',to_jsonb(p.proconfig)
    ) order by p.proname),'[]') from function_names f
      join pg_proc p on p.oid=to_regprocedure(f.signature) join pg_namespace n on n.oid=p.pronamespace),
    'private_schema',jsonb_build_object(
      'exists',exists(select 1 from pg_namespace where nspname='vaidosa_private'),
      'owner',(select pg_get_userbyid(nspowner) from pg_namespace where nspname='vaidosa_private'),
      'acl',(select to_jsonb(nspacl) from pg_namespace where nspname='vaidosa_private')),
    'new_objects',jsonb_build_object(
      'finance_revision',exists(select 1 from pg_attribute where attrelid='public.sales'::regclass
        and attname='finance_revision' and not attisdropped),
      'sale_financial_audit',to_regclass('public.sale_financial_audit') is not null,
      'sale_financial_requests',to_regclass('vaidosa_private.sale_financial_requests') is not null,
      'public_edit_sale_financials',exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='edit_sale_financials'),
      'private_functions',exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='vaidosa_private' and p.proname in ('sale_financial_snapshot',
          'sale_financial_audit_snapshot','lock_payment_sale','bump_sale_finance_revision','edit_sale_financials')),
      'sale_payments_lock_sale',exists(select 1 from pg_trigger where tgrelid='public.sale_payments'::regclass
        and tgname='sale_payments_lock_sale'),
      'sales_finance_revision',exists(select 1 from pg_trigger where tgrelid='public.sales'::regclass
        and tgname='sales_finance_revision')),
    'roles',(select coalesce(jsonb_agg(jsonb_build_object('name',rolname,'superuser',rolsuper,
      'inherit',rolinherit,'bypass_rls',rolbypassrls) order by rolname),'[]') from pg_roles),
    'memberships',(select coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object(
      'role_name',pg_get_userbyid(m.roleid),'member_name',pg_get_userbyid(m.member),
      'grantor_name',pg_get_userbyid(m.grantor)) order by m.roleid,m.member),'[]') from pg_auth_members m),
    'default_acls',(select coalesce(jsonb_agg(jsonb_build_object('owner',pg_get_userbyid(a.defaclrole),
      'schema',n.nspname,'object_type',a.defaclobjtype,'acl',to_jsonb(a.defaclacl))
      order by a.defaclrole,a.defaclnamespace,a.defaclobjtype),'[]') from pg_default_acl a
      left join pg_namespace n on n.oid=a.defaclnamespace),
    'event_triggers',(select coalesce(jsonb_agg(jsonb_build_object('name',e.evtname,
      'owner',pg_get_userbyid(e.evtowner),'event',e.evtevent,'enabled',e.evtenabled,
      'tags',to_jsonb(e.evttags),'function',e.evtfoid::regprocedure::text) order by e.evtname),'[]')
      from pg_event_trigger e)
  )::text as checkpoint_json
)
select checkpoint_json,octet_length(convert_to(checkpoint_json,'UTF8')) as bytes,
  md5(convert_to(checkpoint_json,'UTF8')) as md5 from payload;
