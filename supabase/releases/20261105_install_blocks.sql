-- LOCAL/HOMOLOGACAO: requer metadata real, recuperacao validada e autorizacao futura.
-- Nao inclui nem reaplica migracoes financeiras anteriores.
begin;
-- SOURCE 20261105120000_accounts_integrity.sql
-- Preparado para homologação isolada. Exige parada dos clientes antigos na implantação.
-- Não reescreve valores, movimentos legados, vendas, estoque ou registros fiscais.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create schema if not exists vaidosa_private;
revoke all on schema vaidosa_private from public, anon;
grant usage on schema vaidosa_private to authenticated;

-- REVOKE de tabela não remove grants por coluna: parar e revisar antes.
do $$ begin
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid cross join lateral aclexplode(a.attacl) x
    where n.nspname='public' and c.relname in ('contas','movimentacoes') and a.attnum>0
      and (x.grantee=0 or x.grantee in(select oid from pg_roles where rolname in ('anon','authenticated')))
      and x.privilege_type in ('INSERT','UPDATE','REFERENCES')) then
    raise exception 'Privilégio por coluna inesperado em contas/movimentos: revisar antes de instalar';
  end if;
end $$;

-- Uma política inesperada precisa de revisão, não de substituição silenciosa.
do $$ begin
  if exists(select 1 from pg_policies where schemaname='public'
      and tablename in ('contas','movimentacoes') and policyname<>'authenticated full access') then
    raise exception 'Políticas de contas divergentes: revisar antes de instalar';
  end if;
end $$;

alter table public.contas add column operation_revision bigint not null default 0;
alter table public.contas add column archived_at timestamptz;
alter table public.movimentacoes add column operation_request_id uuid unique;
alter table public.movimentacoes add column reversed_at timestamptz;
alter table public.movimentacoes add column reversed_by uuid;
alter table public.movimentacoes add column reversal_reason text;
alter table public.movimentacoes add constraint movement_reversal_complete check (
  (reversed_at is null and reversed_by is null and reversal_reason is null)
  or (reversed_at is not null and reversed_by is not null and length(trim(reversal_reason)) between 3 and 500)
);

create table public.account_audit (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null, -- sem cascade: o histórico não depende da exclusão da conta
  request_id uuid not null unique,
  action text not null check(action in ('create','settle','edit','reverse','archive')),
  movement_id uuid,
  actor_id uuid not null,
  reason text,
  before_data jsonb not null,
  after_data jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create index account_audit_account_idx on public.account_audit(account_id,created_at);
alter table public.account_audit enable row level security;
revoke all on public.account_audit from public,anon,authenticated;
grant select on public.account_audit to authenticated;
create policy "active staff read account audit" on public.account_audit for select to authenticated
using(exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.active and (p.is_admin or p.is_vendedora)));

create table vaidosa_private.account_requests (
  request_id uuid primary key,
  account_id uuid not null,
  actor_id uuid not null,
  action text not null,
  payload jsonb not null,
  movement_id uuid,
  created_at timestamptz not null default clock_timestamp()
);
alter table vaidosa_private.account_requests enable row level security;
revoke all on vaidosa_private.account_requests from public,anon,authenticated;

