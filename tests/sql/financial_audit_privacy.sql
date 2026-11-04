\set ON_ERROR_STOP on
-- Somente dados sintéticos no cluster descartável; rollback inclui o schema.
begin;
alter table public.sales add column if not exists buyer_cpf_nfce text;
alter table public.sales add column future_unrelated_test text;
alter table public.sale_payments add column future_unrelated_test text;
set local request.jwt.claim.sub = '';

do $$
declare
  v_sale uuid := gen_random_uuid(); v_payment uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid(); v_request uuid := gen_random_uuid();
  v_before_sale jsonb; v_after_sale jsonb; v_result jsonb; v_audit jsonb;
  v_revision bigint; v_payments jsonb; v_entry jsonb;
  v_financial_keys text[] := array['discount','total_bruto','fee_pct','fee_value',
    'net_received','profit','payment_status','pay','installments','finance_revision','updated_at'];
  v_audit_keys text[] := array['id','finance_revision','subtotal','discount','total_bruto',
    'cost_total','fee_pct','fee_value','net_received','profit','payment_status','pay','installments','sale_payments'];
  v_payment_keys text[] := array['id','paid_on','value','method','installments',
    'fee_pct','fee_value','net_value','note'];
begin
  insert into public.clients(id,name) values(v_client,'Cliente sintético da privacidade');
  insert into public.sales(id,client_id,channel,kind,pay,subtotal,total_bruto,cost_total,
    buyer_cpf_nfce,future_unrelated_test,note)
    values(v_sale,v_client,'Loja','Venda','Pendente',100,100,20,
      '00000000000','CAMPO_FUTURO_VENDA_NAO_AUDITAR','OBS_VENDA_NAO_AUDITAR');
  insert into public.sale_payments(id,sale_id,value,method,net_value,paid_on,note,future_unrelated_test)
    values(v_payment,v_sale,100,'PIX',100,'2026-11-04','Observação financeira original','CAMPO_FUTURO_PAGAMENTO_NAO_AUDITAR');
  insert into public.sale_items(sale_id,name,price,cost,qty)
    values(v_sale,'ITEM_NAO_AUDITAR',100,20,1);
  select to_jsonb(s),finance_revision into v_before_sale,v_revision from public.sales s where id=v_sale;
  v_payments:=jsonb_build_array(jsonb_build_object('id',v_payment,'paid_on','2026-11-04',
    'value',80,'method','PIX','installments',0,'note','Observação financeira corrigida'));
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
  v_result:=public.edit_sale_financials(v_sale,v_request,v_revision,20,v_payments,'Desconto com CPF preservado');
  select to_jsonb(s) into v_after_sale from public.sales s where id=v_sale;
  assert v_before_sale-v_financial_keys=v_after_sale-v_financial_keys,
    'correção preserva todas as colunas não financeiras, incluindo CPF e campos futuros';
  assert v_result->>'buyer_cpf_nfce'='00000000000' and
    v_result->>'future_unrelated_test'='CAMPO_FUTURO_VENDA_NAO_AUDITAR' and
    v_result->>'client_id'=v_client::text and v_result->>'note'='OBS_VENDA_NAO_AUDITAR',
    'resposta RPC completa continua compatível';
  assert v_result->'sale_payments'->0->>'future_unrelated_test'='CAMPO_FUTURO_PAGAMENTO_NAO_AUDITAR',
    'coluna futura de pagamento preservada e retornada';
  assert v_result->'sale_items'->0->>'name'='ITEM_NAO_AUDITAR','itens continuam na resposta';
  for v_audit in select before_data from public.sale_financial_audit where request_id=v_request
    union all select after_data from public.sale_financial_audit where request_id=v_request loop
    assert v_audit-v_audit_keys='{}'::jsonb, 'snapshot só permite campos financeiros conhecidos';
    assert not (v_audit ?| array['buyer_cpf_nfce','future_unrelated_test','client_id','note','sale_items']),
      'auditoria não copia CPF, cliente, observação da venda, itens ou futuras colunas';
    for v_entry in select value from jsonb_array_elements(v_audit->'sale_payments') loop
      assert v_entry-v_payment_keys='{}'::jsonb, 'pagamento na auditoria tem lista explícita';
      assert not (v_entry ?| array['future_unrelated_test','created_by','created_at','sale_id']),
        'auditoria não copia metadados extras do pagamento';
    end loop;
  end loop;
  assert (select before_data->'sale_payments'->0->>'note'='Observação financeira original'
    and after_data->'sale_payments'->0->>'note'='Observação financeira corrigida'
    and (before_data->>'total_bruto')::numeric=100 and (after_data->>'total_bruto')::numeric=80
    from public.sale_financial_audit where request_id=v_request), 'histórico financeiro continua útil';
  raise notice 'PASS: CPF e futuras colunas preservados; auditoria restrita a campos financeiros';
end $$;
rollback;
