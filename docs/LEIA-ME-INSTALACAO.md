# Vaidosa — financeiro integrado ao carrinho publicado em 04/11/2026

**Financeiro não aplicado nem publicado. Free sem backups nativos; senha PostgreSQL desconhecida. Não pedir reset. Recuperação de produção ainda NÃO verificada. O caminho proposto é checkpoint direcionado pelo SQL Editor, validado localmente e explicitamente aceito como cobertura limitada, antes da autorização de implantação. Não registrar isso como backup completo.**

Este pacote integra o financeiro auditado `f8651f3` sobre o frontend publicado `931b28c`. Corrige pagamento/desconto de venda existente mantendo ID, peças e estoque, com motivo e histórico financeiro. Preserva a proteção do carrinho e o reset Pendente já publicados. Não executa estorno bancário nem altera vendas automaticamente. A revisão exata está em `REVISAO.txt`; integridade dos arquivos em `SHA256SUMS.txt`.

## Ordem de implantação, condicional à recuperação aprovada

1. No projeto **vaidosa-sistema — ysultkzfhgtyujbomfqz**, seguir `ROTEIRO-CHECKPOINT.md`: exportar uma cópia direcionada privada, conferir integridade/estrutura/escopo e guardar segunda cópia. Exige aceite explícito da cobertura limitada e dos riscos residuais, além da autorização posterior da migração financeira. Se a decisão for exigir recuperação integral, a rota por dump completo continua pendente; o checkpoint não a substitui silenciosamente. O JSON do app não basta. **Não há exportação real validada nesta entrega.**
2. Depois da confirmação, executar **01_preflight.sql** no SQL Editor e conferir quatro funções/assinaturas, todas com `igual_ao_export_auditado=true`. Mudança ou linha extra exige comparação antes de seguir. Confirmar `vaidosa_private` fora dos schemas expostos e pausa efetiva de todos os escritores (caixas, recebimentos, estoque, integrações e tarefas), não só ausência de novas vendas. O checkpoint antecede as mudanças; atividade posterior pode exigir nova exportação. Não há consulta de dados de clientes nesse arquivo.
3. Somente então, em janela tranquila, executar **02_instalar_transacao.sql inteiro**, uma única vez. São três migrações em **uma transação**, sem commits intermediários, com timeout de trava de 5s. Não executar também os arquivos individuais do repositório. Se falhar antes do COMMIT, o conjunto é revertido; não forçar desconexões. Se o resultado for incerto, verificar o estado antes de repetir. O SQL Editor autenticado permite esta etapa sem conhecer a senha PostgreSQL.
4. Executar **03_pos_instalacao.sql** e conferir: primeira linha toda verdadeira; quatro RPCs presentes com anon bloqueado e authenticated autorizado; dezesseis pares tabela/papel presentes sem privilégios administrativos. Uma mensagem “Success” sozinha não basta. Não publicar se algo falhar.
5. Depois de autorização específica para publicar a edição financeira, publicar juntos os **cinco arquivos de frontend** da mesma revisão: `index.html`, `financial-corrections.js`, `cart-draft-store.js`, `cart-draft-ui.js` e `cart-draft-app.js`. Preservar os demais arquivos/assets. Não substituir pelo HTML do pacote antigo `f8651f3`. Atualizar somente quando todos os caixas estiverem sem carrinho/envio ativo; confirmar login e abrir/cancelar a correção de uma venda existente. Não criar/excluir venda real para teste. Uma correção real exige conferir valores e motivo com o operador.

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

**Limite:** UPDATE direto em sales permanece para recálculo INVOKER e metadados. Escritas deliberadas nessa tabela podem contornar o histórico; esta entrega não reforma toda a autorização da loja. Testes sintéticos não certificam saldos históricos reais. Ver `RELATORIO-INTEGRACAO.md` e `RELATORIO-AUDITORIA-ORIGINAL.md`.

## Rollback sem apagar dados

- Antes do COMMIT: a transação reverte o conjunto quando ocorre erro.
- Depois do COMMIT: suspender apenas a edição financeira e preparar correção progressiva no frontend integrado. **Não fazer rollback cego para o HTML antigo nem para `931b28c`: isso reintroduz registro de pagamento sem UUID e fallback de exclusão incompatível com os novos grants.** Manter carrinho, registro seguro de pagamento e exclusão somente RPC. Se a falha envolver funções/triggers usados por outros fluxos, suspender também essas operações. Manter histórico, revisões e tentativas; não restaurar permissões anônimas ou o fallback inseguro. Não há script DROP/TRUNCATE/DELETE de rollback.
- Restauração de backup só após análise e reconciliação de lançamentos posteriores, nunca automaticamente.

## Sistema atualmente publicado

O frontend `931b28c` já corrige a segunda venda e protege novos carrinhos. Recarregar não é mais o procedimento para vender novamente: após confirmação, usar Nova venda. Nunca recarregar um carrinho ativo para aplicar este pacote. A edição financeira ainda não está publicada; manter a venda original, sem excluir/duplicar.

## Histórico de migrações

O instalador manual não registra automaticamente entradas em `supabase_migrations.schema_migrations`. Registrar privadamente os IDs `20261104133207`, `20261104134055`, `20261104165000`, hash do bundle e data/resultado; conciliar esse histórico antes de qualquer futuro `db push`, sem reaplicar os arquivos já executados. Não executar fixtures ou migrações antigas em produção.

## Validação concluída

O relatório `RELATORIO-INTEGRACAO.md` e os logs deste pacote registram os testes da revisão integrada. O pacote original tinha 39 testes; parte do finalizador antigo foi substituída pelo controlador do carrinho já publicado, cuja cobertura também é executada nesta integração. PostgreSQL descartável passou com schema relevante reconstruído dos metadados, cinco cenários concorrentes, descontos, recebimentos, estoque/60 itens, CPF, histórico, grants e proteções existentes. O instalador único foi validado nesse ambiente. `previa-financeira-offline.html` usa dados fictícios e bloqueia conexões; não substitui o banco.
