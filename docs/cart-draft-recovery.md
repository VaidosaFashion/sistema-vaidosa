# Carrinho protegido — pacote isolado, ainda sem publicação

Base: ee4b5e8. Este pacote não depende das novas funções SQL nem deve incluir o pacote financeiro de 04/11. Arquivos de execução: index.html, cart-draft-store.js, cart-draft-ui.js e cart-draft-app.js.

## Comportamento

- Cada conta/projeto tem uma cópia local mínima dos IDs de produtos, quantidades, cliente/vendedor, tabela, canal, tipo e desconto. Sem nomes, CPF, credenciais ou texto livre na nova cópia.
- Reabrir a página mostra o pedido guardado para revisão; não envia automaticamente. Rascunhos com mais de sete dias exigem nova revisão explícita. Envios pendentes nunca são descartados por idade.
- Antes da RPC, grava o UUID e o payload inteiro permitido, lê de volta e compara. Falha de persistência bloqueia o envio. Durante resultado incerto não permite editar, limpar ou criar outro pedido.
- Antes de repetir, consulta a venda por client_request_id. Se a consulta falhar, não repete. Se encontrar, confirma sem enviar. Se não encontrar, permite somente uma repetição explícita do mesmo UUID/payload; ausência não prova que o envio anterior terminou.
- Web Locks mantém um editor por conta/projeto entre abas cooperantes. Navegador sem essa API fica bloqueado; não há fallback com trava não atômica no localStorage.
- Nova venda e Limpar deixam o pagamento em Pendente. A RPC recebe sempre Pendente/zero parcelas. Não há timer atrasado limpando um carrinho novo.
- Observações livres devem ser copiadas e adicionadas em Editar após confirmação. O envio é bloqueado se o campo estiver preenchido; não apaga a observação silenciosamente.
- Após confirmação durável, exibe Nova venda. Falha ao atualizar cache/estoque da tela não transforma a venda em não salva.

## Limites e recuperação

Esta mudança protege carrinhos montados depois de instalada. O carrinho antigo perdido após reload não está no armazenamento desta versão: só é recuperável por uma venda já gravada, outra aba que ainda o mantenha ou registros externos existentes.

localStorage não substitui backup: limpar dados do navegador, usar outro computador/perfil, modo privado ou falha de disco pode remover o rascunho. IDs de cliente e vendedor são referências pessoais; o isolamento é por chave da conta, não criptografia. Um usuário com acesso ao mesmo perfil do navegador pode inspecionar armazenamento.

A função create_sale atual tem UNIQUE(client_request_id), transação para venda/itens/estoque e retorno da venda existente. Isso impede duplicar a venda com o mesmo ID, mas não garante sucesso da segunda chamada concorrente: não há lock antecipado do ID, e uma tentativa pode falhar na validação de estoque enquanto outra termina. A interface reconcilia depois e não libera novo UUID por esse erro. Abas com a versão antiga, outros aparelhos e clientes que ignoram a trava não são coordenados pelo Web Lock.

O payload congela IDs, quantidades, desconto e opções. A função existente recalcula preços pelo catálogo no momento da execução; não recebe preço esperado nem versão do catálogo. O frontend confere preços/estoque antes da revisão, mas não pode impedir alteração concorrente do preço entre revisão e RPC sem mudança no servidor. Não promete reserva de estoque nem preços congelados no servidor.

Somente uma primeira tentativa criada nesta página, com resposta SQL 23514/sales_pay_check e consulta concluída sem venda, pode voltar a rascunho. Uma tentativa recuperada/repetida ou com incerteza anterior permanece bloqueada mesmo que depois receba o mesmo erro.

O contador legado de trocas é atualizado após confirmação a partir do número de vendas Troca do cliente, sem diminuir um contador maior e sem +1 repetido. Continua sendo uma atualização separada da criação da venda. A política de segunda troca não se torna transacional nesta mudança.

## Instalação posterior

Validação local concluída; publicação depende de autorização. Depois da aprovação: comparar com a revisão atual do repositório (inclusive o hotfix Pendente, se já instalado), integrar sem sobrescrever mudanças posteriores, preservar a versão anterior e publicar os quatro arquivos juntos, sem SQL. Fazer a troca quando não houver carrinho ativo; uma aba antiga não recebe a proteção retroativamente. Após instalar, conferir scripts carregados, estado Pendente e revisão do rascunho usando ambiente isolado antes de retomar o caixa. Nunca testar com venda real fictícia.

Rollback do frontend não apaga armazenamento nem vendas. Antes de voltar à versão antiga, resolver qualquer envio pendente e preservar os rascunhos; a versão antiga ignora essa proteção. Não usar exclusão de venda/ajuste de estoque como rollback.

## Testes isolados

`npm ci` com lockfile e `npm test`. Sem credenciais de produção. Testes de core e controller usam armazenamento e Supabase simulados; não são prova de integridade do banco real. Evidência da transação/constraint vem das definições e metadados fornecidos manualmente pelo usuário; nenhuma consulta remota foi feita para este pacote.

## Evidência final

67 testes automatizados passaram na suíte completa: core de armazenamento, controlador, integração com controles reais do HTML e carregamento do main inteiro. Incluem 45 peças, três vendas no mesmo dia, sales_pay_check, confirmação perdida, falhas de armazenamento, reset, cancelamento, contas/abas, BFCache, validação antiga concluída após troca de aba e contador de trocas. Nenhuma chamada real a Supabase, Nuvemshop ou autenticação.

A revisão independente encontrou e corrigiu duas condições de retomada: memória antiga da aba após outra confirmar/limpar; resposta de validação antiga sobrescrevendo um caixa novo. Testes reproduzem ambas. Estado confirmed também não pode ser sobrescrito por saveDraft sem reset explícito.

A prévia HTML é estática, utiliza dados fictícios e mantém os controles desativados. Não constitui teste visual em navegador real. Os testes usam jsdom/Web Locks simulados; não houve validação no Opera operacional nem comprovação nova de integridade do banco real.

O hotfix de quatro linhas e o pacote financeiro continuam separados. Este pacote não contém SQL de instalação, não edita pagamentos/descontos de vendas existentes e não requer o pacote financeiro.
