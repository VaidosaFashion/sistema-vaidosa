-- Campos fiscais no cadastro de produto — preparação pro módulo de NF-e
-- (emissão em si vem depois, planejada à parte). Objetivo imediato: todo
-- produto cadastrado a partir de agora já nasce com a classificação fiscal
-- certa, em vez de precisar de um retrabalho em massa depois.
--
-- Valores de exemplo (default) refletem o cenário mais comum de uma loja
-- de roupa MEI/Simples Nacional vendendo mercadoria nacional no varejo —
-- CONFERIR com o contador antes de emitir qualquer nota de verdade,
-- principalmente o NCM (varia pelo tipo exato de peça) e o CSOSN.

alter table public.products
  add column ncm         text,                                  -- Nomenclatura Comum do Mercosul (8 dígitos) — obrigatório, não tem default seguro (varia por peça)
  add column cfop         text,                                 -- Código Fiscal de Operações — default de venda dentro do estado
  add column cest         text,                                 -- Código Especificador da Substituição Tributária (só se aplicável; roupa geralmente não tem ST)
  add column csosn        text default '102',                   -- Simples Nacional: 102 = tributada sem permissão de crédito (comum pra MEI/Simples revendendo)
  add column origem       text not null default '0'              -- 0 = nacional
              check (origem in ('0','1','2','3','4','5','6','7','8')),
  add column unidade      text not null default 'UN';            -- unidade comercial

comment on column public.products.ncm is
  'Nomenclatura Comum do Mercosul, 8 dígitos. Obrigatório pra emitir NF-e/NFC-e. Sem default — precisa ser preenchido por peça (varia por tipo de roupa).';
comment on column public.products.cfop is
  'Código Fiscal de Operações e Prestações. Sem default fixo aqui pq depende do destino da venda (dentro/fora do estado) — o módulo de emissão decide o CFOP final na hora de gerar a nota; esse campo é só um valor de referência/mais comum pro produto.';
comment on column public.products.cest is
  'Código Especificador da Substituição Tributária — só preencher se a categoria da peça tiver ICMS-ST no seu estado. Deixar vazio se não se aplica.';
comment on column public.products.csosn is
  'Código de Situação da Operação — Simples Nacional (substitui o CST pra quem é Simples/MEI). Default 102 é o mais comum pra revenda simples, mas CONFIRMAR com o contador.';
comment on column public.products.origem is
  'Origem da mercadoria (tabela do NF-e): 0 nacional, 1-8 diversas origens estrangeiras/importação.';
