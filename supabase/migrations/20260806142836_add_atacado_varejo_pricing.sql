-- Sistema Vaidosa — preço atacado x varejo
-- Até agora a loja só vendia atacado (revenda pra outras lojistas), então
-- products.price era o único preço que existia. Com a entrada no Nuvemshop
-- (venda direta ao consumidor final), o mesmo produto passa a ter dois
-- preços válidos ao mesmo tempo — o sistema precisa saber os dois e a
-- vendedora precisa escolher qual vale em cada venda (pedido direto do
-- Kennedy, ver CLAUDE.md).
--
-- products.price vira products.price_atacado (preserva o histórico — é
-- exatamente o mesmo preço que sempre existiu, só ganhou nome explícito).
-- price_varejo é NOT NULL: cadastro de produto não fica pronto sem os dois
-- preços preenchidos (decisão do Kennedy — nada de produto "esquecido" sem
-- preço varejo quando chegar a hora de listar no Nuvemshop).
--
-- Catálogo de produtos está vazio em produção neste momento (Kennedy está
-- recadastrando do zero, ver CLAUDE.md) — não há necessidade de backfill.

-- Todo o bloco é seguro pra rodar mais de uma vez (idempotente) — caso a
-- primeira tentativa tenha falhado no meio (ver nota sobre create_sale na
-- outra migração) e precise ser reexecutado do zero.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='products' and column_name='price')
     and not exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='products' and column_name='price_atacado')
  then
    alter table public.products rename column price to price_atacado;
  end if;
end $$;

alter table public.products
  add column if not exists price_varejo numeric(10,2) not null default 0 check (price_varejo >= 0);

alter table public.products alter column price_varejo drop default;

-- price_tier é por VENDA inteira, não por item — uma venda é ou pra um
-- cliente revendedor (atacado) ou pra um consumidor final (varejo), não os
-- dois misturados no mesmo carrinho (decisão do Kennedy). Default 'Atacado'
-- preserva o comportamento histórico pra qualquer chamada antiga do RPC
-- que ainda não mande esse parâmetro.
alter table public.sales
  add column if not exists price_tier text not null default 'Atacado' check (price_tier in ('Atacado','Varejo'));
