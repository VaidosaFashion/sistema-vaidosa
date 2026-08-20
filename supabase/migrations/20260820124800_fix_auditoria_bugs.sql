-- Bugs da auditoria 2026-08-20.
-- Cole este arquivo no SQL Editor do Supabase (db push não funciona neste
-- projeto — ver CLAUDE.md). O frontend tem fallback pra apply_stock_entry
-- e delete_sale enquanto esta migração não rodar; Misto e a agregação do
-- create_sale SÓ ligam depois deste SQL.

-- =========================================================
-- 1. sales.pay aceita 'Misto' (a tela já oferecia, o check recusava)
-- =========================================================
alter table public.sales drop constraint if exists sales_pay_check;
alter table public.sales add constraint sales_pay_check
  check (pay in ('PIX','Dinheiro','CartaoAVista','CartaoParcelado','Misto'));

-- =========================================================
-- 2. create_sale agrega o mesmo product_id antes de checar estoque
--    (duas linhas do mesmo produto furavam o FOR UPDATE: cada qty era
--    conferida contra o estoque original, a soma podia passar).
--    Assinatura idêntica à versão atual (11 args) — create or replace
--    substitui no lugar, sem overload.
-- =========================================================
create or replace function public.create_sale(
  p_client_request_id uuid,
  p_client_id      uuid,
  p_vendedor_id    uuid,
  p_channel        text,
  p_kind           text,
  p_pay            text,
  p_installments   smallint,
  p_discount       numeric,
  p_note           text,
  p_items          jsonb,
  p_price_tier     text default 'Atacado'
) returns public.sales
language plpgsql security definer set search_path = public as $$
declare
  v_existing public.sales;
  v_sale     public.sales;
  v_item     jsonb;
  v_product  public.products;
  v_price    numeric;
  v_sub numeric := 0; v_cost numeric := 0;
  v_items    jsonb;
begin
  if p_price_tier not in ('Atacado','Varejo') then
    raise exception 'price_tier inválido: %', p_price_tier;
  end if;

  select * into v_existing from public.sales where client_request_id = p_client_request_id;
  if found then return v_existing; end if;

  -- Soma qty por produto ANTES de travar/checar estoque.
  select coalesce(jsonb_agg(jsonb_build_object('product_id', product_id, 'qty', qty)), '[]'::jsonb)
    into v_items
  from (
    select (e->>'product_id')::uuid as product_id,
           sum(coalesce(nullif(e->>'qty','')::int, 0)) as qty
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) e
    group by 1
    having sum(coalesce(nullif(e->>'qty','')::int, 0)) > 0
  ) t;

  if jsonb_array_length(v_items) = 0 then
    raise exception 'Venda sem itens';
  end if;

  for v_item in select * from jsonb_array_elements(v_items) loop
    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid for update;
    if not found then raise exception 'Produto não encontrado'; end if;
    if v_product.stock < (v_item->>'qty')::int then
      raise exception 'Estoque insuficiente: %', v_product.name;
    end if;
    v_price := case when p_price_tier = 'Varejo'
      then coalesce(v_product.price_varejo, v_product.price_atacado)
      else v_product.price_atacado end;
    v_sub  := v_sub  + v_price * (v_item->>'qty')::int;
    v_cost := v_cost + v_product.cost  * (v_item->>'qty')::int;
  end loop;

  insert into public.sales (
    client_request_id, client_id, vendedor_id, channel, kind, pay, installments,
    discount, subtotal, total_bruto, cost_total, note, price_tier, created_by
  ) values (
    p_client_request_id, p_client_id, p_vendedor_id, p_channel, p_kind, p_pay, p_installments,
    p_discount, v_sub, greatest(0, v_sub - p_discount), v_cost, p_note, p_price_tier, auth.uid()
  ) returning * into v_sale;

  for v_item in select * from jsonb_array_elements(v_items) loop
    select * into v_product from public.products where id = (v_item->>'product_id')::uuid;
    v_price := case when p_price_tier = 'Varejo'
      then coalesce(v_product.price_varejo, v_product.price_atacado)
      else v_product.price_atacado end;
    insert into public.sale_items (sale_id, product_id, name, cat, fabric, size, barcode, price, cost, qty)
      values (v_sale.id, v_product.id, v_product.name, v_product.cat, v_product.fabric,
              v_product.size, v_product.barcode, v_price, v_product.cost,
              (v_item->>'qty')::int);

    update public.products set stock = stock - (v_item->>'qty')::int where id = v_product.id;

    insert into public.stock_moves (type, barcode, product_id, qty, stock_after, note, created_by)
      values ('SAIDA', v_product.barcode, v_product.id, -(v_item->>'qty')::int,
              v_product.stock - (v_item->>'qty')::int, 'Venda', auth.uid());
  end loop;

  return v_sale;
