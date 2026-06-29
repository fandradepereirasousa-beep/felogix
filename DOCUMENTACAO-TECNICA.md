# Felogix — Documentação Técnica Completa

> Gerado em 2026-06-29. Reflete o estado real do código em `main` no momento da escrita (commit `57eda2a`). Este documento descreve, não prescreve — para decisões arquiteturais e regras de negócio que devem ser seguidas em trabalho futuro, ver `FELOGIX-SPEC.md`.

---

## 1. Estrutura de pastas do projeto

```
.
├── .env                  # variáveis de ambiente (não versionado em produção real; existe local)
├── .env.example           # template das variáveis esperadas
├── FELOGIX-SPEC.md         # especificação arquitetural das 4 verticais (fonte da verdade de produto)
├── TRACCAR-SETUP.md        # guia de setup do Traccar nativo no VPS (GPS/GT06)
├── felogix.html            # cópia/rascunho histórico do front-end (não servido pela app)
├── package.json / package-lock.json
├── server.js               # backend único: Express + WebSocket + todas as rotas e regras de negócio
├── server.log              # log de execução local (gerado em runtime, não versionado)
└── public/
    ├── index.html           # SPA único (vanilla JS) que atende Track, Fleet, Connect e Patrol
    └── uploads/              # fotos enviadas via multer (veículos, pessoas/compartilhamentos)
```

Não há `src/`, build step, bundler ou framework de front-end — o `public/index.html` é servido como arquivo estático e contém HTML+CSS+JS inline em um único arquivo.

---

## 2. Tecnologias utilizadas

**Backend** (`package.json`, versão `2.3.0`):
- Node.js + **Express 4** — servidor HTTP e roteamento
- **pg** (node-postgres) — acesso direto ao PostgreSQL via SQL cru (sem ORM/query builder)
- **ws** — servidor WebSocket nativo (`/ws`) para posições em tempo real
- **jsonwebtoken** — autenticação stateless via JWT
- **multer** — upload de arquivos (fotos de veículos/pessoas)
- **nodemailer** — envio de e-mail (cobrança financeira e recuperação de senha)
- **cors**, **dotenv**

**Frontend**: HTML + CSS + JavaScript vanilla (sem framework, sem build step), Leaflet.js para o mapa (tiles OpenStreetMap).

**Infraestrutura externa**:
- **PostgreSQL** local na VPS (banco `felogix`)
- **Traccar** (servidor GPS open-source) rodando nativamente na mesma VPS, recebendo dados dos rastreadores via protocolo GT06 (TCP 5023) e expondo API REST (porta 8082) consumida pelo `server.js`
- **PM2** — gerenciador de processo em produção (`felogix-server`)
- **GitHub Actions** — CI/CD (deploy via SSH para a VPS a cada push em `main`)

---

## 3. Banco de dados (tabelas e relacionamentos)

