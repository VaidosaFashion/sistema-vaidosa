\set ON_ERROR_STOP on
-- Somente no PostgreSQL descartável do runner; dados fictícios, sem rede.
begin;
insert into auth.users(id) values
 ('71000000-0000-4000-8000-000000000001'),('71000000-0000-4000-8000-000000000002'),('71000000-0000-4000-8000-000000000003');
insert into public.profiles(id,display_name,login_email,is_admin,active) values
 ('71000000-0000-4000-8000-000000000001','Teste contas','accounts@example.invalid',true,true),
 ('71000000-0000-4000-8000-000000000002','Inativo fictício','inactive@example.invalid',true,false),
 ('71000000-0000-4000-8000-000000000003','Outro operador','other@example.invalid',true,true);
insert into public.categorias(id,nome,tipo) values ('71000000-0000-4000-8000-000000000004','Teste despesa','despesa');
insert into public.clients(id,name) values ('71000000-0000-4000-8000-000000000005','Cliente fictício');
insert into public.contas(id,tipo,descricao,valor,status,proximo_vencimento) values
 ('71000000-0000-4000-8000-000000000010','receber','Legado fictício',100,'concluido','2026-01-31'),
 ('71000000-0000-4000-8000-000000000011','receber','Falha injetada',100,'ativo','2026-01-31');
insert into public.movimentacoes(id,conta_id,tipo,valor,data) values
 ('71000000-0000-4000-8000-000000000020','71000000-0000-4000-8000-000000000010','receber',100,'2026-01-31');
create function pg_temp.reject_account_update() returns trigger language plpgsql as $$
begin
 if new.id='71000000-0000-4000-8000-000000000011' then raise exception 'falha fictícia posterior ao movimento'; end if;
 return new;
end $$;
create trigger z_test_failure before update on public.contas for each row execute function pg_temp.reject_account_update();
set local request.jwt.claim.sub='71000000-0000-4000-8000-000000000001';
set local role authenticated;
do $$
declare
 v_id uuid; v_request uuid:=gen_random_uuid(); v_settle uuid:=gen_random_uuid(); v_reverse uuid:=gen_random_uuid();
 v_values jsonb; v_result jsonb; v_first jsonb; v_lookup jsonb; v_args jsonb; v_movement uuid; v_payable uuid;
 v_error boolean; v_before integer; v_stock jsonb; v_sales jsonb;
