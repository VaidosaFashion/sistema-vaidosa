# Registro local de operações e adaptador de contas

Estado: implementação isolada. Nenhum acesso ao banco real, alteração de configuração ou implantação foi realizado por este componente. Sua ativação depende da migração de contas e da integração da interface no mesmo pacote.

## Contrato reutilizável

`modules/operation-journal.js` expõe `VaidosaOperationJournal` no navegador e CommonJS em Node. Não tem dependências nem endpoints. O chamador injeta `storage` e `locks`, normalmente `localStorage` e `navigator.locks`, além de `projectId`, `userId` e `area` (`accounts` ou `stock`).

```js
const scoped = VaidosaOperationJournal.create({
  storage: localStorage, locks: navigator.locks,
  projectId: 'identificador-publico-da-loja', userId: profile.id, area: 'accounts'
});
const accounts = AccountsRepository.createController({
  client: supabaseClient, journal: scoped.journal,
  withLock: scoped.withLock, createId: () => crypto.randomUUID()
});
await accounts.ready(); // somente leitura do registro local; não chama RPC
```

A chave contém loja, usuário e área separados. O envelope repete o escopo e a versão: um registro copiado de outra conta é recusado. `write(record)` confirma a igualdade exata após `setItem`; `clear(expectedRequestId)` verifica a remoção e pode exigir o identificador esperado. O adaptador confirma a persistência por sua própria leitura também. Corrupção, quota, armazenamento indisponível e ausência de Web Locks bloqueiam novos envios. O registro não é apagado ao detectar erro.

`withLock(callback)` usa uma trava exclusiva por chave, compartilhada entre abas da mesma origem. Uma segunda aba recebe aviso de operação ocupada em vez de entrar na região crítica. O callback deve envolver leitura, gravação, conferência e envio; a trava é liberada mesmo em erro. Isso não coordena dispositivos diferentes, não substitui as travas/revisões/idempotência do servidor e não garante proteção se o chamador deliberadamente ignorar esse contrato.

## Adaptador de contas

`modules/accounts-repository.js` expõe `AccountsRepository`. A única dependência de rede é `client.rpc` injetada. Operações permitidas:

| Operação | Argumentos de `submit({operation,args})` |
|---|---|
| `create_account_v2` | `p_values` com os campos permitidos pelo domínio/SQL |
| `settle_account` | `p_account_id`, `p_expected_revision`, `p_paid_on` |
| `edit_account` | `p_account_id`, `p_expected_revision`, `p_changes` |
| `reverse_account_settlement` | `p_account_id`, `p_movement_id`, `p_expected_revision`, `p_reason` |
| `archive_account` | `p_account_id`, `p_expected_revision`, `p_reason` |

O controller gera `p_request_id`; o formulário não pode fornecê-lo. Alterações no objeto de entrada depois de `submit` não alteram o pedido persistido. `getState()` entrega uma cópia congelada com `status`, `request` e eventualmente `error`/`result`. `submit()` e `retry()` retornam `{ok,status,requestId,result?,error?}`; `error` é uma string para apresentação na interface.

Antes de qualquer RPC mutante, o pedido completo e seu UUID estão gravados e conferidos. Antes de cada tentativa, inclusive a inicial, chama:

```text
get_account_request_status(
  p_request_id,
  p_expected_operation: nome da RPC,
  p_expected_payload: argumentos congelados incluindo p_request_id
)
```

O SQL confirma autor e igualdade do payload. `completed` recupera o resultado existente; `not_found` permite tentar somente o mesmo UUID e payload. Falha da conferência impede o envio. Uma confirmação anterior que desapareça do servidor nunca provoca um novo envio: exige revisão.

Depois de um erro de envio, o adaptador consulta novamente. Uma gravação cuja resposta se perdeu pode assim ser reconhecida sem duplicação. Erro de transporte ou resposta desconhecida permanece `uncertain`, mesmo que o pedido não tenha sido encontrado naquele instante. Uma mensagem de erro sozinha nunca é prova de ausência de gravação.

