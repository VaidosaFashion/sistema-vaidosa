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
initdb -D "$test_root/pgdata" -A trust --no-locale -E UTF8 >"$test_root/init.log" 2>&1
# Sem TCP: nenhum serviço fica disponível fora do socket deste diretório.
pg_ctl -D "$test_root/pgdata" -l "$test_root/server.log" -o "-k $test_root -p $test_port -h ''" start >"$test_root/start.log" 2>&1
cd "$repo_dir"
run_sql() {
  if ! psql -X -h "$test_root" -p "$test_port" -d postgres -v ON_ERROR_STOP=1 -f "$1" >"$test_root/last.log" 2>&1; then
    cat "$test_root/last.log"
    exit 1
  fi
  sed -n '/NOTICE:  PASS:/p' "$test_root/last.log"
}
run_sql tests/sql/bootstrap.sql
for migration in supabase/migrations/*.sql; do run_sql "$migration"; done
run_sql tests/sql/financial_edits.sql
run_sql tests/sql/financial_edits_extra.sql
run_sql tests/sql/harden_sale_stock_rpcs.sql
VAIDOSA_TEST_SOCKET="$test_root" VAIDOSA_TEST_PORT="$test_port" python3 tests/sql/concurrency.py
run_sql docs/audit-sales-readonly.sql
printf '%s\n' 'PASS: todas as migrações e consultas de auditoria em PostgreSQL local descartável'
