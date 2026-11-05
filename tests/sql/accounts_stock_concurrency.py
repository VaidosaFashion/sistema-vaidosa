"""Real PostgreSQL races; ONLY the runner's disposable Unix socket is accepted.

No third-party modules, remote URLs, credentials, production data or TCP.
Each subprocess/statement is bounded; failed children are killed before cleanup.
The runner owns execution. This file does not start a server.
"""
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import time


socket = os.environ.get('VAIDOSA_TEST_SOCKET', '')
port = os.environ.get('VAIDOSA_TEST_PORT', '')
if not re.fullmatch(r'/tmp/vaidosa-sql\.[A-Za-z0-9]+', socket):
    raise SystemExit('Refused: only /tmp/vaidosa-sql.* runner socket is accepted')
if not port.isdecimal() or not 1 <= int(port) <= 65535:
    raise SystemExit('Refused: explicit local test port required')
real_socket = Path(socket).resolve(strict=True)
if not re.fullmatch(r'/(?:private/)?tmp/vaidosa-sql\.[A-Za-z0-9]+', str(real_socket)):
    raise SystemExit('Refused: socket symlink leaves disposable root')
socket_file = real_socket / ('.s.PGSQL.' + port)
if not stat.S_ISSOCK(socket_file.stat().st_mode):
    raise SystemExit('Refused: Unix socket missing')

env = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
env.update(PGPASSFILE='/dev/null', PGSERVICEFILE='/dev/null',
           PGOPTIONS='-c statement_timeout=8000 -c lock_timeout=6000 -c idle_in_transaction_session_timeout=10000')
