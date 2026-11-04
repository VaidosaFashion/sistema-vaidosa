-- Correção financeira atômica, sem recriar venda, itens ou estoque.
-- Aplicar somente após conferir o schema remoto. Não altera vendas existentes.
-- vaidosa_private NÃO deve constar nos schemas expostos do PostgREST.
begin;

create schema if not exists vaidosa_private;
revoke all on schema vaidosa_private from public, anon;
grant usage on schema vaidosa_private to authenticated;

alter table public.sales add column finance_revision bigint not null default 0;

create table public.sale_financial_audit (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null, -- sem cascade: o histórico sobrevive à exclusão da venda
  request_id uuid not null unique,
  actor_id uuid not null,
  actor_name text not null,
  reason text not null,
  before_data jsonb not null,
  after_data jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create index sale_financial_audit_sale_idx on public.sale_financial_audit(sale_id, created_at);
alter table public.sale_financial_audit enable row level security;
revoke all on public.sale_financial_audit from public, anon, authenticated;
grant select on public.sale_financial_audit to authenticated;
create policy "staff read financial history" on public.sale_financial_audit
  for select to authenticated using (exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.active and (p.is_admin or p.is_vendedora)
  ));

create table vaidosa_private.sale_financial_requests (
  request_id uuid primary key,
  sale_id uuid not null,
  actor_id uuid not null,
  payload jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table vaidosa_private.sale_financial_requests enable row level security;
revoke all on vaidosa_private.sale_financial_requests from public, anon, authenticated;

create function vaidosa_private.sale_financial_snapshot(p_sale_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select to_jsonb(s) || jsonb_build_object(
    'sale_items', coalesce((select jsonb_agg(to_jsonb(i) order by i.id)
      from public.sale_items i where i.sale_id = s.id), '[]'::jsonb),
    'sale_payments', coalesce((select jsonb_agg(to_jsonb(p) order by p.id)
      from public.sale_payments p where p.sale_id = s.id), '[]'::jsonb)
  ) from public.sales s where s.id = p_sale_id;
$$;
revoke all on function vaidosa_private.sale_financial_snapshot(uuid) from public, anon, authenticated;

-- Auditoria minimizada: a resposta da RPC continua completa, mas o histórico
-- não copia CPF fiscal, cliente, observação da venda, itens ou futuras colunas.
-- A nota do pagamento fica porque é um campo financeiro editável neste fluxo.
create function vaidosa_private.sale_financial_audit_snapshot(p_sale_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'id',s.id,'finance_revision',s.finance_revision,
    'subtotal',s.subtotal,'discount',s.discount,'total_bruto',s.total_bruto,
    'cost_total',s.cost_total,'fee_pct',s.fee_pct,'fee_value',s.fee_value,
    'net_received',s.net_received,'profit',s.profit,'payment_status',s.payment_status,
    'pay',s.pay,'installments',s.installments,
    'sale_payments',coalesce((select jsonb_agg(jsonb_build_object(
      'id',p.id,'paid_on',p.paid_on,'value',p.value,'method',p.method,
      'installments',p.installments,'fee_pct',p.fee_pct,'fee_value',p.fee_value,
      'net_value',p.net_value,'note',p.note
    ) order by p.id) from public.sale_payments p where p.sale_id=s.id),'[]'::jsonb)
  ) from public.sales s where s.id=p_sale_id;
$$;
revoke all on function vaidosa_private.sale_financial_audit_snapshot(uuid) from public, anon, authenticated;

-- Uma inserção de pagamento pelo fluxo antigo também precisa esperar a
-- correção terminar. UPDATE/DELETE diretos não podem transferir o pagamento.
create function vaidosa_private.lock_payment_sale()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_total numeric; v_fees jsonb; v_existing_sale uuid; v_actor uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    if v_actor is not null then
      if not exists(select 1 from public.profiles where id=v_actor and active and (is_admin or is_vendedora)) then
        raise exception 'Usuário sem permissão para registrar pagamentos' using errcode='42501';
      end if;
      new.created_by := v_actor;
    elsif current_user in ('anon','authenticated') then
      raise exception 'Autenticação necessária para registrar pagamentos' using errcode='42501';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.sale_id is distinct from old.sale_id then
    raise exception 'Não é permitido transferir um pagamento para outra venda';
  end if;
  select total_bruto into v_total from public.sales
    where id = case when tg_op = 'DELETE' then old.sale_id else new.sale_id end
    for update;
  if tg_op = 'INSERT' then
    select sale_id into v_existing_sale from public.sale_payments where id=new.id;
    if found then
      if v_existing_sale<>new.sale_id then
        raise exception 'Identificador de pagamento já usado em outra venda' using errcode='22023';
      end if;
      -- ON CONFLICT DO NOTHING: retry não reprecifica nem muda autoria.
      return new;
    end if;
    if v_actor is not null then
      if new.method not in ('PIX','Dinheiro','Debito','Credito') or new.method is null
        or new.value is null or new.value::text in ('NaN','Infinity','-Infinity') or new.value<=0
        or new.paid_on is null or not isfinite(new.paid_on)
        or new.installments is null
        or (new.method='Credito' and (new.installments<1 or new.installments>24))
        or (new.method<>'Credito' and new.installments<>0) then
        raise exception 'Confira valor, data, forma e parcelas do pagamento' using errcode='22023';
      end if;
      select card_fees into v_fees from public.store_settings where id=true;
      new.fee_pct := case new.method
        when 'Debito' then (v_fees->>'debito')::numeric
        when 'Credito' then coalesce((v_fees->'credito'->>new.installments::text)::numeric,
                                    (v_fees->>'credito_acima')::numeric)
        else 0 end;
      if new.fee_pct is null or new.fee_pct::text in ('NaN','Infinity','-Infinity') or new.fee_pct<0 or new.fee_pct>100 then
        raise exception 'Taxa de cartão inválida. Confira Financeiro > Taxas do cartão.' using errcode='22023';
      end if;
      new.fee_value := round(new.value*new.fee_pct/100,2);
      new.net_value := new.value-new.fee_value;
    end if;
    if coalesce((select sum(value) from public.sale_payments where sale_id=new.sale_id),0)+new.value > v_total then
      raise exception 'O pagamento ultrapassa o saldo atual da venda. Reabra os pagamentos e confira o valor.' using errcode='22023';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function vaidosa_private.lock_payment_sale() from public, anon, authenticated;
create trigger sale_payments_lock_sale before insert or update or delete
  on public.sale_payments for each row execute function vaidosa_private.lock_payment_sale();

create function vaidosa_private.bump_sale_finance_revision()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if row(new.discount,new.subtotal,new.total_bruto,new.cost_total,new.pay,
         new.installments,new.fee_pct,new.fee_value,new.net_received,new.profit,new.payment_status)
     is distinct from
     row(old.discount,old.subtotal,old.total_bruto,old.cost_total,old.pay,
         old.installments,old.fee_pct,old.fee_value,old.net_received,old.profit,old.payment_status)
     or new.finance_revision is distinct from old.finance_revision then
    new.finance_revision := old.finance_revision + 1;
  end if;
  return new;
end;
$$;
revoke all on function vaidosa_private.bump_sale_finance_revision() from public, anon, authenticated;
create trigger sales_finance_revision before update on public.sales
  for each row execute function vaidosa_private.bump_sale_finance_revision();

-- Substitui o trigger existente: mantém os relatórios coerentes em todos os
-- caminhos e invalida um formulário aberto mesmo se só a data/nota mudar.
create or replace function public.recalc_sale_totals() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_sale_id uuid;
  v_paid numeric; v_fee numeric; v_net numeric;
  v_methods integer; v_method text; v_installments smallint;
begin
  v_sale_id := case when tg_op = 'DELETE' then old.sale_id else new.sale_id end;
  perform 1 from public.sales where id = v_sale_id for update;
  select coalesce(sum(value),0), coalesce(sum(fee_value),0), coalesce(sum(net_value),0),
         count(distinct method), min(method), coalesce(max(installments) filter(where method='Credito'),0)
    into v_paid,v_fee,v_net,v_methods,v_method,v_installments
    from public.sale_payments where sale_id = v_sale_id;
  update public.sales set
    fee_value = v_fee, net_received = v_net, profit = v_net - cost_total,
    fee_pct = case when v_paid > 0 then round(v_fee/v_paid,4) else 0 end,
    pay = case when v_methods=0 then 'Pendente' when v_methods=1 then v_method else 'Misto' end,
    installments = case when v_methods=1 and v_method='Credito' then v_installments else 0 end,
    payment_status = case when v_paid >= total_bruto then 'Pago'
                          when v_paid > 0 then 'Parcial' else 'Aberto' end,
    finance_revision = finance_revision + 1
    where id = v_sale_id;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.recalc_sale_totals() from public, anon, authenticated;

-- A implementação privilegiada fica fora da API. O privilégio é necessário
-- para escrever auditoria imutável sem dar INSERT ao cliente. Todos os dados
-- de antes/depois vêm do banco, nunca do navegador. A autorização é explícita
-- porque SECURITY DEFINER não usa RLS: esta é uma loja compartilhada, não SaaS.
create function vaidosa_private.edit_sale_financials(
  p_sale_id uuid, p_request_id uuid, p_expected_revision bigint,
  p_discount numeric, p_payments jsonb, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid(); v_actor_name text;
  v_sale public.sales; v_payment public.sale_payments;
  v_previous vaidosa_private.sale_financial_requests;
  v_payload jsonb; v_before jsonb; v_after jsonb; v_entry jsonb;
  v_normalized jsonb := '[]'::jsonb;
  v_discount numeric; v_total numeric; v_paid numeric := 0;
  v_fee_pct numeric; v_fee numeric; v_net numeric;
  v_method text; v_installments smallint; v_value numeric; v_date date; v_note text;
  v_fees jsonb; v_has_fiscal boolean := false; v_changed boolean := false;
begin
  select p.display_name into v_actor_name from public.profiles p
    where p.id=v_actor and p.active and (p.is_admin or p.is_vendedora);
  if v_actor is null or not found then
    raise exception 'Usuário sem permissão para corrigir pagamentos' using errcode='42501';
  end if;
  if p_request_id is null or p_sale_id is null or p_expected_revision is null then
    raise exception 'Identificação da correção incompleta' using errcode='22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 3 or length(btrim(p_reason)) > 500 then
    raise exception 'Informe o motivo da correção (3 a 500 caracteres)' using errcode='22023';
  end if;
  if p_discount is null or p_discount::text in ('NaN','Infinity','-Infinity') or p_discount < 0 then
    raise exception 'Desconto inválido' using errcode='22023';
  end if;
  if jsonb_typeof(p_payments) is distinct from 'array' then
    raise exception 'Lista de pagamentos inválida' using errcode='22023';
  end if;
  v_discount := round(p_discount,2);
  select jsonb_build_object('sale_id',p_sale_id,'revision',p_expected_revision,
    'discount',v_discount,'reason',btrim(p_reason),
    'payments',coalesce(jsonb_agg(e order by e->>'id'),'[]'::jsonb)) into v_payload
    from jsonb_array_elements(p_payments) e;

  -- A mesma ordem de travas serializa correções e novos pagamentos.
  select * into v_sale from public.sales where id=p_sale_id for update;
  if not found then raise exception 'Venda não encontrada' using errcode='P0002'; end if;
  select * into v_previous from vaidosa_private.sale_financial_requests where request_id=p_request_id;
  if found then
    if v_previous.actor_id <> v_actor or v_previous.payload <> v_payload then
      raise exception 'Identificador já utilizado em outra correção' using errcode='22023';
    end if;
    -- Um retry antigo nunca substitui o cache por uma versão histórica.
    return vaidosa_private.sale_financial_snapshot(p_sale_id);
  end if;
  if v_sale.finance_revision <> p_expected_revision then
    raise exception 'A venda foi alterada em outra tela. Reabra a correção e confira os valores.' using errcode='40001';
  end if;
  if v_discount > v_sale.subtotal then
    raise exception 'O desconto não pode ultrapassar o subtotal da venda' using errcode='22023';
  end if;
  v_total := round(v_sale.subtotal-v_discount,2);
  v_before := vaidosa_private.sale_financial_audit_snapshot(p_sale_id);

  if (select count(*) from public.sale_payments where sale_id=p_sale_id) <> jsonb_array_length(p_payments)
     or (select count(distinct e->>'id') from jsonb_array_elements(p_payments) e) <> jsonb_array_length(p_payments) then
    raise exception 'A lista de pagamentos mudou. Reabra a correção.' using errcode='40001';
  end if;
  select card_fees into v_fees from public.store_settings where id=true;
  for v_entry in select e from jsonb_array_elements(p_payments) e order by e->>'id' loop
    if jsonb_typeof(v_entry) <> 'object' or v_entry->>'id' is null then
      raise exception 'Pagamento sem identificação' using errcode='22023';
    end if;
    select * into v_payment from public.sale_payments
      where id=(v_entry->>'id')::uuid and sale_id=p_sale_id for update;
    if not found then raise exception 'Pagamento não pertence a esta venda' using errcode='22023'; end if;
    v_method := v_entry->>'method';
    v_value := (v_entry->>'value')::numeric;
    v_installments := (v_entry->>'installments')::smallint;
    v_date := (v_entry->>'paid_on')::date;
    v_note := nullif(btrim(v_entry->>'note'),'');
    if v_method is null or v_method not in ('PIX','Dinheiro','Debito','Credito')
      or v_value is null or v_value::text in ('NaN','Infinity','-Infinity')
      or round(v_value,2) <= 0 or v_value >= 100000000
      or v_date is null or not isfinite(v_date)
      or v_installments is null
      or (v_method='Credito' and (v_installments < 1 or v_installments > 24))
      or (v_method<>'Credito' and v_installments<>0)
      or length(coalesce(v_note,'')) > 2000 then
      raise exception 'Confira valor, data, forma e parcelas do pagamento' using errcode='22023';
    end if;
    v_value := round(v_value,2);
    -- Alterar data/nota não reprecifica taxas históricas. Alterar apenas o
    -- valor usa a taxa registrada; nova forma/parcela usa a configuração atual.
    v_fee_pct := v_payment.fee_pct;
    v_fee := v_payment.fee_value;
    v_net := v_payment.net_value;
    if v_method <> v_payment.method or v_installments <> v_payment.installments then
      v_fee_pct := case v_method
        when 'Debito' then (v_fees->>'debito')::numeric
        when 'Credito' then coalesce((v_fees->'credito'->>v_installments::text)::numeric,
                                    (v_fees->>'credito_acima')::numeric)
        else 0 end;
    end if;
    if v_fee_pct is null or v_fee_pct::text in ('NaN','Infinity','-Infinity') or v_fee_pct < 0 or v_fee_pct > 100 then
      raise exception 'Taxa de cartão inválida. Confira Financeiro > Taxas do cartão.' using errcode='22023';
    end if;
    if v_value<>v_payment.value or v_method<>v_payment.method or v_installments<>v_payment.installments then
      v_fee_pct := round(v_fee_pct,2);
      v_fee := round(v_value*v_fee_pct/100,2);
      v_net := v_value-v_fee;
    end if;
    v_paid := v_paid+v_value;
    v_normalized := v_normalized || jsonb_build_array(jsonb_build_object(
      'id',v_payment.id,'paid_on',v_date,'value',v_value,'method',v_method,
      'installments',v_installments,'note',v_note,'fee_pct',v_fee_pct,'fee_value',v_fee,'net_value',v_net));
    if row(v_value,v_method,v_installments,v_date,coalesce(v_note,'')) is distinct from
       row(v_payment.value,v_payment.method,v_payment.installments,v_payment.paid_on,coalesce(v_payment.note,'')) then
      v_changed := true;
    end if;
  end loop;
  if v_paid > v_total then
    raise exception 'Os pagamentos ultrapassam o novo total. Corrija os valores recebidos no mesmo ajuste; nenhum estorno é feito automaticamente.' using errcode='22023';
  end if;
  v_changed := v_changed or v_discount is distinct from v_sale.discount;
  if v_changed then
    -- NFC-e é opcional no main. Qualquer emissão não definitivamente rejeitada
    -- ou cancelada bloqueia correção; inclui pendente/processando/estado desconhecido.
    if to_regclass('public.nfce_emissions') is not null then
      execute $q$ select coalesce(bool_or(coalesce(status,'') not in ('cancelled','canceled','rejected','denied')),false)
        from (select status from public.nfce_emissions where sale_id=$1 for update) e $q$
        into v_has_fiscal using p_sale_id;
      if v_has_fiscal then
        raise exception 'Venda com NFC-e autorizada ou em processamento. Resolva a emissão fiscal antes de corrigir valores.' using errcode='22023';
      end if;
    end if;
    update public.sales set discount=v_discount,total_bruto=v_total where id=p_sale_id;
    for v_entry in select e from jsonb_array_elements(v_normalized) e loop
      update public.sale_payments set
        paid_on=(v_entry->>'paid_on')::date,value=(v_entry->>'value')::numeric,
        method=v_entry->>'method',installments=(v_entry->>'installments')::smallint,
        note=v_entry->>'note',fee_pct=(v_entry->>'fee_pct')::numeric,
        fee_value=(v_entry->>'fee_value')::numeric,net_value=(v_entry->>'net_value')::numeric
      where id=(v_entry->>'id')::uuid and
        row(paid_on,value,method,installments,coalesce(note,''),fee_pct,fee_value,net_value)
        is distinct from
        row((v_entry->>'paid_on')::date,(v_entry->>'value')::numeric,v_entry->>'method',
          (v_entry->>'installments')::smallint,coalesce(v_entry->>'note',''),
          (v_entry->>'fee_pct')::numeric,(v_entry->>'fee_value')::numeric,(v_entry->>'net_value')::numeric);
    end loop;
    -- Desconto sem alteração de pagamento também atualiza o status e o lucro.
    update public.sales set
      fee_value=(select coalesce(sum(fee_value),0) from public.sale_payments where sale_id=p_sale_id),
      net_received=(select coalesce(sum(net_value),0) from public.sale_payments where sale_id=p_sale_id),
      profit=(select coalesce(sum(net_value),0) from public.sale_payments where sale_id=p_sale_id)-cost_total,
      fee_pct=case when v_paid>0 then round((select coalesce(sum(fee_value),0) from public.sale_payments where sale_id=p_sale_id)/v_paid,4) else 0 end,
      pay=(select case when count(distinct method)=0 then 'Pendente'
                      when count(distinct method)=1 then min(method) else 'Misto' end
           from public.sale_payments where sale_id=p_sale_id),
      installments=(select case when count(distinct method)=1 and min(method)='Credito'
                                then max(installments) else 0 end
                    from public.sale_payments where sale_id=p_sale_id),
      payment_status=case when v_paid>=v_total then 'Pago' when v_paid>0 then 'Parcial' else 'Aberto' end
      where id=p_sale_id;
    v_after := vaidosa_private.sale_financial_audit_snapshot(p_sale_id);
    insert into public.sale_financial_audit(sale_id,request_id,actor_id,actor_name,reason,before_data,after_data)
      values(p_sale_id,p_request_id,v_actor,v_actor_name,btrim(p_reason),v_before,v_after);
  end if;
  insert into vaidosa_private.sale_financial_requests(request_id,sale_id,actor_id,payload)
    values(p_request_id,p_sale_id,v_actor,v_payload);
  return vaidosa_private.sale_financial_snapshot(p_sale_id);
end;
$$;
revoke all on function vaidosa_private.edit_sale_financials(uuid,uuid,bigint,numeric,jsonb,text) from public, anon;
grant execute on function vaidosa_private.edit_sale_financials(uuid,uuid,bigint,numeric,jsonb,text) to authenticated;

create function public.edit_sale_financials(
  p_sale_id uuid, p_request_id uuid, p_expected_revision bigint,
  p_discount numeric, p_payments jsonb, p_reason text
) returns jsonb language sql security invoker set search_path = '' as $$
  select vaidosa_private.edit_sale_financials(p_sale_id,p_request_id,p_expected_revision,p_discount,p_payments,p_reason);
$$;
revoke all on function public.edit_sale_financials(uuid,uuid,bigint,numeric,jsonb,text) from public, anon;
grant execute on function public.edit_sale_financials(uuid,uuid,bigint,numeric,jsonb,text) to authenticated;

notify pgrst, 'reload schema';
commit;
