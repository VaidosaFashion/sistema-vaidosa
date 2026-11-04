# Vaidosa — pacote preparado em 04/11/2026

**Não aplicado nem publicado. Backup restaurável de produção e restauração de teste ainda NÃO verificados. Não executar o instalador antes dessa confirmação e da autorização de implantação.**

O pacote corrige pagamento/desconto de venda existente mantendo ID, peças e estoque; corrige o erro da venda seguinte; registra o motivo e histórico financeiro da correção. Não executa estorno bancário nem altera vendas automaticamente. A revisão exata está em `REVISAO.txt`; integridade dos arquivos em `SHA256SUMS.txt`.

## Ordem de implantação, condicional ao backup

1. Confirmar o projeto **vaidosa-sistema — ysultkzfhgtyujbomfqz**. Obter backup completo de schema/dados/funções/grants e comprovar restauração em ambiente separado. O backup JSON do app sozinho não basta. Guardar a evidência do backup/restauração fora do repositório/chat. **Este passo está pendente.**
2. Depois da confirmação, executar **01_preflight.sql** no SQL Editor e conferir quatro funções/assinaturas, todas com `igual_ao_export_auditado=true`. Mudança ou linha extra exige comparação antes de seguir. Confirmar `vaidosa_private` fora dos schemas expostos e ausência de carrinho/requisição em andamento. Não há consulta de dados de clientes nesse arquivo.
3. Somente então, em janela tranquila, executar **02_instalar_transacao.sql inteiro**, uma única vez. São três migrações em **uma transação**, sem commits intermediários, com timeout de trava de 5s. Não executar também os arquivos individuais do repositório. Se falhar antes do COMMIT, o conjunto é revertido; não forçar desconexões. Se o resultado for incerto, verificar o estado antes de repetir.
4. Executar **03_pos_instalacao.sql** e conferir: primeira linha toda verdadeira; quatro RPCs presentes com anon bloqueado e authenticated autorizado; dezesseis pares tabela/papel presentes sem privilégios administrativos. Uma mensagem “Success” sozinha não basta. Não publicar se algo falhar.
5. Publicar juntos **frontend/index.html** e **frontend/financial-corrections.js** da mesma revisão na pasta do site existente, preservando os demais arquivos/assets. Recarregar o sistema, confirmar login e abrir/cancelar a correção de uma venda existente. Não criar/excluir venda real para teste. Uma correção real exige conferir valores e motivo com o operador.

## Permissões alteradas, somente oito tabelas

Anon conserva apenas SELECT em `profiles` para a lista de login. PUBLIC/anon/authenticated perdem privilégios administrativos desnecessários e grants por coluna. As permissões efetivas de tabela de `service_role` são preservadas; heranças inesperadas que manteriam ações proibidas fazem a instalação abortar.

| Tabela | Operações mantidas para authenticated |
| --- | --- |
| sales | SELECT, UPDATE |
| sale_payments | SELECT, INSERT |
| sale_items | SELECT |
| products | SELECT, INSERT, UPDATE, DELETE |
| stock_moves | SELECT, INSERT |
| store_settings | SELECT, INSERT, UPDATE |
| profiles | SELECT |
| nfce_emissions | SELECT |

Criar/excluir venda e corrigir recebimentos usam RPCs com validação de perfil ativo. RPC de exclusão ausente bloqueia a operação, sem devolver estoque em etapas. As proteções fiscais existentes e CPF são preservados; CPF não é copiado ao histórico financeiro. O emissor fiscal incompleto não foi desenvolvido.

**Limite:** UPDATE direto em sales permanece para recálculo INVOKER e metadados. Escritas deliberadas nessa tabela podem contornar o histórico; esta entrega não reforma toda a autorização da loja. Testes sintéticos não certificam saldos históricos reais. Ver `RELATORIO.md`.

## Rollback sem apagar dados

- Antes do COMMIT: a transação reverte o conjunto quando ocorre erro.
- Depois do COMMIT: suspender a nova interface/voltar ao frontend compatível e preparar correção progressiva. Manter histórico, revisões e tentativas; não restaurar permissões anônimas ou o fallback inseguro. Não há script DROP/TRUNCATE/DELETE de rollback.
- Restauração de backup só após análise e reconciliação de lançamentos posteriores, nunca automaticamente.

## Uso provisório do sistema atual

Depois de confirmar a venda salva, recarregar a página **antes de montar o próximo carrinho** restaura o select oculto Pendente; comportamento demonstrado em código/DOM. Não recarregar com carrinho não salvo. Isso não corrige pagamentos existentes: manter a venda original, sem excluir/duplicar.

## Validação concluída

39/39 testes de interface passaram. PostgreSQL descartável passou com schema relevante reconstruído dos metadados, cinco cenários concorrentes, descontos, recebimentos, estoque/60 itens, CPF, histórico, grants e proteções existentes. O instalador único foi validado nesse ambiente. `previa-offline.html` usa dados fictícios e bloqueia conexões; não substitui o banco.
