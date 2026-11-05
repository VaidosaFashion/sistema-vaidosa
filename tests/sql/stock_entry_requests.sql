\set ON_ERROR_STOP on
-- Synthetic fixtures only; parent runner creates a disposable local PostgreSQL.
begin;
insert into auth.users(id) values
 ('00000000-0000-4000-8000-000000005100'),
 ('00000000-0000-4000-8000-000000005101'),
 ('00000000-0000-4000-8000-000000005102');
insert into public.profiles(id,display_name,login_email,is_vendedora,active) values
 ('00000000-0000-4000-8000-000000005100','Estoque fixture','stock5100@example.invalid',true,true),
 ('00000000-0000-4000-8000-000000005101','Inativo fixture','stock5101@example.invalid',true,false),
 ('00000000-0000-4000-8000-000000005102','Outro fixture','stock5102@example.invalid',true,true);
insert into public.colors(id,nome) values('00000000-0000-4000-8000-000000005103','Cor fixture estoque');
insert into public.products(id,name,size,cost,price_atacado,price_varejo,stock,color_id)
 values('00000000-0000-4000-8000-000000005104','Produto fixture estoque','G1',20,100,120,4,
        '00000000-0000-4000-8000-000000005103');

set local role anon;
do $$
declare denied boolean:=false;
begin
  begin perform public.apply_stock_entry_v2(gen_random_uuid(),'00000000-0000-4000-8000-000000005104',1,'ENTRADA');
  exception when insufficient_privilege then denied:=true; end;
  assert denied,'anon must not mutate stock'; denied:=false;
  begin perform public.get_stock_entry_request(gen_random_uuid());
  exception when insufficient_privilege then denied:=true; end;
  assert denied,'anon must not look up requests';
  raise notice 'PASS: stock v2 blocks anon RPCs';
end $$;
reset role;
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000005101';
do $$
declare denied boolean:=false;
begin
  begin perform public.apply_stock_entry_v2(gen_random_uuid(),'00000000-0000-4000-8000-000000005104',1,'ENTRADA');
  exception when insufficient_privilege then denied:=true; end;
  assert denied,'inactive profile must not mutate'; denied:=false;
  begin perform public.get_stock_entry_request(gen_random_uuid());
  exception when insufficient_privilege then denied:=true; end;
  assert denied,'inactive profile must not query requests';
  raise notice 'PASS: stock v2 checks active profiles on read/write';
end $$;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000005100';
do $$
declare
  product uuid:='00000000-0000-4000-8000-000000005104';
  req uuid:='00000000-0000-4000-8000-000000005110';
  result jsonb; again jsonb; rejected boolean; bad_cost numeric; before_moves integer;
begin
  select count(*) into before_moves from public.stock_moves where product_id=product;
  result:=public.apply_stock_entry_v2(req,product,2,'ENTRADA','  synthetic  ',21.50);
  assert result->>'status'='applied' and (result->'product'->>'stock')::integer=6;
  assert (result->'product'->>'cost')::numeric=21.50;
  assert result->'move'->>'note'='synthetic';
  again:=public.apply_stock_entry_v2(req,product,2,'ENTRADA','synthetic',21.5);
  assert result->'move'->>'id'=again->'move'->>'id','repeat preserves movement identity';
  assert (select count(*) from public.stock_moves where product_id=product)=before_moves+1,'repeat must create exactly one move';
  -- Another legitimate movement changes the current balance. Replay cannot
  -- overwrite the UI cache with the old stock snapshot from this request.
  perform public.apply_stock_entry(product,1,'ENTRADA','legacy compatibility');
  again:=public.get_stock_entry_request(req,jsonb_build_object('product_id',product,'qty',2,'type','ENTRADA','note','synthetic','new_cost',21.5));
  assert (again->'product'->>'stock')::integer=7,'lookup returns current stock';
  assert (again->'move'->>'stock_after')::integer=6,'original movement is preserved';
  rejected:=false;
  begin perform public.apply_stock_entry_v2(req,product,3,'ENTRADA','synthetic',21.5);
  exception when invalid_parameter_value then rejected:=true; end;
  assert rejected,'same UUID different payload must fail';
  rejected:=false;
  begin perform public.get_stock_entry_request(req,jsonb_build_object('product_id',product,'qty',2,'type','ENTRADA','note','different','new_cost',21.5));
  exception when invalid_parameter_value then rejected:=true; end;
  assert rejected,'lookup checks expected content too';
  foreach bad_cost in array array[-1,1.001,'NaN'::numeric,'Infinity'::numeric,100000000] loop
    rejected:=false;
    begin perform public.apply_stock_entry_v2(gen_random_uuid(),product,1,'ENTRADA',null,bad_cost);
    exception when invalid_parameter_value then rejected:=true; end;
    assert rejected,'invalid cost must fail before mutation';
  end loop;
  rejected:=false;
  begin perform public.apply_stock_entry_v2('00000000-0000-4000-8000-000000005111',product,-8,'SAIDA');
  exception when check_violation then rejected:=true; end;
  assert rejected,'negative stock must be rejected';
  assert public.get_stock_entry_request('00000000-0000-4000-8000-000000005111')->>'status'='not_found','rejection does not create applied request';
  assert (select stock from public.products where id=product)=7,'all rejections preserve stock';
  rejected:=false;
  begin perform 1 from vaidosa_private.stock_entry_requests;
  exception when insufficient_privilege then rejected:=true; end;
  assert rejected,'request table cannot be read directly by browser role';
  raise notice 'PASS: stock v2 idempotency, payload conflict, canonical refresh, validation, private journal';