base = ['psql', '-X', '-qAt', '-h', socket, '-p', port, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose']
children = []


def stop(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        raise AssertionError('Local test subprocess did not terminate')


def sql(query, success=True):
    result = subprocess.run(base + ['-c', query], text=True, capture_output=True, env=env, timeout=12)
    if success:
        assert result.returncode == 0, result.stderr
    return result


def scalar(query):
    return sql(query).stdout.strip()


def ident(number):
    return f'72000000-0000-4000-8000-{number:012d}'


actor_id = ident(1)
category_id = ident(2)
color_id = ident(3)
product_id = ident(4)
accounts = [ident(number) for number in (10, 11, 12, 13)]
account_list = ','.join("'" + value + "'" for value in accounts)
actor = f"set local request.jwt.claim.sub='{actor_id}'; set local role authenticated;"


def call(query):
    return sql('begin;' + actor + query + ';commit;')


def race(first, second, second_success):
    """First operation holds its transaction; second must meet the held lock.

    The sentinel is emitted only after the first mutation returns. The subsequent
    1-second sleep deliberately retains its transaction locks while B starts.
    Selectors prevent an unbounded blocking read if SQL fails before the sentinel.
    """
    process = subprocess.Popen(base, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, bufsize=1, env=env,
                               start_new_session=True)
    children.append(process)
    try:
        # Suppress the potentially buffered JSON result; only the marker is read.
        process.stdin.write('\\o /dev/null\nbegin;' + actor + first +
                            ';\n\\o\n\\echo VAIDOSA_TEST_LOCK_HELD\n'
                            'select pg_sleep(1); commit;\n')
        process.stdin.close()
        process.stdin = None
        deadline = time.monotonic() + 5
        marker = False
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while time.monotonic() < deadline and process.poll() is None:
                if selector.select(timeout=0.1):
                    line = process.stdout.readline()
                    if 'VAIDOSA_TEST_LOCK_HELD' in line:
                        marker = True
                        break
        if not marker:
            stop(process)
            raise AssertionError('First transaction did not reach its lock marker: ' + process.stderr.read())
        other = sql('begin;' + actor + second + ';commit;', success=False)
        stdout, stderr = process.communicate(timeout=12)
        assert process.returncode == 0, stderr
        if second_success:
            assert other.returncode == 0, other.stderr
        else:
            assert other.returncode != 0 and '40001' in other.stderr, other.stderr
        return other
    finally:
        stop(process)
        children.remove(process)


# Verify server identity before ANY fixture write; command-line host cannot route TCP.
identity = json.loads(scalar("select json_build_object('data_directory',current_setting('data_directory'),"
    "'listen_addresses',current_setting('listen_addresses'),'database',current_database(),"
    "'superuser',(select rolsuper from pg_roles where rolname=current_user))"))
assert Path(identity['data_directory']).resolve() == real_socket / 'pgdata', 'Refused: server is not runner cluster'
assert identity['listen_addresses'] == '' and identity['database'] == 'postgres' and identity['superuser'], 'Refused: server is not isolated owner session'

ready = False
try:
    sql(f"""begin;
      insert into auth.users(id) values('{actor_id}');
      insert into public.profiles(id,display_name,login_email,is_admin) values('{actor_id}','Concorrência fictícia','concurrency720@example.invalid',true);
      insert into public.categorias(id,nome,tipo) values('{category_id}','Categoria fictícia concorrência','despesa');
      insert into public.colors(id,nome) values('{color_id}','Cor fictícia concorrência');
      insert into public.products(id,name,size,cost,price_atacado,price_varejo,stock,color_id)
        values('{product_id}','Produto fictício concorrência','G1',10,20,25,10,'{color_id}');
      insert into public.contas(id,tipo,descricao,valor,proximo_vencimento) values
        ('{accounts[0]}','receber','Concorrência mesmo UUID',100,'2026-01-31'),
        ('{accounts[1]}','receber','Concorrência UUID distinto',100,'2026-01-31');
      insert into public.contas(id,tipo,descricao,valor,proximo_vencimento,categoria_id,recorrencia,parcelas,parcela_atual) values
        ('{accounts[2]}','pagar','Reverter primeiro',100,'2026-01-31','{category_id}','mensal',3,1),
        ('{accounts[3]}','pagar','Liquidar primeiro',100,'2026-01-31','{category_id}','mensal',3,1);
      commit;""")
    ready = True
    request = ident(100)
    same = f"select public.settle_account('{accounts[0]}','{request}',0,'2026-01-31')"
    race(same, same, second_success=True)
    assert scalar(f"select count(*) from public.movimentacoes where conta_id='{accounts[0]}'") == '1'
    assert scalar(f"select operation_revision from public.contas where id='{accounts[0]}'") == '1'
    assert scalar(f"select count(*) from public.account_audit where account_id='{accounts[0]}' and action='settle'") == '1'
    print('PASS: accounts same UUID concurrently -> one movement, revision and audit')

    race(f"select public.settle_account('{accounts[1]}','{ident(101)}',0,'2026-01-31')",
         f"select public.settle_account('{accounts[1]}','{ident(102)}',0,'2026-01-31')", second_success=False)
    assert scalar(f"select count(*) from public.movimentacoes where conta_id='{accounts[1]}'") == '1'
    assert scalar(f"select operation_revision from public.contas where id='{accounts[1]}'") == '1'
    print('PASS: accounts different UUIDs, same revision -> exactly one success')

    for number, account_id in enumerate(accounts[2:]):
        call(f"select public.settle_account('{account_id}','{ident(110 + number)}',0,'2026-01-31')")
        movement = scalar(f"select id from public.movimentacoes where conta_id='{account_id}'")
        reverse = f"select public.reverse_account_settlement('{account_id}','{movement}','{ident(120 + number)}',1,'Reversão fictícia concorrente')"
        settle = f"select public.settle_account('{account_id}','{ident(130 + number)}',1,'2026-02-28')"
        race(reverse if number == 0 else settle, settle if number == 0 else reverse, second_success=False)
        state = json.loads(scalar(f"select json_build_object('revision',operation_revision,'installment',parcela_atual,"
            f"'movements',(select count(*) from public.movimentacoes where conta_id='{account_id}'),"
            f"'reversed',(select count(*) from public.movimentacoes where conta_id='{account_id}' and reversed_at is not null)) from public.contas where id='{account_id}'"))
        assert state == ({'revision': 2, 'installment': 1, 'movements': 1, 'reversed': 1} if number == 0
                         else {'revision': 2, 'installment': 3, 'movements': 2, 'reversed': 0}), state
        assert scalar(f"select count(*) from public.account_audit where account_id='{account_id}'") == '2'
    print('PASS: reversal vs settlement in both lock orders -> no lost history')

    same = f"select public.apply_stock_entry_v2('{ident(200)}','{product_id}',2,'ENTRADA','Teste concorrente',null)"
    race(same, same, second_success=True)
    assert scalar(f"select stock from public.products where id='{product_id}'") == '12'
    assert scalar(f"select count(*) from public.stock_moves where product_id='{product_id}'") == '1'
    print('PASS: stock same UUID concurrently -> one increment and movement')
    race(f"select public.apply_stock_entry_v2('{ident(201)}','{product_id}',3,'ENTRADA','Teste A',null)",
         f"select public.apply_stock_entry_v2('{ident(202)}','{product_id}',4,'ENTRADA','Teste B',null)", second_success=True)
    assert scalar(f"select stock from public.products where id='{product_id}'") == '19'
    assert scalar(f"select count(*) from public.stock_moves where product_id='{product_id}'") == '3'
    assert scalar(f"select sum(qty) from public.stock_moves where product_id='{product_id}'") == '9'
    print('PASS: stock distinct UUIDs concurrently -> canonical sum preserved')
finally:
    for child in list(children):
        stop(child)
    if ready:
        # Owner cleanup is restricted to the exact fake IDs after server identity check.
        # Remove fake journals/audit before accounts; never disable history protections.
        sql(f"""begin;
          delete from vaidosa_private.account_requests where account_id in ({account_list});
          delete from public.account_audit where account_id in ({account_list});
          delete from public.movimentacoes where conta_id in ({account_list});
          delete from public.contas where id in ({account_list});
          delete from vaidosa_private.stock_entry_requests where product_id='{product_id}';
          delete from public.stock_moves where product_id='{product_id}';
          delete from public.products where id='{product_id}';
          delete from public.colors where id='{color_id}';
          delete from public.categorias where id='{category_id}';
          delete from public.profiles where id='{actor_id}';
          delete from auth.users where id='{actor_id}';
          commit;""")
