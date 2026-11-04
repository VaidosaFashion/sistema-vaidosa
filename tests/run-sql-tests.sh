#!/bin/sh
# Cria um cluster descartável; não aceita URL, senha ou banco remoto.
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_root=$(mktemp -d /tmp/vaidosa-sql.XXXXXX)
test_port=55439
cleanup() {
  pg_ctl -D "$test_root/pgdata" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$test_root"
}
trap cleanup EXIT HUP INT TERM
if ! initdb -D "$test_root/pgdata" -A trust --no-locale -E UTF8 >"$test_root/init.log" 2>&1; then
  cat "$test_root/init.log"
  exit 1
fi
# Sem TCP: nenhum serviço fica disponível fora do socket deste diretório.
if ! pg_ctl -D "$test_root/pgdata" -l "$test_root/server.log" -o "-k $test_root -p $test_port -h ''" start >"$test_root/start.log" 2>&1; then
  cat "$test_root/start.log"
  if [ -f "$test_root/server.log" ]; then cat "$test_root/server.log"; fi
  exit 1
fi
cd "$repo_dir"
run_sql() {
  if ! psql -X -h "$test_root" -p "$test_port" -d postgres -v ON_ERROR_STOP=1 -f "$1" >"$test_root/last.log" 2>&1; then
    cat "$test_root/last.log"
    exit 1
  fi
  sed -n '/NOTICE:  PASS:/p' "$test_root/last.log"
}
run_sql tests/sql/bootstrap.sql
for migration in supabase/migrations/202608*.sql; do run_sql "$migration"; done
run_sql tests/sql/observed_schema.sql
run_sql tests/sql/observed_privileges.sql
# Exportação privada SOMENTE da fixture local, antes da migração.
if ! psql -X -q --csv -h "$test_root" -p "$test_port" -d postgres -v ON_ERROR_STOP=1 \
  -f tests/sql/checkpoint_financeiro.sql >"$test_root/checkpoint.csv" 2>"$test_root/checkpoint-error.log"; then
  printf '%s\n' 'FAIL: exportação sintética de checkpoint; nenhum dado exibido'
  exit 1
fi
python3 tests/verify-financial-checkpoint.py "$test_root/checkpoint.csv"
VAIDOSA_TEST_SOCKET="$test_root" VAIDOSA_TEST_PORT="$test_port" python3 tests/checkpoint-roundtrip.py rows
run_sql docs/deploy-preflight.sql
run_sql supabase/releases/20261104_install_sales.sql
VAIDOSA_TEST_SOCKET="$test_root" VAIDOSA_TEST_PORT="$test_port" python3 tests/checkpoint-roundtrip.py functions
run_sql tests/sql/financial_edits.sql
run_sql tests/sql/financial_edits_extra.sql
run_sql tests/sql/financial_audit_privacy.sql
run_sql tests/sql/harden_sale_stock_rpcs.sql
run_sql tests/sql/table_privileges.sql
VAIDOSA_TEST_SOCKET="$test_root" VAIDOSA_TEST_PORT="$test_port" python3 tests/sql/concurrency.py
run_sql docs/audit-sales-readonly.sql
run_sql docs/audit-manual-estrutura.sql
run_sql docs/deploy-postcheck.sql
printf '%s\n' 'PASS: todas as migrações e consultas de auditoria em PostgreSQL local descartável'
