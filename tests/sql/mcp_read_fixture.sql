-- TEST ONLY. Ephemeral fixture roles/policies, never a production migration.
begin;
do $$ begin if current_database()<>'vaidosa_mcp_read_fixture' or inet_server_addr() is not null then raise exception 'FIXTURE_ONLY'; end if; end $$;
create role mcp_fixture_reader nologin noinherit nosuperuser nobypassrls nocreatedb nocreaterole;
create role mcp_fixture_manager login noinherit nosuperuser nobypassrls;
create role mcp_fixture_alice login noinherit nosuperuser nobypassrls;
create role mcp_fixture_bob login noinherit nosuperuser nobypassrls;
create role mcp_fixture_stock login noinherit nosuperuser nobypassrls;
create role mcp_fixture_inactive login noinherit nosuperuser nobypassrls;
create role mcp_fixture_finance login noinherit nosuperuser nobypassrls;
create role mcp_fixture_unknown login noinherit nosuperuser nobypassrls;
create schema mcp_fixture;
revoke all on schema mcp_fixture from public;
create table mcp_fixture.binding(singleton boolean primary key check(singleton),source text not null,store text not null,database_name text not null,cluster_id text not null);
insert into mcp_fixture.binding values(true,'vaidosa_disposable_source','fixture_store','vaidosa_mcp_read_fixture',(select system_identifier::text from pg_control_system()));
create table mcp_fixture.grants(role_name name primary key,subject uuid not null,active boolean not null,scopes text[] not null,customers uuid[]);
revoke all on mcp_fixture.binding,mcp_fixture.grants from public;
grant usage on schema public,mcp_fixture to mcp_fixture_reader;
create function mcp_fixture.can_read(p_scope text,p_customer uuid default null,p_customer_required boolean default false)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from mcp_fixture.grants g join public.profiles p on p.id=g.subject cross join mcp_fixture.binding b
  where g.role_name=session_user and g.active and p.active and (p.is_admin or p.is_vendedora)
   and b.database_name=current_database() and p_scope=any(g.scopes)
   and (not p_customer_required or g.customers is null or p_customer=any(g.customers)));
$$;
create function mcp_fixture.receipt_visible(p_sale uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.sales s where s.id=p_sale and mcp_fixture.can_read('finance:read',s.client_id,true));
$$;
create function mcp_fixture.movement_visible(p_account uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.contas c where c.id=p_account and mcp_fixture.can_read('finance:read',c.cliente_id,true));
$$;
revoke all on function mcp_fixture.can_read(text,uuid,boolean),mcp_fixture.receipt_visible(uuid),mcp_fixture.movement_visible(uuid) from public;
grant execute on function mcp_fixture.can_read(text,uuid,boolean),mcp_fixture.receipt_visible(uuid),mcp_fixture.movement_visible(uuid) to mcp_fixture_reader;
-- Projection owner is neither table owner nor BYPASSRLS. End-user roles have no
-- table SELECT, role membership, writes or access to application private journals.
revoke all on public.products from public;
grant select(id,name,size,color_id,stock) on public.products to mcp_fixture_reader;
grant select(id,nome) on public.colors to mcp_fixture_reader;
grant select(id,client_id,sold_at,payment_status,subtotal,discount,total_bruto) on public.sales to mcp_fixture_reader;
grant select(id,sale_id,product_id,qty,price) on public.sale_items to mcp_fixture_reader;
grant select(id,sale_id,paid_on,value,fee_value,net_value) on public.sale_payments to mcp_fixture_reader;
grant select(id,cliente_id,tipo,valor,proximo_vencimento,status,recorrencia,parcela_atual,parcelas,archived_at) on public.contas to mcp_fixture_reader;
grant select(id,conta_id,valor,pago,reversed_at) on public.movimentacoes to mcp_fixture_reader;
create policy mcp_stock on public.products for select to mcp_fixture_reader using(mcp_fixture.can_read('stock:read'));
create policy mcp_colors on public.colors for select to mcp_fixture_reader using(mcp_fixture.can_read('stock:read'));
create policy mcp_sales on public.sales for select to mcp_fixture_reader using(mcp_fixture.can_read('sales:read',client_id,true) or mcp_fixture.can_read('finance:read',client_id,true));
create policy mcp_items on public.sale_items for select to mcp_fixture_reader using(exists(select 1 from public.sales s where s.id=sale_id));
create policy mcp_receipts on public.sale_payments for select to mcp_fixture_reader using(mcp_fixture.receipt_visible(sale_id));
create policy mcp_accounts on public.contas for select to mcp_fixture_reader using(mcp_fixture.can_read('finance:read',cliente_id,true));
create policy mcp_movements on public.movimentacoes for select to mcp_fixture_reader using(mcp_fixture.movement_visible(conta_id));

