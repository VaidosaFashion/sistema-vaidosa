"""Prove installer aborts atomically on unexpected column grants; disposable socket only."""
import os,re,subprocess
from pathlib import Path
socket=os.environ.get('VAIDOSA_TEST_SOCKET','');port=os.environ.get('VAIDOSA_TEST_PORT','')
assert re.fullmatch(r'/tmp/vaidosa-sql\.[A-Za-z0-9]+',socket) and port.isdecimal()
env={k:v for k,v in os.environ.items() if not k.startswith('PG')}
env.update(PGPASSFILE='/dev/null',PGSERVICEFILE='/dev/null',PGOPTIONS='-c statement_timeout=10000 -c lock_timeout=5000')
base=['psql','-X','-qAt','-h',socket,'-p',port,'-d','postgres','-v','ON_ERROR_STOP=1']
def query(sql):
 r=subprocess.run(base+['-c',sql],capture_output=True,text=True,env=env,timeout=15);assert r.returncode==0,r.stderr;return r.stdout.strip()
assert Path(query('show data_directory')).resolve()==Path(socket).resolve()/'pgdata'
assert query('show listen_addresses')==''
signature='public.create_conta(uuid,text,text,numeric,date,text,uuid,text,integer,date,uuid,text)'
before=query("select md5(pg_get_functiondef('"+signature+"'::regprocedure))")
try:
 query('grant update(valor) on public.contas to authenticated')
 r=subprocess.run(base+['-f','supabase/releases/20261105_install_blocks.sql'],capture_output=True,text=True,env=env,timeout=15)
 assert r.returncode!=0 and 'Privilégio por coluna inesperado' in r.stderr,r.stderr
 assert query("select count(*) from information_schema.columns where table_schema='public' and table_name='contas' and column_name='operation_revision'")=='0'
 assert query("select to_regclass('public.account_audit') is null")=='t'
 assert query("select md5(pg_get_functiondef('"+signature+"'::regprocedure))")==before
 print('PASS: unexpected column grant blocks installer; no columns/audit/function changes survive rollback')
finally:
 query('revoke update(valor) on public.contas from authenticated')

# Prepared follow-up case: inherited privileges must also abort atomically.
# This new case has NOT been executed under the required follow-up OS sandbox.
try:
 query('create role vaidosa_inherited_fixture nologin; grant truncate on public.contas to vaidosa_inherited_fixture; grant vaidosa_inherited_fixture to authenticated')
 r=subprocess.run(base+['-f','supabase/releases/20261105_install_blocks.sql'],capture_output=True,text=True,env=env,timeout=15)
 assert r.returncode!=0 and 'Direitos efetivos inesperados' in r.stderr,r.stderr
 assert query("select count(*) from information_schema.columns where table_schema='public' and table_name='contas' and column_name='operation_revision'")=='0'
 assert query("select to_regclass('public.account_audit') is null")=='t'
 assert query("select md5(pg_get_functiondef('"+signature+"'::regprocedure))")==before
 print('PASS: inherited fixture privilege blocks installer atomically')
finally:
 query('revoke vaidosa_inherited_fixture from authenticated; drop owned by vaidosa_inherited_fixture; drop role vaidosa_inherited_fixture')
