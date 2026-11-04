-- Somente cluster local descartavel, ANTES do instalador financeiro.
-- psql -X -q --csv ... -v ON_ERROR_STOP=1 -f tests/sql/checkpoint_financeiro.sql > ARQUIVO_LOCAL
-- Depois: python3 tests/verify-financial-checkpoint.py ARQUIVO_LOCAL
-- Uma linha sintetica em cada uma das 11 tabelas exportadas; rollback total.
-- UUIDs ab... exclusivos. Auth e apenas dependencia local, nao entra no export.
begin;
insert into auth.users(id) values ('ab000000-0000-4000-8000-000000000002');
insert into public.vendedores(id,name,phone,note,created_by) values
  ('ab000000-0000-4000-8000-000000000003','Vendedora fictícia',null,
   E'Observação sintética\nsegunda linha','ab000000-0000-4000-8000-000000000002');
insert into public.profiles(id,display_name,login_email,is_admin,is_vendedora,vendedor_id,active) values
  ('ab000000-0000-4000-8000-000000000002','Perfil fictício','checkpoint@example.invalid',
   true,true,'ab000000-0000-4000-8000-000000000003',true);
insert into public.clients(id,name,note,cpf,phone,city,created_by) values
  ('ab000000-0000-4000-8000-000000000001',
   'Cliente fictício, "ação"',E'Linha sintética 1\nLinha sintética 2',null,null,
   'Cidade sintética','ab000000-0000-4000-8000-000000000002');
insert into public.colors(id,nome,created_by) values
  ('ab000000-0000-4000-8000-000000000004','Azul sintético checkpoint',
   'ab000000-0000-4000-8000-000000000002');
insert into public.products(id,barcode,name,size,cost,price_atacado,price_varejo,stock,color_id,note,created_by) values
  ('ab000000-0000-4000-8000-000000000005','SYNTH-CHECKPOINT-AB','Peça fictícia "única"',
   'G3',55.40,129.95,159.90,3,'ab000000-0000-4000-8000-000000000004',null,
   'ab000000-0000-4000-8000-000000000002');
insert into public.sales(id,client_request_id,sold_at,client_id,vendedor_id,channel,kind,
  pay,installments,discount,subtotal,total_bruto,cost_total,note,price_tier,buyer_cpf_nfce,created_by) values
  ('ab000000-0000-4000-8000-000000000006','ab000000-0000-4000-8000-000000000007',
   '2024-02-29 12:34:56.123456-03','ab000000-0000-4000-8000-000000000001',
   'ab000000-0000-4000-8000-000000000003','Loja','Venda','Credito',2,
   10.15,259.90,249.75,110.80,E'Venda fictícia\nsem operação real','Atacado','00000000000',
   'ab000000-0000-4000-8000-000000000002');
insert into public.sale_items(id,sale_id,product_id,name,cat,fabric,size,barcode,price,cost,qty) values
  ('ab000000-0000-4000-8000-000000000008','ab000000-0000-4000-8000-000000000006',
   'ab000000-0000-4000-8000-000000000005','Peça fictícia "única"',null,'Algodão','G3',
   'SYNTH-CHECKPOINT-AB',129.95,55.40,2);
insert into public.sale_payments(id,sale_id,paid_on,value,method,installments,fee_pct,fee_value,net_value,note,created_by) values
  ('ab000000-0000-4000-8000-000000000009','ab000000-0000-4000-8000-000000000006',
   '2024-02-29',249.75,'Credito',2,4.99,12.46,237.29,E'Pagamento fictício, "teste"\nsegunda linha',
   'ab000000-0000-4000-8000-000000000002');
insert into public.stock_moves(id,moved_at,type,barcode,product_id,qty,stock_after,note,created_by) values
  ('ab000000-0000-4000-8000-000000000010','2024-02-29 12:35:00-03','SAIDA',
   'SYNTH-CHECKPOINT-AB','ab000000-0000-4000-8000-000000000005',-2,3,null,
   'ab000000-0000-4000-8000-000000000002');
update public.store_settings set block_second_swap=false,
  card_fees='{"debito":2.99,"credito":{"1":3.99,"2":4.99},"credito_acima":8.99}'::jsonb where id=true;
insert into public.nfce_emissions(id,sale_id,numero,serie,ambiente,status,log,
  created_at,updated_at,chave_acesso,codigo_status,motivo_status,protocolo_autorizacao,
  xml_signed,qrcode_url,error_message,protocolo_data,emit_snapshot,created_by) values
  ('ab000000-0000-4000-8000-000000000011','ab000000-0000-4000-8000-000000000006',
   1,1,'homologacao','rejected','[{"ficticio":true,"mensagem":"ação\nlinha 2","valor":249.75,"nulo":null}]'::jsonb,
   '2024-02-29 12:36:00-03','2024-02-29 12:36:00-03',null,'TESTE','Somente fixture sintética',
   null,null,null,null,null,'{"ficticio":true,"itens":[{"quantidade":2,"preco":129.95}]}'::jsonb,
   'ab000000-0000-4000-8000-000000000002');
\ir ../../docs/checkpoint-financeiro-readonly.sql
rollback;
