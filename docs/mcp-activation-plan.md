# Ativação futura do MCP Vaidosa

Status desta entrega: **executável local fixture, somente leitura; nenhuma integração real ativa**. Nenhum OAuth, segredo, permissão de banco, configuração de cliente, listener HTTP ou recurso externo foi criado. O [README do componente](../mcp/README.md) contém comandos e contratos executados pelos testes.

Atualização de 06/11/2026: a [fronteira de negócio assíncrona](mcp-business-read-preparation.md)
foi implementada com gateway mock e integração em memória ao handler HTTP existente.
Isso prepara parte do item 3 abaixo; implementação/autorização do gateway real,
verificador criptográfico, RLS efetiva e clientes reais continuam pendentes. O
componente não ativa a conexão e não requer instalar o bundle mutante.

## Caminho de integração

1. Revisar os resultados fictícios no cliente de teste local. A próxima validação com Codex/Claude deve primeiro apontar para `node <caminho-absoluto>/mcp/server.cjs --fixture`, com escopo seller por padrão. Essa descrição não grava configurações nem confirma suporte de uma versão específica do cliente.
2. Definir usuários, lojas, permissões e ferramentas necessárias; confirmar quais dados podem sair da aplicação para um cliente de IA. IDs opacos e totais ainda podem ser sensíveis em produção. Definir retenção, acesso e revogação da auditoria antes de ativar acesso real.
3. Criar adapter de leitura sobre os serviços canônicos, com RLS/autorização efetiva por usuário e loja, snapshot/paginação consistente, timeout/cancelamento, validação de saída e testes de contrato. Consultas devem ser parametrizadas e limitadas. Não usar DOM, cache do caixa ou localStorage como fonte de verdade; não duplicar regra de saldo, descontos ou conciliação no MCP.
4. Selecionar transporte/SDK e provar compatibilidade por versão com os clientes pretendidos. Um cliente local pode usar stdio; um serviço remoto requer autenticação de usuário, validação de audiência/escopo, isolamento de sessões, proteção de origem e transporte seguro. Não tratar um `role` enviado pelo modelo como autenticação. Validações de token nunca são substituídas por instruções no prompt.
5. Obter confirmação específica para configuração/credenciais/OAuth/permissões e ativação. O servidor intermediário mantém segredos no lado servidor; não disponibiliza service role no navegador nem ao modelo. Preferir credenciais de privilégio mínimo e usuário efetivo; nenhum SQL arbitrário, dump ou ferramenta genérica de administração.
6. Ensaiar em ambiente separado com fixtures e depois dados de homologação autorizados, bloquear mutações em ambas as camadas, verificar negações entre lojas/usuários, limitar volume/custo, validar revogação e retorno sem acesso real. Só então decidir ativação gradual de leitura.

Não existe ajuste de flag que transforme esta implementação fixture em produção. O guard de rede deve permanecer no executável fixture; o futuro servidor real terá entrada separada e revisão específica. A aplicação continua funcionando sem processo MCP; falha ou remoção do MCP não deve impedir vendas.

## Contratos para conectar módulos e canais

```text
UI / API / MCP (transporte e apresentação)
             ↓
serviços de aplicação (autorização, invariantes, idempotência)
             ↓
domínio canônico (contas, recebimentos, vendas, estoque, clientes)
             ↓
repositórios/adapters (banco, fixture, canais externos)
```

O MCP é uma interface; a consistência vem do domínio e banco. Adaptadores de marketplace ou automações devem respeitar os mesmos contratos e versões. Mapear IDs externos de pedido/evento com origem explícita; deduplicar eventos antes de mutações futuras; não somar contas manuais e recebimentos de vendas sem relação canônica. Dados de pagamentos e documentos fiscais exigem permissões específicas, nunca exportação implícita de snapshots. Este pacote não conclui o módulo fiscal nem altera suas proteções.

## Fronteira de mutações futuras

Esta versão não oferece criar/excluir venda, receber pagamento, corrigir desconto ou movimentar estoque. Um eventual módulo de escrita exige autorização separada e comandos de domínio restritos. A confirmação deve identificar operação, alvo, valores, versão esperada e efeito antes da gravação; vincular a aprovação a um payload canônico imutável, usuário e expiração. UUID/idempotência deve manter o mesmo resultado entre tentativas, com consulta do estado antes de reenvio incerto, transação atômica, revisão otimista e trilha de alterações. Não aceitar `confirmed: true` vindo apenas do modelo como prova de aprovação humana.

Leitura e escrita devem ter permissões, ferramentas e implantação separadas. Eventos de canais externos não substituem autorização nem regras de estoque. Não implementar SQL genérico para contornar essas fronteiras.

## Critérios de aceitação antes de conexão real

- Adapter real comprovadamente filtra cada consulta por principal confiável; teste negativo para outra loja/usuário e para IDs inexistentes/inacessíveis com erro uniforme.
- DTOs minimizados; sem CPF, contato, notas, XML fiscal ou segredo. Inclusões posteriores exigem necessidade e escopo explícitos.
- Contratos com fonte única para estoque por variante, parcelas/recebimentos, vínculos de cliente e datas; agregados sem dupla contagem.
- Transporte oficial versionado e ensaios com as versões reais dos clientes; limites, timeout, cancelamento, quotas por identidade e logs auditáveis com retenção definida.
- Plano de revogação: desativar acesso MCP sem indisponibilizar caixa; nenhuma exclusão de dados no rollback. Segredos rotacionáveis e permissão mínima revisada.
- Aprovação específica de ativação, configuração e acesso. Nada disso está presumido pela autorização de construir o protótipo.

Pendências de produção: identidade/OAuth ou outro mecanismo escolhido, adapter real, grants/RLS mínimos, transporte de produção, auditoria persistente, operação/monitoramento e ensaio Codex/Claude. Essas são decisões futuras; não bloqueiam executar e revisar o protótipo fictício entregue.
