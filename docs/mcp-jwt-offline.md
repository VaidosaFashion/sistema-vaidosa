# JWT offline com chaves de teste

Preparação na cópia sobre `6cf6641`. `mcp/local-jwt-verifier.cjs` integra a
verificação de assinatura/claims ao boundary MCP existente. **Não ativa identidade
real, OAuth, JWKS remoto, credencial, serviço público ou cliente real.** Os únicos
emissores/audiências dos testes são endereços `.invalid`.

## Biblioteca e fronteira de confiança

Assinatura e importação JWK usam `jwtVerify`, `decodeProtectedHeader` e `importJWK`
da biblioteca reconhecida **jose 6.2.15**, MIT, já disponível no cache autorizado.
Os 48 arquivos de runtime/licença/package metadata foram comparados por SHA-256
ao manifesto do ensaio anterior; origem e integridade npm constam de
`tests/fixtures/jose-runtime.json`. Nenhum download/instalação, pacote de origem
desconhecida ou hook foi executado nesta etapa. Não se declara versão mais recente
ou ausência de vulnerabilidades futuras. Não há implementação própria de assinatura.

O módulo recebe o engine JOSE explicitamente de código confiável; não importa
dependência, busca chave ou lê ambiente ao ser carregado. Não é permitido escolher
engine/chave/emissor por argumento do modelo. Os testes carregam o pacote fixado
como dependência somente leitura na cópia descartável. A aplicação não ganhou
instalação automática ou flag de produção. A seleção/auditoria de dependências do
bootstrap real ainda é requisito futuro.

Chaves privadas são geradas apenas em memória dentro do sandbox pelos testes,
usando JOSE/WebCrypto, e não são exportadas, gravadas ou entregues. O verificador
aceita apenas chaves públicas locais explicitamente configuradas. Não fornece API
de assinatura nem expõe seus controles de rotação/revogação como ferramenta MCP.

## Perfil restrito ensaiado

- Somente ES256, curva P-256, header exato `typ: at+jwt`, `kid` conhecido e limitado.
  Sem `none`, HMAC, chave simétrica/privada, algoritmo negociado pelo token, cabeçalhos
  de chave incorporada/remota ou seleção de URL a partir do header.
- Até quatro JWKs públicas. Kty/curva/alg/use/key_ops e campos permitidos são
  conferidos antes de importar. Kid duplicado, ponto inválido ou propriedade extra
  recusam a configuração. Importação/assinatura continuam delegadas ao JOSE.
- Token compacto ASCII/base64url com três segmentos não vazios, máximo 4 KiB.
  Header e claims extras são recusados; erros são genéricos e não carregam `cause`,
  payload, chave, token ou dados pessoais.
- Issuer e audiência únicos, canônicos e configurados pelo servidor; contexto de
  verificação precisa coincidir. Não existe descoberta remota. Aud array/múltiplos
  recursos não fazem parte deste perfil.
- `sub` e `jti` são UUIDs; `iss/aud/sub/jti/iat/exp/scope` obrigatórios. Datas
  inteiras; exp futuro; iat não futuro; nbf opcional, entre iat e exp e não futuro.
  Tolerância zero. Vida/idade máxima é política explícita entre 1 e 900 segundos;
  testes usam 300. Não é decisão sobre o provedor ou TTL real da loja.
- Scope string sem duplicatas, limitada ao conjunto `mcp:read`, `stock:read`,
  `sales:read`, `finance:read`. O boundary exige mcp:read e faz interseção dos escopos
  com grants atuais. Loja, papel e clientes vêm do autorizador confiável, não do JWT
  ou modelo. Claims de role/store/contato não são aceitas nesse perfil.

`http-identity.cjs` mantém o retorno normalizado e a proveniência no WeakMap.
O guard de validade/revogação do verificador é conferido antes/depois do autorizador
assíncrono e também em `requireVerifiedPrincipal`. Assim, um principal criado antes
de revogar o token não continua usando diretamente o serviço/gateway/cache. O guard
retém somente hashes de jti/subject, tempos e estado de chaves públicas; não o JWT.
Verificadores legados que não retornam esse guard continuam com seu contrato anterior;
não se atribui a eles revogação que não implementam.

