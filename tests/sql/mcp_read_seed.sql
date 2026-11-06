-- Entirely invented values. Actor LOGIN is trusted only by this private fixture.
begin;
do $$ begin if current_database()<>'vaidosa_mcp_read_fixture' or inet_server_addr() is not null then raise exception 'FIXTURE_ONLY'; end if; end $$;
insert into auth.users(id) select ('77000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,6)n;
insert into public.profiles(id,display_name,login_email,is_admin,is_vendedora,active)
select id,'Fixture actor','actor'||row_number()over()||'@example.invalid',id='77000000-0000-4000-8000-000000000001',true,id<>'77000000-0000-4000-8000-000000000005' from auth.users;
insert into mcp_fixture.grants(role_name,subject,active,scopes,customers) values
 ('mcp_fixture_manager','77000000-0000-4000-8000-000000000001',true,array['stock:read','sales:read','finance:read'],null),
 ('mcp_fixture_alice','77000000-0000-4000-8000-000000000002',true,array['stock:read','sales:read'],array['77000000-0000-4000-8000-000000000010'::uuid]),
 ('mcp_fixture_bob','77000000-0000-4000-8000-000000000003',true,array['sales:read','finance:read'],array['77000000-0000-4000-8000-000000000011'::uuid]),
 ('mcp_fixture_stock','77000000-0000-4000-8000-000000000004',true,array['stock:read'],null),
 ('mcp_fixture_inactive','77000000-0000-4000-8000-000000000005',true,array['stock:read','sales:read','finance:read'],null),
 ('mcp_fixture_finance','77000000-0000-4000-8000-000000000006',true,array['finance:read'],array['77000000-0000-4000-8000-000000000010'::uuid]);
insert into public.clients(id,name,cpf,note) values
 ('77000000-0000-4000-8000-000000000010','PRIVATE_CUSTOMER_SENTINEL','FICTICIO','PRIVATE_NOTE_SENTINEL'),
 ('77000000-0000-4000-8000-000000000011','Cliente inventado B','FICTICIO','Somente fixture');
insert into public.colors(id,nome) values('77000000-0000-4000-8000-000000000020','Vermelho'),('77000000-0000-4000-8000-000000000021','Azul');
insert into public.products(id,barcode,name,size,cost,price_atacado,price_varejo,stock,color_id) values
 ('77000000-0000-4000-8000-000000000030','FX30','Vestido fixture','G1',10,100.10,120,7,'77000000-0000-4000-8000-000000000020'),
 ('77000000-0000-4000-8000-000000000031','FX31','Vestido fixture','G2',10,50,60,0,'77000000-0000-4000-8000-000000000020'),
 ('77000000-0000-4000-8000-000000000032','FX32','Vestido fixture','G1',10,100,120,5,'77000000-0000-4000-8000-000000000021');
insert into public.sales(id,client_id,sold_at,channel,kind,pay,subtotal,discount,total_bruto,cost_total,note,buyer_cpf_nfce) values
 ('77000000-0000-4000-8000-000000000040','77000000-0000-4000-8000-000000000010','2026-11-01T01:30:00.000001Z','Loja','Venda','PIX',100.10,0.10,100,10,'PRIVATE_NOTE_SENTINEL','FICTICIO'),
 ('77000000-0000-4000-8000-000000000041','77000000-0000-4000-8000-000000000010','2026-11-01T01:30:00.000002Z','Loja','Venda','Pendente',50,0,50,5,null,null),
 ('77000000-0000-4000-8000-000000000042','77000000-0000-4000-8000-000000000011','2026-11-01T01:30:00.000003Z','Loja','Venda','PIX',200,0,200,20,null,null);
insert into public.sale_items(id,sale_id,product_id,name,price,cost,qty) values
 ('77000000-0000-4000-8000-000000000060','77000000-0000-4000-8000-000000000040','77000000-0000-4000-8000-000000000030','Fixture',100.10,10,1),
 ('77000000-0000-4000-8000-000000000061','77000000-0000-4000-8000-000000000041','77000000-0000-4000-8000-000000000031','Fixture',50,5,1),
 ('77000000-0000-4000-8000-000000000062','77000000-0000-4000-8000-000000000042','77000000-0000-4000-8000-000000000032','Fixture',100,10,2);
insert into public.sale_payments(id,sale_id,paid_on,value,method,fee_value,net_value,note) values
 ('77000000-0000-4000-8000-000000000070','77000000-0000-4000-8000-000000000040','2026-11-02',100,'PIX',2,98,'PRIVATE_PAYMENT_NOTE'),
 ('77000000-0000-4000-8000-000000000071','77000000-0000-4000-8000-000000000042','2026-11-03',200,'Dinheiro',0,200,null);
insert into public.categorias(id,nome,tipo) values('77000000-0000-4000-8000-000000000080','Despesa fictícia','despesa');
insert into public.contas(id,cliente_id,tipo,descricao,valor,proximo_vencimento,status,recorrencia,parcela_atual,parcelas,categoria_id,archived_at) values
 ('77000000-0000-4000-8000-000000000050','77000000-0000-4000-8000-000000000010','receber','PRIVATE_ACCOUNT_NOTE',30,'2026-11-10','ativo','mensal',2,3,null,null),
 ('77000000-0000-4000-8000-000000000051','77000000-0000-4000-8000-000000000011','receber','Fixture B',20,'2026-11-10','ativo',null,1,1,null,null),
 ('77000000-0000-4000-8000-000000000052',null,'pagar','Fixture pagar',10,'2026-11-10','ativo','unica',1,1,'77000000-0000-4000-8000-000000000080',null),
 ('77000000-0000-4000-8000-000000000053','77000000-0000-4000-8000-000000000010','receber','Fixture arquivo',10,'2026-11-10','concluido',null,1,1,null,'2026-11-05T12:00:00Z');
insert into public.movimentacoes(id,conta_id,tipo,valor,data,pago,reversed_at,reversed_by,reversal_reason) values
 ('77000000-0000-4000-8000-000000000090','77000000-0000-4000-8000-000000000050','receber',10,'2026-11-01',true,null,null,null),
 ('77000000-0000-4000-8000-000000000091','77000000-0000-4000-8000-000000000050','receber',5,'2026-11-01',true,'2026-11-02T12:00:00Z','77000000-0000-4000-8000-000000000001','Correção fixture');
commit;
