\set ON_ERROR_STOP on
-- Dados integralmente fictícios. Nunca executar num projeto remoto.
insert into auth.users values ('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');
insert into public.profiles(id,display_name,login_email,is_admin) values
 ('00000000-0000-4000-8000-000000000001','Teste','test@example.invalid',true);
insert into public.colors(id,nome) values('00000000-0000-4000-8000-000000000003','Cor fictícia');
insert into public.products(id,name,size,cost,price_atacado,price_varejo,stock,color_id)
 values('00000000-0000-4000-8000-000000000004','Produto fictício','G1',20,100,120,90,'00000000-0000-4000-8000-000000000003');
insert into public.sales(id,channel,kind,pay,subtotal,total_bruto,cost_total) values
 ('00000000-0000-4000-8000-000000000010','Loja','Venda','Pendente',6000,6000,1200),
 ('00000000-0000-4000-8000-000000000011','Loja','Venda','Pendente',100,100,20),
 ('00000000-0000-4000-8000-000000000012','Loja','Venda','Pendente',100,100,20);
insert into public.sale_items(sale_id,product_id,name,price,cost,qty)
 select '00000000-0000-4000-8000-000000000010'::uuid,
 case when n=60 then null else '00000000-0000-4000-8000-000000000004'::uuid end,
 'Peça fictícia '||n,100,20,1 from generate_series(1,60) n;
insert into public.sale_payments(id,sale_id,value,method,installments,fee_pct,fee_value,net_value,paid_on,note) values
 ('00000000-0000-4000-8000-000000000020','00000000-0000-4000-8000-000000000010',3000,'PIX',0,0,0,3000,'2026-10-01','Original PIX'),
 ('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000010',3000,'Credito',3,5,150,2850,'2026-10-02','Original cartão');
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
set role authenticated;
do $$
declare
  v_sale uuid := '00000000-0000-4000-8000-000000000010';
  v_result jsonb; v_before jsonb; v_payments jsonb; v_rev bigint; v_audit integer;
  v_id uuid := gen_random_uuid(); v_error boolean; v_stock jsonb; v_items jsonb;
