-- Additive stock entry contract. Apply only after release review/backup.
-- Does not replace apply_stock_entry or rewrite any existing stock/movement.
begin;
create schema if not exists vaidosa_private;
create table vaidosa_private.stock_entry_requests (
  request_id uuid primary key,
  actor_id uuid not null,
  product_id uuid not null,
  move_id uuid not null,
  payload_hash text not null check (length(payload_hash) = 64),
  applied_at timestamptz not null default now()
);
-- IDs deliberately survive product/movement/user deletion. No payload, notes,
-- product snapshots, CPF or client data are duplicated in this journal.
alter table vaidosa_private.stock_entry_requests enable row level security;
revoke all on vaidosa_private.stock_entry_requests from public, anon, authenticated;

create function public.get_stock_entry_request(
  p_request_id uuid,
  p_expected_payload jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_request vaidosa_private.stock_entry_requests;
  v_product public.products;
  v_move public.stock_moves;
  v_payload jsonb;
begin
  if v_actor is null or not exists (
    select 1 from public.profiles p where p.id=v_actor and p.active and (p.is_admin or p.is_vendedora)
  ) then raise exception 'Usuário sem permissão para conferir estoque' using errcode='42501'; end if;
  if p_request_id is null then raise exception 'Identificador da entrada obrigatório' using errcode='22023'; end if;
  -- Same lock as mutation. A completed lookup waits for an in-flight operation
  -- that already holds this lock; absent is never interpreted as permission to
  -- change the request ID after an uncertain transport failure.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stock-entry:'||p_request_id::text,0));
  select * into v_request from vaidosa_private.stock_entry_requests where request_id=p_request_id;
  if not found then return jsonb_build_object('status','not_found','request_id',p_request_id); end if;
  if v_request.actor_id <> v_actor then
    raise exception 'Entrada pertence a outra sessão de usuário' using errcode='42501';
  end if;
  if p_expected_payload is not null then
    if jsonb_typeof(p_expected_payload) <> 'object' then
      raise exception 'Conteúdo esperado inválido' using errcode='22023';
    end if;
    v_payload := jsonb_build_object(
      'product_id',(p_expected_payload->>'product_id')::uuid,
      'qty',(p_expected_payload->>'qty')::integer,
      'type',p_expected_payload->>'type',
      'note',nullif(btrim(p_expected_payload->>'note'),''),
      'new_cost',round((p_expected_payload->>'new_cost')::numeric,2)
    );
    if v_request.payload_hash <> encode(sha256(convert_to(v_payload::text,'UTF8')),'hex') then
      raise exception 'Identificador de entrada reutilizado com outros dados' using errcode='22023';
    end if;
  end if;
  select * into v_product from public.products where id=v_request.product_id;
  select * into v_move from public.stock_moves where id=v_request.move_id;
  return jsonb_build_object('status','applied','request_id',p_request_id,
    'product',case when v_product.id is null then null else to_jsonb(v_product) end,
    'product_deleted',v_product.id is null,
    'move',case when v_move.id is null then null else to_jsonb(v_move) end,
    'move_missing',v_move.id is null);
end;
$$;

create function public.apply_stock_entry_v2(
  p_request_id uuid,
  p_product_id uuid,
  p_qty integer,
  p_type text,
  p_note text default null,
  p_new_cost numeric default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_product public.products;
  v_move public.stock_moves;
  v_payload jsonb;
  v_existing jsonb;
  v_stock bigint;
begin
  if v_actor is null or not exists (
    select 1 from public.profiles p where p.id=v_actor and p.active and (p.is_admin or p.is_vendedora)
  ) then raise exception 'Usuário sem permissão para alterar estoque' using errcode='42501'; end if;
  if p_request_id is null or p_product_id is null or p_qty is null or p_qty=0 or
     p_type is null or p_type not in ('ENTRADA','SAIDA','DEVOLUCAO') then
    raise exception 'Identificador, produto, quantidade ou tipo inválido' using errcode='22023';
  end if;
  if p_new_cost is not null and (p_new_cost::text in ('NaN','Infinity','-Infinity') or
    p_new_cost < 0 or p_new_cost > 99999999.99 or p_new_cost <> round(p_new_cost,2)) then
    raise exception 'Custo inválido: utilize até dois decimais' using errcode='22023';
  end if;
  if char_length(coalesce(p_note,'')) > 2000 then
    raise exception 'Observação pode ter até 2.000 caracteres' using errcode='22023';
  end if;
  v_payload := jsonb_build_object('product_id',p_product_id,'qty',p_qty,'type',p_type,
    'note',nullif(btrim(p_note),''),'new_cost',round(p_new_cost,2));
  -- Lookup checks owner + content under the same transaction-scoped lock.
  v_existing := public.get_stock_entry_request(p_request_id,v_payload);
  if v_existing->>'status'='applied' then return v_existing; end if;

  select * into v_product from public.products where id=p_product_id for update;
  if not found then raise exception 'Produto não encontrado' using errcode='P0002'; end if;
  v_stock := v_product.stock::bigint + p_qty::bigint;
  if v_stock < 0 then raise exception 'Estoque insuficiente: %',v_product.name using errcode='23514'; end if;
  if v_stock > 2147483647 then raise exception 'Saldo excede o limite permitido' using errcode='22003'; end if;
  update public.products set stock=v_stock::integer,cost=coalesce(p_new_cost,cost)
    where id=p_product_id returning * into v_product;
  insert into public.stock_moves(type,barcode,product_id,qty,stock_after,note,created_by)
    values(p_type,v_product.barcode,p_product_id,p_qty,v_product.stock,nullif(btrim(p_note),''),v_actor)
    returning * into v_move;
  insert into vaidosa_private.stock_entry_requests(request_id,actor_id,product_id,move_id,payload_hash)
    values(p_request_id,v_actor,p_product_id,v_move.id,encode(sha256(convert_to(v_payload::text,'UTF8')),'hex'));
  return jsonb_build_object('status','applied','request_id',p_request_id,
    'product',to_jsonb(v_product),'product_deleted',false,'move',to_jsonb(v_move),'move_missing',false);
end;
$$;
revoke all on function public.get_stock_entry_request(uuid,jsonb) from public,anon;
revoke all on function public.apply_stock_entry_v2(uuid,uuid,integer,text,text,numeric) from public,anon;
grant execute on function public.get_stock_entry_request(uuid,jsonb) to authenticated;
grant execute on function public.apply_stock_entry_v2(uuid,uuid,integer,text,text,numeric) to authenticated;
commit;
