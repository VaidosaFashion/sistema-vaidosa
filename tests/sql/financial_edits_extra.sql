\set ON_ERROR_STOP on
set request.jwt.claim.sub = '';
insert into public.sales(id,channel,kind,pay,subtotal,total_bruto,cost_total) values
 ('00000000-0000-4000-8000-000000000030','Loja','Venda','Pendente',100,100,20);
insert into public.sale_payments(id,sale_id,value,method,installments,fee_pct,fee_value,net_value,paid_on)
 values('00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000030',40,'Credito',2,5,1.99,38.01,'2026-10-01');
-- Simula rótulo histórico desatualizado sem alterar os pagamentos.
update public.sales set pay='CartaoParcelado', installments=0, fee_pct=0
 where id='00000000-0000-4000-8000-000000000030';
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
set role authenticated;
do $$
declare v_sale uuid:='00000000-0000-4000-8000-000000000030';
  v_payments jsonb; v_rev bigint; v_result jsonb; v_error boolean;
begin
  select jsonb_agg(jsonb_build_object('id',id,'paid_on',paid_on,'value',value,
    'method',method,'installments',installments,'note',note)) into v_payments
    from public.sale_payments where sale_id=v_sale;
  select finance_revision into v_rev from public.sales where id=v_sale;
  v_result:=public.edit_sale_financials(v_sale,gen_random_uuid(),v_rev,10,v_payments,'Somente desconto');
  assert v_result->>'pay'='Credito' and (v_result->>'installments')::int=2, 'deriva forma historica';
  assert (v_result->>'fee_pct')::numeric=.0498, 'taxa agregada real';
  assert v_result->>'payment_status'='Parcial', 'parcial';
  v_rev:=(v_result->>'finance_revision')::bigint;
  v_payments:=jsonb_set(v_payments,'{0,note}','"Só observação"');
  v_result:=public.edit_sale_financials(v_sale,gen_random_uuid(),v_rev,10,v_payments,'Corrigir observação');
  assert (v_result->>'net_received')::numeric=38.01, 'nota não reprecifica histórico';
  v_rev:=(v_result->>'finance_revision')::bigint;
  v_payments:=jsonb_set(v_payments,'{0,installments}','3');
  v_result:=public.edit_sale_financials(v_sale,gen_random_uuid(),v_rev,10,v_payments,'Mudar parcelas');
  assert (v_result->>'fee_value')::numeric=2.80 and (v_result->>'net_received')::numeric=37.20, 'taxa atual arredondada';
  v_rev:=(v_result->>'finance_revision')::bigint;
  -- Repetir INSERT com mesmo ID via ON CONFLICT não lança/recobra nada.
  insert into public.sale_payments(id,sale_id,value,method,net_value) values
   ('00000000-0000-4000-8000-000000000031',v_sale,40,'PIX',40) on conflict(id) do nothing;
  assert (select finance_revision from public.sales where id=v_sale)=v_rev, 'insert retry sem revisão';
  -- Usuário do app não pode contornar a RPC alterando recebimentos diretamente.
  v_error:=false;
  begin update public.sale_payments set paid_on='2026-10-04' where sale_id=v_sale;
  exception when insufficient_privilege then v_error:=true; end;
  assert v_error, 'UPDATE direto de pagamento negado';
  assert (select finance_revision from public.sales where id=v_sale)=v_rev, 'operação negada não muda revisão';
  -- Pagamento novo acima do saldo é negado no servidor.
  v_error:=false;
  begin insert into public.sale_payments(sale_id,value,method,net_value) values(v_sale,51,'PIX',51);
  exception when invalid_parameter_value then v_error:=true; end;
  assert v_error, 'novo pagamento acima saldo';
  raise notice 'PASS: parcial, desconto isolado, taxa histórica, novas parcelas, retry INSERT e UPDATE direto negado';
end $$;
reset role;
-- Manutenção externa pelo owner também invalida uma correção aberta.
-- Não concede UPDATE ao papel da aplicação para simular esse cenário.
do $$
declare v_sale uuid:='00000000-0000-4000-8000-000000000030';
  v_rev bigint; v_payments jsonb; v_error boolean:=false;
begin
  select finance_revision into v_rev from public.sales where id=v_sale;
  select jsonb_agg(jsonb_build_object('id',id,'paid_on',paid_on,'value',value,
    'method',method,'installments',installments,'note',note)) into v_payments
    from public.sale_payments where sale_id=v_sale;
  update public.sale_payments set paid_on='2026-10-04' where sale_id=v_sale;
  assert (select finance_revision from public.sales where id=v_sale)>v_rev, 'manutenção externa invalida';
  begin perform public.edit_sale_financials(v_sale,gen_random_uuid(),v_rev,10,v_payments,'Formulário antigo');
  exception when serialization_failure then v_error:=true; end;
  assert v_error, 'revisão antiga após manutenção externa';
