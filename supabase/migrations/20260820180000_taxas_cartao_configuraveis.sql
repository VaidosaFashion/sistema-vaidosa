-- Taxas de cartão configuráveis + forma de pagamento derivada (2026-08-20)
-- Rodar no SQL Editor do Supabase, um bloco por vez, conferindo cada um
-- (ver CLAUDE.md: "Success" do editor não prova que aplicou).

-- =========================================================
-- 1. Taxas do cartão saem do código e passam a viver no banco.
--    Kennedy ajusta no Financeiro; a taxa muda conforme a loja
--    bate ou não a meta de faturamento, então não pode ser fixa.
--    jsonb em vez de uma coluna por parcela: amanhã pode ter 10x
--    sem precisar de migração nova.
-- =========================================================
alter table public.store_settings
  add column if not exists card_fees jsonb not null default '{
    "debito": 2.99,
    "credito": {"1": 4.99, "2": 6.99, "3": 6.99, "4": 6.99, "5": 6.99, "6": 6.99},
    "credito_acima": 8.99
  }'::jsonb;

-- A tabela é singleton (id = true) e pode estar vazia: garante a linha.
insert into public.store_settings (id) values (true) on conflict (id) do nothing;

-- =========================================================
-- 2. sales.pay deixa de ser digitado na tela e passa a refletir
--    o que foi REALMENTE pago:
--      venda recém-lançada  -> 'Pendente'
--      um pagamento só      -> a forma dele (PIX/Dinheiro/Debito/Credito)
--      dois ou mais         -> 'Misto'
--    Os valores antigos continuam válidos por causa das 73 vendas
--    históricas, que têm CartaoAVista/CartaoParcelado.
-- =========================================================
alter table public.sales drop constraint if exists sales_pay_check;
alter table public.sales add constraint sales_pay_check
  check (pay in (
    'Pendente','PIX','Dinheiro','Debito','Credito','Misto',
    'CartaoAVista','CartaoParcelado'
  ));
