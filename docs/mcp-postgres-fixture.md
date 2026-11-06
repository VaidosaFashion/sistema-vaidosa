# MCP com PostgreSQL — integração somente fictícia

Preparação local sobre `9293412`. As cinco consultas existentes agora podem passar
pelo novo `mcp/postgres-read-gateway.cjs` e pelo PostgreSQL descartável dos testes.
Transporte, ferramentas e DTO v2 existentes foram reutilizados. Não há servidor
público, OAuth, cliente real, credencial, implantação ou alteração do banco da loja.

## Fronteiras

```text
handler MCP existente → identidade simulada/verificada no boundary do processo
 → serviço/adapter de negócio existentes → postgres-read-gateway
 → executor PSQL exclusivo de testes → transação REPEATABLE READ READ ONLY
 → função de projeção sem propriedade das tabelas ou BYPASSRLS
 → tabelas canônicas da fixture, com RLS e grants efêmeros
```

O gateway não importa driver, abre conexão ou lê ambiente; recebe `executeRead`
explicitamente. O executor fornecido está somente em `tests/support`, preso a
Linux/UID10001, controles do sandbox, socket `/scratch/mcp-socket`, porta 55432,
banco `vaidosa_mcp_read_fixture` e identificador do cluster do harness. Não aceita
URI, host, porta, SQL ou ambiente PG do modelo. Usa apenas Node/psql já disponíveis,
sem dependência nova. Os dados do request são JSON codificado em base64 dentro de
uma consulta SQL fixa, não interpolação de SQL fornecido pelo modelo.

O adapter passa o principal original, registrado no WeakMap de autenticação,
separadamente do plano. Gateway e executor conferem sua proveniência, emissor,
audiência, validade, loja e escopos; um objeto copiado/congelado ou os campos
`role/store/subject` dos argumentos não bastam. Token não é entregue ao banco,
gateway, cache ou auditoria. O transporte continua reautenticando cada request.

## Identidade simulada versus autorização no banco

Nos testes, um verificador inventado aceita somente `fixture-token`; não valida JWT
criptográfico nem OAuth. O executor mapeia o principal confiável para um papel
LOGIN efêmero fixo. O socket privado usa autenticação trust apenas no cluster
descartável. Quem controlasse esse socket e seu ambiente poderia escolher outro
LOGIN: isso **não é autenticação real de usuário** nem solução pronta de produção.

Dentro desse modelo explicitamente simulado, as negações são executadas pelo
PostgreSQL. A função de projeção tem dono `mcp_fixture_reader`, NOLOGIN,
NOBYPASSRLS, sem propriedade das tabelas e com SELECT apenas nas colunas necessárias.
Os papéis de usuário têm somente EXECUTE nessa função, sem membership do reader,
SELECT bruto, escrita ou leitura dos ledgers privados da aplicação. RLS consulta
`SESSION_USER`, grants selados e perfil ativo. Inventar um GUC de JWT/subject não
troca o LOGIN. O banco revalida escopo por operação, sujeito e visibilidade do
cliente mesmo se o autorizador fictício da aplicação conceder acesso maior.

O binding selado configura explicitamente **uma fonte/banco para uma loja** e
confere banco/cluster; nenhuma coluna `store_id` foi adicionada ao negócio. Trocar
fonte/loja no request é negado. Não demonstra multiempresa em um único banco nem
assume que as policies atuais da loja sejam estas. Papéis/policies deste ensaio
ficam em `tests/sql/mcp_read_fixture.sql`, com guarda e transação; **não são migração
de produção**. A RLS foi exercitada no PG efêmero; não foi implantada no Supabase.

## Projeções e consistência

As cinco operações devolvem apenas os campos do contrato canônico existente:
estoque por variante; pedidos do cliente; detalhe de venda/itens; recebimentos de
vendas por `paid_on`; contas manuais/movimentos efetivos. Não retornam contato/CPF,
notas livres, XML fiscal, custos, payloads privados ou segredos. Origens financeiras
continuam separadas; não há conciliação ou saldo presumido. Centavos, revisão de
itens/subtotal e datas/fuso continuam validados pelo adapter e DTO existentes.

A primeira leitura materializa uma projeção mínima completa sob uma transação
REPEATABLE READ READ ONLY, fechada logo após a leitura. Não deixa transação ou
conexão persistente. O processo mantém até oito snapshots por gateway, cada um
limitado a 256 KiB serializados, por até cinco minutos. Valores podem refletir o instante inicial;
uma consulta nova busca estado atual. Não é atualização em tempo real de saldo.

Cada página posterior consulta novamente a autorização no banco **e a visibilidade
atual dos IDs/vínculos de cliente e movimentos aninhados**. Reatribuição A→B,
remoção, policy ou grant alterado invalida o snapshot antes de liberar dados antigos.
Só comparar grants seria insuficiente; a regressão dessa falha faz parte do ensaio.
Atualizar um valor ainda autorizado pode conservar o snapshot antigo coerente.
Novo gateway/backend futuro precisa implementar esse fingerprint de visibilidade,
não devolver um hash constante. O código não prova sozinho a semântica de um
executor arbitrário injetado.

Cursores opacos permanecem vinculados a principal, operação, filtros, limite e
snapshot; até 128 tokens por snapshot, com expulsão dos antigos. Limites existentes
de página/serviço/DTO continuam. A fonte limita a 2.000 raízes, 1.000 recebimentos,
200 itens por venda, 100 movimentos por conta e 260.000 bytes antes de responder.
Não retorna agregado parcial. O executor limita stdout a 256 KiB, stderr a 4 KiB e
processo a 1,5 s; statement timeout 1 s/lock 250 ms. Abort encerra o psql e impede entrega;
timeout do banco é defesa independente. Não equivale a provar todas as interrupções
possíveis de um driver remoto. RLS/índices reais e grandes volumes exigem outro ensaio.

## Testes e ativação futura

`tests/mcp-postgres.test.cjs` cria o cluster, confere hashes de 15 arquivos do schema,
aplica baseline/bundles locais e papéis/seed fictícios. Exercita as cinco ferramentas,
negações de identidade/escopo, RLS, cache/paginação/revogação, DTO/centavos, leitura
sem efeitos e integração HTTP em memória. Não configurar esses logins em clientes
reais. O supervisor externo autorizado aplica rede negada, ambiente mínimo,
fonte/toolchain somente leitura, scratch e limites completos antes do alvo.

Próximo passo real continua separado: mecanismo criptográfico e vínculo confiável
de identidade/backend, autorização/RLS revisadas, homologação e volumes reais
autorizados, privacidade/retenção, transporte/observabilidade e testes das versões
Codex/Claude. Nenhum grants/role de produção deve ser copiado automaticamente desta
fixture. Ativação/configuração/credenciais precisam de autorização específica futura.
O caixa e o bundle financeiro permanecem independentes desse componente de leitura.