end $$;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000005102';
do $$
declare denied boolean:=false;
begin
  begin perform public.get_stock_entry_request('00000000-0000-4000-8000-000000005110');
  exception when insufficient_privilege then denied:=true; end;
  assert denied,'another actor cannot read another request'; denied:=false;
  begin perform public.apply_stock_entry_v2('00000000-0000-4000-8000-000000005110','00000000-0000-4000-8000-000000005104',2,'ENTRADA','synthetic',21.5);
  exception when insufficient_privilege then denied:=true; end;
  assert denied,'another actor cannot replay another request';
  raise notice 'PASS: stock v2 request ownership';
end $$;
reset role;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000005100';
-- A forced movement failure demonstrates transaction rollback, rather than
-- assuming atomicity because the visible balance happened to look right.
create function public.stock_fixture_failure() returns trigger language plpgsql as $$
begin if new.note='FAIL_FIXTURE' then raise exception 'Synthetic movement failure'; end if; return new; end $$;
create trigger stock_fixture_failure before insert on public.stock_moves for each row execute function public.stock_fixture_failure();
do $$
declare rejected boolean:=false; before_stock integer; after_stock integer; before_count integer; after_count integer;
begin
  select stock into before_stock from public.products where id='00000000-0000-4000-8000-000000005104';
  select count(*) into before_count from vaidosa_private.stock_entry_requests;
  begin perform public.apply_stock_entry_v2('00000000-0000-4000-8000-000000005112','00000000-0000-4000-8000-000000005104',5,'ENTRADA','FAIL_FIXTURE',99);
  exception when raise_exception then rejected:=true; end;
  select stock into after_stock from public.products where id='00000000-0000-4000-8000-000000005104';
  select count(*) into after_count from vaidosa_private.stock_entry_requests;
  assert rejected and before_stock=after_stock and before_count=after_count,'stock/movement/request must rollback together';
  assert (select cost from public.products where id='00000000-0000-4000-8000-000000005104')=21.5,'cost also rolls back';
  assert not exists(select 1 from information_schema.columns where table_schema='vaidosa_private' and table_name='stock_entry_requests' and column_name in ('note','payload','snapshot','cpf')),'journal stores only IDs and digest';
  raise notice 'PASS: stock v2 movement failure rolls back balance, cost, and request';
end $$;
drop trigger stock_fixture_failure on public.stock_moves;
drop function public.stock_fixture_failure();
set local role authenticated;
delete from public.products where id='00000000-0000-4000-8000-000000005104';
do $$
declare result jsonb;
begin
  result:=public.apply_stock_entry_v2('00000000-0000-4000-8000-000000005110','00000000-0000-4000-8000-000000005104',2,'ENTRADA','synthetic',21.5);
  assert result->>'status'='applied' and (result->>'product_deleted')::boolean,'deleted product does not invalidate applied request';
  assert result->'product'='null'::jsonb and result->'move'->'product_id'='null'::jsonb,'no product recreation and original movement survives FK set-null';
  raise notice 'PASS: stock v2 safe retry after product deletion';
end $$;
reset role;
rollback;
