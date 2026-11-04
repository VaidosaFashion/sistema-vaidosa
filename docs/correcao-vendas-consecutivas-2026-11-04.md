# Vendas consecutivas — diagnóstico e correção local

## Causa encontrada

O relato era de só conseguir lançar uma venda por dia. No código versionado,
não existe limite diário: `sales.sold_at` tem um índice comum, enquanto a
idempotência usa `client_request_id` e a identidade da venda usa UUID.

O problema acontece depois de finalizar a primeira venda **ou clicar em Limpar**:

1. Desde a mudança de pagamentos de 20/08, o `<select id="sale_pay">` oculto
   contém somente `<option value="Pendente">`.
2. Os dois caminhos de limpeza ainda atribuíam `sale_pay.value = "PIX"`.
3. O DOM de um select sem essa opção devolve `value === ""`.
4. A próxima chamada `create_sale` enviava `p_pay: ""`, que não atende ao
   `sales_pay_check` registrado nas migrações.
5. Recarregar a página volta a selecionar `Pendente`, permitindo outra primeira
   venda. Portanto, não era uma regra de data; era o estado deixado na tela.

Essa cadeia foi confirmada por inspeção das migrações e pelo DOM real do HTML
em jsdom. Nenhuma venda real foi criada e o schema de produção não foi alterado.

## Correção

- `resetSaleDraft()` centraliza os dois resets e mantém `Pendente`.
- Uma venda nova envia explicitamente `Pendente` e zero parcelas; a forma
  efetiva continua sendo determinada pelos pagamentos registrados depois.
- A limpeza ocorre imediatamente após confirmação da venda. O timer antigo
  de 1,5 segundo podia limpar o começo da próxima venda e deixava a anterior
  disponível para novo envio quando o botão já tinha sido liberado.
- Durante o envio, o pedido é capturado e os controles ficam bloqueados.
  Resposta perdida preserva payload e UUID para repetir a mesma tentativa.
  Erro SQL definido permite corrigir o rascunho; erro de rede incerto mantém
  a opção `Confirmar venda pendente`.
- Erro ao atualizar histórico depois de uma venda confirmada não deixa o
  carrinho vendido pronto para ser reenviado.

Não há migração de banco necessária para esta correção específica. A migração
preexistente de 20/08 que aceita `Pendente` continua sendo pré-requisito.

## Verificação

`node --test tests/sale-finalize.test.cjs` — **7 testes passaram**:

- reprodução do reset inválido com a opção PIX ausente;
- duas vendas na mesma data, IDs diferentes e estoque baixado uma vez por venda;
- limpar rascunho e lançar outra venda;
- cliques simultâneos e tentativa de limpar durante envio;
- resposta perdida após commit e retry com o mesmo UUID, sem venda duplicada;
- rejeição SQL preservando rascunho editável e estoque;
- erro de atualização do histórico depois do commit, sem repetir a venda.

Os testes usam dados fictícios e um substituto local da RPC. Não confirmam
disponibilidade/regras atualmente instaladas no Supabase remoto. O estado de
retry fica em memória desta aba; recarregar a página descarta esse estado, então
uma confirmação pendente deve ser resolvida pelo botão antes de recarregar.
