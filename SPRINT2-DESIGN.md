# SPRINT2-DESIGN.md

**Sprint 2 — Comercial: Design e Especificação**
**Branch base:** `main` (commit `0c52d09`)
**Versão:** Pré-piloto (atualizar após bugs do GT06)

---

## Visão geral

A Sprint 1 entregou a plataforma operacional. A Sprint 2 transforma o Felogix em uma **plataforma de gestão de rastreamento** — capaz de suportar clientes reais, contratos, equipamentos em campo e receita recorrente.

Quatro módulos em ordem de prioridade de negócio:

| # | Módulo | Bloqueia | Sprint |
|---|---|---|---|
| 1 | Equipamentos | Segunda instalação | 2 |
| 2 | Cadastro de cliente completo | Contrato / nota fiscal | 2 |
| 3 | Financeiro básico | Controle de receita | 2 |
| 4 | Dashboard comercial | Visão de negócio | 2 (posterior) |
| 5 | Instalações com fotos | Histórico de campo | 3 |

---

## Módulo 1 — Equipamentos

### Por que é o mais urgente

Hoje o IMEI é uma propriedade do veículo (`veiculos.imei`). Isso quebra no momento em que:
- Um rastreador defeituoso precisa ser substituído
- O mesmo rastreador é instalado em outro veículo
- Um rastreador está em estoque aguardando instalação
- É necessário saber qual chip/operadora está em qual veículo

### Schema proposto

```sql
CREATE TABLE equipamentos (
  id              SERIAL PRIMARY KEY,
  modelo          VARCHAR(100) NOT NULL,           -- GT06, GT06N, etc.
  imei            VARCHAR(20) UNIQUE NOT NULL,
  iccid           VARCHAR(25),                     -- número do SIM card
  operadora       VARCHAR(50),                     -- Claro, Vivo, Tim, etc.
  numero_chip     VARCHAR(20),
  firmware        VARCHAR(50),
  data_compra     DATE,
  garantia_ate    DATE,
  custo           NUMERIC(10,2),
  status          VARCHAR(20) NOT NULL DEFAULT 'estoque',
    -- estoque | instalando | instalado | manutencao | removido | perdido
  cliente_id      INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  veiculo_id      INTEGER REFERENCES veiculos(id) ON DELETE SET NULL,
  instalador      VARCHAR(100),
  data_instalacao DATE,
  observacoes     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON equipamentos(imei);
CREATE INDEX ON equipamentos(status);
CREATE INDEX ON equipamentos(cliente_id);
CREATE INDEX ON equipamentos(veiculo_id);
```

### Migração do campo `veiculos.imei`

O campo `veiculos.imei` **não é removido** — continua sendo o vínculo com o Traccar. O novo `equipamentos.veiculo_id` é o vínculo de gestão. Os dois coexistem:

```
equipamentos.imei → Traccar (protocolo GT06)
equipamentos.veiculo_id → veiculos (gestão)
veiculos.imei → Traccar (existente, mantido)
```

Na instalação de um equipamento em um veículo, o sistema copia `equipamentos.imei` → `veiculos.imei` automaticamente. Na remoção, `veiculos.imei` é zerado.

### Endpoints

```
GET    /api/equipamentos              → lista (filtros: status, cliente_id)
POST   /api/equipamentos              → cadastrar novo (adminOnly)
GET    /api/equipamentos/:id          → detalhe
PUT    /api/equipamentos/:id          → editar
DELETE /api/equipamentos/:id          → remover (só se status=estoque)
POST   /api/equipamentos/:id/instalar → instala em veiculo_id (muda status→instalado, copia imei→veiculos)
POST   /api/equipamentos/:id/remover  → desvincula do veículo (status→estoque ou manutencao)
```

### UI (nova aba "Equipamentos" no admin)

**Cards por status com filtro:**
- Resumo: `X em estoque · Y instalados · Z em manutenção`
- Card por equipamento: modelo, IMEI (truncado), operadora, status badge, cliente/veículo atual
- Ações: Editar · Instalar em veículo · Remover · Ver histórico

