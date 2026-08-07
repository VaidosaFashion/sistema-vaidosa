-- Sistema Vaidosa — integração Nuvemshop, mapa de produtos
-- Guarda, por barcode (chave já única e gerada pelo servidor pra cada
-- grade/cor de produto), o product_id/variant_id correspondente na
-- Nuvemshop. Populado em lote pela Edge Function nuvemshop-sync-catalog
-- (varre o catálogo da Nuvemshop e casa por barcode) — nunca escrito
-- pelo frontend direto. É essa tabela que permite empurrar baixa de
-- estoque pra Nuvemshop em 1 chamada de API por item vendido, sem
-- precisar buscar o produto lá toda hora.
create table public.nuvemshop_product_map (
  barcode             text primary key,
  nuvemshop_product_id text not null,
  nuvemshop_variant_id text not null,
  updated_at          timestamptz not null default now()
);

alter table public.nuvemshop_product_map enable row level security;
-- Sem nenhuma policy pra "authenticated" — deny total, igual nuvemshop_credentials.
-- Só a Edge Function (via service role) lê/escreve.
