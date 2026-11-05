# Estoque: contrato incremental

Esta alteração é local, aditiva e ainda depende de revisão/aplicação futura. Não consulta dados reais. Conserva a RPC antiga `apply_stock_entry(uuid,integer,text,text,numeric)` para compatibilidade; o novo adaptador nunca usa o fallback de UPDATE no produto seguido de INSERT no movimento.

## Fronteiras

- `StockDomain` (`modules/stock-domain.js`): validação pura; mapeamento de produto canônico; substituição seletiva do cache; agrupamento por variante mantendo cada ID/código de barras.
- `StockRepository` (`modules/stock-repository.js`): cliente Supabase e journal injetados, sem URL/chave/fetch; coordena uma intenção congelada e consulta sua conclusão.
- Banco: `apply_stock_entry_v2(p_request_id,p_product_id,p_qty,p_type,p_note,p_new_cost)` grava saldo, custo opcional, movimento e comprovante de idempotência na mesma transação. `get_stock_entry_request(p_request_id,p_expected_payload default null)` consulta o resultado; o adaptador sempre envia o conteúdo esperado.
- UI: captura/revisa dados, escopa armazenamento por projeto+usuário, fornece trava entre abas, apresenta estado pendente e aplica os produtos canônicos retornados antes de liberar a próxima operação.

Escolha de reutilização: módulos UMD/CommonJS pequenos combinam com o frontend atual e testes Node existentes; não adicionam frameworks/dependências. Usa transações, locks e funções PostgreSQL já disponíveis, sem SDK novo. Uma migração aditiva limita regressão e permite atualização progressiva, sem reescrever os demais módulos.

## Uso pelo frontend

```js
const controller = StockRepository.createController({
  client: sb,
  createId: () => crypto.randomUUID(),
  journal: {read, write, clear},
  withLock: fn => navigator.locks.request(journalKey, fn)
});
await controller.ready(); // recuperar aviso de tentativa pendente
const result = await controller.submit({productId, qty, type:'ENTRADA', note, newCost});
// Ou retry() na retomada, sem montar um payload novo.
if (result.ok) {
  // Atualizar cache pelo ID; se product_deleted, remover somente esse ID.
  // Upsert do movimento por ID, nunca unshift duplicado.
  await controller.acknowledge(); // também consulta o resultado antes de limpar
}
```

`read/write/clear` podem ser síncronos ou assíncronos; `read` retorna objeto JSON ou null. O journal é obrigatório e deve ser persistente. `write` deve gravar o objeto recebido exatamente; o módulo lê de volta antes da RPC mutante. `withLock(fn)` é obrigatório e deve serializar o ciclo inteiro entre abas usando a mesma chave do journal, não um mutex só em memória. Se Web Locks/armazenamento estiverem indisponíveis, a UI deve bloquear o lançamento e explicar a limitação. Não usar uma chave global entre contas/lojas; não limpar automaticamente em logout, expiração, cancelamento de modal ou troca de produto uma tentativa que pode ter chegado ao banco. Outro dispositivo não compartilha o journal: não repetir manualmente a entrada sem conferir o movimento original.

Métodos assíncronos: `ready`, `submit`, `retry`, `acknowledge`, `discardRejected`. `getState()` retorna cópia `{busy,status,pending}`. `submit/retry` retornam `{ok,status,requestId,result?,error?,warning?}`; configuração, validação local, journal corrompido, edição de intenção pendente e chamadas simultâneas podem lançar erro. A UI deve capturar ambos os caminhos. `acknowledge` retorna o resultado canônico consultado novamente: aplicar também essa versão ao cache, pois outra operação pode ter mudado o saldo entre os dois passos.

O journal contém versão, UUID, produto, quantidade, tipo, custo opcional, observação e fase. Não copia cadastro/CPF/preço de venda, perfil nem credenciais. Observações livres podem conter informação inserida pelo operador; não se deve colocá-las em logs/telemetria. São mantidas localmente só até a conclusão explicitamente reconhecida. Limpeza normal do navegador remove esta proteção: o banco continua idempotente **somente se o mesmo UUID for preservado**. Um novo UUID é uma nova operação legítima; o servidor não tenta adivinhar duplicidade por produto, data ou quantidade.

Estados `prepared/submitting/uncertain/rejected/applied`. Uma tentativa em andamento encontrada após recarregar vira incerta. Consulta com falha impede reenvio cego; consulta ausente após falha de rede não libera um ID novo. Retry usa os mesmos dados e UUID. Erro SQL reconhecido na primeira tentativa, sem incerteza anterior e com consulta ausente confirmada, permite `discardRejected()` explícito para revisar e enviar outra intenção. Mensagem genérica não comprova rejeição. Nenhum erro posterior elimina uma incerteza anterior. Cancelar formulário fecha a UI, sem transformar tentativa incerta em cancelada no banco.