create function mcp_fixture.authorize(p jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare g mcp_fixture.grants; b mcp_fixture.binding; profile public.profiles; needed text;
begin
 select * into g from mcp_fixture.grants where role_name=session_user;
 select * into b from mcp_fixture.binding where singleton;
 select * into profile from public.profiles where id=g.subject;
 needed:=case p->>'operation' when 'stock_variants' then 'stock:read' when 'customer_orders' then 'sales:read' when 'sale_detail' then 'sales:read' when 'sale_receipts' then 'finance:read' when 'manual_accounts' then 'finance:read' end;
 if g.subject is null or not g.active or profile.id is null or not profile.active or not(profile.is_admin or profile.is_vendedora)
  or needed is null or not needed=any(g.scopes) or p->>'subject' is distinct from g.subject::text
  or p->>'source' is distinct from b.source or p->>'store' is distinct from b.store
  or b.database_name is distinct from current_database() or inet_server_addr() is not null
  or b.cluster_id is distinct from (select system_identifier::text from pg_control_system()) then
   raise exception 'Source unavailable' using errcode='42501';
 end if;
 return jsonb_build_object('source',b.source,'store',b.store,'subject',g.subject::text,'cluster',b.cluster_id,
  'authorization',encode(sha256(convert_to(jsonb_build_object('grant',to_jsonb(g),'profile',jsonb_build_object('active',profile.active,'admin',profile.is_admin,'seller',profile.is_vendedora),'binding',to_jsonb(b))::text,'UTF8')),'hex'));
end $$;
revoke all on function mcp_fixture.authorize(jsonb) from public;
grant execute on function mcp_fixture.authorize(jsonb) to mcp_fixture_reader;

create function mcp_fixture.read_snapshot(p jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare meta jsonb; rows jsonb; result jsonb; visibility jsonb; f jsonb:=p->'filters'; customers uuid[]; requested uuid; total integer; account record;
begin
 meta:=mcp_fixture.authorize(p);
 if p->>'mode' is null or p->>'mode' not in ('snapshot','authorize') or (p->>'maxRows')::integer is distinct from 2000 or (p->>'maxBytes')::integer is distinct from 260000
  or jsonb_typeof(f) is distinct from 'object' or jsonb_typeof(p->'customers') is null or jsonb_typeof(p->'customers') not in ('array','null') then raise exception 'Invalid read contract' using errcode='22023'; end if;
 customers:=case when p->'customers'='null'::jsonb then null else array(select v::uuid from jsonb_array_elements_text(p->'customers') x(v)) end;
 case p->>'operation'
 when 'stock_variants' then
  if f<>'{}' then raise exception 'Invalid filters' using errcode='22023'; end if;
  if exists(select 1 from public.products p join public.colors c on c.id=p.color_id where length(p.name)>200 or length(c.nome)>80) then raise exception 'Oversize field' using errcode='54000'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'name',x.name,'size',x.size,'color_name',x.nome,'stock',x.stock) order by x.id),'[]') into rows
   from(select p.id,p.name,p.size,p.stock,c.nome from public.products p join public.colors c on c.id=p.color_id order by p.id limit 2001)x;
 when 'customer_orders' then
  if not f?'customerId' or f-'customerId'<>'{}' then raise exception 'Invalid filters' using errcode='22023'; end if;
  requested:=(f->>'customerId')::uuid;
  select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'client_id',x.client_id,'sold_at',x.sold_at,'payment_status',x.payment_status,'subtotal',x.subtotal::text,'discount',x.discount::text,'total_bruto',x.total_bruto::text) order by x.sold_at desc,x.id),'[]') into rows
   from(select s.id,s.client_id,s.sold_at,s.payment_status,s.subtotal,s.discount,s.total_bruto from public.sales s where s.client_id=requested and (customers is null or s.client_id=any(customers)) order by s.sold_at desc,s.id limit 2001)x;
 when 'sale_detail' then
  if not f?'saleId' or f-'saleId'<>'{}' then raise exception 'Invalid filters' using errcode='22023'; end if;
  requested:=(f->>'saleId')::uuid;
  if (select count(*) from public.sale_items i where i.sale_id=requested)>200 then raise exception 'Too many items' using errcode='54000'; end if;
  select jsonb_build_object('id',s.id,'client_id',s.client_id,'sold_at',s.sold_at,'payment_status',s.payment_status,'subtotal',s.subtotal::text,'discount',s.discount::text,'total_bruto',s.total_bruto::text,'items_complete',true,
   'items',(select coalesce(jsonb_agg(jsonb_build_object('product_id',i.product_id,'qty',i.qty,'price',i.price::text) order by i.id),'[]') from public.sale_items i where i.sale_id=s.id)) into rows
   from public.sales s where s.id=requested and (customers is null or s.client_id=any(customers));
 when 'sale_receipts' then
  if not f?'from' or not f?'to' or f-'from'-'to'<>'{}' or (f->>'to')::date<(f->>'from')::date or (f->>'to')::date-(f->>'from')::date>365 then raise exception 'Invalid filters' using errcode='22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'sale_id',x.sale_id,'client_id',x.client_id,'paid_on',x.paid_on,'value',x.value::text,'fee_value',x.fee_value::text,'net_value',x.net_value::text) order by x.paid_on,x.id),'[]') into rows
   from(select r.id,r.sale_id,s.client_id,r.paid_on,r.value,r.fee_value,r.net_value from public.sale_payments r join public.sales s on s.id=r.sale_id where r.paid_on between (f->>'from')::date and (f->>'to')::date and (customers is null or s.client_id=any(customers)) order by r.paid_on,r.id limit 1001)x;
  if jsonb_array_length(rows)>1000 then raise exception 'Too many receipts' using errcode='54000'; end if;
 when 'manual_accounts' then
  if f-'kind'-'includeArchived'<>'{}' or f->'includeArchived'<>'false'::jsonb or (f->>'kind') is not null and f->>'kind' not in ('payable','receivable') then raise exception 'Invalid filters' using errcode='22023'; end if;
  rows:='[]';
  for account in select c.id,c.cliente_id,c.tipo,c.valor,c.proximo_vencimento,c.status,c.recorrencia,c.parcela_atual,c.parcelas,c.archived_at from public.contas c where c.archived_at is null and (customers is null or c.cliente_id=any(customers)) and (f->>'kind' is null or c.tipo=case f->>'kind' when 'payable' then 'pagar' else 'receber' end) order by c.id limit 2001 loop
   if (select count(*) from public.movimentacoes m where m.conta_id=account.id)>100 then raise exception 'Too many movements' using errcode='54000'; end if;
   rows:=rows||jsonb_build_array(to_jsonb(account)||jsonb_build_object('valor',account.valor::text,'movements_complete',true,'movimentacoes',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'conta_id',m.conta_id,'valor',m.valor::text,'pago',m.pago,'reversed_at',m.reversed_at) order by m.id),'[]') from public.movimentacoes m where m.conta_id=account.id)));
  end loop;
 else raise exception 'Unknown operation' using errcode='22023'; end case;
 if jsonb_typeof(rows)='array' then
  if jsonb_array_length(rows)>2000 then raise exception 'Too many rows' using errcode='54000'; end if;
 end if;
 -- Recompute visible identities/ownership (including nested movements) under
 -- current RLS on every page. A grant hash alone would allow stale cross-client
 -- rows after reassignment or a policy change. Values may remain an older,
 -- internally coherent materialized snapshot, while access must remain current.
 if jsonb_typeof(rows)='array' then
  select coalesce(jsonb_agg(jsonb_build_object('id',r.value->'id','customer',coalesce(r.value->'client_id',r.value->'cliente_id'),
   'movements',case when r.value?'movimentacoes' then (select coalesce(jsonb_agg(jsonb_build_object('id',m.value->'id','account',m.value->'conta_id') order by m.value->>'id'),'[]') from jsonb_array_elements(r.value->'movimentacoes')m) else '[]'::jsonb end) order by r.value->>'id'),'[]') into visibility from jsonb_array_elements(rows)r;
 else visibility:=jsonb_build_object('id',rows->'id','customer',rows->'client_id'); end if;
 meta:=jsonb_set(meta,'{authorization}',to_jsonb(encode(sha256(convert_to((meta->>'authorization')||visibility::text,'UTF8')),'hex')));
 result:=meta||jsonb_build_object('rows',rows);
 if octet_length(convert_to(result::text,'UTF8'))>260000 then raise exception 'Source byte limit' using errcode='54000'; end if;
 if p->>'mode'='authorize' then return meta||jsonb_build_object('rows',null); end if;
 return result;
end $$;
alter function mcp_fixture.read_snapshot(jsonb) owner to mcp_fixture_reader;
revoke all on function mcp_fixture.read_snapshot(jsonb) from public;
grant usage on schema mcp_fixture to mcp_fixture_manager,mcp_fixture_alice,mcp_fixture_bob,mcp_fixture_stock,mcp_fixture_inactive,mcp_fixture_finance,mcp_fixture_unknown;
grant execute on function mcp_fixture.read_snapshot(jsonb) to mcp_fixture_manager,mcp_fixture_alice,mcp_fixture_bob,mcp_fixture_stock,mcp_fixture_inactive,mcp_fixture_finance,mcp_fixture_unknown;
commit;
