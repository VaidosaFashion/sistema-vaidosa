\set ON_ERROR_STOP on
-- Reconstrução LOCAL da diferença relevante observada em produção em 04/11/2026.
-- Aplicar após 202608*.sql e antes das novas migrações. Nunca aplicar em produção.
-- Colunas, tipos, nulabilidade, checks, FKs, índices, RLS e grants vieram da
-- metadata fornecida. Os nomes de constraints/índices são rótulos desta fixture.
-- Defaults fiscais NÃO foram fornecidos: não inventamos defaults. Cada INSERT
-- de teste informa id, numero, serie, ambiente, status, log e timestamps.
-- Os demais sete schemas/tabelas relevantes coincidem com as migrações antigas;
-- as policies compartilhadas e profiles.active já foram criadas pela baseline.

alter table public.sales add column buyer_cpf_nfce text;

create table public.nfce_emissions (
  id uuid primary key,
  sale_id uuid not null references public.sales(id) on delete cascade,
  numero integer not null,
  serie smallint not null,
  ambiente text not null check (ambiente in ('homologacao','producao')),
  status text not null check (status in (
    'pending','transmitted','authorized','rejected','denied','error','cancelled'
  )),
  log jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  chave_acesso text,
  codigo_status text,
  motivo_status text,
  protocolo_autorizacao text,
  xml_signed text,
  qrcode_url text,
  error_message text,
  protocolo_data timestamptz,
  emit_snapshot jsonb,
  created_by uuid references auth.users(id)
);
create index nfce_emissions_sale_id_idx on public.nfce_emissions(sale_id);
create unique index nfce_emissions_authorized_sale_idx on public.nfce_emissions(sale_id)
  where status='authorized';
create trigger set_updated_at before update on public.nfce_emissions
  for each row execute function public.set_updated_at();
alter table public.nfce_emissions enable row level security;
create policy "authenticated read emissions" on public.nfce_emissions
  for select to authenticated using (true);

grant all privileges on table public.sales, public.sale_items, public.sale_payments,
  public.products, public.stock_moves, public.profiles, public.store_settings,
  public.nfce_emissions to anon, authenticated;

-- Origem dos grants não veio no export. Exercita também herança via PUBLIC:
-- não muda as permissões efetivas observadas de anon/authenticated.
grant select on public.products to public;
