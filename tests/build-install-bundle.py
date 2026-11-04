"""Gera, sem executar SQL, o instalador manual de uma única transação."""
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
names = [
    '20261104133207_edit_sale_financials.sql',
    '20261104134055_harden_sale_stock_rpcs.sql',
    '20261104165000_limit_sales_table_privileges.sql',
]
parts = ["""-- VAIDOSA: instalação manual preparada, NÃO APLICADA EM PRODUÇÃO.
-- PRÉ-REQUISITO PENDENTE: backup real completo com restauração verificada.
-- Depois do backup: conferir 01_preflight.sql e projeto ysultkzfhgtyujbomfqz.
-- Executar TODO o arquivo uma única vez. Não selecionar apenas trechos.
-- Contém as três migrações em uma só transação, sem COMMIT intermediário.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regclass('public.sale_financial_audit') is not null
     or exists(select 1 from information_schema.columns where table_schema='public'
       and table_name='sales' and column_name='finance_revision') then
    raise exception 'Correção já presente ou instalação parcial: conferir estado, não reaplicar';
  end if;
end $$;
"""]
for name in names:
    source = (root / 'supabase' / 'migrations' / name).read_text()
    # Só as linhas do wrapper de transação; não altera BEGIN/END de PL/pgSQL.
    assert len(re.findall(r'^begin;\s*$', source, re.M | re.I)) == 1, name
    assert len(re.findall(r'^commit;\s*$', source, re.M | re.I)) == 1, name
    body = re.sub(r'^(?:begin;|commit;)\s*$', '', source, flags=re.M | re.I)
    parts.append(f'\n-- Origem: {name}\n{body}\n')
parts.append("""
-- Pós-condições antes de confirmar a transação.
do $$ begin
  if to_regprocedure('public.edit_sale_financials(uuid,uuid,bigint,numeric,jsonb,text)') is null
     or to_regprocedure('vaidosa_private.sale_financial_audit_snapshot(uuid)') is null
     or has_table_privilege('authenticated','public.sale_payments','UPDATE,DELETE')
     or has_table_privilege('authenticated','public.sales','INSERT,DELETE')
     or has_function_privilege('anon','public.delete_sale(uuid)','EXECUTE')
     or not has_table_privilege('anon','public.profiles','SELECT') then
    raise exception 'Pós-condição não atendida: instalação inteira será revertida';
  end if;
end $$;
commit;
-- Após sucesso: executar 03_pos_instalacao.sql antes de publicar o frontend.
""")
output = root / 'supabase' / 'releases' / '20261104_install_sales.sql'
output.parent.mkdir(exist_ok=True)
output.write_text('\n'.join(parts))
print(output)
