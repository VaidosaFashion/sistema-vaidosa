"""Ensaio exclusivo do cluster descartável; NÃO é restaurador de produção."""
import csv
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

socket = os.environ['VAIDOSA_TEST_SOCKET']
assert socket.startswith('/tmp/vaidosa-sql.') and Path(socket).is_dir()
assert os.environ['VAIDOSA_TEST_PORT'] == '55439'
assert sys.argv[1:] in (['rows'], ['functions'])
raw = (Path(socket) / 'checkpoint.csv').read_text()
csv.field_size_limit(sys.maxsize)
envelope = next(csv.DictReader(io.StringIO(raw)))
payload = envelope['checkpoint_json']
json.loads(payload)
tag = '$cp_' + uuid.uuid4().hex + '$'
assert tag not in payload
if sys.argv[1] == 'rows':
    action = r"""
  for entry in select key,value from jsonb_each(cp->'tables') loop
    temporary_name := 'recovery_' || entry.key;
    execute format('create temporary table %I (like public.%I)',temporary_name,entry.key);
    execute format('insert into %I select * from jsonb_populate_recordset(null::public.%I,$1)',temporary_name,entry.key)
      using entry.value->'rows';
    execute format('select coalesce(jsonb_agg(to_jsonb(t) order by t.id),''[]''::jsonb) from %I t',temporary_name) into recovered;
    if recovered <> entry.value->'rows' then raise exception 'Checkpoint row roundtrip mismatch'; end if;
  end loop;
  raise notice 'PASS: checkpoint recupera valores/tipos das 11 tabelas em temporarias locais';
"""
else:
    action = r"""
  for fn in select value from jsonb_array_elements(cp->'functions') loop
    execute fn->>'definition';
    select pg_get_functiondef(p.oid) into restored_definition
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname=fn->>'schema' and p.proname=fn->>'name'
        and pg_get_function_identity_arguments(p.oid)=fn->>'identity_args';
    if restored_definition is distinct from fn->>'definition' then raise exception 'Function definition roundtrip mismatch'; end if;
  end loop;
  raise notice 'PASS: checkpoint recupera cinco definicoes originais apos migracao e reverte apenas o ensaio local';
"""
script = ('begin; create temporary table checkpoint_source(payload jsonb); insert into checkpoint_source values ('
          + tag + payload + tag + '::jsonb);\n' + r"""
do $roundtrip$
declare cp jsonb; entry record; fn jsonb; temporary_name text; recovered jsonb; restored_definition text;
begin
  select payload into cp from checkpoint_source;
""" + action + 'end; $roundtrip$; rollback;')
result = subprocess.run(['psql','-X','-q','-h',socket,'-p',os.environ['VAIDOSA_TEST_PORT'],
                         '-d','postgres','-v','ON_ERROR_STOP=1'], input=script,
                        text=True, capture_output=True)
# Mesmo num erro não imprimir o script/dados. Este ensaio é só para fixtures.
for line in result.stderr.splitlines():
    if 'NOTICE:  PASS:' in line: print(line)
if result.returncode:
    print('FAIL: checkpoint roundtrip local; nenhum dado exportado foi exibido.')
sys.exit(result.returncode)