Todo o schema é criado/migrado em `initDB()` (`server.js`, a partir da linha ~803) via `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (migração idempotente, sem ferramenta de migração dedicada).

### Núcleo (multi-tenant por cliente)
- **`clientes`** — tenant raiz. `tipo` (`cpf`/`cnpj`), `documento`, `nome`, `email`, `senha` (texto plano — ver observação de segurança abaixo), `plano`, `valor_plano`, `dia_vencimento`, `cobranca_modo`, `ativo`, `tentativas_login`/`bloqueado_ate` (rate-limit de login), `telefone`, `endereco`.
- **`veiculos`** — `cliente_id → clientes`. `placa` (única), `imei` (nulo = "sem rastreador"), `modelo`, `ano`, `cor`, `foto`, `bloqueado`, `traccar_device_id` (vínculo real com o Traccar), `compartilhamento_id` (nulo na maioria dos casos).
- **`colaboradores`** — funcionários criados por um cliente CNPJ (gestor). `cliente_id`, `grupo_id → grupos_veiculos` (escopo de visibilidade), credenciais próprias, mesmo mecanismo de bloqueio por tentativas que `clientes`.
- **`grupos_veiculos`** / **`grupo_veiculos_itens`** — agrupamento de veículos por cliente, usado para restringir o que cada colaborador vê.

### Track (rastreamento veicular)
- **`alertas_prefs`** — preferências de alerta por cliente (`velocidade`, `bloqueio`, `geocerca`, `offline`, `horario`).
- **`alertas_eventos`** — eventos reais disparados pelo motor de alertas (`tipo`, `mensagem`, `lido`), por `cliente_id`/`veiculo_id`.
- **`geocercas`** — cercas circulares (`latitude`, `longitude`, `raio_m`); `veiculo_id` nulo = aplica à frota toda do cliente.

### Connect (compartilhamento de localização tipo Life360)
- **`grupos_rastreamento`** — círculos/grupos privados por cliente.
- **`rastreadores_compartilhados`** — pessoas/dispositivos rastreados via GPS do navegador/celular (token público, foto, senha opcional, posição atual).
- **`posicoes_historico`** — trilha histórica de posições de um `compartilhamento_id`.

### Fleet (checklist e controle de custos)
- **`fleet_checklist_itens`** — template de itens de checklist por cliente (`nome`, `ordem`, `ativo`).
- **`fleet_checklist_execucoes`** — execuções de checklist por veículo (`tipo` pré/pós, `itens` em JSONB, `tem_problema`).

> Nota arquitetural relevante: estas duas tabelas são vinculadas só por `cliente_id`/`veiculo_id`, sem nenhum filtro por `imei`/`tipo` do veículo. Isso significa que checklist/controle de custos funciona para **qualquer** veículo, com ou sem rastreador.

### Patrol (rondas)
- **`patrol_pontos`** — pontos de ronda fixos (`latitude`, `longitude`, `raio_metros`).
- **`patrol_checkins`** — check-ins de vigilante em um ponto, vinculados a `compartilhamento_id` (a "pessoa" rastreada via Connect), com distância calculada e `dentro_raio`.

### Financeiro / operacional
- **`pagamentos`** — cobrança mensal por cliente (`mes_ref`, `valor`, `pago`, `enviado_em`).
- **`emails_log`** — histórico de e-mails de cobrança efetivamente enviados.
- **`config`** — chave/valor genérico (templates de e-mail, baseline de cobrança automática).
- **`logs_acesso`** — log de tentativas de login (sucesso/falha, IP, e-mail).

Todas as FKs usam `ON DELETE CASCADE` (ou `SET NULL` quando a referência é opcional), então excluir um cliente limpa toda sua árvore de dados automaticamente.

---

## 4. Módulos existentes

O sistema é dividido em 4 produtos ("verticais"), todos servidos pelo mesmo backend/frontend, diferenciados em runtime por `APP_MODE` (derivado de `location.pathname` no cliente):

1. **Track** — rastreamento veicular via hardware GPS (Traccar).
2. **Fleet** — controle de custos/checklist de frota, independente de rastreamento.
3. **Connect** — compartilhamento de localização entre pessoas (estilo Life360), sem hardware.
4. **Patrol** — rondas de segurança/vigilância com check-in por geocerca.

Cada produto tem sua própria rota (`/track`, `/fleet`, `/connect`, `/patrol`), mas todas servem o mesmo `public/index.html`, que ajusta navegação, abas e textos conforme `APP_MODE`.

Há também uma página seletora institucional (`/`) e páginas de produto genéricas (`/produtos/:slug`) com copy de marketing, geradas a partir do catálogo `PRODUTOS` em `server.js`.

---

## 5. Funcionalidades prontas

- Login multi-perfil: admin / gestor (cliente CPF ou CNPJ) / colaborador, com JWT (12h) e bloqueio por 5 tentativas falhas.
- CRUD completo de clientes, veículos, grupos de veículos e colaboradores, com escopo de visibilidade por role.
- Rastreamento em tempo real via WebSocket (posições do Traccar, broadcast a cada 5s) + histórico de trajeto.
- Bloqueio/desbloqueio real de ignição via Traccar (`engineStop`/`engineResume`) para veículos com IMEI.
- Motor de alertas (velocidade, offline, bloqueio) — eventos in-app, sem disparo automático de e-mail.
- Geofencing: criação de geocercas no mapa, motor de avaliação de entrada/saída, alerta in-app na transição.
- Compartilhamento de localização (Connect): grupos, convite por link/token, foto, senha opcional por pessoa, painel estilo Life360.
- Checklist de frota (Fleet): itens customizáveis por cliente, execução pré/pós-viagem por veículo, histórico, funciona com ou sem rastreador.
- Rondas (Patrol): cadastro de pontos com geocerca, check-in do vigilante validado por distância/raio, histórico por ponto.
- Financeiro: cobrança mensal manual (gera rascunho, calcula valor por plano/por veículo), envio de fatura por e-mail **somente sob ação manual do admin** (`POST /api/financeiro/enviar`), log de e-mails enviados.
- Upload de foto (multer) para veículos e pessoas compartilhadas.
- Lembrete interno (a cada 6h) avisando só o admin sobre faturas pendentes — nunca enviado ao cliente automaticamente.

---

## 6. Funcionalidades em desenvolvimento

Nenhuma feature está em desenvolvimento ativo neste momento — o backlog do Patrol (ver seção 7) é o próximo foco, mas ainda não iniciado.

---

## 7. Funcionalidades planejadas

Do pedido de evolução do **Felogix Patrol** (decisão: continuar incrementalmente no monólito atual, não reescrever em Next.js/Prisma/Socket.IO):

- Check-in por QR Code e por NFC (hoje só geocerca/GPS).
- Botão de pânico/SOS.
- Notificações push, WhatsApp e SMS (hoje só in-app).
- Sincronização offline (PWA) para áreas sem sinal.
- Chat entre vigilante/supervisor e central de monitoramento.
- Relatório de fechamento de plantão em PDF/Excel.
- RBAC de 5 níveis (Administrador/Supervisor/Operador/Vigilante/Cliente) — hoje há só admin/gestor/colaborador.
- Alertas de desvio de rota / geofence mais granulares para rondas veiculares.

Do Track (`FELOGIX-SPEC.md`):
- Alertas por horário (toggle já existe em `alertas_prefs.horario`, sem motor nem UI).

---

## 8. APIs existentes

Convenção: todas as rotas autenticadas exigem header `Authorization: Bearer <jwt>` (middleware `auth`); rotas marcadas `adminOnly` exigem `role === 'admin'`.

**Autenticação**
- `POST /api/login` — admin/gestor/colaborador
- `POST /api/esqueci-senha`, `POST /api/alterar-senha`, `GET /api/verify-token`

**Clientes** (`adminOnly`)
- `GET/POST /api/clientes`, `PUT/DELETE /api/clientes/:id`

**Veículos**
- `GET /api/veiculos`, `POST /api/veiculos` (adminOnly, upload de foto), `PUT/DELETE /api/veiculos/:id`
- `GET /api/veiculos/:id/historico`

**Fleet — Checklist**
- `GET/POST /api/fleet/checklist-itens`, `PUT/DELETE /api/fleet/checklist-itens/:id`
- `POST/GET /api/fleet/checklist-execucoes`

**Patrol — Rondas**
- `GET/POST /api/patrol/pontos`, `PUT/DELETE /api/patrol/pontos/:id`
- `GET /api/patrol/checkins`

**Equipe (Track CNPJ)**
- `GET/POST /api/grupos-veiculos`, `GET /api/grupos-veiculos/:id/veiculos`, `PUT/DELETE /api/grupos-veiculos/:id`
- `GET/POST /api/colaboradores`, `PUT/DELETE /api/colaboradores/:id`

**Posições / Traccar**
- `GET /api/posicoes`
- `POST /api/traccar/sync` (adminOnly), `GET /api/traccar/status` (adminOnly)

**Connect — Compartilhamentos**
- `POST/GET /api/compartilhamentos`, `DELETE /api/compartilhamentos/:id`
- `POST/DELETE /api/compartilhamentos/:id/senha`
- `POST /api/compartilhamentos/:token/location` (pública — recebe GPS do navegador)
- `GET /api/compartilhamentos/:id/historico`
- `GET/POST /api/grupos`, `DELETE /api/grupos/:id`, `GET/POST /api/grupos/:id/pessoas`

**Página pública `/track/:token`**
- `GET /track/:token` (HTML), `POST /api/track/:token/login`
- `PUT /api/track/:token/perfil`, `GET /api/track/:token/grupo`, `GET /api/track/:token/pontos-proximos`, `POST /api/track/:token/checkin`

**Alertas e geocercas**
- `GET/PUT /api/alertas`, `GET /api/alertas/eventos`
- `GET/POST /api/geocercas`, `PUT/DELETE /api/geocercas/:id`

**Financeiro** (`adminOnly`)
- `GET /api/financeiro`, `POST /api/financeiro/cobrar`, `POST /api/financeiro/pago`
- `GET /api/financeiro/rascunhos`, `POST /api/financeiro/enviar` (**único disparo de e-mail manual de cobrança**), `GET /api/financeiro/emails`

**Outros**
- `GET /api/health` — health check usado pelo deploy CI/CD

---

## 9. Sistema de login e permissões

Três roles, todos emitidos como JWT (12h) com `role` no payload:

| Role | Origem | Escopo |
|---|---|---|
| `admin` | credencial fixa (`ADMIN_EMAIL`/`ADMIN_PASS`, env) | acesso total a todos os clientes/produtos |
| `gestor` | tabela `clientes` (CPF ou CNPJ) | seus próprios dados; se CNPJ, pode criar colaboradores/grupos |
| `colaborador` | tabela `colaboradores`, criado por um gestor CNPJ | só os veículos do `grupo_id` ao qual foi atribuído |

Há ainda um quarto "perfil" sem JWT próprio: o acesso público via `/track/:token` (pessoa de um grupo Connect/Patrol), autenticado por token de URL + senha opcional por pessoa.

Proteção contra brute-force: 5 tentativas erradas bloqueiam a conta por 15 minutos (`tentativas_login`/`bloqueado_ate`, em `clientes` e `colaboradores`). Há também rate-limit por IP em `/api/login` (10/min), `/api/esqueci-senha` (3/5min) e `/api/track/:token/login` (10/min).

**Observação de segurança**: senhas (`clientes.senha`, `colaboradores.senha`) são armazenadas em texto plano, comparadas com `===`. Não é hash/bcrypt. Isso é uma dívida técnica pré-existente, não nova — sinalizada aqui para visibilidade, sem ação automática (mudar o esquema de senha quebraria logins existentes e exigiria migração coordenada).

---

## 10. Arquitetura do sistema

Monólito clássico, deploy único:

```
┌─────────────────────────────────────────────┐
│ VPS (produção)                               │
│  ┌─────────────┐   ┌─────────────────────┐  │
│  │ PostgreSQL  │←──│ server.js (PM2)     │  │
│  │ (felogix)   │   │ Express + ws (8082) │  │
│  └─────────────┘   │ porta 3000 (local)  │  │
│                     └──────────┬──────────┘  │
│  ┌─────────────┐               │             │
│  │ Traccar     │←── GT06/TCP   │ HTTP+WS     │
│  │ (GPS nativo)│    5023       │ via Nginx   │
│  └─────────────┘               ↓             │
└─────────────────────────────────────────────┘
                          felogix.com.br (HTTPS)
