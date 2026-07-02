# SPRINT1-FINAL.md

**Relatório de Conclusão da Sprint 1**
**Branch:** `claude/felogix-dev-assistant-macmsv`
**Data:** 2026-07-01

---

## O que foi corrigido neste commit

### ALTO-1 — Remoção do log da VAPID_PRIVATE_KEY (`server.js`, linha ~43)

**Problema:** Ao iniciar sem as variáveis `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` no `.env`, o servidor gerava um par temporário e imprimia a chave privada VAPID no console via `console.warn`. Isso expunha a chave em `pm2 logs`, em arquivos `~/.pm2/logs/` e em qualquer sistema de coleta de logs conectado.

**Correção:** Removida a linha:
```js
// ANTES (removido):
console.warn(`[push] VAPID_PRIVATE_KEY=${VAPID_PRIVATE_KEY}`);
```

O log agora exibe apenas:
1. Aviso de que as variáveis estão ausentes (par temporário em uso)
2. Instrução para definir no `.env`
3. `VAPID_PUBLIC_KEY` (chave pública — segura para logs)

A `VAPID_PRIVATE_KEY` não aparece em nenhum `console.*` no arquivo.

---

### ALTO-2 — Remoção do `hashSenha(ADMIN_PASS)` bloqueante no seed (`server.js`, linhas ~1126–1134)

**Problema:** O seed do gestor de teste usava `ON CONFLICT (email) DO UPDATE SET senha = EXCLUDED.senha`. Isso forçava a avaliação de `hashSenha(ADMIN_PASS)` — que internamente chama `crypto.scryptSync` — em **todo restart do servidor**, bloqueando o event loop por ~50–100ms e sobrescrevendo a senha existente sem necessidade.

**Correção:** O seed agora verifica a existência do registro com um `SELECT id` antes de executar o `INSERT`. `hashSenha` só é chamado se o registro não existir (primeira inicialização):

```js
// DEPOIS:
const _gestorExiste = await pool.query('SELECT id FROM clientes WHERE email=$1', [...]);
if (!_gestorExiste.rows.length) {
  await pool.query(`INSERT INTO clientes (...) VALUES (...)`, [..., hashSenha(ADMIN_PASS)]);
}
```

**Comportamento nos restarts normais:** apenas um `SELECT id` rápido — sem `scryptSync`, sem escrita no banco.

**Como atualizar a senha quando `ADMIN_PASS` mudar no `.env`:**
```sql
DELETE FROM clientes WHERE email='fandradepereirasousa@gmail.com';
-- Em seguida: pm2 restart felogix
```
O servidor recria o registro com a nova senha no próximo start.

---

## Como foi verificado

| Verificação | Método | Resultado |
|---|---|---|
| `VAPID_PRIVATE_KEY` não aparece em logs | `grep VAPID_PRIVATE_KEY server.js` — nenhum `console.*` com o valor | ✅ Confirmado |
| Somente `VAPID_PUBLIC_KEY` é logada | Leitura do bloco linhas 36–43 | ✅ Confirmado |
| `hashSenha` não executado em restart com registro existente | Lógica de guarda `if (!_gestorExiste.rows.length)` isolando o `scryptSync` | ✅ Confirmado |
| Sem regressão no seed do checklist | O bloco seguinte (`INSERT INTO fleet_checklist_itens`) não foi alterado e depende apenas da existência de `clientes`, não da linha de seed | ✅ Confirmado |
| Sem regressão no login do gestor | `verificarSenhaLogin` e `hashSenha` intactos; a senha gravada no primeiro start continua válida | ✅ Confirmado |
| Sem regressão no push | `webpush.setVapidDetails` usa `VAPID_PRIVATE_KEY` normalmente; remoção foi apenas do log | ✅ Confirmado |

---

## Riscos remanescentes

| # | Severidade | Descrição | Ação |
|---|---|---|---|
| MÉDIO-1 | 🟡 Médio | Push HTTP calls no broadcast loop de 5s | Sprint 2/3 |
| MÉDIO-2 | 🟡 Médio | N+1 queries em `getPosicoesEnriquecidas` a cada 5s | Sprint 3 |
| MÉDIO-3 | 🟡 Médio | `liveErrCount` não resetado no `ws.onopen` | Sprint 2 |
| MÉDIO-4 | 🟡 Médio | `felogixConfirm` sem suporte a teclado (Escape/focus-trap) | Sprint 2 |
| BAIXO-1 | 🔵 Baixo | Service worker com `skipWaiting` sem estratégia de cache | Aceitável por ora |
| BAIXO-2 | 🔵 Baixo | `openBS(selV)` chamado incondicionalmente em `applyPosicoes` | Sprint 3 |
| BAIXO-3 | 🔵 Baixo | `SELECT *` em `alterar-senha` | Cleanup futuro |

Nenhum dos riscos remanescentes é bloqueante para o merge.

---

## Veredito final

### ✅ Pronto para merge em `main`

Os dois únicos bloqueantes identificados na revisão de produção (`PRODUCTION-REVIEW.md`) foram corrigidos:

- **ALTO-1** — VAPID_PRIVATE_KEY removida dos logs ✅
- **ALTO-2** — `hashSenha(ADMIN_PASS)` não executa mais em restarts normais ✅

A Sprint 1 (B1–B5 + R1–R3 + S1–S3 + O1–O2 + Push Notifications) está completa e a branch pode ser mergeada com segurança em `main` para validação com o hardware GT06.

---

*Gerado em `claude/felogix-dev-assistant-macmsv` @ 2026-07-01*
