-- TEST ONLY, private ephemeral PostgreSQL. Never a production migration.
begin;
do $$ begin if current_database()<>'vaidosa_mcp_read_fixture' or inet_server_addr() is not null then raise exception 'FIXTURE_ONLY'; end if; end $$;
create role mcp_revocation_reader login noinherit nosuperuser nobypassrls nocreatedb nocreaterole;
create role mcp_revocation_writer login noinherit nosuperuser nobypassrls nocreatedb nocreaterole;
create schema mcp_revocation_fixture;
revoke all on schema mcp_revocation_fixture from public;
create table mcp_revocation_fixture.state(
 namespace text primary key check(namespace~'^[a-f0-9]{64}$'),incarnation uuid not null,
 cluster_id text not null,revision bigint not null default 0 check(revision>=0),disabled boolean not null default false,
 entry_limit integer not null default 128 check(entry_limit between 1 and 4096),event_limit integer not null default 256 check(event_limit between 1 and 8192));
create table mcp_revocation_fixture.revoked(
 namespace text not null references mcp_revocation_fixture.state(namespace),kind text not null check(kind in ('token','subject','key')),
 target text not null check(target~'^[a-f0-9]{64}$'),cutoff bigint,
 primary key(namespace,kind,target),check((kind='subject' and cutoff is not null and cutoff>=0) or (kind<>'subject' and cutoff is null)));
create table mcp_revocation_fixture.requests(
 request_id uuid primary key,namespace text not null references mcp_revocation_fixture.state(namespace),payload jsonb not null,
 applied_revision bigint not null,created_at timestamptz not null default clock_timestamp());
create index revocation_requests_namespace on mcp_revocation_fixture.requests(namespace);
revoke all on all tables in schema mcp_revocation_fixture from public;
grant usage on schema mcp_revocation_fixture to mcp_revocation_reader,mcp_revocation_writer;

create function mcp_revocation_fixture.check_state(p jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s mcp_revocation_fixture.state; allowed boolean;
begin
 if session_user<>'mcp_revocation_reader' or current_database()<>'vaidosa_mcp_read_fixture' or inet_server_addr() is not null then raise exception 'Unavailable' using errcode='42501'; end if;
 select * into s from mcp_revocation_fixture.state where namespace=p->>'namespace';
 if not found or s.incarnation is distinct from (p->>'incarnation')::uuid or s.cluster_id is distinct from (select system_identifier::text from pg_control_system())
  or not coalesce((p->>'token')~'^[a-f0-9]{64}$',false) or not coalesce((p->>'subject')~'^[a-f0-9]{64}$',false) or not coalesce((p->>'key')~'^[a-f0-9]{64}$',false)
  or (p->>'nonce')::uuid is null or (p->>'iat')::bigint is null or (p->>'exp')::bigint is null or (p->>'iat')::bigint<0 or (p->>'exp')::bigint<=(p->>'iat')::bigint then raise exception 'Unavailable' using errcode='42501'; end if;
 allowed:=not s.disabled and not exists(select 1 from mcp_revocation_fixture.revoked r where r.namespace=s.namespace and
  ((r.kind='token' and r.target=p->>'token') or (r.kind='key' and r.target=p->>'key') or(r.kind='subject' and r.target=p->>'subject' and (p->>'iat')::bigint<=r.cutoff)));
 return jsonb_build_object('namespace',s.namespace,'incarnation',s.incarnation::text,'nonce',p->>'nonce','revision',s.revision::text,'allowed',allowed);
end $$;
revoke all on function mcp_revocation_fixture.check_state(jsonb) from public;
grant execute on function mcp_revocation_fixture.check_state(jsonb) to mcp_revocation_reader;

create function mcp_revocation_fixture.apply(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare s mcp_revocation_fixture.state; old mcp_revocation_fixture.requests; payload jsonb; status text; req uuid:=(p->>'requestId')::uuid;
begin
 if session_user<>'mcp_revocation_writer' or current_database()<>'vaidosa_mcp_read_fixture' or inet_server_addr() is not null then raise exception 'Unavailable' using errcode='42501'; end if;
 if req is null or (p->>'nonce')::uuid is null or p->>'mode' is null or p->>'mode' not in ('record','lookup') or p->>'kind' is null or p->>'kind' not in ('token','subject','key')
  or not coalesce((p->>'target')~'^[a-f0-9]{64}$',false) or (p->>'kind'='subject' and ((p->>'cutoff')::bigint is null or (p->>'cutoff')::bigint<0))
  or (p->>'kind'<>'subject' and p->'cutoff' is distinct from 'null'::jsonb) then raise exception 'Invalid intent' using errcode='22023'; end if;
 payload:=jsonb_build_object('kind',p->>'kind','target',p->>'target','cutoff',p->'cutoff');
 perform pg_advisory_xact_lock(hashtextextended('mcp-revoke:'||req::text,0));
 select * into s from mcp_revocation_fixture.state where namespace=p->>'namespace' for update;
 if not found or s.incarnation is distinct from (p->>'incarnation')::uuid or s.cluster_id is distinct from(select system_identifier::text from pg_control_system()) then raise exception 'Unavailable' using errcode='42501'; end if;
 select * into old from mcp_revocation_fixture.requests where request_id=req;
 if found then
  if old.namespace<>s.namespace or old.payload is distinct from payload then raise exception 'Intent mismatch' using errcode='22023'; end if;
  status:=case when p->>'mode'='lookup' then 'applied' else 'replayed' end;
 elsif p->>'mode'='lookup' then status:='not_found';
 elsif s.disabled then status:='locked_down';
 elsif (select count(*) from mcp_revocation_fixture.requests where namespace=s.namespace)>=s.event_limit or
  (not exists(select 1 from mcp_revocation_fixture.revoked where namespace=s.namespace and kind=p->>'kind' and target=p->>'target') and (select count(*) from mcp_revocation_fixture.revoked where namespace=s.namespace)>=s.entry_limit) then
  update mcp_revocation_fixture.state set disabled=true,revision=revision+1 where namespace=s.namespace returning * into s;
  status:='locked_down';
 else
  insert into mcp_revocation_fixture.revoked(namespace,kind,target,cutoff) values(s.namespace,p->>'kind',p->>'target',(p->>'cutoff')::bigint)
   on conflict(namespace,kind,target) do update set cutoff=greatest(mcp_revocation_fixture.revoked.cutoff,excluded.cutoff);
  update mcp_revocation_fixture.state set revision=revision+1 where namespace=s.namespace returning * into s;
  insert into mcp_revocation_fixture.requests(request_id,namespace,payload,applied_revision) values(req,s.namespace,payload,s.revision);
  status:='applied';
 end if;
 return jsonb_build_object('namespace',s.namespace,'incarnation',s.incarnation::text,'nonce',p->>'nonce','revision',s.revision::text,'requestId',req::text,'status',status);
end $$;
revoke all on function mcp_revocation_fixture.apply(jsonb) from public;
grant execute on function mcp_revocation_fixture.apply(jsonb) to mcp_revocation_writer;
commit;