begin
  select jsonb_agg(to_jsonb(p) order by p.id) into v_stock from public.products p;
  select jsonb_agg(to_jsonb(i) order by i.id) into v_items from public.sale_items i;
  select finance_revision into v_rev from public.sales where id=v_sale;
  select jsonb_agg(jsonb_build_object('id',id,'paid_on',paid_on,'value',value-300,
    'method',method,'installments',installments,'note',note) order by id) into v_payments
    from public.sale_payments where sale_id=v_sale;
  v_result := public.edit_sale_financials(v_sale,v_id,v_rev,600,v_payments,'Desconto após finalizar');
  assert (v_result->>'total_bruto')::numeric=5400, 'total desconto';
  assert (v_result->>'net_received')::numeric=5265, 'liquido preserva taxa historica 5%';
  assert (v_result->>'profit')::numeric=4065, 'lucro';
  assert v_result->>'payment_status'='Pago' and v_result->>'pay'='Misto', 'estado/forma';
  assert jsonb_array_length(v_result->'sale_items')=60, '60 itens mantidos';
  assert (select jsonb_agg(to_jsonb(i) order by i.id) from public.sale_items i)=v_items, 'itens intactos incl legado';
  assert (select jsonb_agg(to_jsonb(p) order by p.id) from public.products p)=v_stock, 'estoque intacto';
  assert (select count(*) from public.stock_moves)=0, 'nenhum movimento';
  assert (select count(*) from public.sale_financial_audit)=1, 'uma auditoria';
  assert (select before_data->>'total_bruto' from public.sale_financial_audit limit 1)='6000.00', 'antes real';
  assert (select actor_name from public.sale_financial_audit limit 1)='Teste', 'ator';
  assert (select reason from public.sale_financial_audit limit 1)='Desconto após finalizar', 'motivo';
  assert public.edit_sale_financials(v_sale,v_id,v_rev,600,v_payments,'Desconto após finalizar')=v_result, 'retry';
  assert (select count(*) from public.sale_financial_audit)=1, 'retry sem auditoria duplicada';
  v_error:=false;
  begin perform public.edit_sale_financials(v_sale,v_id,v_rev,601,v_payments,'Desconto após finalizar');
  exception when invalid_parameter_value then v_error:=true; end;
  assert v_error, 'UUID com payload diferente rejeitado';
  v_error:=false;
  begin perform public.edit_sale_financials(v_sale,gen_random_uuid(),v_rev,600,v_payments,'Outro terminal');
  exception when serialization_failure then v_error:=true; end;
  assert v_error, 'revisao obsoleta rejeitada';
  v_rev:=(v_result->>'finance_revision')::bigint;
  v_before:=v_result;
  v_result:=public.edit_sale_financials(v_sale,gen_random_uuid(),v_rev,600,v_payments,'Salvar sem mudanças');
  assert v_result=v_before, 'no-op mantém revisao';
  assert (select count(*) from public.sale_financial_audit)=1, 'no-op sem histórico extra';
  -- Forma muda para PIX, data muda em uma linha; nenhuma duplicação.
  v_payments:=jsonb_set(v_payments,'{1,method}','"PIX"');
  v_payments:=jsonb_set(v_payments,'{1,installments}','0');
  v_payments:=jsonb_set(v_payments,'{1,paid_on}','"2026-10-03"');
  v_result:=public.edit_sale_financials(v_sale,gen_random_uuid(),v_rev,600,v_payments,'Forma corrigida para PIX');
  assert v_result->>'pay'='PIX' and (v_result->>'fee_value')::numeric=0, 'forma/taxa';
  assert (select count(*) from public.sale_payments where sale_id=v_sale)=2, 'IDs mantidos';
  assert (select paid_on from public.sale_payments where id='00000000-0000-4000-8000-000000000021')='2026-10-03'::date, 'data';
  -- Replay antigo retorna estado atual, não volta o cache à primeira correção.
  assert (public.edit_sale_financials(v_sale,v_id,2,600,
    jsonb_set(jsonb_set(jsonb_set(v_payments,'{1,method}','"Credito"'),'{1,installments}','3'),'{1,paid_on}','"2026-10-02"'),
    'Desconto após finalizar')->>'pay')='PIX', 'retry retorna atual';
  -- Sem pagamentos: desconto de 100% conclui; desconto parcial continua aberto.
  v_result:=public.edit_sale_financials('00000000-0000-4000-8000-000000000011',gen_random_uuid(),0,100,'[]','Desconto integral');
  assert v_result->>'payment_status'='Pago' and (v_result->>'total_bruto')::numeric=0, 'zero pago';
  v_result:=public.edit_sale_financials('00000000-0000-4000-8000-000000000012',gen_random_uuid(),0,10,'[]','Desconto parcial');
  assert v_result->>'payment_status'='Aberto' and (v_result->>'total_bruto')::numeric=90, 'desconto sem pagamento';
  -- Validações não podem deixar alteração parcial nem histórico.
  select finance_revision into v_rev from public.sales where id=v_sale;
  select count(*) into v_audit from public.sale_financial_audit;
  v_error:=false;
  begin perform public.edit_sale_financials(v_sale,gen_random_uuid(),v_rev,700,v_payments,'Desconto sem ajustar pagamento');
  exception when invalid_parameter_value then v_error:=true; end;
  assert v_error, 'pagamento excessivo';
  v_error:=false;
  begin perform public.edit_sale_financials(v_sale,gen_random_uuid(),v_rev,-1,v_payments,'Desconto negativo');
  exception when invalid_parameter_value then v_error:=true; end;
  assert v_error, 'desconto negativo';
  v_error:=false;
  begin perform public.edit_sale_financials(v_sale,gen_random_uuid(),v_rev,6001,v_payments,'Desconto excessivo');
  exception when invalid_parameter_value then v_error:=true; end;
  assert v_error, 'desconto maior subtotal';
  v_error:=false;
  begin perform public.edit_sale_financials(v_sale,gen_random_uuid(),v_rev,600,jsonb_set(v_payments,'{0,value}','0'),'Valor inválido');
  exception when invalid_parameter_value then v_error:=true; end;
  assert v_error, 'pagamento zero';
  v_error:=false;
  begin perform public.edit_sale_financials(v_sale,gen_random_uuid(),v_rev,600,v_payments-0,'Lista incompleta');
  exception when serialization_failure then v_error:=true; end;
  assert v_error, 'lista incompleta';
  assert (select count(*) from public.sale_financial_audit)=v_audit, 'falhas sem auditoria';
  assert (select finance_revision from public.sales where id=v_sale)=v_rev, 'falhas sem mutacao';
  v_error:=false;
  begin insert into public.sale_financial_audit(sale_id,request_id,actor_id,actor_name,reason,before_data,after_data)
    values(v_sale,gen_random_uuid(),auth.uid(),'Falso','Falso','{}','{}');
  exception when insufficient_privilege then v_error:=true; end;
  assert v_error, 'cliente nao pode forjar auditoria';
  raise notice 'PASS: desconto, forma, datas, histórico, idempotência, revisões, limites, 60 itens, legado e estoque';
end $$;
reset role;
-- Usuário sem profile e anônimo não podem usar a implementação privilegiada.
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000002';
set role authenticated;
do $$ declare v_error boolean:=false; begin
  begin perform public.edit_sale_financials('00000000-0000-4000-8000-000000000011',gen_random_uuid(),0,0,'[]','Sem perfil');
  exception when insufficient_privilege then v_error:=true; end;
  assert v_error, 'sem profile negado';
end $$;
reset role;
set role anon;
do $$ declare v_error boolean:=false; begin
  begin perform public.edit_sale_financials('00000000-0000-4000-8000-000000000011',gen_random_uuid(),0,0,'[]','Anonimo');
  exception when insufficient_privilege then v_error:=true; end;
  assert v_error, 'anon negado';
end $$;
reset role;