## Rotação e revogação locais

`replaceKeys` valida/importa um candidato completo e publica atomicamente. Uma
substituição inválida é recusada e **preserva a configuração anterior válida**;
não declara rotação concluída. Se uma chave foi comprometida, revogá-la é operação
separada necessária; uma tentativa inválida de rotação não equivale a revogação.
É possível sobreposição explícita de chaves. Remover uma chave impede novas
verificações com ela. Toda troca publicada invalida provas/principais anteriores,
exigindo reautenticação; rotação durante uma verificação assíncrona é detectada.

Controles locais de código confiável:

- `revokeToken(jti)`: bloqueia aquele UUID pelo horizonte máximo aceito. O contrato
  exige jti único por token; não reemitir outro token usando o mesmo UUID.
- `revokeSubject(sub)`: cutoff de iat, revogando tokens emitidos até aquele segundo.
  Um token único emitido depois ainda depende de grants atuais. Isso não desativa
  permanentemente o usuário; inativação pertence ao autorizador/backend.
- `revokeKey(kid)`: bloqueia o identificador inclusive em configurações futuras da
  mesma instância; não há desbloqueio implícito por rotação.

Mapas de token/subject e conjunto de kid são limitados a 128 entradas cada. Jti/sub
são armazenados como SHA-256 com sal aleatório da instância; tokens nunca são cacheados.
Entradas temporárias só expiram após o horizonte máximo de tokens aceitos. Se a
capacidade de revogação esgotar, a instância é desabilitada, sem esquecer uma
revogação para continuar aceitando tokens. Relógio retrocedendo também desabilita
a instância. Tolerância de relógio/monitoramento reais são decisões futuras.

**Estado somente em memória:** reinício elimina essas listas e não há coordenação
entre processos. Não é mecanismo durável/distribuído de logout/revogação. Antes de
ativação real é indispensável definir armazenamento/propagação confiáveis,
indisponibilidade, retenção, recuperação e revogação de conta/chave. O protótipo não
cria esses serviços ou acesso persistente. Não há promessa de revogação contínua
de bytes já entregues ou de uma resposta depois da última checagem.

## Ensaios e limites

`tests/mcp-jwt.test.cjs` usa assinaturas reais com chaves inteiramente fictícias:
alteração de assinatura/payload, algoritmo/tipo/kid/chaves indevidas, iss/aud,
exp/nbf/iat, escopos, limites e erros opacos; rotação, revogação e corridas
assíncronas; principal já registrado, capacidade e relógio. O cenário adicional de
`mcp-postgres.test.cjs` passa JWT assinado pelo boundary às cinco consultas PG e ao
handler HTTP em memória, revoga o jti e verifica negação sem nova query; token
novo autorizado continua funcionando no serviço em cache.

Isso melhora o ensaio anterior de identidade simulada, mas o emissor e o vínculo
LOGIN do PG continuam fictícios. OAuth, registro de cliente, discovery, JWKS remoto,
emissão/renovação real, sessão real e apps Codex/Claude não foram ativados/testados.
RLS executada apenas no PG efêmero; nada implantado na loja. Preservam-se controles
OS e limites já comprovados, sem exceção de navegador e sem segredo real.

Para ativação futura, escolher serviço emissor e perfil de access token, política
de chaves/rotação/revogação durável, identidade/backend real, TLS/ingress e versões
de clientes. Substituir o protótipo somente após revisão, homologação e autorização
específicas. Não é suficiente copiar `.invalid`, logins trust ou chaves dos testes.

Fontes primárias consultadas em 06/11/2026: [jose](https://github.com/panva/jose),
[jwtVerify](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md).
O código efetivamente ensaiado é o artefato local fixado, não o branch main remoto.
