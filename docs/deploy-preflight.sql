-- Somente leitura; usar na implantação futura, não é uma solicitação de nova
-- rodada de auditoria. Confirmar projeto ysultkzfhgtyujbomfqz no painel.
-- Hash diferente exige comparação, não substituição cega da função.
with esperado(nome,hash) as (values
  ('apply_stock_entry','75dfe06a978687fb7d3329f5e1b23e9c'),
  ('create_sale','942931fb08247d0f3940a2f4800d4b26'),
  ('delete_sale','75b33aeb20ed86984d21b100a86281f8'),
  ('recalc_sale_totals','02c4a0160cd9b896eef82a2d812fb8ae')
)
select e.nome, e.hash as hash_auditado,
  pg_get_function_identity_arguments(p.oid) as assinatura,
  md5(pg_get_functiondef(p.oid)) as hash_atual,
  md5(pg_get_functiondef(p.oid))=e.hash as igual_ao_export_auditado
from esperado e
left join pg_namespace n on n.nspname='public'
left join pg_proc p on p.pronamespace=n.oid and p.proname=e.nome and p.prokind='f'
order by e.nome;