Um erro retornado explicitamente pela RPC com SQLSTATE `22023`, `22P02`, `23502`, `23503`, `23505`, `23514`, `42501`, `40001`, `40P01` ou `P0002` pode virar `rejected` **somente** após conferência `not_found` e se nenhuma tentativa anterior desse UUID ficou incerta. `P0001` genérico permanece incerto. `discardRejected()` refaz a conferência antes de liberar o registro. Uma rejeição posterior nunca apaga incerteza de tentativa anterior.

`ready()` lê o armazenamento e não dispara envio ou consulta remota. A interface deve apresentar a operação pendente e oferecer `retry()` explícito. Outro formulário não pode substituir pedido pendente. Após resultado concluído, a interface atualiza os dados canônicos e chama `acknowledge()`; este só libera o registro da conclusão conferida pelo controller atual. Depois de recarregar, é necessário conferir o resultado novamente antes de reconhecer. O resultado completo da conta fica apenas na memória, não é duplicado no registro persistente.

## Privacidade, duração e limites

- O registro contém UUID, operação, campos necessários à repetição, datas, revisão e marcadores de estado. `descricao`, `obs` e `p_reason` explicitamente enviados pelo formulário podem permanecer no dispositivo até a resolução; não há criptografia local. A interface não deve incluir dados pessoais ou segredos nesses textos livres.
- Campos estruturados de CPF/CNPJ, senha, token e chave de serviço são recusados pelo journal. Essa lista é uma barreira adicional, não um detector de dados pessoais inseridos em texto livre.
- Resultados de contas, nomes de clientes, CPF, contatos e conteúdo do servidor não são adicionados automaticamente. Não há telemetria, envio a terceiros nem logs com payload pelo módulo.
- Não existe expiração que apague operações incertas. Depois de confirmada ou rejeitada com segurança, a liberação é explícita. O limite do envelope é de 98.304 caracteres JSON; excesso bloqueia a gravação.
- O registro é específico do perfil do navegador, origem, loja, usuário e área. Não acompanha outro navegador/dispositivo, não é backup e não sincroniza na nuvem. Logout não apaga o registro; outro usuário recebe outra chave. Limpar os dados do navegador, navegação privada, falha de disco ou outro script da mesma origem podem removê-lo. Não se deve afirmar recuperação garantida nessas condições.
- A confirmação de `localStorage` é uma leitura imediata, não uma garantia contra perda física ou limpeza posterior. Idempotência/revisões no servidor continuam essenciais.
- Web Locks protege abas cooperantes da mesma origem. Dispositivos diferentes usam UUIDs próprios; a revisão do servidor impede duas baixas concorrentes do mesmo estado. Duas criações intencionais em dispositivos diferentes podem criar duas contas; não há regra de deduplicação por descrição/valor.
- O adaptador não decide taxas, baixa parcial, cancelamento de obrigação ativa ou reconstrução de movimento legado. Essas regras pertencem ao domínio e ao SQL; não são inferidas de mensagens de erro.

## Verificação local

```sh
node --test tests/operation-journal.test.cjs tests/accounts-repository.test.cjs
```

Testes usam memória, clientes RPC fictícios e Web Locks simuladas, sem conexão de rede. Cobrem persistência antes do envio, resposta perdida, recuperação após recarga sem envio automático, payload imutável, reenvio idempotente, conflitos entre abas, armazenamento indisponível/corrompido, minimização, rejeições conhecidas, revisão defasada, ausência de conta, confirmação desaparecida e preservação da incerteza em tentativas posteriores. Integração com PostgreSQL e tela real deve ser conferida pela suíte do pacote; estes testes isolados não certificam o banco de produção.

Decisão de dependências: a necessidade é pequena e usa recursos padronizados do navegador; não foi introduzido pacote de armazenamento, rede, validação ou criptografia. Nenhum código remoto foi instalado ou executado para este bloco.
