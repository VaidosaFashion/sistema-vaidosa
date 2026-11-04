\set ON_ERROR_STOP on
-- Executado exclusivamente pelo runner em cluster descartável, antes do fix.
-- Prova o risco do grant no SQL; não demonstra que a API HTTP exponha TRUNCATE.
begin;
set local role anon;
truncate public.store_settings;
reset role;
do $$ begin
  assert (select count(*) from public.store_settings)=0,
    'TRUNCATE concedido não é filtrado por políticas de linha';
  raise notice 'PASS: risco de TRUNCATE reproduzido só em fixture local e revertido';
end $$;
rollback;