```

- Um único processo Node (`server.js`) serve API REST, WebSocket e os arquivos estáticos do SPA.
- PostgreSQL e Traccar rodam na mesma VPS, acessados via `localhost`.
- Nginx (fora deste repo) faz proxy/TLS na frente da porta 3000.
- Não há fila de mensagens, cache distribuído, microsserviços ou containers em produção — tudo roda como processo Node único gerenciado por PM2.

---

## 11. Como os módulos se comunicam

- **Track ↔ Traccar**: `server.js` faz polling HTTP da API do Traccar (`sincronizarVeiculosTraccar`, a cada 5min, e busca de posições a cada 5s via `broadcastPosicoes`) e traduz para o WebSocket próprio (`/ws`) que o front-end consome.
- **Fleet ↔ Track**: compartilham a mesma tabela `veiculos`; Fleet (checklist) não depende de o veículo ter `imei` ou não — é uma camada independente sobre o mesmo registro de veículo.
- **Connect ↔ Patrol**: Patrol reusa a infraestrutura de "pessoa rastreada" do Connect (`rastreadores_compartilhados`/`compartilhamento_id`) como identidade do vigilante — um check-in de ronda (`patrol_checkins`) referencia o `compartilhamento_id` de quem fez o check-in.
- **Frontend ↔ Backend**: um único SPA (`public/index.html`) detecta `APP_MODE` pela URL e ajusta nav/abas/textos; toda comunicação é REST (`api()`/`apiUpload()` helpers) + um único canal WebSocket compartilhado entre os 4 produtos (mensagens diferenciadas por `msg.type`).

---

## 12. Prints ou descrição das telas

Não há prints neste documento (fora do escopo "sem gerar código/artefatos visuais"). Descrição funcional das telas principais do SPA, por aba:

- **Login** — formulário único, detecta role pela resposta da API.
- **Mapa** (Track/Connect/Patrol) — mapa Leaflet com veículos/pessoas, painel lateral com lista, last-seen, trilha histórica, zoom-to-fit.
- **Clientes** (admin) — tabela com CRUD, toggle ativo/inativo, configuração de cobrança.
- **Veículos** — tabela com CRUD, modal de cadastro com escolha "IMEI" vs "sem rastreador" (com aviso explicando que IMEI cobre rastreamento + custos), botão de bloqueio/desbloqueio para veículos com IMEI.
- **Checklist** (Fleet) — itens configuráveis + execução pré/pós-viagem + histórico por veículo.
- **Alertas** — preferências (toggles) e lista de eventos disparados.
- **Geocercas** (Track) — desenho de cerca circular no mapa + CRUD.
- **Pontos de ronda** (Patrol) — cadastro de ponto com raio + histórico de check-ins.
- **Equipe** (Track CNPJ) — grupos de veículos + colaboradores.
- **Compartilhamentos / Grupos** (Connect/Patrol) — grupos, pessoas, senha por pessoa, link de convite.
- **Financeiro** (admin) — rascunho de cobrança mensal, envio manual de fatura por e-mail, histórico de envios.
- **Página pública `/track/:token`** — perfil da pessoa, lista do grupo estilo Life360, check-in de ronda (Patrol).

---

## 13. Lista de rotas

**Páginas (HTML)**: `/`, `/track`, `/fleet`, `/connect`, `/patrol`, `/produtos/:slug`, `/track/:token`

**API**: ver seção 8 (lista completa de endpoints REST).

**WebSocket**: `/ws?token=<jwt>` — canal único, mensagens tipadas (`posicao`, `compartilhamento`, etc.), escopadas por role no servidor (colaborador só recebe veículos do seu grupo).

---

## 14. Componentes reutilizáveis

Não há componentização formal (sem framework de UI), mas o front-end tem helpers reutilizados entre todos os produtos:

- `api(method, path, body)` / `apiUpload(method, path, formData)` — wrapper de fetch com JWT automático e timeout/retry.
- `fetchComTimeout` — fetch com timeout configurável.
- `thumbHtml(foto, emoji, size)` — avatar/thumbnail padronizado (foto ou emoji fallback).
- `escHtml` — sanitização de texto antes de injetar em HTML (proteção básica contra XSS em campos livres).
- `buildNav()` / `goTab()` — navegação por abas, adaptada por `APP_MODE` e `role`.
- `initMap()` / `addMkr()` / `syncMkrs()` / `centerAll()` — ciclo de vida do mapa Leaflet, compartilhado por Track/Connect/Patrol.
- `connectWS()` / `disconnectWS()` — gestão do canal WebSocket único.
- Modais de mini-mapa para desenhar raio/geocerca (`gcInitMiniMap`/`prInitMiniMap`) — mesmo padrão usado em Geocercas (Track) e Pontos de Ronda (Patrol).

No backend, `auth`/`adminOnly` (middlewares) e `rateLimit(max, windowMs)` são os únicos "componentes" reutilizados entre rotas.

---

## 15. Serviços em background

Todos rodam como `setInterval` dentro do próprio processo Node (sem worker separado, sem cron do sistema, sem fila):

| Serviço | Frequência | Função |
|---|---|---|
| `broadcastPosicoes` | 5s | Busca posições atuais (Traccar + compartilhamentos), avalia alertas/geocercas, envia via WebSocket |
| `sincronizarVeiculosTraccar` | 5min | Sincroniza lista de dispositivos do Traccar com `veiculos.traccar_device_id` |
| `verificarLembreteMensal` | 6h (+ 1x no startup) | Avisa **só o admin**, in-app, sobre faturas do mês pendentes de revisão — nunca envia nada ao cliente |
| `loadGrupo` / `loadPontos` (frontend, página `/track/:token`) | 15s | Refresh de lista de pessoas do grupo / pontos de ronda próximos |

---

## 16. Integrações externas

- **Traccar** — servidor GPS open-source, rodando nativamente na mesma VPS. `server.js` consome sua API REST (autenticação básica via `TRACCAR_USER`/`TRACCAR_PASS`) para listar dispositivos, posições e enviar comandos (`engineStop`/`engineResume`).
- **SMTP (nodemailer)** — envio de e-mail. Único uso de disparo automático pré-existente: `/api/esqueci-senha` e `POST /api/clientes` (e-mail de boas-vindas no cadastro). Todo o resto do fluxo financeiro é **manual** (`POST /api/financeiro/enviar`), por política explícita do projeto — proibido automatizar envio de e-mail sem autorização.
- **OpenStreetMap (tiles)** — usado pelo Leaflet no front-end, sem chave de API.
- **GitHub Actions** — CI/CD: deploy via SSH (`appleboy/ssh-action`) a cada push em `main`, com health-check pós-deploy (`/api/health`).

Não há integração com gateway de pagamento, WhatsApp/SMS, push notification ou serviço de mapas pago (Google Maps/Mapbox) hoje — todos planejados (ver seção 7), nenhum implementado.

---

## 17. Como está organizado o código

- **`server.js`** (~2900 linhas) — arquivo único contendo: setup do Express/WS, definição de schema (`initDB`), middlewares (`auth`, `adminOnly`, `rateLimit`), motor de alertas/geofencing, todas as rotas REST, lógica de e-mail/financeiro, e o catálogo de produtos (`PRODUTOS`) usado nas páginas de marketing. Não há separação em controllers/services/models — tudo inline, em ordem aproximadamente cronológica de quando cada feature foi adicionada.
- **`public/index.html`** (~2900 linhas) — SPA único: CSS inline no `<head>`, HTML dos modais/telas, e todo o JS (sem módulos ES, sem bundler) em um `<script>` no final. Funções organizadas por feature (Clientes, Veículos, Checklist, Alertas, Geocercas, Patrol, Compartilhamentos, Equipe, Financeiro), não por camada técnica.
- Não há testes automatizados versionados no repositório — testes são escritos ad-hoc (Playwright) durante o desenvolvimento de cada feature e descartados após validar, não fazem parte do CI.
- **`FELOGIX-SPEC.md`** é o documento de decisão de produto/arquitetura (o que cada vertical deve fazer, o que já foi feito, regras como "proibido e-mail automático"). Este documento (`DOCUMENTACAO-TECNICA.md`) é o retrato técnico do que existe; `FELOGIX-SPEC.md` é a fonte da verdade de **o que deve ser construído**.

---

## 18. O que ainda falta para o projeto ficar pronto

- **Patrol**: QR/NFC checkin, SOS, push/WhatsApp/SMS, sync offline (PWA), chat, relatório PDF/Excel, RBAC de 5 níveis (ver seção 7).
- **Track**: alertas por horário (toggle existe, sem motor/UI).
- **Segurança**: senhas em texto plano (`clientes`/`colaboradores`) — migração para hash é dívida técnica conhecida, não programada por exigir coordenação (invalida sessões/senhas atuais).
- **Testes**: nenhuma suíte automatizada permanente (CI roda só deploy, sem testes).
- **Connect como vertical própria**: hoje vive tecnicamente dentro do namespace do Track (`/track/:token`, tabelas `grupos_rastreamento`/`rastreadores_compartilhados`); decisão de produto pendente sobre separar de fato ou manter como está (registrada em `FELOGIX-SPEC.md`).
- **Felogix Hub / SSO unificado** entre os 4 produtos — mencionado como visão futura, não iniciado.

---

## 19. Roadmap sugerido

1. **Curto prazo** — fechar os gaps pontuais já mapeados: alertas por horário (Track), e decidir/separar Connect como vertical própria.
2. **Patrol incremental** (decisão tomada: sem reescrita em stack nova) — nesta ordem sugerida, por valor/risco:
   - QR Code checkin (reaproveita UI de geocerca já existente, baixo risco)
   - Relatório de fechamento de plantão em PDF (alto valor percebido pelo cliente, sem dependência de infra nova)
   - Notificações push (substitui parte do "SOS"/alertas urgentes sem precisar de WhatsApp/SMS pago)
   - SOS / botão de pânico
   - Sync offline (PWA) — mais complexo, deixar para depois de validar o restante
   - Chat e RBAC de 5 níveis — maior escopo, avaliar demanda real antes de construir
3. **Médio prazo** — avaliar hashing de senha com plano de migração (forçar reset coordenado) e introduzir alguma suíte de testes mínima no CI antes de cada deploy.
4. **Longo prazo** — Felogix Hub/SSO entre as 4 verticais, se o crescimento de clientes com múltiplos produtos justificar.

Este roadmap é uma sugestão técnica, não um compromisso de prazo — prioridades reais devem ser validadas com o usuário/dono do produto antes de iniciar qualquer item.
