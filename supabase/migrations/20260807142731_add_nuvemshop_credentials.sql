-- Sistema Vaidosa — integração Nuvemshop (Step 5 do roteiro original)
-- Guarda o access_token obtido via OAuth (fluxo "Para os seus clientes",
-- app privado não listado na loja de aplicativos) e o store_id (chamado
-- de "user_id" na resposta da API da Nuvemshop/Tiendanube) da loja
-- vinculada. Loja única (Vaidosa Fashion Plus) — não é multi-tenant,
-- mas a tabela comporta mais de uma linha caso precise reconectar.
--
-- RLS deny-total pra "authenticated", igual fiscal_issuer/nfce_numeracao:
-- só a Edge Function (via service role) toca essa tabela. O access_token
-- é um segredo de verdade (dá acesso de escrita na loja Nuvemshop) —
-- não pode vazar pro frontend nem pra nenhum usuário comum do app.
create table public.nuvemshop_credentials (
  id           uuid primary key default gen_random_uuid(),
  store_id     text not null,
  access_token text not null,
  scope        text,
  connected_at timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.nuvemshop_credentials enable row level security;
-- Sem nenhuma policy pra "authenticated" — deny total, de propósito.