**Instalar em veículo (modal):**
- Selecionar cliente → selecionar veículo do cliente
- Campo instalador + data
- Confirmar → `POST /api/equipamentos/:id/instalar`

**Estados de status (badges):**
```
estoque     → badge-gray    "Em estoque"
instalando  → badge-amber   "Instalando"
instalado   → badge-green   "Instalado"
manutencao  → badge-red     "Manutenção"
removido    → badge-offline "Removido"
perdido     → badge-red     "Perdido"
```

---

## Módulo 2 — Cadastro de cliente completo

### Schema — extensão da tabela `clientes`

```sql
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS tipo_pessoa     VARCHAR(10) DEFAULT 'pf',  -- pf | pj
  ADD COLUMN IF NOT EXISTS razao_social    VARCHAR(200),
  ADD COLUMN IF NOT EXISTS nome_fantasia   VARCHAR(200),
  ADD COLUMN IF NOT EXISTS documento      VARCHAR(20),   -- CPF ou CNPJ (já existe como 'documento')
  ADD COLUMN IF NOT EXISTS inscricao_estadual VARCHAR(20),
  ADD COLUMN IF NOT EXISTS responsavel    VARCHAR(150),
  ADD COLUMN IF NOT EXISTS whatsapp       VARCHAR(20),
  ADD COLUMN IF NOT EXISTS cep            VARCHAR(9),
  ADD COLUMN IF NOT EXISTS logradouro     VARCHAR(200),
  ADD COLUMN IF NOT EXISTS numero         VARCHAR(20),
  ADD COLUMN IF NOT EXISTS complemento    VARCHAR(100),
  ADD COLUMN IF NOT EXISTS bairro         VARCHAR(100),
  ADD COLUMN IF NOT EXISTS cidade         VARCHAR(100),
  ADD COLUMN IF NOT EXISTS estado         CHAR(2);
```

> Nota: `documento` já existe. `telefone` e `endereco` já existem (Sprint 1). Os novos campos complementam sem quebrar o existente.

### Lookup de CEP

Integração com ViaCEP (sem chave de API, sem custo):
```js
// No frontend, ao sair do campo CEP:
async function buscarCep(cep) {
  const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
  const d = await r.json();
  if (!d.erro) {
    document.getElementById('eLogradouro').value = d.logradouro;
    document.getElementById('eBairro').value = d.bairro;
    document.getElementById('eCidade').value = d.localidade;
    document.getElementById('eEstado').value = d.uf;
  }
}
```

### UI — formulário expandido em `openEditCliente`

Organizado em seções colapsáveis para não sobrecarregar a tela:

```
[Dados principais]   Nome / Razão Social / Nome Fantasia
[Documento]          CPF ou CNPJ · IE (opcional)
[Contato]            Responsável · Telefone · WhatsApp · Email
[Endereço]           CEP (com auto-preenchimento) · Rua · Número · Complemento · Bairro · Cidade · UF
[Plano]              (já existe — sem alteração)
```

---

## Módulo 3 — Financeiro básico

### O que já existe

- Tabela `cobrancas` com `cliente_id`, `mes_ref`, `valor`, `status`
- Endpoint `POST /api/financeiro/enviar` com envio de e-mail
- UI de cobranças com seleção de clientes e envio em lote

### O que falta

#### 3a — Status de pagamento por cobrança

```sql
ALTER TABLE cobrancas
  ADD COLUMN IF NOT EXISTS status_pgto   VARCHAR(20) DEFAULT 'pendente',
    -- pendente | pago | vencido | isento | cancelado
  ADD COLUMN IF NOT EXISTS data_vencimento DATE,
  ADD COLUMN IF NOT EXISTS data_pagamento  DATE,
  ADD COLUMN IF NOT EXISTS comprovante_url TEXT,
  ADD COLUMN IF NOT EXISTS observacoes    TEXT;
```

Endpoints:
```
PUT /api/financeiro/cobrancas/:id/pago      → marca como pago + data_pagamento
PUT /api/financeiro/cobrancas/:id/vencido   → marca como vencido
GET /api/financeiro/cobrancas?status=pendente&mes_ref=2026-07  → filtros
```

#### 3b — Bloqueio automático por inadimplência

