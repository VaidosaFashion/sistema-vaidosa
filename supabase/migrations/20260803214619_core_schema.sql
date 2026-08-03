-- Sistema Vaidosa — Step 1: schema central (substitui localStorage por Postgres)
-- Ver /Users/kennedyrodrigues/ZCodeProject/vaidosa-sistema/CLAUDE.md para contexto completo.

create extension if not exists pgcrypto;

-- =========================================================
-- IDENTIDADE / LOGIN
-- =========================================================

-- Uma linha por login (Kennedy, Cristiane, Tatiane), espelha auth.users 1:1.
-- Separado de "vendedores": nem todo login vende (Kennedy é só ADM),
-- e no futuro pode haver vendedor sem login próprio.
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  login_email  text not null unique,
  is_admin     boolean not null default false,
  is_vendedora boolean not null default false,
  vendedor_id  uuid, -- FK adicionada depois que vendedores existir (ver abaixo)
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

comment on table public.profiles is
  'Login das 3 pessoas do sistema. login_email/display_name legíveis por anon '
  'para a tela de login listar nomes antes de autenticar — sem dado sensível.';

-- =========================================================
-- NEGÓCIO
-- =========================================================

create table public.vendedores (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  phone      text,
  note       text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles
  add constraint profiles_vendedor_id_fkey
  foreign key (vendedor_id) references public.vendedores(id) on delete set null;

create table public.clients (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text,
  cnpj        text,
  cpf         text,
  city        text,
  note        text,
  troca_count integer not null default 0 check (troca_count >= 0),
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.categorias (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null,
  tipo       text not null check (tipo in ('despesa','receita')),
  created_at timestamptz not null default now()
);

-- Sequência de barcode do SERVIDOR — substitui o contador por dispositivo
-- (vaidosa_code_counter em localStorage) que podia gerar o mesmo código
-- "VF000042" em dois aparelhos diferentes apontando pra produtos diferentes.
create sequence public.product_barcode_seq start 1;

create table public.products (
  id         uuid primary key default gen_random_uuid(),
  barcode    text not null unique
             default ('VF' || lpad(nextval('public.product_barcode_seq')::text, 6, '0')),
  sku        text,
  name       text not null,
  cat        text,
  fabric     text,
  size       text not null check (size in ('G1','G2','G3','G4','G5')),
  cost       numeric(10,2) not null default 0 check (cost >= 0),
  price      numeric(10,2) not null default 0 check (price >= 0),
  stock      integer not null default 0 check (stock >= 0),
  note       text,
  family_key text, -- não usado ainda; reservado para futura tela "editar todos os tamanhos juntos"
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_name_idx   on public.products (name);
create index products_sku_idx    on public.products (sku);
create index products_family_idx on public.products (family_key);

create table public.sales (
  id                 uuid primary key default gen_random_uuid(),
  client_request_id  uuid unique, -- chave de idempotência (evita duplo lançamento por duplo clique)
  sold_at            timestamptz not null default now(),
  client_id          uuid references public.clients(id) on delete set null,
  vendedor_id        uuid references public.vendedores(id) on delete set null,
  channel            text not null check (channel in ('Loja','Trafego','WhatsApp','Instagram','Indicacao','Outro')),
  kind               text not null check (kind in ('Venda','Troca')),
  pay                text not null check (pay in ('PIX','Dinheiro','CartaoAVista','CartaoParcelado')),
  installments       smallint not null default 0 check (installments >= 0),
  discount           numeric(10,2) not null default 0,
  subtotal           numeric(10,2) not null default 0,
  total_bruto        numeric(10,2) not null default 0,
  cost_total         numeric(10,2) not null default 0,
  fee_pct            numeric(6,4) not null default 0,  -- FRAÇÃO (ex 0.0299) — escala diferente de sale_payments.fee_pct
  fee_value          numeric(10,2) not null default 0,
  net_received       numeric(10,2) not null default 0,
  profit             numeric(10,2) not null default 0,
  note               text,
  payment_status     text not null default 'Aberto' check (payment_status in ('Aberto','Parcial','Pago')),
  created_by         uuid references auth.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index sales_sold_at_idx   on public.sales (sold_at desc);
create index sales_client_id_idx on public.sales (client_id);
create index sales_vendedor_idx  on public.sales (vendedor_id);

create table public.sale_items (
  id         uuid primary key default gen_random_uuid(),
  sale_id    uuid not null references public.sales(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  name       text not null, -- snapshot no momento da venda
  cat        text,
  fabric     text,
  size       text,
  barcode    text,
  price      numeric(10,2) not null default 0,
  cost       numeric(10,2) not null default 0,
  qty        integer not null check (qty > 0)
);
create index sale_items_sale_id_idx    on public.sale_items (sale_id);
create index sale_items_product_id_idx on public.sale_items (product_id);

create table public.sale_payments (
  id           uuid primary key default gen_random_uuid(),
  sale_id      uuid not null references public.sales(id) on delete cascade,
  paid_on      date not null default current_date,
  value        numeric(10,2) not null check (value > 0),
  method       text not null check (method in ('PIX','Dinheiro','Debito','Credito')),
  installments smallint not null default 0,
  fee_pct      numeric(5,2) not null default 0,  -- PERCENTUAL (ex 2.99) — escala diferente de sales.fee_pct, preservado como está hoje no app
  fee_value    numeric(10,2) not null default 0,
  net_value    numeric(10,2) not null default 0,
  note         text,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now()
);
create index sale_payments_sale_id_idx on public.sale_payments (sale_id);

create table public.stock_moves (
  id          uuid primary key default gen_random_uuid(),
  moved_at    timestamptz not null default now(),
  type        text not null check (type in ('ENTRADA','SAIDA','DEVOLUCAO')),
  barcode     text,
  product_id  uuid references public.products(id) on delete set null,
  qty         integer not null, -- assinado: negativo em SAIDA, igual à convenção atual do app
  stock_after integer not null,
  note        text,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now()
);
create index stock_moves_product_idx  on public.stock_moves (product_id);
create index stock_moves_moved_at_idx on public.stock_moves (moved_at desc);

create table public.contas (
  id                  uuid primary key default gen_random_uuid(),
  client_request_id   uuid unique, -- chave de idempotência
  tipo                text not null check (tipo in ('pagar','receber')),
  descricao           text not null,
  valor               numeric(10,2) not null check (valor > 0),
  status              text not null default 'ativo' check (status in ('ativo','concluido')),
  proximo_vencimento  date not null,
  obs                 text,
  -- campos específicos de "pagar"
  categoria_id        uuid references public.categorias(id) on delete set null,
  recorrencia         text check (recorrencia in ('unica','semanal','mensal')),
  parcelas            integer,
  parcela_atual       integer,
  data_inicio         date,
  -- campos específicos de "receber"
  cliente_id          uuid references public.clients(id) on delete set null,
  forma_recebimento   text check (forma_recebimento in ('PIX','Cartão Crédito','Cartão Débito','Dinheiro')),
  created_by          uuid references auth.users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint contas_tipo_pagar_needs_categoria
    check (tipo <> 'pagar' or categoria_id is not null)
);
create index contas_tipo_status_idx on public.contas (tipo, status);

-- Substitui o texto congelado (categoriaNome) que hoje fica desatualizado
-- se a categoria for renomeada — join ao vivo em vez de snapshot.
create view public.v_contas
with (security_invoker = true) as
select c.*,
       cat.nome as categoria_nome,
       cl.name  as cliente_nome
from public.contas c
left join public.categorias cat on cat.id = c.categoria_id
left join public.clients    cl  on cl.id  = c.cliente_id;

-- Registro de cada pagamento/recebimento contra uma conta (existe hoje em
-- db.movimentacoes, não estava documentado no CLAUDE.md original).
create table public.movimentacoes (
  id             uuid primary key default gen_random_uuid(),
  conta_id       uuid not null references public.contas(id) on delete cascade,
  tipo           text not null check (tipo in ('pagar','receber')),
  descricao      text,
  valor          numeric(10,2) not null,
  data           date not null default current_date,
  data_pagamento date,
  pago           boolean not null default true,
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now()
);
create index movimentacoes_conta_idx on public.movimentacoes (conta_id);

-- Regra de negócio hoje presa em localStorage por aparelho (blockSecondSwap)
-- — vira uma linha única (singleton) compartilhada por todos.
create table public.store_settings (
  id                boolean primary key default true,
  block_second_swap boolean not null default true,
  updated_at        timestamptz not null default now(),
  constraint store_settings_is_singleton check (id = true)
);
insert into public.store_settings (id) values (true);

-- =========================================================
-- updated_at automático
-- =========================================================

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['vendedores','clients','products','sales','contas','store_settings']
  loop
    execute format(
      'create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()',
      t
    );
  end loop;
end $$;
