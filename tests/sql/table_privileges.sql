\set ON_ERROR_STOP on
begin;
do $$ declare v_table text; v_role text; begin
  foreach v_table in array array['sales','sale_items','sale_payments','products',
    'stock_moves','store_settings','profiles','nfce_emissions'] loop
    foreach v_role in array array['anon','authenticated'] loop
      assert not has_table_privilege(v_role,'public.'||v_table,'TRUNCATE,TRIGGER,REFERENCES'),
        'papel do app sem privilégios administrativos: '||v_role||' '||v_table;
    end loop;
    assert not has_table_privilege('anon','public.'||v_table,'INSERT,UPDATE,DELETE'),
      'anon sem escrita';
    assert not has_any_column_privilege('anon','public.'||v_table,'INSERT,UPDATE,REFERENCES'),
      'anon sem escrita por coluna';
  end loop;
  assert has_table_privilege('anon','public.profiles','SELECT'),'login mantém listagem';
  assert has_table_privilege('service_role','public.products','SELECT'),'backend mantém privilégio antes herdado de PUBLIC';
  assert has_table_privilege('authenticated','public.sale_payments','INSERT'),'registro de pagamento mantido';
  assert not has_table_privilege('authenticated','public.sales','INSERT,DELETE'),'vendas via RPC';
  assert not has_table_privilege('authenticated','public.sale_items','INSERT,UPDATE,DELETE'),'itens via RPC';
  assert not has_table_privilege('authenticated','public.sale_payments','UPDATE,DELETE'),'correção via RPC';
  assert not has_any_column_privilege('authenticated','public.sale_payments','UPDATE'),'sem grant por coluna';
  assert has_table_privilege('authenticated','public.sales','UPDATE'),'recálculo e metadados mantidos';
end $$;
set local role anon;
do $$ declare v_denied boolean:=false; begin
  begin truncate public.store_settings;
  exception when insufficient_privilege then v_denied:=true; end;
  assert v_denied,'TRUNCATE anon rejeitado';
end $$;
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$ declare v_denied boolean; begin
  v_denied:=false;
  begin truncate public.store_settings;
  exception when insufficient_privilege then v_denied:=true; end;
  assert v_denied,'TRUNCATE authenticated rejeitado';
  v_denied:=false;
  begin delete from public.sales where id='00000000-0000-4000-8000-000000000010';
  exception when insufficient_privilege then v_denied:=true; end;
  assert v_denied,'DELETE direto venda rejeitado';
  v_denied:=false;
  begin update public.sale_payments set value=1 where id='00000000-0000-4000-8000-000000000020';
  exception when insufficient_privilege then v_denied:=true; end;
  assert v_denied,'UPDATE direto pagamento rejeitado';
  raise notice 'PASS: grants mínimos, login preservado, TRUNCATE e DML financeiro direto bloqueados';
end $$;
rollback;