exception
  when unique_violation then
    select * into v_existing from public.sales where client_request_id = p_client_request_id;
    return v_existing;
end;
$$;

grant execute on function public.create_sale(
  uuid, uuid, uuid, text, text, text, smallint, numeric, text, jsonb, text
) to authenticated;

-- =========================================================
-- 3. apply_stock_entry — trava a linha do produto (FOR UPDATE)
--    Fecha a corrida de duas entradas simultâneas no mesmo SKU.
-- =========================================================
create or replace function public.apply_stock_entry(
  p_product_id uuid,
  p_qty        int,
  p_type       text,
  p_note       text default null,
  p_new_cost   numeric default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_product   public.products;
  v_new_stock int;
  v_move      public.stock_moves;
begin
  if p_type not in ('ENTRADA','SAIDA','DEVOLUCAO') then
    raise exception 'tipo inválido: %', p_type;
  end if;
  if p_qty = 0 then
    raise exception 'quantidade não pode ser zero';
  end if;

  select * into v_product from public.products where id = p_product_id for update;
  if not found then raise exception 'Produto não encontrado'; end if;

  v_new_stock := v_product.stock + p_qty;
  if v_new_stock < 0 then
    raise exception 'Estoque insuficiente: %', v_product.name;
  end if;

  update public.products
    set stock = v_new_stock,
        cost  = case when p_new_cost is not null then p_new_cost else cost end
    where id = p_product_id
    returning * into v_product;

  insert into public.stock_moves (type, barcode, product_id, qty, stock_after, note, created_by)
    values (p_type, v_product.barcode, v_product.id, p_qty, v_new_stock, p_note, auth.uid())
    returning * into v_move;

  return jsonb_build_object('product', to_jsonb(v_product), 'move', to_jsonb(v_move));
end;
$$;

grant execute on function public.apply_stock_entry(uuid, int, text, text, numeric) to authenticated;

-- =========================================================
-- 4. delete_sale — devolve estoque e apaga a venda NA MESMA
--    transação. Trava NFC-e autorizada no banco (não só no JS),
--    e só consulta nfce_emissions se a tabela existir.
-- =========================================================
create or replace function public.delete_sale(p_sale_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_item            record;
  v_product         public.products;
  v_new_stock       int;
  v_nfce_authorized boolean := false;
begin
  if to_regclass('public.nfce_emissions') is not null then
    execute $q$
      select exists(
        select 1 from public.nfce_emissions
        where sale_id = $1 and status = 'authorized'
      )
    $q$ into v_nfce_authorized using p_sale_id;
    if v_nfce_authorized then
      raise exception 'Essa venda tem NFC-e autorizada — excluir apagaria o registro fiscal. Cancele a nota na SEFAZ antes.';
    end if;
  end if;

  if not exists (select 1 from public.sales where id = p_sale_id) then
    raise exception 'Venda não encontrada';
  end if;

  for v_item in select * from public.sale_items where sale_id = p_sale_id loop
    if v_item.product_id is null then continue; end if;
    select * into v_product from public.products where id = v_item.product_id for update;
    if not found then continue; end if; -- produto já apagado: não tem pra onde devolver
    v_new_stock := v_product.stock + v_item.qty;
    update public.products set stock = v_new_stock where id = v_product.id;
    insert into public.stock_moves (type, barcode, product_id, qty, stock_after, note, created_by)
      values ('DEVOLUCAO', v_product.barcode, v_product.id, v_item.qty, v_new_stock, 'Venda excluída', auth.uid());
  end loop;

  delete from public.sales where id = p_sale_id;
end;
$$;

grant execute on function public.delete_sale(uuid) to authenticated;