## Banco, autorização e concorrência

As duas RPCs exigem `auth.uid()` e perfil ativo de administrador/vendedora. `anon` não executa; a tabela privada não concede leitura/escrita direta a `authenticated`. O comprovante pertence ao autor; outro usuário não pode consultar/repetir o mesmo UUID. Um lock transacional por UUID serializa retries; `FOR UPDATE` no produto serializa intenções diferentes sobre o mesmo saldo. A tabela guarda apenas IDs, digest SHA-256 do conteúdo canônico e instante da aplicação. Sem cópia de observação/cadastro/CPF. Reuso com conteúdo diferente é erro, inclusive na consulta com expectativa informada. Não são usados locks de sessão que sobreviveriam à transação.

Resposta aplicada: `{status:'applied',request_id,product,product_deleted,move,move_missing}`. O produto é o estado **atual**, enquanto o movimento é o original; saldo antigo do movimento não pode substituir saldo canônico. Um produto excluído retorna `product:null,product_deleted:true`; a operação não é refeita. O comprovante não desaparece em cascata com produto/usuário/movimento. Ausência excepcional do movimento retorna `move_missing:true` para conferência administrativa; não autoriza lançar novamente.

Limites: `stock_moves` ainda não referencia a venda original; não se fabricou reconciliação por venda nem corrigiu movimentos antigos. A RPC antiga permanece sem UUID e clientes antigos ainda podem repeti-la. Esta migração não fecha todas as escritas diretas permitidas no schema atual. Segurança integral do banco exige revisar separadamente consumidores/policies antes de remover permissões compatíveis com telas antigas. Os testes são sintéticos; não demonstram correção do estoque real. Retenção dos comprovantes deverá ter política antes de qualquer limpeza; apagá-los reabre possibilidade de repetir um UUID antigo.

## Cache e variantes: integração obrigatória

`mergeCanonicalProducts(cache, rows, requestedIds)` preserva campos omitidos e substitui os retornados pelo banco; IDs solicitados ausentes da resposta bem-sucedida deixam o cache. Só chamar após consulta bem-sucedida, nunca converter erro em lista vazia. Atualizar **todos** os produtos consultados antes de apresentar erro de estoque insuficiente no caixa. Depois de excluir venda com devolução, reler os IDs afetados; não somar quantidades a um saldo local possivelmente antigo.

`groupByVariant(products)` retorna variante com `records[]`, `stock` agregado e `ambiguous` quando mais de um ID participa. Cada registro conserva ID/código/saldo. Mostrar uma unidade no agrupamento não significa que todos os códigos daquela variante têm uma unidade. O caixa escolhe o produto pelo ID/código exato; nunca usar saldo agregado para autorizar venda de um registro sem saldo. Cores sem identidade/nome não são agrupadas automaticamente.

## Regras preservadas e decisões pendentes

Quantidade mantém sinal explícito da RPC existente; tipo classifica o movimento, mas este bloco não cria regra automática de troca/devolução, política de custo médio ou correção do passado. A tela de entrada deve aceitar apenas quantidade positiva no seu contexto; o contrato de baixo nível também permite saída negativa. Custo informado significa substituição explícita do custo unitário, como antes, sem rateio inventado. Precisão de centavos é validada, não arredondada silenciosamente.

## Validação e implantação futura

Node: `node --test tests/stock-domain.test.cjs tests/stock-repository.test.cjs`. Fixtures SQL: `tests/sql/stock_entry_requests.sql`, somente no runner PostgreSQL descartável depois da migração nova. Os testes cobrem replay, conflito de conteúdo, bloqueio de acesso, saldo atual, exclusão posterior de produto e falha forçada do movimento revertendo saldo/custo/comprovante juntos. Teste simultâneo real de duas conexões deve complementar a fixture sequencial na suíte de integração.

Ordem futura: backup/checkpoint aprovado; comparar schema/assinaturas atuais; aplicar migração transacional; conferir privilégios/RPCs; publicar frontend com módulos e integração; monitorar erros sem dados pessoais. Rollback preferido do frontend: conservar a versão com proteção de carrinho e tratamento financeiro; reverter apenas a integração nova de estoque se necessário, reconhecendo que clientes antigos não têm idempotência. Após COMMIT não apagar tabela/comprovantes nem movimentos para desfazer: analisar falha e aplicar correção aditiva. Migração só cria objetos novos e não muda saldo ou movimento existente.
