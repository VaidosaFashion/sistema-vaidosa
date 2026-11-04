-- Grants observados por export manual do usuário em 04/11/2026.
-- Não altera linhas, políticas, FKs ou triggers. Preserva os privilégios
-- efetivos de tabela de service_role, inclusive quando vinham de PUBLIC.
-- Mantém o modelo de loja compartilhada; não é uma reforma completa de RLS.
begin;

do $$
declare t record; v_columns text; v_service_privs text; v_priv text;
begin
  for t in select c.oid,c.relname from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in (
      'sales','sale_items','sale_payments','products','stock_moves',
      'profiles','store_settings','nfce_emissions'
    ) and c.relkind='r'
  loop
    -- PUBLIC também é herdado pelo backend. Conserva os privilégios efetivos
    -- de tabela de service_role, sem presumir de onde vieram os grants.
    v_service_privs := null;
    if exists(select 1 from pg_roles where rolname='service_role') then
      select string_agg(p,', ') into v_service_privs
      from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
      where has_table_privilege('service_role',t.oid,p);
      foreach v_priv in array array['SELECT','INSERT','UPDATE','REFERENCES'] loop
        if has_any_column_privilege('service_role',t.oid,v_priv)
           and not has_table_privilege('service_role',t.oid,v_priv) then
          raise exception 'Grants de backend por coluna em %; revisar antes de reduzir PUBLIC',t.relname;
        end if;
      end loop;
    end if;
    -- Grants por coluna não desaparecem ao revogar o grant da tabela.
    select string_agg(quote_ident(a.attname),', ' order by a.attnum)
      into v_columns from pg_attribute a
      where a.attrelid=t.oid and a.attnum>0 and not a.attisdropped;
    execute format('revoke all privileges (%s) on table public.%I from public, anon, authenticated',v_columns,t.relname);
    execute format('revoke all on table public.%I from public, anon, authenticated',t.relname);
    if v_service_privs is not null then
      execute format('grant %s on table public.%I to service_role',v_service_privs,t.relname);
    end if;
  end loop;
end $$;

grant select on public.profiles to anon, authenticated;
grant select, update on public.sales to authenticated;
grant select on public.sale_items to authenticated;
grant select, insert on public.sale_payments to authenticated;
grant select, insert, update, delete on public.products to authenticated;
grant select, insert on public.stock_moves to authenticated;
grant select, insert, update on public.store_settings to authenticated;
do $$ begin
  if to_regclass('public.nfce_emissions') is not null then
    grant select on public.nfce_emissions to authenticated;
  end if;
end $$;

-- Impede sucesso aparente se privilégios herdados de OUTRO papel ainda
-- permitirem ações removidas. Nesse caso toda esta transação é revertida.
do $$
declare t record; v_role text; v_priv text; v_forbidden text; v_forbidden_columns text;
begin
  for t in select c.oid,c.relname from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in (
      'sales','sale_items','sale_payments','products','stock_moves',
      'profiles','store_settings','nfce_emissions'
    ) and c.relkind='r'
  loop
    foreach v_role in array array['anon','authenticated'] loop
      foreach v_priv in array array['TRUNCATE','TRIGGER','REFERENCES'] loop
        if has_table_privilege(v_role,t.oid,v_priv) then
          raise exception 'Privilégio herdado inesperado: % % em %; revisar memberships',v_role,v_priv,t.relname;
        end if;
      end loop;
      if has_any_column_privilege(v_role,t.oid,'REFERENCES') then
        raise exception 'REFERENCES herdado por coluna: % em %',v_role,t.relname;
      end if;
    end loop;
    if has_table_privilege('anon',t.oid,'INSERT,UPDATE,DELETE')
       or has_any_column_privilege('anon',t.oid,'INSERT,UPDATE,REFERENCES')
       or (t.relname<>'profiles' and has_any_column_privilege('anon',t.oid,'SELECT')) then
      raise exception 'Acesso anônimo herdado inesperado em %',t.relname;
    end if;
    v_forbidden := case t.relname
      when 'sales' then 'INSERT,DELETE'
      when 'sale_payments' then 'UPDATE,DELETE'
      when 'sale_items' then 'INSERT,UPDATE,DELETE'
      when 'profiles' then 'INSERT,UPDATE,DELETE'
      when 'nfce_emissions' then 'INSERT,UPDATE,DELETE'
      when 'stock_moves' then 'UPDATE,DELETE'
      when 'store_settings' then 'DELETE' else null end;
    v_forbidden_columns := case t.relname
      when 'sales' then 'INSERT'
      when 'sale_payments' then 'UPDATE'
      when 'sale_items' then 'INSERT,UPDATE'
      when 'profiles' then 'INSERT,UPDATE'
      when 'nfce_emissions' then 'INSERT,UPDATE'
      when 'stock_moves' then 'UPDATE' else null end;
    if (v_forbidden is not null and has_table_privilege('authenticated',t.oid,v_forbidden))
       or (v_forbidden_columns is not null and has_any_column_privilege('authenticated',t.oid,v_forbidden_columns)) then
      raise exception 'Escrita herdada inesperada em %; revisar memberships',t.relname;
    end if;
  end loop;
  if has_table_privilege('authenticated','public.sales','INSERT,DELETE')
     or has_any_column_privilege('authenticated','public.sales','INSERT')
     or has_table_privilege('authenticated','public.sale_payments','UPDATE,DELETE')
     or has_any_column_privilege('authenticated','public.sale_payments','UPDATE') then
    raise exception 'Escrita financeira herdada inesperada; revisar memberships';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
