"""Local-only concurrency checks. Run by tests/run-sql-tests.sh."""
import os
import subprocess

socket = os.environ['VAIDOSA_TEST_SOCKET']
port = os.environ['VAIDOSA_TEST_PORT']
assert socket.startswith('/tmp/') or socket.startswith('/private/tmp/'), 'Only disposable local socket allowed'
base = ['psql', '-X', '-h', socket, '-p', port, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At']
actor = "set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001'; set role authenticated;"

def sql(query, success=True):
    result = subprocess.run(base + ['-c', query], text=True, capture_output=True)
    if success:
        assert result.returncode == 0, result.stderr
    else:
        assert result.returncode != 0, 'Expected transaction failure'
    return result

def holding(query):
    process = subprocess.Popen(base, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    process.stdin.write(actor + "begin;" + query + ";\n\\echo LOCKED\nselect pg_sleep(1.2); commit;\n")
    process.stdin.close()
    for line in process.stdout:
        if 'LOCKED' in line:
            return process
    raise AssertionError(process.stderr.read())

def finish(process):
    process.wait(timeout=10)
    assert process.returncode == 0, process.stderr.read()

# Fake sale and one existing payment; no products/stock needed.
for n in [40, 50, 60]:
    sale = f'00000000-0000-4000-8000-{n:012}'
    payment = f'00000000-0000-4000-8000-{n+1:012}'
    sql(f"insert into sales(id,channel,kind,pay,subtotal,total_bruto,cost_total) values('{sale}','Loja','Venda','Pendente',100,100,20); insert into sale_payments(id,sale_id,value,method,net_value) values('{payment}','{sale}',40,'PIX',40);")

sale='00000000-0000-4000-8000-000000000040'
payment='00000000-0000-4000-8000-000000000041'
request='00000000-0000-4000-8000-000000000042'
payload=f"'[{{\"id\":\"{payment}\",\"paid_on\":\"2026-11-04\",\"value\":40,\"method\":\"PIX\",\"installments\":0,\"note\":null}}]'::jsonb"
# A: add payment commits first. B's stale editor waits, then must reject.
a=holding(f"insert into sale_payments(sale_id,value,method,net_value) values('{sale}',10,'PIX',10)")
b=sql(actor+f"select edit_sale_financials('{sale}','{request}',1,10,{payload},'Concorrência inclusão')",False)
finish(a)
assert 'outra tela' in b.stderr, b.stderr
assert sql(f"select count(*) from sale_payments where sale_id='{sale}'").stdout.strip()=='2'
assert sql(f"select count(*) from sale_financial_audit where sale_id='{sale}'").stdout.strip()=='0'

sale='00000000-0000-4000-8000-000000000050'
payment='00000000-0000-4000-8000-000000000051'
request='00000000-0000-4000-8000-000000000052'
payload=f"'[{{\"id\":\"{payment}\",\"paid_on\":\"2026-11-04\",\"value\":40,\"method\":\"PIX\",\"installments\":0,\"note\":null}}]'::jsonb"
# A: correction lowers total to 50. B's old 20 payment waits then must reject.
a=holding(f"select edit_sale_financials('{sale}','{request}',1,50,{payload},'Concorrência desconto')")
b=sql(actor+f"insert into sale_payments(sale_id,value,method,net_value) values('{sale}',20,'PIX',20)",False)
finish(a)
assert 'ultrapassa' in b.stderr, b.stderr
assert sql(f"select total_bruto from sales where id='{sale}'").stdout.strip()=='50.00'
assert sql(f"select count(*) from sale_payments where sale_id='{sale}'").stdout.strip()=='1'

sale='00000000-0000-4000-8000-000000000060'
payment='00000000-0000-4000-8000-000000000061'
request='00000000-0000-4000-8000-000000000062'
payload=f"'[{{\"id\":\"{payment}\",\"paid_on\":\"2026-11-04\",\"value\":40,\"method\":\"PIX\",\"installments\":0,\"note\":null}}]'::jsonb"
call=f"select edit_sale_financials('{sale}','{request}',1,10,{payload},'Retry concorrente')"
# Same request concurrent twice: one financial event, one audit, same result.
a=holding(call)
b=sql(actor+call)
finish(a)
assert sql(f"select count(*) from sale_financial_audit where sale_id='{sale}'").stdout.strip()=='1'
assert sql(f"select count(*) from vaidosa_private.sale_financial_requests where sale_id='{sale}'").stdout.strip()=='1'
print('PASS: concurrent insert → stale correction, correction → excess insert rejection, simultaneous retry → one audit')

# Hardened inventory RPCs: duplicate same-request sale and concurrent delete.
product='00000000-0000-4000-8000-000000000140'
request='00000000-0000-4000-8000-000000000141'
sql(f"insert into products(id,name,size,cost,price_atacado,price_varejo,stock,color_id) values('{product}','Última peça fictícia','G1',20,100,120,1,'00000000-0000-4000-8000-000000000003')")
items=f"'[{{\"product_id\":\"{product}\",\"qty\":1}}]'::jsonb"
call=f"select id from create_sale('{request}'::uuid,null::uuid,null::uuid,'Loja','Venda','Pendente',0::smallint,0::numeric,null::text,{items},'Atacado')"
a=holding(call)
b=sql(actor+call)
finish(a)
assert sql(f"select count(*) from sales where client_request_id='{request}'").stdout.strip()=='1'
assert sql(f"select stock from products where id='{product}'").stdout.strip()=='0'
sale=sql(f"select id from sales where client_request_id='{request}'").stdout.strip()
a=holding(f"select delete_sale('{sale}'::uuid)")
b=sql(actor+f"select delete_sale('{sale}'::uuid)")
finish(a)
assert sql(f"select stock from products where id='{product}'").stdout.strip()=='1'
assert sql(f"select count(*) from stock_moves where product_id='{product}' and type='DEVOLUCAO'").stdout.strip()=='1'
print('PASS: same-request concurrent last-item sale → one sale; concurrent delete → one stock restoration')
