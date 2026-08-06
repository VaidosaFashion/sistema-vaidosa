-- create_sale precisava ser atualizada junto com a coluna price_atacado/
-- price_varejo: ela calcula subtotal e sale_items.price a partir do preço
-- do PRODUTO no servidor (v_product.price), não do que o carrinho no
-- frontend mostra — então sem essa mudança toda venda continuaria cobrando
-- o preço atacado, mesmo com "Varejo" selecionado na tela.
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
  p_items          jsonb,   -- [{ "product_id": "...", "qty": 2 }, ...]
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
begin
  if p_price_tier not in ('Atacado','Varejo') then
    raise exception 'price_tier inválido: %', p_price_tier;
  end if;

  select * into v_existing from public.sales where client_request_id = p_client_request_id;
  if found then return v_existing; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
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

  for v_item in select * from jsonb_array_elements(p_items) loop
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
    -- duas chamadas quase simultâneas com a mesma chave de idempotência
    select * into v_existing from public.sales where client_request_id = p_client_request_id;
    return v_existing;
end;
$$;

grant execute on function public.create_sale to authenticated;
