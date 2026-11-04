-- Proteções das RPCs existentes que compartilham vendas/estoque com a correção.
-- Não altera dados existentes. Mantém assinaturas e o modelo de loja compartilhada.
-- Requer perfil ativo administrador ou vendedora; chama anon passa a ser negada.
-- Aplicar após conferir funções/grants reais; executar testes em banco isolado.
begin;

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
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_existing public.sales;
  v_sale     public.sales;
  v_item     jsonb;
  v_product  public.products;
  v_price    numeric;
  v_sub numeric := 0; v_cost numeric := 0;
  v_items    jsonb;
  v_constraint text;
begin
  if v_actor is null or not exists (
    select 1 from public.profiles p
    where p.id = v_actor and p.active and (p.is_admin or p.is_vendedora)
  ) then
    raise exception 'Usuário sem permissão para alterar vendas ou estoque' using errcode = '42501';
  end if;
  if p_client_request_id is null then
    raise exception 'Identificador da tentativa é obrigatório' using errcode = '22023';
  end if;
  -- Serializa a MESMA tentativa antes de ler estoque. Um retry concorrente
  -- deve retornar a venda original, inclusive quando ela vendeu a última peça.
  perform pg_advisory_xact_lock(hashtextextended(p_client_request_id::text, 0));
  select * into v_existing from public.sales where client_request_id = p_client_request_id;
  if found then return v_existing; end if;

  if p_price_tier is null or p_price_tier not in ('Atacado','Varejo') then
    raise exception 'Tabela de preço inválida' using errcode = '22023';
  end if;
  if p_discount is null or p_discount::text in ('NaN','Infinity','-Infinity') or p_discount < 0 then
    raise exception 'Desconto inválido' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Lista de itens inválida' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'Venda sem itens' using errcode = '22023';
  end if;
  -- Não descarta silenciosamente linhas inválidas ao agregar o produto.
  for v_item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) is distinct from 'object'
       or nullif(v_item->>'product_id','') is null
       or not coalesce(v_item->>'qty' ~ '^[1-9][0-9]*$', false) then
      raise exception 'Produto ou quantidade inválida' using errcode = '22023';
    end if;
    perform (v_item->>'product_id')::uuid;
    if (v_item->>'qty')::numeric > 2147483647 then
      raise exception 'Quantidade inválida' using errcode = '22023';
    end if;
  end loop;

  -- Soma qty por produto ANTES de travar/checar estoque.
  select coalesce(jsonb_agg(jsonb_build_object('product_id', product_id, 'qty', qty) order by product_id), '[]'::jsonb)
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

  if p_discount > v_sub then
    raise exception 'O desconto não pode ultrapassar o subtotal da venda' using errcode = '22023';
  end if;

  insert into public.sales (
    client_request_id, client_id, vendedor_id, channel, kind, pay, installments,
    discount, subtotal, total_bruto, cost_total, profit, payment_status, note, price_tier, created_by
  ) values (
    -- Os parâmetros legados permanecem na API, mas a forma vem dos pagamentos.
    -- Sem recebimento registrado, a venda nasce Pendente e sem parcelas.
    p_client_request_id, p_client_id, p_vendedor_id, p_channel, p_kind, 'Pendente', 0,
    round(p_discount,2), v_sub, v_sub - round(p_discount,2), v_cost, -v_cost,
    case when v_sub - round(p_discount,2) = 0 then 'Pago' else 'Aberto' end,
    p_note, p_price_tier, v_actor
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
              v_product.stock - (v_item->>'qty')::int, 'Venda', v_actor);
  end loop;

  return v_sale;
exception
  when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'sales_client_request_id_key' then
      select * into v_existing from public.sales where client_request_id = p_client_request_id;
      if found then return v_existing; end if;
    end if;
    raise; -- nunca transforma outra violação em sucesso com retorno NULL
end;
$$;

revoke all on function public.create_sale(
  uuid, uuid, uuid, text, text, text, smallint, numeric, text, jsonb, text
) from public, anon;

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
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_product   public.products;
  v_new_stock int;
  v_move      public.stock_moves;
begin
  if v_actor is null or not exists (
    select 1 from public.profiles p
    where p.id = v_actor and p.active and (p.is_admin or p.is_vendedora)
  ) then
    raise exception 'Usuário sem permissão para alterar vendas ou estoque' using errcode = '42501';
  end if;
  if p_type is null or p_type not in ('ENTRADA','SAIDA','DEVOLUCAO') then
    raise exception 'tipo inválido: %', p_type;
  end if;
  if p_qty is null or p_qty = 0 then
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
    values (p_type, v_product.barcode, v_product.id, p_qty, v_new_stock, p_note, v_actor)
    returning * into v_move;

  return jsonb_build_object('product', to_jsonb(v_product), 'move', to_jsonb(v_move));
end;
$$;

revoke all on function public.apply_stock_entry(uuid, int, text, text, numeric) from public, anon;

grant execute on function public.apply_stock_entry(uuid, int, text, text, numeric) to authenticated;

-- =========================================================
-- 4. delete_sale — devolve estoque e apaga a venda NA MESMA
--    transação. Trava NFC-e autorizada/em processamento no banco,
--    e só consulta nfce_emissions se a tabela existir.
-- =========================================================
create or replace function public.delete_sale(p_sale_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_item            record;
  v_product         public.products;
  v_new_stock       int;
  v_nfce_authorized boolean := false;
begin
  if v_actor is null or not exists (
    select 1 from public.profiles p
    where p.id = v_actor and p.active and (p.is_admin or p.is_vendedora)
  ) then
    raise exception 'Usuário sem permissão para alterar vendas ou estoque' using errcode = '42501';
  end if;
  if p_sale_id is null then
    raise exception 'Venda não informada' using errcode = '22023';
  end if;
  -- Trava a venda ANTES de ler os itens/devolver estoque: duas exclusões
  -- concorrentes nunca devolvem as mesmas peças duas vezes.
  perform 1 from public.sales where id = p_sale_id for update;
  if not found then return; end if; -- retry de exclusão já concluída

  if to_regclass('public.nfce_emissions') is not null then
    execute $q$
      select coalesce(bool_or(coalesce(status,'') not in
        ('cancelled','canceled','rejected','denied')),false)
      from (select status from public.nfce_emissions
            where sale_id = $1 for update) e
    $q$ into v_nfce_authorized using p_sale_id;
    if v_nfce_authorized then
      raise exception 'Essa venda tem NFC-e autorizada ou em processamento. Resolva a emissão fiscal antes de excluir.';
    end if;
  end if;

  for v_item in select * from public.sale_items where sale_id = p_sale_id order by product_id, id loop
    if v_item.product_id is null then continue; end if;
    select * into v_product from public.products where id = v_item.product_id for update;
    if not found then continue; end if; -- produto já apagado: não tem pra onde devolver
    v_new_stock := v_product.stock + v_item.qty;
    update public.products set stock = v_new_stock where id = v_product.id;
    insert into public.stock_moves (type, barcode, product_id, qty, stock_after, note, created_by)
      values ('DEVOLUCAO', v_product.barcode, v_product.id, v_item.qty, v_new_stock, 'Venda excluída', v_actor);
  end loop;

  delete from public.sales where id = p_sale_id;
end;
$$;

revoke all on function public.delete_sale(uuid) from public, anon;

grant execute on function public.delete_sale(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
