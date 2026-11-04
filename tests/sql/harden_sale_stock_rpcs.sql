\set ON_ERROR_STOP on
-- Apenas PostgreSQL local descartável: fixtures fictícias, revertidas no final.
begin;
insert into auth.users values
 ('00000000-0000-4000-8000-000000000100'),
 ('00000000-0000-4000-8000-000000000101');
insert into public.profiles(id,display_name,login_email,is_vendedora,active) values
 ('00000000-0000-4000-8000-000000000100','Staff fictício','staff100@example.invalid',true,true),
 ('00000000-0000-4000-8000-000000000101','Inativo fictício','staff101@example.invalid',true,false);
insert into public.colors(id,nome) values
 ('00000000-0000-4000-8000-000000000102','Cor teste RPC');
insert into public.products(id,name,size,cost,price_atacado,price_varejo,stock,color_id)
 values('00000000-0000-4000-8000-000000000103','Produto teste RPC','G1',20,100,120,20,
        '00000000-0000-4000-8000-000000000102');
set local role anon;
do $$
declare blocked boolean;
begin
  blocked:=false;
  begin perform public.create_sale(gen_random_uuid(),null,null,'Loja','Venda','Pendente',0::smallint,0,null,'[]','Atacado');
  exception when insufficient_privilege then blocked:=true; end;
  assert blocked, 'anon não pode criar venda';
  blocked:=false;
  begin perform public.apply_stock_entry('00000000-0000-4000-8000-000000000103',1,'ENTRADA');
  exception when insufficient_privilege then blocked:=true; end;
  assert blocked, 'anon não pode alterar estoque';
  blocked:=false;
  begin perform public.delete_sale('00000000-0000-4000-8000-000000000110');
  exception when insufficient_privilege then blocked:=true; end;
  assert blocked, 'anon não pode excluir venda';
end $$;
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000101';
do $$
declare blocked boolean;
begin
  blocked:=false;
  begin perform public.create_sale(gen_random_uuid(),null,null,'Loja','Venda','Pendente',0::smallint,0,null,'[]','Atacado');
  exception when insufficient_privilege then blocked:=true; end;
  assert blocked, 'perfil inativo não pode criar venda';
  blocked:=false;
  begin perform public.apply_stock_entry('00000000-0000-4000-8000-000000000103',1,'ENTRADA');
  exception when insufficient_privilege then blocked:=true; end;
  assert blocked, 'perfil inativo não pode alterar estoque';
  blocked:=false;
  begin perform public.delete_sale('00000000-0000-4000-8000-000000000110');
  exception when insufficient_privilege then blocked:=true; end;
  assert blocked, 'perfil inativo não pode excluir venda';
end $$;
set local request.jwt.claim.sub = '';
do $$
declare blocked boolean:=false;
begin
  begin perform public.apply_stock_entry('00000000-0000-4000-8000-000000000103',1,'ENTRADA');
  exception when insufficient_privilege then blocked:=true; end;
  assert blocked, 'authenticated sem uid não passa pela guarda';
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000100';
-- O owner prepara/varia fixtures fiscais (a aplicação tem SELECT somente).
-- As RPCs SECURITY DEFINER mantêm a guarda real de auth.uid() do staff acima;
-- os testes de grants anon/authenticated permanecem nos blocos próprios.
reset role;
do $$
declare
  product uuid:='00000000-0000-4000-8000-000000000103';
  req uuid:=gen_random_uuid();
  items jsonb:=jsonb_build_array(jsonb_build_object('product_id',product,'qty',2),
                               jsonb_build_object('product_id',product,'qty',3));
  one_item jsonb:=jsonb_build_array(jsonb_build_object('product_id',product,'qty',1));
  sale public.sales; again public.sales; second_sale public.sales;
  blocked boolean; bad_discount numeric; bad_items jsonb; fiscal_status text;
  movements integer; initial_sales integer;