end $$;
-- Schema fiscal vem de observed_schema.sql. Fixture do owner informa todos os
-- campos obrigatórios: os defaults reais não foram fornecidos na metadata.
insert into public.nfce_emissions(id,sale_id,numero,serie,ambiente,status,log,created_at,updated_at)
 values(gen_random_uuid(),'00000000-0000-4000-8000-000000000030',30,1,'homologacao','authorized','[]',now(),now());
do $$
declare v_state text; v_error boolean; v_rev bigint; v_payments jsonb;
  v_sale uuid:='00000000-0000-4000-8000-000000000030';
begin
  select finance_revision into v_rev from public.sales where id=v_sale;
  select jsonb_agg(jsonb_build_object('id',id,'paid_on',paid_on,'value',value,
    'method',method,'installments',installments,'note',note)) into v_payments
    from public.sale_payments where sale_id=v_sale;
  foreach v_state in array array['authorized','transmitted','pending','error'] loop
    update public.nfce_emissions set status=v_state where sale_id=v_sale;
    v_error:=false;
    begin perform public.edit_sale_financials(v_sale,gen_random_uuid(),v_rev,11,v_payments,'Correção fiscal bloqueada');
    exception when invalid_parameter_value then v_error:=true; end;
    assert v_error, 'fiscal bloqueado: '||v_state;
    assert (select finance_revision from public.sales where id=v_sale)=v_rev, 'fiscal rollback';
  end loop;
  -- Estados inexistentes e NULL são recusados pelo schema real antes da RPC.
  foreach v_state in array array['processing','unknown','',null] loop
    v_error:=false;
    begin update public.nfce_emissions set status=v_state where sale_id=v_sale;
    exception when check_violation or not_null_violation then v_error:=true; end;
    assert v_error, 'status fora do schema fiscal recusado';
  end loop;
  update public.nfce_emissions set status='rejected' where sale_id=v_sale;
  perform public.edit_sale_financials(v_sale,gen_random_uuid(),v_rev,11,v_payments,'Emissão rejeitada confirmada');
  raise notice 'PASS: matriz fiscal observada, constraints de status e rejeição definitiva';
end $$;
-- JSON inválido, duplicado, pagamento de outra venda e NaN não gravam.
set role authenticated;
do $$
declare v_sale uuid:='00000000-0000-4000-8000-000000000030';
  v_bad jsonb; v_rev bigint; v_payments jsonb; v_error boolean;
begin
  select finance_revision into v_rev from public.sales where id=v_sale;
  select jsonb_agg(jsonb_build_object('id',id,'paid_on',paid_on,'value',value,
    'method',method,'installments',installments,'note',note)) into v_payments
    from public.sale_payments where sale_id=v_sale;
  foreach v_bad in array array[
    jsonb_set(v_payments,'{0,id}','"00000000-0000-4000-8000-000000000020"'),
    jsonb_set(v_payments,'{0,value}','"NaN"'),
    jsonb_set(v_payments,'{0,method}','"Misto"'),
    jsonb_set(v_payments,'{0,installments}','0'),
    jsonb_set(v_payments,'{0,paid_on}','null'),
    v_payments||v_payments
  ] loop
    v_error:=false;
    begin perform public.edit_sale_financials(v_sale,gen_random_uuid(),v_rev,11,v_bad,'Dados inválidos');
    exception when invalid_parameter_value or serialization_failure then v_error:=true; end;
    assert v_error, 'payload inválido rejeitado';
  end loop;
  raise notice 'PASS: limites e pagamento de outra venda';
end $$;
reset role;
-- O servidor ignora taxas/líquido/autoria enviados pelo navegador num novo pagamento.
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
set role authenticated;
insert into public.sale_payments(id,sale_id,value,method,installments,fee_pct,fee_value,net_value,created_by)
 values('00000000-0000-4000-8000-000000000032','00000000-0000-4000-8000-000000000030',30,'Credito',2,0,0,999,'00000000-0000-4000-8000-000000000002');
do $$ begin
  assert (select fee_value=2.10 and net_value=27.90 and fee_pct=6.99 and created_by=auth.uid()
    from public.sale_payments where id='00000000-0000-4000-8000-000000000032'), 'servidor calcula taxa e autor';
  raise notice 'PASS: novo pagamento usa taxa oficial e autor autenticado';
end $$;
reset role;
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000002';
set role authenticated;
do $$ declare v_error boolean:=false; begin
  begin insert into public.sale_payments(sale_id,value,method,net_value)
    values('00000000-0000-4000-8000-000000000030',1,'PIX',1);
  exception when insufficient_privilege then v_error:=true; end;
  assert v_error, 'sem perfil não inclui pagamento';
end $$;
reset role;
