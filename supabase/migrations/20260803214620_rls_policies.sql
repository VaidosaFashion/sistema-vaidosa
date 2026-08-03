-- Sistema Vaidosa — Step 1: RLS
-- Modelo de confiança: 3 pessoas compartilhando os dados da MESMA loja,
-- não é multi-tenant. Toda tabela de negócio: qualquer usuário autenticado
-- tem acesso total. created_by é só auditoria, nunca controla acesso.

do $$
declare t text;
begin
  foreach t in array array[
    'vendedores','clients','products','sales','sale_items',
    'sale_payments','stock_moves','categorias','contas',
    'movimentacoes','store_settings'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "authenticated full access" on public.%I for all to authenticated using (true) with check (true)',
      t
    );
  end loop;
end $$;

-- profiles é a exceção: precisa ser listável ANTES do login (tela "escolha
-- seu nome"), mas nunca gravável pelo app — gestão das 3 contas é manual.
alter table public.profiles enable row level security;

create policy "profiles are listable for login" on public.profiles
  for select
  to anon, authenticated
  using (active = true);
