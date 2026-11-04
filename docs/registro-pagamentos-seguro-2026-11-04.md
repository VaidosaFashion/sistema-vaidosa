# Registro de novos pagamentos — preparação local

O registro usa um UUID criado pelo cliente e mantido durante toda a tentativa.
A gravação usa `sale_payments.id` com `ON CONFLICT DO NOTHING` (via
`upsert(..., { onConflict: "id", ignoreDuplicates: true })`): uma repetição
não sobrescreve o pagamento anterior nem cria outra linha.

Depois da escrita, a tela confirma o ID e a venda por leitura e busca novamente
a venda com seus itens/pagamentos. Forma, taxas, líquido, lucro, status e revisão
financeira vêm do resultado canônico do banco. Não há mais uma escrita separada
em `sales.pay` pelo navegador. **O trigger novo de recálculo é pré-requisito**;
publicar este frontend antes da migração deixaria os rótulos desatualizados.

Durante envio ou resposta incerta, campos e outras ações do modal ficam
bloqueados, preservando o mesmo payload para confirmar a tentativa. Quando a
escrita já foi reconhecida, uma falha de leitura/atualização da tela repete
somente as leituras. Antes de repetir, consulta o pagamento pelo seu ID e pelo
ID da venda; a consulta também ocorre depois de qualquer resposta/erro da
escrita. Se a consulta falhar, mantém o bloqueio. Somente uma rejeição negocial
permitida, na primeira tentativa sem incerteza e com ausência confirmada,
libera o rascunho editável. Um erro SQL/PGRST posterior a resposta incerta nunca
libera outro UUID. O fluxo de correção mantém os IDs dos pagamentos e não os
exclui/recria.

A data inicial usa `hojeISOLocal()`, evitando a mudança de dia de `valueAsDate`
baseada em UTC. Histórico também preserva líquido igual a zero.

`node --test tests/payment-add.test.cjs` passou **13 testes**, totalmente offline:
cancelamento sem escrita, data local, totais/revisão canônicos, estoque intacto,
cliques simultâneos, resposta perdida, falha de refresh após gravação, rejeição
SQL, precisão inválida, líquido zero e seis regressões de consulta/retry,
incluindo resposta perdida seguida de `PGRST301`/`42501`. A suíte integrada
completa passou 108 testes.

Limitação: a tentativa pendente vive na memória da aba. Recarregar/fechar o
navegador descarta seu UUID; resolva a confirmação pendente antes de recarregar.
Nenhuma venda real foi alterada nos testes.
