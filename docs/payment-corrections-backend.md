# Edição financeira — contrato e validação local

A migração `20261104133207_edit_sale_financials.sql` prepara uma correção atômica do desconto e dos pagamentos **já existentes**. Não recria a venda, não insere/exclui pagamentos, não muda itens, custo de compra, data da venda nem estoque. A redução de um recebimento é correção de registro; não realiza estorno na maquininha nem transfere dinheiro.

RPC pública, executável apenas por `authenticated`:

```js
sb.rpc('edit_sale_financials', {
  p_sale_id: sale.id,
  p_request_id: requestId, // manter ao repetir o mesmo envio após falha de rede
  p_expected_revision: sale.finance_revision,
  p_discount: 100.00,
  p_payments: [ // lista completa de pagamentos existentes; IDs preservados
    { id: payment.id, paid_on: '2026-11-04', value: 900.00,
      method: 'PIX', installments: 0, note: 'Valor corrigido' }
  ],
  p_reason: 'Desconto combinado depois da finalização'
});
```

A resposta é a venda atual em snake_case, com `sale_items`, `sale_payments` e `finance_revision`. No retry confirmado retorna o estado atual do banco, inclusive se houve outra correção depois. O mesmo UUID com parâmetros diferentes é recusado. Uma gravação sem mudanças não incrementa a revisão nem cria histórico financeiro.

O banco trava a venda e os pagamentos, recusa formulário obsoleto, pagamento de outra venda, IDs duplicados/incompletos, desconto fora de 0–subtotal, valor não positivo/não finito, data inválida e parcelas incompatíveis. Os pagamentos não podem exceder o novo total. É permitido pagamento parcial e desconto integral sem pagamento; total zero fica Pago. Corrigir valor usa a taxa histórica do pagamento; corrigir apenas data/observação preserva o líquido histórico exato. Trocar forma ou parcelas usa a taxa atual configurada. Valores calculados arredondam em centavos.

`public.sale_financial_audit` guarda autor, nome, momento, motivo e snapshots reais de antes/depois. A API só tem SELECT para funcionários ativos; INSERT/UPDATE/DELETE são revogados. A implementação privilegiada fica em `vaidosa_private`, com `search_path` vazio, acesso autenticado explicitamente conferido e sem autor/snapshot fornecido pelo navegador. **Esse schema não pode ser exposto no PostgREST.** O histórico não tem exclusão em cascata ao excluir uma venda. A política anterior de escrita direta nas tabelas de negócio continua existente; o histórico novo cobre as correções feitas por esta RPC, não pretende auditar retrospectivamente toda ação administrativa/direta.

A resposta completa da RPC preserva compatibilidade com colunas reais adicionais, incluindo `sales.buyer_cpf_nfce`, e não altera esses campos. O histórico usa uma projeção independente com lista explícita de campos financeiros: IDs, revisão, totais, taxas, status, forma/parcelas e os campos editáveis dos pagamentos. Não copia CPF fiscal, cliente, observação da venda, itens nem futuras colunas não financeiras. A observação do **pagamento** permanece no antes/depois porque pode ser corrigida neste fluxo. O teste `tests/sql/financial_audit_privacy.sql` acrescenta CPF e campos futuros sintéticos para verificar preservação dos dados e exclusão da auditoria; deve ser executado pelo runner local após esta alteração.

O trigger dos pagamentos serializa o fluxo antigo com a correção, incrementa a revisão inclusive ao mudar data/nota e deriva forma, parcelas, status, taxa agregada, líquido e lucro. Novos INSERTs de usuário autenticado conferem funcionário ativo, calculam taxas no servidor, registram `auth.uid()` como autor e conferem o saldo depois da trava. A repetição com o mesmo ID via `ON CONFLICT DO NOTHING` não recalcula o pagamento. Importações de manutenção por administrador sem JWT mantêm valores históricos fornecidos.

Se a tabela opcional `nfce_emissions` existir, as linhas da venda são travadas e estados diferentes de `cancelled`, `canceled`, `rejected`, `denied` impedem a correção. `error` e estados desconhecidos bloqueiam porque podem representar resultado fiscal incerto. O schema e o fluxo fiscal real ainda precisam ser conferidos antes de aplicar em produção; um emissor externo precisa respeitar as mesmas travas para não usar um snapshot antigo. Deadlocks de atualizações SQL diretas concorrentes são abortados pelo Postgres, sem gravação parcial; a tela deve apresentar falha e pedir reabertura.

## Testes reproduzíveis

```sh
./tests/run-sql-tests.sh
```

Requer binários PostgreSQL (`initdb`, `pg_ctl`, `psql`) e Python 3. O script cria um cluster novo em `/tmp`, usa socket privado e porta 55439 **sem TCP**, aplica todas as migrações, roda os testes SQL/Python e as consultas de auditoria, e encerra/remove o cluster por `trap`. Não aceita `DATABASE_URL` e não usa credenciais nem dados reais.

Resultado local: **PASS**, PostgreSQL 17.11, 04/11/2026. Incluiu:

- 60 itens preservados, incluindo item histórico com `product_id = NULL`; estoque e movimentos intactos.
- Desconto, parcial/integral, forma, parcelas, data, taxas antigas/atuais, líquido/lucro, motivos e autoria.
- Retry, no-op, UUID reutilizado incorretamente, revisão obsoleta, dados inválidos e tentativa de forjar histórico.
- Novo pagamento com taxa/líquido/autor falsificados pelo cliente corrigido pelo servidor; usuário sem perfil e anônimo recusados.
- Status fiscal autorizado, processamento, erro e desconhecido impedem alteração.
- Duas sessões: inclusão de pagamento invalida correção antiga; correção reduzindo saldo impede inclusão excessiva concorrente; duas chamadas do mesmo ajuste criam um único histórico.
- Com a migração adicional de proteção de estoque: duas chamadas da venda da última peça com o mesmo UUID criam uma venda; duas exclusões concorrentes devolvem uma peça só; vendas diferentes no mesmo dia são aceitas.

Nenhuma migração foi aplicada em produção nesta tarefa. O schema real, as políticas adicionais e as funções instaladas precisam ser comparados com `docs/audit-sales-readonly.sql` antes da publicação. Aplicar as migrações antes do frontend; não simular correção por sequência de UPDATEs no navegador se a RPC estiver ausente.