create function vaidosa_private.account_snapshot(p_account_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('id',c.id,'tipo',c.tipo,'valor',c.valor,'status',c.status,
    'proximo_vencimento',c.proximo_vencimento,'categoria_id',c.categoria_id,
    'recorrencia',c.recorrencia,'parcelas',c.parcelas,'parcela_atual',c.parcela_atual,
    'data_inicio',c.data_inicio,'cliente_id',c.cliente_id,'forma_recebimento',c.forma_recebimento,
    'operation_revision',c.operation_revision,'archived_at',c.archived_at)
  from public.contas c where c.id=p_account_id;
$$;
revoke all on function vaidosa_private.account_snapshot(uuid) from public,anon,authenticated;

create function vaidosa_private.account_revision_guard()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then
    if exists(select 1 from public.movimentacoes where conta_id=old.id)
       or exists(select 1 from public.account_audit where account_id=old.id) then
      raise exception 'Conta com histórico deve ser arquivada, nunca excluída' using errcode='23503';
    end if;
    return old;
  end if;
  new.operation_revision:=old.operation_revision+1;
  return new;
end;
$$;
revoke all on function vaidosa_private.account_revision_guard() from public,anon,authenticated;
create trigger account_revision_guard before update or delete on public.contas
for each row execute function vaidosa_private.account_revision_guard();

-- SELECT c.* da view antiga foi expandido no momento da criação: preserve ordem.
create or replace view public.v_contas with(security_invoker=true) as
select c.id,c.client_request_id,c.tipo,c.descricao,c.valor,c.status,c.proximo_vencimento,c.obs,
  c.categoria_id,c.recorrencia,c.parcelas,c.parcela_atual,c.data_inicio,c.cliente_id,
  c.forma_recebimento,c.created_by,c.created_at,c.updated_at,
  cat.nome as categoria_nome,cl.name as cliente_nome,c.operation_revision,c.archived_at
from public.contas c left join public.categorias cat on cat.id=c.categoria_id
left join public.clients cl on cl.id=c.cliente_id;

create function vaidosa_private.account_response(p_account_id uuid,p_movement_id uuid,p_replayed boolean)
returns jsonb language sql stable security invoker set search_path='' as $$
select jsonb_build_object('account',to_jsonb(c),
 'movement',(select to_jsonb(m) from public.movimentacoes m where m.id=p_movement_id),
 'replayed',p_replayed) from public.contas c where c.id=p_account_id;
$$;
revoke all on function vaidosa_private.account_response(uuid,uuid,boolean) from public,anon,authenticated;

-- O UUID é bloqueado antes da conta. Mesma tentativa nunca executa duas vezes;
-- tentativas diferentes competem pela revisão e somente uma avança.
create function vaidosa_private.account_operation(
  p_action text,p_account_id uuid,p_request_id uuid,p_expected_revision bigint,p_args jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=auth.uid(); v_account public.contas; v_request vaidosa_private.account_requests;
  v_movement public.movimentacoes; v_origin public.account_audit;
  v_payload jsonb; v_before jsonb; v_after jsonb; v_reason text;
  v_due date; v_installment integer; v_status text; v_changed boolean;
begin
  if v_actor is null or not exists(select 1 from public.profiles where id=v_actor and active and (is_admin or is_vendedora)) then
    raise exception 'Perfil ativo autorizado necessário' using errcode='42501';
  end if;
  if p_request_id is null or p_action is null or p_action not in ('create','settle','edit','reverse','archive')
    or p_args is null or jsonb_typeof(p_args)<>'object' then
    raise exception 'Operação inválida' using errcode='22023';
  end if;
  v_payload:=jsonb_build_object('action',p_action,'account_id',p_account_id,'expected_revision',p_expected_revision,'args',p_args);
  perform pg_advisory_xact_lock(hashtextextended('account-request:'||p_request_id::text,0));
  select * into v_request from vaidosa_private.account_requests where request_id=p_request_id;
  if found then
    if v_request.actor_id<>v_actor or v_request.payload<>v_payload then
      raise exception 'Identificador já usado por outra operação' using errcode='22023';
    end if;
    perform 1 from public.contas where id=v_request.account_id for update;
    return vaidosa_private.account_response(v_request.account_id,v_request.movement_id,true);
  end if;

  if p_action='create' then
    if p_account_id is not null or p_expected_revision is not null then raise exception 'Criação inválida' using errcode='22023'; end if;
    if exists(select 1 from jsonb_object_keys(p_args) k where k not in
      ('tipo','descricao','valor','proximo_vencimento','obs','categoria_id','recorrencia','parcelas','data_inicio','cliente_id','forma_recebimento')) then
      raise exception 'Campo de criação não permitido' using errcode='22023';
    end if;
    if p_args->>'tipo' is null or p_args->>'tipo' not in ('pagar','receber')
      or coalesce(length(trim(p_args->>'descricao')),0) not between 1 and 500
      or coalesce((p_args->>'valor')::numeric,0)<=0 or (p_args->>'valor')::numeric>99999999.99
      or (p_args->>'valor')::numeric<>round((p_args->>'valor')::numeric,2)
      or p_args->>'proximo_vencimento' is null or not isfinite((p_args->>'proximo_vencimento')::date)
      or coalesce(length(p_args->>'obs'),0)>4000 then
      raise exception 'Dados da conta inválidos' using errcode='22023';
    end if;
    if p_args->>'tipo'='pagar' and (p_args->>'categoria_id' is null or p_args->>'recorrencia' is null
      or p_args->>'recorrencia' not in ('unica','semanal','mensal')
      or coalesce((p_args->>'parcelas')::int,0)<1) then
      raise exception 'Categoria, recorrência e parcelas são necessárias' using errcode='22023';
    end if;
    insert into public.contas(client_request_id,tipo,descricao,valor,proximo_vencimento,obs,categoria_id,
      recorrencia,parcelas,parcela_atual,data_inicio,cliente_id,forma_recebimento,created_by)
    values(p_request_id,p_args->>'tipo',trim(p_args->>'descricao'),(p_args->>'valor')::numeric,
      (p_args->>'proximo_vencimento')::date,p_args->>'obs',(p_args->>'categoria_id')::uuid,
      p_args->>'recorrencia',(p_args->>'parcelas')::int,1,(p_args->>'data_inicio')::date,
      (p_args->>'cliente_id')::uuid,p_args->>'forma_recebimento',v_actor) returning * into v_account;
    v_before:='{}'::jsonb;
  else
    if p_account_id is null or p_expected_revision is null or p_expected_revision<0 then
      raise exception 'Identificador e revisão são necessários' using errcode='22023';
    end if;
    select * into v_account from public.contas where id=p_account_id for update;
    if not found then raise exception 'Conta não encontrada' using errcode='P0002'; end if;
    if v_account.operation_revision<>p_expected_revision then
      raise exception 'Conta alterada em outra operação. Atualize antes de continuar' using errcode='40001';
    end if;
    if v_account.archived_at is not null then raise exception 'Conta arquivada' using errcode='22023'; end if;
    v_before:=vaidosa_private.account_snapshot(v_account.id);
    if p_action='settle' then
      if v_account.status<>'ativo' then raise exception 'Conta já concluída' using errcode='22023'; end if;
      if p_args->>'paid_on' is null or not isfinite((p_args->>'paid_on')::date) then raise exception 'Data inválida' using errcode='22023'; end if;
      v_due:=v_account.proximo_vencimento; v_installment:=v_account.parcela_atual; v_status:='concluido';
      if v_account.tipo='pagar' and v_account.recorrencia is distinct from 'unica' then
        if v_account.recorrencia is null or v_account.recorrencia not in ('semanal','mensal')
          or v_account.parcelas is null or v_account.parcelas<1 or v_installment is null
          or v_installment<1 or v_installment>v_account.parcelas then
          raise exception 'Parcelamento legado incompleto: revise a conta antes de pagar' using errcode='22023';
        end if;
        if v_installment<v_account.parcelas then
          v_installment:=v_installment+1; v_status:='ativo';
          v_due:=case when v_account.recorrencia='semanal' then v_due+7 else (v_due+interval '1 month')::date end;
        end if;
      end if;
      insert into public.movimentacoes(conta_id,tipo,descricao,valor,data,data_pagamento,pago,created_by,operation_request_id)
      values(v_account.id,v_account.tipo,case when v_account.tipo='pagar' then
          v_account.descricao||' - Parcela '||coalesce(v_account.parcela_atual::text,'1')||'/'||coalesce(v_account.parcelas::text,'1')
          else v_account.descricao end,v_account.valor,(p_args->>'paid_on')::date,(p_args->>'paid_on')::date,true,v_actor,p_request_id)
      returning * into v_movement;
      update public.contas set status=v_status,parcela_atual=v_installment,proximo_vencimento=v_due where id=v_account.id returning * into v_account;
    elsif p_action='edit' then
      if v_account.status<>'ativo' then raise exception 'Conta concluída: preserve o histórico; reverta o recebimento elegível primeiro' using errcode='22023'; end if;
      if exists(select 1 from jsonb_object_keys(p_args) k where k not in
        ('descricao','valor','proximo_vencimento','obs','categoria_id','cliente_id','forma_recebimento')) then
        raise exception 'Campo de edição não permitido' using errcode='22023';
      end if;
      if (p_args?'descricao' and coalesce(length(trim(p_args->>'descricao')),0) not between 1 and 500)
       or (p_args?'valor' and (coalesce((p_args->>'valor')::numeric,0)<=0 or (p_args->>'valor')::numeric>99999999.99
          or (p_args->>'valor')::numeric<>round((p_args->>'valor')::numeric,2)))
       or (p_args?'proximo_vencimento' and (p_args->>'proximo_vencimento' is null or not isfinite((p_args->>'proximo_vencimento')::date)))
       or coalesce(length(p_args->>'obs'),0)>4000 then raise exception 'Alteração inválida' using errcode='22023'; end if;
      if v_account.tipo='pagar' and (p_args?'cliente_id' or p_args?'forma_recebimento') then raise exception 'Campo exclusivo de recebimento' using errcode='22023'; end if;
      if v_account.tipo='receber' and p_args?'categoria_id' then raise exception 'Campo exclusivo de pagamento' using errcode='22023'; end if;
      if p_args?'descricao' then p_args:=jsonb_set(p_args,'{descricao}',to_jsonb(trim(p_args->>'descricao'))); end if;
      select exists(select 1 from jsonb_each(p_args) p where p.value is distinct from to_jsonb(v_account)->p.key) into v_changed;
      if v_changed then
        update public.contas set
          descricao=case when p_args?'descricao' then p_args->>'descricao' else descricao end,
          valor=case when p_args?'valor' then (p_args->>'valor')::numeric else valor end,
          proximo_vencimento=case when p_args?'proximo_vencimento' then (p_args->>'proximo_vencimento')::date else proximo_vencimento end,
          obs=case when p_args?'obs' then p_args->>'obs' else obs end,
          categoria_id=case when p_args?'categoria_id' then (p_args->>'categoria_id')::uuid else categoria_id end,
          cliente_id=case when p_args?'cliente_id' then (p_args->>'cliente_id')::uuid else cliente_id end,
          forma_recebimento=case when p_args?'forma_recebimento' then p_args->>'forma_recebimento' else forma_recebimento end
        where id=v_account.id returning * into v_account;
      end if;
    elsif p_action='reverse' then
      v_reason:=trim(p_args->>'reason');
      if v_reason is null or length(v_reason) not between 3 and 500 then raise exception 'Informe o motivo da reversão' using errcode='22023'; end if;
      select * into v_movement from public.movimentacoes where id=(p_args->>'movement_id')::uuid and conta_id=v_account.id for update;
      if not found or v_movement.operation_request_id is null then raise exception 'Movimento legado sem estado anterior verificável: reversão automática indisponível' using errcode='22023'; end if;
      if v_movement.reversed_at is not null then raise exception 'Movimento já revertido' using errcode='22023'; end if;
      select * into v_origin from public.account_audit where request_id=v_movement.operation_request_id
        and account_id=v_account.id and movement_id=v_movement.id and action='settle';
      if not found or (v_origin.after_data->>'operation_revision')::bigint is distinct from v_account.operation_revision
        or v_origin.after_data is distinct from v_before then
        raise exception 'A conta mudou após esse movimento: reversão automática bloqueada' using errcode='40001';
      end if;
      update public.movimentacoes set reversed_at=clock_timestamp(),reversed_by=v_actor,reversal_reason=v_reason
        where id=v_movement.id returning * into v_movement;
      update public.contas set status=v_origin.before_data->>'status',
        parcela_atual=(v_origin.before_data->>'parcela_atual')::integer,
        proximo_vencimento=(v_origin.before_data->>'proximo_vencimento')::date
        where id=v_account.id returning * into v_account;
    elsif p_action='archive' then
      v_reason:=trim(p_args->>'reason');
      if v_reason is null or length(v_reason) not between 3 and 500 then raise exception 'Informe o motivo do arquivamento' using errcode='22023'; end if;
      -- Não some com uma obrigação em aberto: decisão de cancelamento de dívida é separada.
      if v_account.status<>'concluido' then raise exception 'Conta ativa não pode ser arquivada; cancelamento de obrigação exige decisão específica' using errcode='22023'; end if;
      update public.contas set archived_at=clock_timestamp() where id=v_account.id returning * into v_account;
    end if;
  end if;
  v_after:=vaidosa_private.account_snapshot(v_account.id);
  insert into vaidosa_private.account_requests(request_id,account_id,actor_id,action,payload,movement_id)
    values(p_request_id,v_account.id,v_actor,p_action,v_payload,v_movement.id);
  if v_before is distinct from v_after or p_action='edit' and coalesce(v_changed,false) then
    insert into public.account_audit(account_id,request_id,action,movement_id,actor_id,reason,before_data,after_data)
    values(v_account.id,p_request_id,p_action,v_movement.id,v_actor,v_reason,v_before,v_after);
  end if;
  return vaidosa_private.account_response(v_account.id,v_movement.id,false);
end;
$$;
revoke all on function vaidosa_private.account_operation(text,uuid,uuid,bigint,jsonb) from public,anon;
grant execute on function vaidosa_private.account_operation(text,uuid,uuid,bigint,jsonb) to authenticated;

create function public.settle_account(p_account_id uuid,p_request_id uuid,p_expected_revision bigint,p_paid_on date)
returns jsonb language sql security invoker set search_path='' as $$
 select vaidosa_private.account_operation('settle',p_account_id,p_request_id,p_expected_revision,jsonb_build_object('paid_on',p_paid_on));
$$;
create function public.edit_account(p_account_id uuid,p_request_id uuid,p_expected_revision bigint,p_changes jsonb)
returns jsonb language sql security invoker set search_path='' as $$
 select vaidosa_private.account_operation('edit',p_account_id,p_request_id,p_expected_revision,p_changes);
$$;
create function public.reverse_account_settlement(p_account_id uuid,p_movement_id uuid,p_request_id uuid,p_expected_revision bigint,p_reason text)
returns jsonb language sql security invoker set search_path='' as $$
 select vaidosa_private.account_operation('reverse',p_account_id,p_request_id,p_expected_revision,jsonb_build_object('movement_id',p_movement_id,'reason',p_reason));
$$;
create function public.archive_account(p_account_id uuid,p_request_id uuid,p_expected_revision bigint,p_reason text)
returns jsonb language sql security invoker set search_path='' as $$
 select vaidosa_private.account_operation('archive',p_account_id,p_request_id,p_expected_revision,jsonb_build_object('reason',p_reason));
$$;
create function public.create_account_v2(p_request_id uuid,p_values jsonb)
returns jsonb language sql security invoker set search_path='' as $$
 select vaidosa_private.account_operation('create',null,p_request_id,null,p_values);
$$;
create function vaidosa_private.account_request_status(p_request_id uuid,p_expected_operation text,p_expected_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_request vaidosa_private.account_requests; v_action text; v_args jsonb; v_payload jsonb;
begin
  if v_actor is null or not exists(select 1 from public.profiles where id=v_actor and active and (is_admin or is_vendedora)) then
    raise exception 'Perfil ativo autorizado necessário' using errcode='42501';
  end if;
  if p_request_id is null or jsonb_typeof(p_expected_payload) is distinct from 'object'
    or (p_expected_payload->>'p_request_id')::uuid is distinct from p_request_id then
    raise exception 'Identificador e payload da tentativa são necessários' using errcode='22023';
  end if;
  case p_expected_operation
    when 'create_account_v2' then v_action:='create'; v_args:=p_expected_payload->'p_values';
    when 'settle_account' then v_action:='settle'; v_args:=jsonb_build_object('paid_on',p_expected_payload->'p_paid_on');
    when 'edit_account' then v_action:='edit'; v_args:=p_expected_payload->'p_changes';
    when 'reverse_account_settlement' then v_action:='reverse'; v_args:=jsonb_build_object('movement_id',p_expected_payload->'p_movement_id','reason',p_expected_payload->'p_reason');
    when 'archive_account' then v_action:='archive'; v_args:=jsonb_build_object('reason',p_expected_payload->'p_reason');
    else raise exception 'Operação esperada inválida' using errcode='22023';
  end case;
  v_payload:=jsonb_build_object('action',v_action,
    'account_id',case when v_action='create' then null else (p_expected_payload->>'p_account_id')::uuid end,
    'expected_revision',case when v_action='create' then null else (p_expected_payload->>'p_expected_revision')::bigint end,
    'args',v_args);
  perform pg_advisory_xact_lock(hashtextextended('account-request:'||p_request_id::text,0));
  select * into v_request from vaidosa_private.account_requests where request_id=p_request_id and actor_id=v_actor;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if v_request.payload is distinct from v_payload then raise exception 'Tentativa armazenada não corresponde ao payload informado' using errcode='22023'; end if;
  perform 1 from public.contas where id=v_request.account_id for update;
  return jsonb_build_object('status','completed','result',vaidosa_private.account_response(v_request.account_id,v_request.movement_id,true));
end;
$$;
revoke all on function vaidosa_private.account_request_status(uuid,text,jsonb) from public,anon;
grant execute on function vaidosa_private.account_request_status(uuid,text,jsonb) to authenticated;
create function public.get_account_request_status(p_request_id uuid,p_expected_operation text,p_expected_payload jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select vaidosa_private.account_request_status(p_request_id,p_expected_operation,p_expected_payload); $$;

-- Mantém assinatura e retorno da criação existente; fecha a rota anônima e
-- torna o UUID vinculado ao payload e ao autor. Sem política de limpeza do ledger.
create or replace function public.create_conta(
 p_client_request_id uuid,p_tipo text,p_descricao text,p_valor numeric,p_proximo_vencimento date,p_obs text,
 p_categoria_id uuid default null,p_recorrencia text default null,p_parcelas int default null,p_data_inicio date default null,
 p_cliente_id uuid default null,p_forma_recebimento text default null
) returns public.contas language plpgsql security invoker set search_path='' as $$
declare v_response jsonb; v_account public.contas;
begin
 v_response:=vaidosa_private.account_operation('create',null,p_client_request_id,null,jsonb_build_object(
 'tipo',p_tipo,'descricao',p_descricao,'valor',p_valor,'proximo_vencimento',p_proximo_vencimento,'obs',p_obs,
 'categoria_id',p_categoria_id,'recorrencia',p_recorrencia,'parcelas',p_parcelas,'data_inicio',p_data_inicio,
 'cliente_id',p_cliente_id,'forma_recebimento',p_forma_recebimento));
 select * into v_account from jsonb_populate_record(null::public.contas,v_response->'account');
 return v_account;
end;
$$;

revoke all on function public.settle_account(uuid,uuid,bigint,date),public.edit_account(uuid,uuid,bigint,jsonb),
 public.reverse_account_settlement(uuid,uuid,uuid,bigint,text),public.archive_account(uuid,uuid,bigint,text),
 public.get_account_request_status(uuid,text,jsonb),public.create_account_v2(uuid,jsonb),public.create_conta(uuid,text,text,numeric,date,text,uuid,text,int,date,uuid,text)
 from public,anon;
grant execute on function public.settle_account(uuid,uuid,bigint,date),public.edit_account(uuid,uuid,bigint,jsonb),
 public.reverse_account_settlement(uuid,uuid,uuid,bigint,text),public.archive_account(uuid,uuid,bigint,text),
 public.get_account_request_status(uuid,text,jsonb),public.create_account_v2(uuid,jsonb),public.create_conta(uuid,text,text,numeric,date,text,uuid,text,int,date,uuid,text)
 to authenticated;

-- O frontend antigo perde escrita: implantar junto, com caixas e integrações pausados.
drop policy "authenticated full access" on public.contas;
drop policy "authenticated full access" on public.movimentacoes;
revoke all on public.contas,public.movimentacoes from public,anon,authenticated;
grant select on public.contas,public.movimentacoes to authenticated;
create policy "active staff read accounts" on public.contas for select to authenticated
using(exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.active and (p.is_admin or p.is_vendedora)));
create policy "active staff read movements" on public.movimentacoes for select to authenticated
using(exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.active and (p.is_admin or p.is_vendedora)));
-- REVOKE direto não elimina direitos vindos de memberships. Falha integral
-- se algum caminho herdado ainda permitir escrita ou administração.
do $$
declare t regclass; r text;
begin
 foreach t in array array['public.contas'::regclass,'public.movimentacoes'::regclass] loop
  foreach r in array array['anon','authenticated'] loop
   if has_table_privilege(r,t,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
     or has_any_column_privilege(r,t,'INSERT,UPDATE,REFERENCES') then
    raise exception 'Direitos efetivos inesperados em % para %; revisar memberships antes de instalar',t,r;
   end if;
  end loop;
  if has_any_column_privilege('anon',t,'SELECT') then
   raise exception 'Leitura anônima herdada inesperada em %; revisar memberships',t;
  end if;
 end loop;
end $$;
notify pgrst,'reload schema';

-- SOURCE 20261105121000_stock_entry_requests.sql
-- Additive stock entry contract. Apply only after release review/backup.
-- Does not replace apply_stock_entry or rewrite any existing stock/movement.
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