begin
 select jsonb_agg(to_jsonb(p) order by id) into v_stock from public.products p;
 select jsonb_agg(to_jsonb(s) order by id) into v_sales from public.sales s;
 v_values:=jsonb_build_object('tipo','receber','descricao','Receber fictício','valor',3600,
   'proximo_vencimento','2026-01-31','cliente_id','71000000-0000-4000-8000-000000000005','forma_recebimento','PIX');
 v_first:=public.create_account_v2(v_request,v_values); v_id:=(v_first->'account'->>'id')::uuid;
 assert v_first->'account'->>'cliente_id'='71000000-0000-4000-8000-000000000005','cliente vinculado';
 assert (v_first->'account'->>'operation_revision')::bigint=0,'revisão inicial';
 v_result:=public.create_account_v2(v_request,v_values);
 assert v_result->'account'=v_first->'account' and (v_result->>'replayed')::boolean,'criação idempotente';
 assert (select count(*) from public.contas where client_request_id=v_request)=1,'uma conta';
 v_error:=false;
 begin perform public.create_account_v2(v_request,jsonb_set(v_values,'{valor}','3601')); exception when invalid_parameter_value then v_error:=true; end;
 assert v_error,'UUID não aceita payload novo';
 v_args:=jsonb_build_object('p_request_id',v_request,'p_values',v_values);
 v_lookup:=public.get_account_request_status(v_request,'create_account_v2',v_args);
 assert v_lookup->>'status'='completed' and v_lookup->'result'->'account'->>'id'=v_id::text,'recupera criação';
 v_error:=false;
 begin perform public.get_account_request_status(v_request,'create_account_v2',jsonb_set(v_args,'{p_values,valor}','3601')); exception when invalid_parameter_value then v_error:=true; end;
 assert v_error,'lookup valida conteúdo congelado';
 v_request:=gen_random_uuid();
 assert public.get_account_request_status(v_request,'create_account_v2',jsonb_build_object('p_request_id',v_request,'p_values',v_values))->>'status'='not_found','tentativa ausente';

 v_result:=public.edit_account(v_id,gen_random_uuid(),0,'{"valor":3500}');
 assert v_result->'account'->>'cliente_id'='71000000-0000-4000-8000-000000000005','editar valor preserva cliente';
 assert (v_result->'account'->>'operation_revision')::bigint=1,'edição incrementa revisão';
 v_result:=public.edit_account(v_id,gen_random_uuid(),1,'{"valor":3500}');
 assert (v_result->'account'->>'operation_revision')::bigint=1,'no-op não altera revisão';
 v_error:=false;
 begin perform public.edit_account(v_id,gen_random_uuid(),0,'{"valor":3400}'); exception when serialization_failure then v_error:=true; end;
 assert v_error,'edição obsoleta rejeitada';
 v_error:=false;
 begin perform public.edit_account(v_id,gen_random_uuid(),1,'{"valor":-10}'); exception when invalid_parameter_value then v_error:=true; end;
 assert v_error,'valor inválido rejeitado';

 v_first:=public.settle_account(v_id,v_settle,1,'2026-02-01');
 v_movement:=(v_first->'movement'->>'id')::uuid;
 assert v_first->'account'->>'status'='concluido','recebimento conclui';
 assert (v_first->'movement'->>'valor')::numeric=3500,'integral, sem taxa inventada';
 assert v_first->'movement'->>'created_by'='71000000-0000-4000-8000-000000000001','autoria';
 assert v_first->'movement'->>'data_pagamento'='2026-02-01','data literal';
 v_result:=public.settle_account(v_id,v_settle,1,'2026-02-01');
 assert v_result->'movement'=v_first->'movement' and (v_result->>'replayed')::boolean,'retry não duplica movimento';
 assert (select count(*) from public.movimentacoes where conta_id=v_id)=1,'movimento único';
 v_args:=jsonb_build_object('p_account_id',v_id,'p_request_id',v_settle,'p_expected_revision',1,'p_paid_on','2026-02-01');
 assert public.get_account_request_status(v_settle,'settle_account',v_args)->>'status'='completed','recupera settlement';
 v_error:=false;
 begin perform public.settle_account(v_id,gen_random_uuid(),1,'2026-02-01'); exception when serialization_failure then v_error:=true; end;
 assert v_error,'outra tentativa da revisão antiga não duplica';
 v_error:=false;
 begin perform public.settle_account(v_id,gen_random_uuid(),2,'2026-02-01'); exception when invalid_parameter_value then v_error:=true; end;
 assert v_error,'concluída não recebe novamente';
 v_error:=false;
 begin perform public.edit_account(v_id,gen_random_uuid(),2,'{"cliente_id":null}'); exception when invalid_parameter_value then v_error:=true; end;
 assert v_error,'conta concluída preserva campos';
 v_result:=public.reverse_account_settlement(v_id,v_movement,v_reverse,2,'Correção fictícia');
 assert v_result->'account'->>'status'='ativo','reversão restaura status';
 assert (v_result->'account'->>'operation_revision')::bigint=3,'reversão avança revisão';
 assert v_result->'movement'->>'reversed_at' is not null,'movimento marcado';
 assert (select count(*) from public.movimentacoes where conta_id=v_id)=1,'histórico não apagado';
 assert (select count(*) from public.movimentacoes where conta_id=v_id and reversed_at is null)=0,'revertido não integra saldo efetivo';
 assert public.reverse_account_settlement(v_id,v_movement,v_reverse,2,'Correção fictícia')->>'replayed'='true','reversão repetida idempotente';
 assert public.settle_account(v_id,v_settle,1,'2026-02-01')->'account'->>'status'='ativo','replay antigo retorna estado atual';
 v_result:=public.edit_account(v_id,gen_random_uuid(),3,'{"cliente_id":null}');
 assert v_result->'account'->'cliente_id'='null'::jsonb,'desvinculação explícita';
 v_error:=false;
 begin perform public.archive_account(v_id,gen_random_uuid(),4,'Não presumir perdão'); exception when invalid_parameter_value then v_error:=true; end;
 assert v_error,'arquivamento não cancela obrigação ativa';
 v_result:=public.settle_account(v_id,gen_random_uuid(),4,'2026-02-02');
 v_result:=public.archive_account(v_id,gen_random_uuid(),5,'Histórico encerrado');
 assert v_result->'account'->>'archived_at' is not null and v_result->'account'->>'status'='concluido','arquivo preserva conclusão';
 assert (select count(*) from public.movimentacoes where conta_id=v_id)=2,'arquivo preserva todos movimentos';

 -- Calendário preservado: 31/01 -> último dia de fevereiro; parcela seguinte explícita.
 v_values:=jsonb_build_object('tipo','pagar','descricao','Mensal fictícia','valor',100,
   'proximo_vencimento','2026-01-31','categoria_id','71000000-0000-4000-8000-000000000004','recorrencia','mensal','parcelas',3);
 v_result:=public.create_account_v2(gen_random_uuid(),v_values); v_payable:=(v_result->'account'->>'id')::uuid;
 v_result:=public.settle_account(v_payable,gen_random_uuid(),0,'2026-01-31');
 assert v_result->'account'->>'proximo_vencimento'='2026-02-28' and v_result->'account'->>'parcela_atual'='2','fim de mês';
 v_movement:=(v_result->'movement'->>'id')::uuid;
 v_result:=public.edit_account(v_payable,gen_random_uuid(),1,'{"descricao":"Atualizada"}');
 v_error:=false;
 begin perform public.reverse_account_settlement(v_payable,v_movement,gen_random_uuid(),2,'Após edição'); exception when serialization_failure then v_error:=true; end;
 assert v_error,'reversão bloqueada depois de edição';
 v_result:=public.settle_account(v_payable,gen_random_uuid(),2,'2026-02-28');
 assert v_result->'account'->>'parcela_atual'='3' and v_result->'account'->>'proximo_vencimento'='2026-03-28','avança parcela seguinte';
 v_result:=public.settle_account(v_payable,gen_random_uuid(),3,'2026-03-28');
 assert v_result->'account'->>'status'='concluido','última parcela conclui';

 v_error:=false;
 begin perform public.reverse_account_settlement('71000000-0000-4000-8000-000000000010','71000000-0000-4000-8000-000000000020',gen_random_uuid(),0,'Legado sem snapshot'); exception when invalid_parameter_value then v_error:=true; end;
 assert v_error,'movimento legado não reconstituído';
 select count(*) into v_before from public.movimentacoes;
 v_error:=false;
 begin perform public.settle_account('71000000-0000-4000-8000-000000000011',gen_random_uuid(),0,'2026-01-31'); exception when raise_exception then v_error:=true; end;
 assert v_error and (select count(*) from public.movimentacoes)=v_before,'falha após insert reverte toda operação';
 assert (select operation_revision from public.contas where id='71000000-0000-4000-8000-000000000011')=0,'revisão não avançou após falha';
 assert not exists(select 1 from public.account_audit where account_id='71000000-0000-4000-8000-000000000011'),'falha não grava auditoria';
 assert not exists(select 1 from public.account_audit where before_data?'obs' or after_data?'obs' or before_data?'descricao' or after_data?'descricao'),'auditoria minimizada';
 assert not has_table_privilege('authenticated','public.contas','UPDATE') and not has_table_privilege('authenticated','public.movimentacoes','DELETE'),'DML direto fechado';
 assert not has_function_privilege('anon','public.settle_account(uuid,uuid,bigint,date)','EXECUTE'),'anônimo bloqueado';
 v_error:=false;
 begin delete from public.movimentacoes where conta_id=v_id; exception when insufficient_privilege then v_error:=true; end;
 assert v_error,'exclusão direta negada';
 perform set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000003',true);
 assert public.get_account_request_status(v_settle,'settle_account',v_args)->>'status'='not_found','outro autor não recupera tentativa privada';
 perform set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000002',true);
 v_error:=false;
 begin perform public.create_account_v2(gen_random_uuid(),v_values); exception when insufficient_privilege then v_error:=true; end;
 assert v_error,'perfil inativo bloqueado';
 perform set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000001',true);
 assert (select jsonb_agg(to_jsonb(p) order by id) from public.products p) is not distinct from v_stock,'estoque intacto';
 assert (select jsonb_agg(to_jsonb(s) order by id) from public.sales s) is not distinct from v_sales,'vendas intactas';
end $$;
reset role;
rollback;
\echo 'accounts_integrity: PASS (rollback das fixtures)'
