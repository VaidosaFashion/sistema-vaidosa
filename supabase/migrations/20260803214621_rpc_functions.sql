-- Sistema Vaidosa — Step 1: funções RPC idempotentes
-- Corrige o bug de duplo clique (btnFinalize / btnSalvarPagar / btnSalvarReceber,
-- ver CLAUDE.md) na camada certa: o servidor garante que um client_request_id
-- repetido nunca cria um segundo registro, e a linha do produto é travada
-- (for update) antes de conferir/baixar estoque — fecha a corrida entre dois
-- dispositivos vendendo a mesma peça ao mesmo tempo, algo que não existia
-- como risco antes (cada dispositivo tinha seu próprio estoque isolado).

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
  p_items          jsonb   -- [{ "product_id": "...", "qty": 2 }, ...]
) returns public.sales
language plpgsql security definer set search_path = public as $$
declare
  v_existing public.sales;
  v_sale     public.sales;
  v_item     jsonb;
  v_product  public.products;
  v_sub numeric := 0; v_cost numeric := 0;
begin
  select * into v_existing from public.sales where client_request_id = p_client_request_id;
  if found then return v_existing; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid for update;
    if not found then raise exception 'Produto não encontrado'; end if;
    if v_product.stock < (v_item->>'qty')::int then
      raise exception 'Estoque insuficiente: %', v_product.name;
    end if;
    v_sub  := v_sub  + v_product.price * (v_item->>'qty')::int;
    v_cost := v_cost + v_product.cost  * (v_item->>'qty')::int;
  end loop;

  insert into public.sales (
    client_request_id, client_id, vendedor_id, channel, kind, pay, installments,
    discount, subtotal, total_bruto, cost_total, note, created_by
  ) values (
    p_client_request_id, p_client_id, p_vendedor_id, p_channel, p_kind, p_pay, p_installments,
    p_discount, v_sub, greatest(0, v_sub - p_discount), v_cost, p_note, auth.uid()
  ) returning * into v_sale;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products where id = (v_item->>'product_id')::uuid;
    insert into public.sale_items (sale_id, product_id, name, cat, fabric, size, barcode, price, cost, qty)
      values (v_sale.id, v_product.id, v_product.name, v_product.cat, v_product.fabric,
              v_product.size, v_product.barcode, v_product.price, v_product.cost,
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

create or replace function public.create_conta(
  p_client_request_id  uuid,
  p_tipo               text,
  p_descricao          text,
  p_valor              numeric,
  p_proximo_vencimento date,
  p_obs                text,
  p_categoria_id       uuid default null,
  p_recorrencia        text default null,
  p_parcelas           int  default null,
  p_data_inicio        date default null,
  p_cliente_id         uuid default null,
  p_forma_recebimento  text default null
) returns public.contas
language plpgsql security definer set search_path = public as $$
declare v_existing public.contas; v_conta public.contas;
begin
  select * into v_existing from public.contas where client_request_id = p_client_request_id;
  if found then return v_existing; end if;

  insert into public.contas (
    client_request_id, tipo, descricao, valor, proximo_vencimento, obs,
    categoria_id, recorrencia, parcelas, parcela_atual, data_inicio,
    cliente_id, forma_recebimento, created_by
  ) values (
    p_client_request_id, p_tipo, p_descricao, p_valor, p_proximo_vencimento, p_obs,
    p_categoria_id, p_recorrencia, p_parcelas, 1, p_data_inicio,
    p_cliente_id, p_forma_recebimento, auth.uid()
  ) returning * into v_conta;
  return v_conta;
exception
  when unique_violation then
    select * into v_existing from public.contas where client_request_id = p_client_request_id;
    return v_existing;
end;
$$;

grant execute on function public.create_conta to authenticated;

-- =========================================================
-- Recalcula fee_value/net_received/profit/payment_status na venda
-- sempre que sale_payments muda — reproduz exatamente a fórmula de
-- btnAddPayment (index.html:4440-4448) e getSalePaymentStatus
-- (index.html:4258-4264), agora centralizada no servidor em vez de
-- recalculada no JS a cada render.
-- =========================================================

create or replace function public.recalc_sale_totals() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_sale_id uuid := coalesce(new.sale_id, old.sale_id);
  v_total_bruto numeric;
  v_cost_total  numeric;
  v_total_paid  numeric;
  v_total_fee   numeric;
  v_total_net   numeric;
  v_status      text;
begin
  select total_bruto, cost_total into v_total_bruto, v_cost_total
    from public.sales where id = v_sale_id;

  select coalesce(sum(value),0), coalesce(sum(fee_value),0), coalesce(sum(net_value),0)
    into v_total_paid, v_total_fee, v_total_net
    from public.sale_payments where sale_id = v_sale_id;

  v_status := case
    when v_total_paid >= v_total_bruto and v_total_bruto > 0 then 'Pago'
    when v_total_paid > 0 then 'Parcial'
    else 'Aberto'
  end;

  update public.sales
    set fee_value = v_total_fee,
        net_received = v_total_net,
        profit = v_total_net - coalesce(v_cost_total,0),
        payment_status = v_status
    where id = v_sale_id;

  return coalesce(new, old);
end;
$$;

create trigger sale_payments_recalc
  after insert or update or delete on public.sale_payments
  for each row execute function public.recalc_sale_totals();