begin
  select count(*) into initial_sales from public.sales;
  foreach bad_discount in array array[-1,501,'NaN'::numeric,null::numeric] loop
    blocked:=false;
    begin perform public.create_sale(gen_random_uuid(),null,null,'Loja','Venda','Pendente',0::smallint,bad_discount,null,items,'Atacado');
    exception when invalid_parameter_value then blocked:=true; end;
    assert blocked, 'desconto inválido rejeitado atomicamente';
  end loop;
  for bad_items in select x from jsonb_array_elements(jsonb_build_array(
    'null'::jsonb,'{}'::jsonb,'[]'::jsonb,
    jsonb_build_array(jsonb_build_object('product_id',product,'qty',0)),
    jsonb_build_array(jsonb_build_object('product_id',product,'qty',-1)),
    jsonb_build_array(jsonb_build_object('product_id',product,'qty',1.5)),
    jsonb_build_array(jsonb_build_object('qty',1))
  )) x loop
    blocked:=false;
    begin perform public.create_sale(gen_random_uuid(),null,null,'Loja','Venda','Pendente',0::smallint,0,null,bad_items,'Atacado');
    exception when invalid_parameter_value then blocked:=true; end;
    assert blocked, 'itens inválidos não podem ser descartados silenciosamente';
  end loop;
  blocked:=false;
  begin perform public.create_sale(null,null,null,'Loja','Venda','Pendente',0::smallint,0,null,items,'Atacado');
  exception when invalid_parameter_value then blocked:=true; end;
  assert blocked, 'UUID de tentativa obrigatório';
  blocked:=false;
  begin perform public.create_sale(gen_random_uuid(),null,null,'Loja','Venda','Pendente',0::smallint,0,null,items,null);
  exception when invalid_parameter_value then blocked:=true; end;
  assert blocked, 'tabela de preço obrigatória';
  assert (select count(*) from public.sales)=initial_sales, 'rejeições sem venda';
  assert (select stock from public.products where id=product)=20, 'rejeições sem baixa de estoque';

  sale:=public.create_sale(req,null,null,'Loja','Venda','CartaoParcelado',6::smallint,50,null,items,'Atacado');
  assert sale.subtotal=500 and sale.discount=50 and sale.total_bruto=450, 'desconto sobre subtotal servidor';
  assert sale.profit=-100 and sale.payment_status='Aberto', 'resumos iniciais coerentes';
  assert sale.pay='Pendente' and sale.installments=0, 'sem pagamento ignora forma/parcelas legadas';
  assert (select count(*) from public.sale_items where sale_id=sale.id)=1, 'produto repetido agregado';
  assert (select qty from public.sale_items where sale_id=sale.id)=5, 'quantidade agregada';
  assert (select stock from public.products where id=product)=15, 'uma baixa exata';
  again:=public.create_sale(req,null,null,'Loja','Venda','Pendente',0::smallint,50,null,items,'Atacado');
  assert again.id=sale.id, 'retry retorna mesma venda';
  assert (select stock from public.products where id=product)=15, 'retry não repete baixa';
  second_sale:=public.create_sale(gen_random_uuid(),null,null,'Loja','Venda','Pendente',0::smallint,120,null,one_item,'Varejo');
  assert second_sale.id<>sale.id and second_sale.sold_at::date=sale.sold_at::date, 'duas vendas no mesmo dia';
  assert second_sale.total_bruto=0 and second_sale.payment_status='Pago', '100% desconto conclui sem recebimento';
  assert second_sale.profit=-20, 'lucro inicial da venda gratuita';
  assert (select stock from public.products where id=product)=14, 'segunda venda baixa uma peça';

  insert into public.sale_payments(sale_id,value,method,fee_pct,fee_value,net_value)
    values(sale.id,450,'PIX',0,0,450);
  insert into public.nfce_emissions(id,sale_id,numero,serie,ambiente,status,log,created_at,updated_at)
    values('00000000-0000-4000-8000-000000000104',sale.id,104,1,'homologacao','authorized','[]',now(),now());
  foreach fiscal_status in array array['authorized','transmitted','pending','error'] loop
    update public.nfce_emissions set status=fiscal_status
      where id='00000000-0000-4000-8000-000000000104';
    blocked:=false;
    begin perform public.delete_sale(sale.id);
    exception when raise_exception then blocked:=true; end;
    assert blocked, 'exclusão bloqueada para NFC-e autorizada ou incerta';
    assert exists(select 1 from public.sales where id=sale.id), 'bloqueio fiscal preserva venda';
    assert (select stock from public.products where id=product)=14, 'bloqueio fiscal preserva estoque';
  end loop;
  delete from public.nfce_emissions where id='00000000-0000-4000-8000-000000000104';
  perform public.delete_sale(sale.id);
  assert not exists(select 1 from public.sales where id=sale.id), 'exclusão remove venda';
  assert not exists(select 1 from public.sale_payments where sale_id=sale.id), 'exclusão remove pagamentos em cascade';
  assert (select stock from public.products where id=product)=19, 'exclusão devolve exatamente cinco peças';
  select count(*) into movements from public.stock_moves where product_id=product;
  perform public.delete_sale(sale.id);
  assert (select stock from public.products where id=product)=19, 'segunda exclusão não duplica estoque';
  assert (select count(*) from public.stock_moves where product_id=product)=movements, 'segunda exclusão não cria movimento';
  perform public.apply_stock_entry(product,3,'ENTRADA','Teste local',21);
  assert (select stock from public.products where id=product)=22, 'entrada normal preservada';
  assert (select cost from public.products where id=product)=21, 'custo normal preservado';
end $$;
reset role;

-- Uma colisão diferente da chave de tentativa deve continuar sendo erro.
create unique index hardening_test_note_unique on public.sales(note)
  where note='fixture-hardening-unique';
set local role authenticated;
do $$
declare items jsonb:='[{"product_id":"00000000-0000-4000-8000-000000000103","qty":1}]';
        blocked boolean:=false; before_stock integer;
begin
  perform public.create_sale(gen_random_uuid(),null,null,'Loja','Venda','Pendente',0::smallint,0,'fixture-hardening-unique',items,'Atacado');
  select stock into before_stock from public.products where id='00000000-0000-4000-8000-000000000103';
  begin perform public.create_sale(gen_random_uuid(),null,null,'Loja','Venda','Pendente',0::smallint,0,'fixture-hardening-unique',items,'Atacado');
  exception when unique_violation then blocked:=true; end;
  assert blocked, 'unique_violation não relacionada não vira sucesso NULL';
  assert (select stock from public.products where id='00000000-0000-4000-8000-000000000103')=before_stock,
    'falha de constraint sem baixa parcial';
  raise notice 'PASS: RPCs venda/estoque auth, descontos, itens, retry, exclusão repetida e constraints';
end $$;
reset role;
rollback;