No `server.js`, job diário (pode usar `setInterval` de 24h no startup):

```js
// Roda 1x/dia: verifica cobranças vencidas há mais de X dias
// e seta veiculos.bloqueado = true para o cliente
```

Configurável por cliente: `clientes.dias_tolerancia` (default: 5).

#### 3c — Dashboard financeiro (tela Financeiro expandida)

Quatro KPI cards no topo:
```
MRR          → soma de cobrancas com status_pgto='pago' no mês atual
A vencer      → soma pendentes com data_vencimento >= hoje
Vencidas      → soma pendentes com data_vencimento < hoje
Isentos       → count clientes plano=cortesia
```

Tabela abaixo: cliente · plano · valor · vencimento · status · ações (Marcar pago / Ver comprovante)

---

## Módulo 4 — Dashboard comercial (admin)

Nova tela `/admin/dashboard` ou nova aba "Dashboard":

### KPIs

```
Clientes ativos        → clientes WHERE ativo=true AND plano != 'cortesia'
Clientes em teste      → clientes WHERE plano='track' AND created_at > NOW()-'30 days'
Clientes cortesia      → clientes WHERE plano='cortesia'
Veículos monitorados   → count(veiculos) WHERE ativo=true AND imei IS NOT NULL
Rastreadores instalados → count(equipamentos) WHERE status='instalado'
Rastreadores em estoque → count(equipamentos) WHERE status='estoque'
MRR                    → (calculado via cobrancas)
Ticket médio           → MRR / clientes_ativos
```

### Gráficos (Chart.js — já disponível ou incluir via CDN)

- **Receita mensal** — barras dos últimos 6 meses (pago vs previsto)
- **Clientes por plano** — pizza (cortesia / track / personalizado)
- **Novos clientes** — linha dos últimos 3 meses

---

## Ordem de implementação recomendada

```
Sprint 2A (2–3 dias de dev):
  [1] Migration: tabela equipamentos
  [2] CRUD backend equipamentos (7 endpoints)
  [3] UI admin: aba Equipamentos
  [4] Fluxo instalar/remover (vincula imei↔veiculo)

Sprint 2B (1–2 dias de dev):
  [5] Migration: colunas extras em clientes
  [6] Lookup CEP no frontend (ViaCEP)
  [7] Formulário de cliente expandido

Sprint 2C (2 dias de dev):
  [8] Migration: status_pgto + datas em cobrancas
  [9] Endpoints de pagamento
  [10] UI Financeiro expandida com KPIs e tabela de status

Sprint 2D (1 dia de dev):
  [11] Dashboard comercial (KPIs + gráficos)
```

**Total estimado: 6–8 dias de desenvolvimento**, assumindo bugs do piloto já resolvidos antes de iniciar.

---

## Dependências e riscos

| Risco | Mitigação |
|---|---|
| Migration `clientes` pode conflitar com coluna `documento` existente | Usar `ADD COLUMN IF NOT EXISTS` — idempotente |
| ViaCEP pode estar offline | Campo CEP com fallback manual; não bloquear submit |
| Bloqueio automático por inadimplência pode bloquear cliente erroneamente | Testar com `dias_tolerancia=999` inicialmente; habilitar manualmente por cliente |
| `veiculos.imei` zerado ao remover equipamento pode perder histórico no Traccar | `posicoes_historico` já está gravado — histórico preservado |

---

## O que NÃO entra na Sprint 2

- Instalações com fotos (Sprint 3 — requer upload mobile em campo)
- Boleto / PIX automático (Sprint 3 — requer integração com gateway de pagamento)
- App mobile nativo (fora do escopo atual)
- Multi-tenant completo (arquitetura atual suporta o modelo atual)

---

## Pré-condição para iniciar a Sprint 2

**Relatório de bugs do piloto GT06 recebido e corrigido.**

Seguir `TRACK-HARDWARE-TEST.md`. Bugs de hardware têm prioridade sobre funcionalidades comerciais — um cliente real vai descobrir um bug de GPS antes de precisar de um dashboard de MRR.

---

*Design gerado em `main` @ 2026-07-02 — revisar após piloto antes de implementar*
