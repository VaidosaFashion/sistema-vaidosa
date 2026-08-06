-- Sistema Vaidosa — cor como atributo estruturado do produto
-- Até agora só existia tamanho (G1-G5) como atributo estruturado — cor era,
-- na melhor das hipóteses, texto livre dentro do SKU interno, que não é
-- usado pra identificar/filtrar/agrupar produto nenhum. Resultado: o
-- sistema não distinguia "Vestido Floral Preto G2" de "Vestido Floral
-- Azul G2". Pedido direto do Kennedy: cadastro de cores reaproveitável
-- (evita erro de digitação/inconsistência) + seleção obrigatória na hora
-- de gerar um produto, igual já acontece com tamanho.
--
-- Kennedy já está recadastrando produtos ativamente no momento em que essa
-- migração foi escrita — diferente da anterior (atacado/varejo), não dá
-- pra assumir catálogo vazio aqui. Qualquer produto que já exista na hora
-- de rodar isso ganha automaticamente a cor "Sem cor definida" (criada só
-- se precisar), pra não quebrar o NOT NULL nem perder produto já
-- cadastrado — ele reatribui a cor de verdade depois, editando o produto.

create table public.colors (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- Evita duplicata por digitação ("Preto" x "preto " x "PRETO") — mesmo
-- risco que motivou o cadastro centralizado em primeiro lugar.
create unique index colors_nome_unique_idx on public.colors (lower(trim(nome)));

alter table public.colors enable row level security;
create policy "authenticated full access" on public.colors
  for all to authenticated using (true) with check (true);

-- on delete restrict: não deixa apagar uma cor que já tem produto
-- cadastrado, pra não deixar produto "sem cor" por baixo do pano.
alter table public.products
  add column color_id uuid references public.colors(id) on delete restrict;

-- Backfill defensivo (ver nota do topo do arquivo) — só cria/usa o
-- placeholder se realmente existir produto sem cor nesse momento.
do $$
declare v_default_color_id uuid;
begin
  if exists (select 1 from public.products where color_id is null) then
    select id into v_default_color_id from public.colors
      where lower(trim(nome)) = lower(trim('Sem cor definida'));
    if v_default_color_id is null then
      insert into public.colors (nome) values ('Sem cor definida')
        returning id into v_default_color_id;
    end if;
    update public.products set color_id = v_default_color_id where color_id is null;
  end if;
end $$;

-- not null: cor é obrigatória em todo produto daqui pra frente (decisão do
-- Kennedy, mesma lógica do price_varejo obrigatório — nada de produto
-- "esquecido" sem cor).
alter table public.products alter column color_id set not null;
