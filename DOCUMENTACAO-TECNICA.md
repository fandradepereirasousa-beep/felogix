# Felogix — Documentação Técnica Completa

> Atualizado em 2026-06-30. Reflete o estado real do código em `main` no momento da escrita (commit `907fcfb`). Este documento descreve, não prescreve — para decisões arquiteturais e regras de negócio que devem ser seguidas em trabalho futuro, ver `FELOGIX-SPEC.md`.

---

## 1. Estrutura de pastas do projeto

```
.
├── .env                        # variáveis de ambiente (não versionado; existe localmente e na VPS via PM2)
├── .env.example                # template das variáveis esperadas
├── .github/
│   └── workflows/
│       ├── deploy.yml          # CI/CD: deploy via SSH a cada push em main
│       ├── setup-traccar.yml   # workflow auxiliar para setup do Traccar nativo na VPS
│       ├── diagnostico-porta-8082.yml
│       └── cleanup-traccar-docker.yml
├── DOCUMENTACAO-TECNICA.md     # este arquivo
├── FELOGIX-SPEC.md             # especificação arquitetural das 4 verticais (fonte da verdade de produto)
├── TRACCAR-SETUP.md            # guia de setup do Traccar nativo no VPS (GPS/GT06)
├── felogix.html                # cópia/rascunho histórico do front-end (não servido pela app)
├── package.json / package-lock.json
├── server.js                   # backend único: Express + WebSocket + todas as rotas e regras de negócio (~3226 linhas)
├── server.log                  # log de execução local (gerado em runtime, não versionado)
└── public/
    ├── index.html              # SPA único (vanilla JS) — atende Track, Fleet, Connect e Patrol (~2651 linhas)
    └── uploads/                # fotos enviadas via multer (veículos, pessoas/compartilhamentos)
```

Não há `src/`, build step, bundler ou framework de front-end. O `public/index.html` é servido como arquivo estático e contém HTML + CSS + JS inline em um único arquivo.

---

## 2. Tecnologias utilizadas

**Backend** (`package.json`, versão `2.3.0`):

| Pacote | Versão | Uso |
|---|---|---|
| express | ^4.18.2 | servidor HTTP e roteamento |
| pg | ^8.10.0 | acesso ao PostgreSQL (SQL direto, sem ORM) |
| ws | ^8.14.2 | servidor WebSocket nativo (`/ws`) |
| jsonwebtoken | ^9.0.2 | autenticação stateless via JWT |
| multer | ^2.2.0 | upload de arquivos (fotos de veículos/pessoas) |
| nodemailer | ^6.9.7 | envio de e-mail (cobrança e recuperação de senha) |
| pdfkit | ^0.19.1 | geração de PDFs (relatório de fechamento de plantão) |
| qrcode | ^1.5.4 | geração de QR Codes (pontos de ronda do Patrol) |
| cors | ^2.8.5 | CORS headers |
| dotenv | ^16.3.1 | carregamento do .env |

**Frontend**: HTML + CSS + JavaScript vanilla (sem framework, sem build step). Biblioteca de mapa: **Leaflet.js** via CDN (cdnjs.cloudflare.com), com tiles OpenStreetMap. Sem TypeScript, sem npm no front-end.

**Infraestrutura externa**:
- **PostgreSQL** local na VPS (banco `felogix`)
- **Traccar** (servidor GPS open-source) rodando nativamente na mesma VPS, recebendo dados dos rastreadores via protocolo GT06 (TCP 5023) e expondo API REST (porta 8082)
- **PM2** — gerenciador de processo em produção (`felogix-server`)
- **Nginx** — proxy reverso e TLS (não gerenciado por este repo)
- **GitHub Actions** — CI/CD (deploy via SSH para a VPS a cada push em `main`)

---

## 3. Banco de dados (tabelas e relacionamentos)

Todo o schema é criado/migrado em `initDB()` (`server.js`, linha ~803) via `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (migração idempotente, sem ferramenta dedicada como Flyway/Liquibase). Basta reiniciar o servidor para aplicar novas colunas.

### Núcleo (multi-tenant por cliente)

**`clientes`** — tenant raiz.
- `id` SERIAL PK
- `tipo` VARCHAR(4) — `'cpf'` ou `'cnpj'`
- `documento` TEXT UNIQUE — CPF ou CNPJ
- `nome`, `email` UNIQUE, `senha` (texto plano — ver nota de segurança)
- `telefone`, `endereco`
- `plano` — `'cortesia'`, `'basico'`, `'avancado'`, `'premium'`
- `valor_plano` NUMERIC, `dia_vencimento` INT, `cobranca_modo` — `'fixo'` ou `'por_veiculo'`
- `ativo` BOOLEAN, `tentativas_login` INT, `bloqueado_ate` TIMESTAMPTZ
- `criado_em` TIMESTAMPTZ DEFAULT NOW()

**`veiculos`** — pertence a um `cliente_id`.
- `id`, `cliente_id` → clientes, `placa` UNIQUE, `imei` (NULL = sem rastreador), `modelo`, `ano`, `cor`, `foto`
- `bloqueado` BOOLEAN — estado atual de bloqueio de ignição
- `traccar_device_id` INT — vínculo real com dispositivo no Traccar
- `compartilhamento_id` INT → rastreadores_compartilhados (geralmente NULL)

**`colaboradores`** — funcionários de gestor CNPJ.
- `id`, `cliente_id` → clientes, `grupo_id` → grupos_veiculos (escopo de visibilidade)
- `nome`, `re` (registro), `senha` (texto plano), `ativo`
- `tentativas_login`, `bloqueado_ate` (mesmo mecanismo de rate-limit que clientes)

**`grupos_veiculos`** — agrupamento de veículos por cliente.
- `id`, `cliente_id`, `nome`, `criado_em`

**`grupo_veiculos_itens`** — muitos-para-muitos entre grupos e veículos.
- `grupo_id` → grupos_veiculos, `veiculo_id` → veiculos

---

### Track (rastreamento veicular)

**`alertas_prefs`** — preferências de alerta por cliente.
- `id`, `cliente_id` UNIQUE → clientes
- `velocidade` BOOLEAN, `bloqueio` BOOLEAN, `geocerca` BOOLEAN, `offline` BOOLEAN, `horario` BOOLEAN
- `email_alertas` TEXT (e-mail de alerta — não usado por envio automático; campo legado)

**`alertas_eventos`** — eventos reais disparados pelo motor de alertas.
- `id`, `cliente_id`, `veiculo_id`, `tipo` (velocidade/offline/bloqueio/geocerca), `mensagem`, `lido` BOOLEAN, `criado_em`

**`geocercas`** — cercas circulares por cliente.
- `id`, `cliente_id`, `nome`, `latitude`, `longitude` NUMERIC, `raio_m` INT
- `veiculo_id` INT (NULL = aplica a toda a frota do cliente)
- `ativo` BOOLEAN, `criado_em`

---

### Connect (compartilhamento de localização)

**`grupos_rastreamento`** — círculos/grupos privados por cliente.
- `id`, `cliente_id`, `nome`, `criado_em`

**`rastreadores_compartilhados`** — pessoas/dispositivos rastreados via GPS do navegador.
- `id`, `cliente_id`, `grupo_id` → grupos_rastreamento
- `token` TEXT UNIQUE — URL pública (`/track/:token`)
- `nome`, `foto`, `senha` (hash não usado — texto plano), `telefone`
- `latitude`, `longitude` NUMERIC, `ultima_atualizacao` TIMESTAMPTZ
- `ativo` BOOLEAN, `criado_em`

**`posicoes_historico`** — trilha histórica de posições de um compartilhamento.
- `id`, `compartilhamento_id` → rastreadores_compartilhados
- `latitude`, `longitude` NUMERIC, `criado_em`

---

### Fleet (checklist e controle de custos)

**`fleet_checklist_itens`** — template de itens de checklist por cliente.
- `id`, `cliente_id`, `nome`, `ordem` INT, `ativo` BOOLEAN, `criado_em`

**`fleet_checklist_execucoes`** — execuções de checklist por veículo.
- `id`, `cliente_id`, `veiculo_id`, `tipo` (pre/pos), `itens` JSONB, `tem_problema` BOOLEAN, `criado_em`

---

### Patrol (rondas de segurança)

**`patrol_pontos`** — pontos de ronda fixos cadastrados pelo gestor.
- `id`, `cliente_id`, `nome`, `latitude`, `longitude` NUMERIC, `raio_metros` INT
- `qr_codigo` TEXT UNIQUE — código gerado automaticamente ao cadastrar o ponto; usado para gerar o QR físico (`/api/patrol/pontos/:id/qrcode`) e validar check-in sem GPS
- `ativo` BOOLEAN, `criado_em`

**`patrol_checkins`** — check-ins de vigilante em um ponto.
- `id`, `cliente_id`, `ponto_id` → patrol_pontos, `compartilhamento_id` → rastreadores_compartilhados
- `latitude`, `longitude` NUMERIC (NULL para check-ins QR sem GPS), `distancia_metros` NUMERIC
- `dentro_raio` BOOLEAN, `criado_em`
- `tipo` VARCHAR(10) — `'geocerca'` (GPS) ou `'qrcode'`

**`patrol_plantoes`** — plantões (jornadas de trabalho) do vigilante.
- `id`, `cliente_id`, `compartilhamento_id` → rastreadores_compartilhados
- `inicio` TIMESTAMPTZ DEFAULT NOW()
- `fim` TIMESTAMPTZ (NULL enquanto aberto)
- `latitude_inicio`, `longitude_inicio`, `latitude_fim`, `longitude_fim` NUMERIC
- `status` VARCHAR(10) DEFAULT `'aberto'` — `'aberto'` ou `'fechado'`
- `criado_em` TIMESTAMPTZ

Regra: um vigilante só pode ter um plantão `'aberto'` por vez (enforçado via `SELECT ... WHERE status='aberto'` antes do INSERT).

---

### Financeiro / operacional

**`pagamentos`** — cobrança mensal por cliente.
- `id`, `cliente_id`, `mes_ref` DATE, `valor` NUMERIC, `pago` BOOLEAN, `enviado_em` TIMESTAMPTZ

**`emails_log`** — histórico de e-mails de cobrança enviados.
- `id`, `cliente_id`, `mes_ref`, `email`, `assunto`, `enviado_em`

**`config`** — chave/valor genérico (templates de e-mail, configurações do sistema).
- `chave` TEXT PK, `valor` TEXT

**`logs_acesso`** — log de tentativas de login.
- `id`, `email`, `ip`, `sucesso` BOOLEAN, `criado_em`

Todas as FKs usam `ON DELETE CASCADE` (ou `SET NULL` quando a referência é opcional) — excluir um cliente cascateia e remove toda sua árvore de dados.

---

## 4. Arquitetura do sistema

Monólito clássico, deploy único:

```
┌────────────────────────────────────────────────────────┐
│ VPS produção (felogix.com.br)                          │
│                                                        │
│  ┌──────────────┐   HTTP REST + WebSocket              │
│  │ PostgreSQL   │ ←── server.js (Node / PM2)           │
│  │ banco felogix│     porta 3000                       │
│  └──────────────┘     ↑                                │
│                        │ HTTP via localhost             │
│  ┌──────────────┐       │                              │
│  │ Traccar      │ ←────┘                               │
│  │ (GPS nativo) │  API REST :8082 + GT06 TCP :5023     │
│  └──────────────┘                                      │
│                                                        │
│  Nginx (proxy reverso + TLS) ← tráfego público HTTPS  │
└────────────────────────────────────────────────────────┘
         ↑ GitHub Actions (deploy via SSH a cada push em main)
```

- Um único processo Node (`server.js`) serve API REST, WebSocket e arquivos estáticos do SPA.
- PostgreSQL e Traccar rodam na mesma VPS, acessados via `localhost`.
- Nginx (fora deste repo) faz proxy reverso e TLS (HTTPS) na frente da porta 3000.
- Não há fila de mensagens, cache distribuído, microsserviços ou containers em produção.

---

## 5. Fluxo de login e autenticação

**Endpoint**: `POST /api/login`  
**Body**: `{ email, senha }` (JSON)  
**Rate-limit**: 10 tentativas/minuto por IP

**Fluxo**:
1. Verifica se é a credencial fixa de admin (`ADMIN_EMAIL`/`ADMIN_PASS` do env).
2. Busca em `clientes` por e-mail → compara senha (texto plano com `===`).
3. Se não encontrou, busca em `colaboradores` por e-mail → mesmo mecanismo.
4. Aplica rate-limit de 5 tentativas; após falhas, bloqueia conta por 15 min (`bloqueado_ate`).
5. Sucesso → retorna `{ token, role, nome, empresa, initials, plano, tipo }`.

**JWT payload**:
- Admin: `{ id: 0, role: 'admin', nome }`
- Gestor: `{ id: clientes.id, role: 'gestor', nome, empresa, tipo: 'cpf'|'cnpj' }`
- Colaborador: `{ id: colaboradores.id, role: 'colaborador', clienteId: clientes.id, grupoId, nome, empresa }`

**Token**: JWT assinado com `JWT_SECRET` (env), expira em 12h.

**Acesso público** (`/track/:token`): sem JWT; autenticado por token na URL + senha opcional por pessoa (POST `/api/track/:token/login`). O servidor gera um cookie de sessão curto para verificações subsequentes naquela página.

**Proteção anti-brute-force**:
- 10/min por IP em `/api/login`, 3/5min em `/api/esqueci-senha`, 10/min em `/api/track/:token/login`
- 5 tentativas erradas bloqueiam a conta (`clientes`/`colaboradores`) por 15 min

---

## 6. Módulos existentes

O sistema é dividido em 4 produtos ("verticais"), todos servidos pelo mesmo backend/frontend. O `APP_MODE` é derivado de `location.pathname` no cliente (ex.: `/patrol/...` → mode `patrol`).

### 6.1 Felogix Track
Rastreamento veicular via hardware GPS (protocolo GT06, Traccar).

- Rastreamento em tempo real via WebSocket (posições broadcast a cada 5s).
- Histórico de trajeto por veículo.
- Bloqueio/desbloqueio de ignição via Traccar (`engineStop`/`engineResume`) para veículos com IMEI.
- Motor de alertas: velocidade, offline, bloqueio, geocerca — eventos registrados em `alertas_eventos`, visíveis in-app.
- Geofencing: criação de cercas circulares no mapa, avaliação de entrada/saída no motor de alertas.
- Perfil CPF: acesso simplificado, só seus veículos.
- Perfil CNPJ: hierarquia gestor → colaboradores por grupo de veículos.

### 6.2 Felogix Fleet
Controle de custos e checklist de frota. **Funcional mas básico**: apenas checklist. Sem plano de manutenção, odômetro ou gestão de multas/documentos (backlog).

- Itens de checklist customizáveis por cliente (CRUD).
- Execução de checklist pré/pós-viagem por veículo (tipo, itens em JSONB, flag de problema).
- Histórico de execuções.
- Funciona com qualquer veículo, independente de ter rastreador ou não.

### 6.3 Felogix Connect
Compartilhamento de localização P2P (estilo Life360), sem hardware.

- Grupos privados com convite por link/token.
- Rastreamento via GPS do próprio celular/navegador.
- Foto, senha opcional por pessoa.
- Painel estilo Life360: lista de membros com last-seen e posição no mapa.
- Hoje tecnicamente vive no namespace de `/track/:token`; a separação como vertical própria em `/connect` é decisão pendente (ver `FELOGIX-SPEC.md`, Vertical 3).

### 6.4 Felogix Patrol
Sistema de rondas e auditoria de vigilantes.

- **Cadastro de pontos de ronda** pelo gestor (nome, coordenada, raio em metros).
- **Check-in por geocerca/GPS**: vigilante abre `/track/:token`, seleciona ponto próximo e confirma check-in com validação de distância.
- **Check-in por QR Code**: gestor gera QR para cada ponto (`/api/patrol/pontos/:id/qrcode`), vigilante escaneia com a câmera nativa → rota `/patrol/checkin/:qr_codigo` confirma presença usando o token salvo em `localStorage`.
- **Plantão (jornada de trabalho)**: vigilante inicia e fecha o plantão pelo próprio link pessoal; só um plantão aberto por vez.
- **Relatório PDF de fechamento**: gerado pelo `pdfkit` com identificação do vigilante, duração do plantão, taxa de eficiência (check-ins dentro do raio / total de pontos × jornada), linha do tempo de passagens. Disponível para download manual no painel do gestor — **nunca enviado automaticamente por e-mail**.
- **Painel do gestor**: aba "Pontos de Ronda" (CRUD + histórico de check-ins), aba "Plantões" (lista com status, eficiência, botão de download do PDF).

---

## 7. APIs e endpoints

Convenção: rotas autenticadas exigem `Authorization: Bearer <jwt>`. `adminOnly` = role `'admin'`.

### Autenticação
| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| POST | `/api/login` | público | login multi-perfil (admin/gestor/colaborador) |
| POST | `/api/esqueci-senha` | público | envia e-mail com nova senha aleatória |
| POST | `/api/alterar-senha` | auth | altera senha do usuário logado |
| GET | `/api/verify-token` | auth | valida JWT e retorna perfil atualizado |

### Clientes
| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| GET | `/api/clientes` | adminOnly | lista todos os clientes |
| POST | `/api/clientes` | adminOnly | cria cliente (envia e-mail de boas-vindas) |
| PUT | `/api/clientes/:id` | adminOnly | edita cliente |
| DELETE | `/api/clientes/:id` | adminOnly | exclui cliente (CASCADE nos dados) |

### Veículos
| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| GET | `/api/veiculos` | auth | lista veículos (filtrado por role/grupo) |
| POST | `/api/veiculos` | adminOnly | cadastra veículo (upload de foto) |
| PUT | `/api/veiculos/:id` | auth | edita veículo; gestor pode alterar `bloqueado` (dispara Traccar) |
| DELETE | `/api/veiculos/:id` | adminOnly | exclui veículo |
| GET | `/api/veiculos/:id/historico` | auth | trajeto histórico |

### Posições / Traccar
| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| GET | `/api/posicoes` | auth | posições atuais (filtra por role) |
| POST | `/api/traccar/sync` | adminOnly | força sincronização de dispositivos |
| GET | `/api/traccar/status` | adminOnly | status de conexão com Traccar |

### Fleet — Checklist
| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| GET/POST | `/api/fleet/checklist-itens` | auth | itens de checklist do cliente |
| PUT/DELETE | `/api/fleet/checklist-itens/:id` | auth | edita/exclui item |
| POST | `/api/fleet/checklist-execucoes` | auth | registra execução |
| GET | `/api/fleet/checklist-execucoes` | auth | histórico de execuções |

### Patrol — Rondas
| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| GET/POST | `/api/patrol/pontos` | auth | pontos de ronda do cliente |
| PUT/DELETE | `/api/patrol/pontos/:id` | auth | edita/exclui ponto |
| GET | `/api/patrol/pontos/:id/qrcode` | auth | gera imagem PNG do QR Code do ponto |
| GET | `/api/patrol/checkins` | auth | histórico de check-ins |
| GET | `/api/patrol/plantoes` | auth | lista plantões (com métricas de eficiência) |
| GET | `/api/patrol/plantoes/:id/pdf` | auth | download do PDF de fechamento (stream) |

### Patrol — Endpoints públicos do vigilante (`/track/:token`)
| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| GET | `/api/track/:token/pontos-proximos` | público | pontos de ronda próximos à posição |
| POST | `/api/track/:token/checkin` | público | check-in por GPS (valida distância) |
| POST | `/api/track/:token/checkin-qr` | público | check-in por QR Code |
| GET | `/api/track/:token/plantao/atual` | público | plantão em andamento (se houver) |
| POST | `/api/track/:token/plantao/iniciar` | público | inicia plantão |
| POST | `/api/track/:token/plantao/fechar` | público | fecha plantão |

### Connect — Compartilhamentos
| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| POST/GET | `/api/compartilhamentos` | auth | cria/lista compartilhamentos |
| DELETE | `/api/compartilhamentos/:id` | auth | exclui compartilhamento |
| POST/DELETE | `/api/compartilhamentos/:id/senha` | auth | define/remove senha |
| POST | `/api/compartilhamentos/:token/location` | público | recebe GPS do navegador |
| GET | `/api/compartilhamentos/:id/historico` | auth | histórico de posições |
| GET/POST | `/api/grupos` | auth | grupos de rastreamento |
| DELETE | `/api/grupos/:id` | auth | exclui grupo |
| GET/POST | `/api/grupos/:id/pessoas` | auth | pessoas do grupo |

### Página `/track/:token`
| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| GET | `/track/:token` | público | página HTML do vigilante/pessoa rastreada |
| POST | `/api/track/:token/login` | público | autenticação por senha pessoal |
| PUT | `/api/track/:token/perfil` | público | edita nome e foto (upload) |
| GET | `/api/track/:token/grupo` | público | lista pessoas do grupo |

### Equipe (Track CNPJ)
| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| GET/POST | `/api/grupos-veiculos` | auth | grupos de veículos |
| GET | `/api/grupos-veiculos/:id/veiculos` | auth | veículos do grupo |
| PUT/DELETE | `/api/grupos-veiculos/:id` | auth | edita/exclui grupo |
| GET/POST | `/api/colaboradores` | auth | colaboradores do cliente CNPJ |
| PUT/DELETE | `/api/colaboradores/:id` | auth | edita/exclui colaborador |

### Alertas e geocercas (Track)
| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| GET/PUT | `/api/alertas` | auth | preferências de alerta (gestor) |
| GET | `/api/alertas/eventos` | auth | lista eventos disparados |
| GET/POST | `/api/geocercas` | auth | geocercas do cliente |
| PUT/DELETE | `/api/geocercas/:id` | auth | edita/exclui geocerca |

### Financeiro
| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| GET | `/api/financeiro` | adminOnly | visão consolidada de cobrança |
| POST | `/api/financeiro/cobrar` | adminOnly | gera rascunho de fatura |
| POST | `/api/financeiro/pago` | adminOnly | marca fatura como paga |
| GET | `/api/financeiro/rascunhos` | adminOnly | rascunhos pendentes de envio |
| POST | `/api/financeiro/enviar` | adminOnly | **envia fatura por e-mail** (único disparo de e-mail manual de cobrança) |
| GET | `/api/financeiro/emails` | adminOnly | histórico de envios |

### Outros
| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| GET | `/api/health` | público | health check (usado pelo CI/CD após deploy) |

---

## 8. Páginas HTML servidas

| Rota | Descrição |
|---|---|
| `/` | Página seletora institucional (gerada em server.js) |
| `/track` | SPA Track (serve public/index.html) |
| `/fleet` | SPA Fleet (serve public/index.html) |
| `/connect` | SPA Connect (serve public/index.html) |
| `/patrol` | SPA Patrol (serve public/index.html) |
| `/produtos/:slug` | Página de marketing de produto (gerada em server.js) |
| `/track/:token` | Página HTML inline do vigilante/pessoa rastreada (gerada em server.js) |
| `/patrol/checkin/:qr_codigo` | Página HTML inline de confirmação de check-in por QR Code (gerada em server.js) |

---

## 9. WebSocket

**Conexão**: `ws://host/ws?token=<jwt>`  
**Autenticação**: JWT validado no `connection` handler; colaborador só recebe veículos do seu grupo.

**Mensagens enviadas pelo servidor** (broadcast a cada 5s):

| `type` | Conteúdo | Quem recebe |
|---|---|---|
| `posicao` | latitude, longitude, velocidade, placa, etc. de cada veículo | gestor/colaborador filtrado por grupo |
| `compartilhamento` | latitude, longitude, nome, foto de cada pessoa rastreada | gestor (todos os compartilhamentos do cliente) |

Não há mensagens do cliente para o servidor via WebSocket — toda ação é via REST.

---

## 10. Serviços em background (setInterval)

Todos rodam dentro do processo Node, sem worker separado:

| Serviço | Frequência | Função |
|---|---|---|
| `broadcastPosicoes` | 5s | Busca posições (Traccar + compartilhamentos), avalia alertas/geocercas, envia via WebSocket |
| `sincronizarVeiculosTraccar` | 5min | Sincroniza lista de dispositivos Traccar com `veiculos.traccar_device_id` |
| `verificarLembreteMensal` | 6h + startup | Avisa **só o admin** (in-app) sobre faturas pendentes — nunca envia ao cliente |
| `loadGrupo` / `loadPontos` (frontend) | 15s | Refresh de grupo/pontos na página `/track/:token` |

---

## 11. Motor de alertas (Track)

Acionado em `broadcastPosicoes` a cada 5s. Lógica em `avaliarAlertas()`:

1. Carrega `alertas_prefs` e `geocercas` de todos os clientes com veículos visíveis.
2. Para cada posição recebida do Traccar:
   - **Velocidade**: se `velocidade > 100 km/h` e toggle `velocidade=true` → `dispararAlerta()`.
   - **Geocerca**: calcula distância da posição até cada geocerca; detecta transição `dentro ↔ fora` e dispara alerta se toggle `geocerca=true`.
3. Após processar todas as posições:
   - **Offline**: veículos com `traccar_device_id` que não apareceram nas posições há mais de 30 min → alerta se toggle `offline=true`.
4. `dispararAlerta(clienteId, veiculoId, tipo, mensagem)`:
   - Aplica cooldown de 10 min por par `(tipo, veiculo_id)` para não spam.
   - Insere em `alertas_eventos`.
   - Chama `enviarPushParaCliente(clienteId, 'Felogix Track', mensagem)` (ver seção 12.1).

O toggle `horario` existe em `alertas_prefs` mas ainda não há motor nem UI para configurar janelas de horário.

---

## 11.1 Notificações push (Web Push / VAPID)

Implementado via biblioteca `web-push` (servidor) + Push API/Service Worker (navegador).

- **Setup**: `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` lidos do `.env`; se ausentes, um par é gerado em memória a cada restart (mesma estratégia de fallback do `JWT_SECRET`) — inscrições existentes ficam inválidas após restart sem chaves fixas em produção.
- **Tabela**: `push_subscriptions (id, cliente_id, endpoint UNIQUE, p256dh, auth, criado_em)`.
- **Endpoints** (todos exigem `auth`; apenas role `gestor` tem acesso — `admin`/`colaborador` recebem 403):
  - `GET /api/push/vapid-public-key` — público, retorna a chave pública para o `pushManager.subscribe()` do navegador.
  - `POST /api/push/subscribe` — recebe `{endpoint, keys:{p256dh,auth}}` (saída de `PushSubscription.toJSON()`); upsert por `endpoint`.
  - `DELETE /api/push/subscribe` — remove a inscrição do `cliente_id` autenticado.
- **`enviarPushParaCliente(clienteId, titulo, corpo, dataExtra)`**: busca todas as inscrições do cliente, envia via `webpush.sendNotification()`; em caso de erro 404/410 (inscrição morta), remove a linha de `push_subscriptions` automaticamente.
- **Disparo automático**:
  - Track: dentro de `dispararAlerta()` (velocidade, offline, geocerca) — ver seção 11.
  - Patrol: check-in (GPS e QR Code), início de plantão, fechamento de plantão.
- **Service Worker** (`public/sw.js`): escuta `push` (mostra notificação) e `notificationclick` (foca/abre a janela). Servido estaticamente em `/sw.js` com escopo de origem completo.
- **Frontend**: botão "Ativar/Desativar notificações" na tela de Alertas do gestor (`renderAlertas()` em `public/index.html`), com `urlBase64ToUint8Array()`, `atualizarBotaoPush()` e `togglePush()`.
- **Limitação conhecida de ambiente de teste**: em sandboxes com rede restrita, `pushManager.subscribe()` trava esperando handshake com o push service do navegador (ex.: FCM do Chrome) — não é um bug, é a mesma classe de restrição de rede do Leaflet/CDN (seção 20). Em produção (VPS com internet irrestrita) funciona normalmente.

---

## 12. Geração de QR Code (Patrol)

- Ao criar um `patrol_ponto`, o servidor gera um `qr_codigo` UUID v4 único.
- `GET /api/patrol/pontos/:id/qrcode` gera a imagem PNG do QR code com `qrcode.toBuffer()`, contendo a URL `https://felogix.com.br/patrol/checkin/<qr_codigo>`.
- A página `/patrol/checkin/:qr_codigo` é uma página HTML inline (gerada por server.js), carregada quando o vigilante escaneia o QR com a câmera nativa do celular.
- A página lê o `token` do vigilante de `localStorage` (salvo quando ele abre `/track/:token` pela primeira vez no mesmo dispositivo) e faz `POST /api/track/:token/checkin-qr` automaticamente.
- O check-in por QR não exige GPS: latitude/longitude ficam NULL em `patrol_checkins`; `tipo = 'qrcode'`.

---

## 13. Geração de PDF de fechamento de plantão

- `GET /api/patrol/plantoes/:id/pdf` (auth, gestor)
- Gerado com `pdfkit` (streaming direto para `res`).
- Conteúdo: identificação do vigilante, empresa/gestor, período do plantão, taxa de eficiência (checkins `dentro_raio / (total pontos × horas)` normalizado), linha do tempo de passagens com horário, tipo (GPS/QR) e status (dentro/fora do raio).
- Disponível **somente para download manual no painel do gestor** — nunca enviado automaticamente por e-mail (política arquitetural do projeto: ver `FELOGIX-SPEC.md`, seção de Notas de arquitetura).

---

## 14. Como o front-end (SPA) está organizado

`public/index.html` (~2651 linhas): HTML + CSS + JS em um único arquivo sem build step.

**Detecção de modo**:
```js
const APP_MODE = location.pathname.startsWith('/patrol') ? 'patrol'
               : location.pathname.startsWith('/fleet')  ? 'fleet'
               : location.pathname.startsWith('/connect') ? 'connect'
               : 'track';
```

**Helpers globais reutilizáveis**:
- `api(method, path, body)` / `apiUpload(method, path, formData)` — wrapper de fetch com JWT automático, timeout e retry.
- `escHtml(str)` — sanitização antes de injetar em innerHTML (proteção contra XSS).
- `thumbHtml(foto, emoji, size)` — avatar padronizado (foto ou emoji fallback).
- `buildNav()` / `goTab(id)` — navegação por abas, adaptada por APP_MODE e role.
- `initMap()` / `addMkr()` / `syncMkrs()` / `centerAll()` — ciclo de vida do mapa Leaflet.
- `connectWS()` / `disconnectWS()` — WebSocket único compartilhado.
- `gcInitMiniMap` / `prInitMiniMap` — modais de mini-mapa para desenhar raio (geocercas e pontos de ronda usam o mesmo padrão).

**Abas por produto**:
- Track: Mapa, Veículos, Alertas, Geocercas, Equipe, Compartilhamentos, Financeiro (admin), Clientes (admin)
- Fleet: Checklist
- Patrol: Mapa, Pontos de Ronda, Plantões, Compartilhamentos
- Connect: Mapa, Compartilhamentos, Grupos

---

## 15. Variáveis de ambiente necessárias (.env)

Ver `.env.example` na raiz do projeto. Todas as variáveis são opcionais (têm fallback), exceto as marcadas como **obrigatórias em produção**:

| Variável | Obrigatória | Default (se ausente) | Descrição |
|---|---|---|---|
| `JWT_SECRET` | ✅ produção | gerado aleatoriamente (invalida sessões ao reiniciar) | segredo de assinatura dos JWTs |
| `DB_PASS` | ✅ produção | — | senha do PostgreSQL |
| `ADMIN_PASS` | ✅ produção | `'95050578.Fege'` (hardcoded — alterar!) | senha do admin |
| `MAIL_USER` | ✅ e-mail | — | conta Gmail (app password) |
| `MAIL_PASS` | ✅ e-mail | — | senha de app do Gmail |
| `PORT` | não | `3000` | porta do servidor HTTP |
| `TRACCAR_HOST` | não | `'localhost'` | host do Traccar |
| `TRACCAR_PORT` | não | `8082` | porta da API REST do Traccar |
| `TRACCAR_USER` | não | `'admin'` | usuário do Traccar |
| `TRACCAR_PASS` | não | `'admin'` | senha do Traccar |
| `LEMBRETE_EMAIL` | não | `'felogix.br@gmail.com'` | destino dos lembretes mensais internos |

**Na VPS**, as variáveis são gerenciadas pelo PM2 (via `pm2 ecosystem.config.js` ou diretamente no processo) ou por um arquivo `.env` na raiz do projeto (`/var/www/felogix/.env`). O deploy (`deploy.yml`) executa `pm2 restart felogix-server --update-env`, que relê o `.env`.

**Segredos do GitHub Actions** (usados em `deploy.yml`):
- `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_PORT` — credenciais SSH para deploy

---

## 16. Deploy e CI/CD

**Arquivo**: `.github/workflows/deploy.yml`  
**Trigger**: push em `main` (ou `workflow_dispatch` manual)  
**Concorrência**: um deploy por vez; push novo cancela o anterior.

**Passos**:
1. SSH na VPS via `appleboy/ssh-action@v1.2.0`.
2. `cd /var/www/felogix && git fetch origin main && git reset --hard origin/main`
3. `npm install --production`
4. `pm2 restart felogix-server --update-env && pm2 save`
5. Health check: `curl http://localhost:3000/api/health` → espera HTTP 200.

**Padrão de branch**:
- Desenvolvimento em `claude/felogix-dev-assistant-macmsv` (ou branch de feature)
- Merge fast-forward em `main` → dispara deploy automático
- Falhas transientes de SSH para a VPS são conhecidas; o retry manual (`rerun_failed_jobs`) sempre resolve

---

## 17. Como executar localmente

**Pré-requisitos**: Node.js 18+, PostgreSQL rodando com banco `felogix` criado.

```bash
# 1. Instalar dependências
npm install

# 2. Configurar variáveis de ambiente
cp .env.example .env
# Editar .env com DB_PASS, JWT_SECRET, MAIL_USER, MAIL_PASS

# 3. Iniciar o servidor (cria/migra as tabelas automaticamente)
node server.js

# O servidor escuta na porta 3000 (ou $PORT)
# Acesse: http://localhost:3000
```

**PostgreSQL**: o `server.js` espera conexão em:
```
{ host: 'localhost', port: 5432, database: 'felogix', user: 'postgres', password: process.env.DB_PASS }
```

**Traccar** (opcional para Track): o servidor loga avisos mas não falha se o Traccar estiver offline — funcionalidades não-GPS continuam operando normalmente.

---

## 18. O que já está concluído

| Funcionalidade | Produto |
|---|---|
| Login multi-perfil (admin/gestor/colaborador) com JWT + brute-force protection | Core |
| CRUD completo de clientes, veículos, grupos, colaboradores | Core |
| Rastreamento em tempo real via WebSocket (Traccar + compartilhamentos) | Track / Connect |
| Histórico de trajeto | Track / Connect |
| Bloqueio/desbloqueio real de ignição via Traccar | Track |
| Motor de alertas (velocidade, offline, bloqueio, geocerca) | Track |
| Geofencing: criação no mapa + avaliação em tempo real | Track |
| Hierarquia CNPJ → grupos de veículos → colaboradores | Track |
| Compartilhamento de localização (grupos, invite link, foto, senha, Life360) | Connect |
| Checklist de frota (itens customizáveis, execução pré/pós, histórico) | Fleet |
| Cadastro de pontos de ronda com geocerca | Patrol |
| Check-in por GPS (validação de distância/raio) | Patrol |
| Check-in por QR Code (geração de QR, página de confirmação, token localStorage) | Patrol |
| Plantão: início/fechamento com validação de jornada única | Patrol |
| Relatório PDF de fechamento de plantão (pdfkit, download manual) | Patrol |
| Painel do gestor: pontos, histórico de check-ins, lista de plantões, download PDF | Patrol |
| Notificações push (Web Push/VAPID): alertas do Track + eventos do Patrol (check-in, plantão) | Track / Patrol |
| Financeiro: cobrança mensal, fatura por e-mail (manual), histórico | Admin |
| Upload de fotos (veículos, pessoas) | Core |
| Páginas institucionais (`/`, `/produtos/:slug`) | Marketing |

---

## 19. O que ainda falta desenvolver

**Patrol** (próximos itens do backlog, em ordem sugerida):
- ❌ **SOS / botão de pânico** — vigilante dispara alerta de emergência; gestor recebe push imediato (reaproveita infra de push já implementada)
- ❌ **Sincronização offline (PWA)** — app continua funcionando sem conexão; check-ins são enfileirados e sincronizados ao voltar online
- ❌ **Chat** — comunicação entre vigilante e central de monitoramento
- ❌ **RBAC de 5 níveis** — hoje: admin/gestor/colaborador; planejado: Administrador/Supervisor/Operador/Vigilante/Cliente
- ❌ **Check-in por foto** (antifraude) — vigilante tira foto do ponto de interesse; coordenada GPS capturada no momento da foto
- ❌ **Pausas com/sem foto** (refeição, fisiológico, ocorrência, manutenção)
- ❌ **Perfil Supervisor** — foco em auditoria de postos com registro fotográfico

**Track**:
- ❌ **Alertas por horário** — toggle `alertas_prefs.horario` existe mas não há motor nem UI para configurar janelas

**Infraestrutura / dívida técnica**:
- ❌ **Hash de senhas** — `clientes.senha` e `colaboradores.senha` em texto plano; migração exige reset coordenado de senhas existentes
- ❌ **Suíte de testes automatizados** no CI (hoje: testes ad-hoc com Playwright durante dev, descartados depois)
- ❌ **Separar Connect** como vertical própria sob `/connect` (decisão pendente; hoje funciona sob `/track/:token`)

---

## 20. Problemas conhecidos

- **Senhas em texto plano**: comparadas com `===` no login. Dívida técnica conhecida — não foi corrigida para evitar quebrar sessões existentes sem migração coordenada.
- **`server.js` e `public/index.html` monolíticos**: ~3200 e ~2650 linhas respectivamente, sem separação em módulos. Funciona bem no volume atual; pode se tornar gargalo de manutenção se o número de verticais crescer muito.
- **Deploy com SSH transiente**: o runner do GitHub Actions ocasionalmente não consegue alcançar a VPS no primeiro attempt (timeout TCP). Histórico mostra que o `rerun_failed_jobs` sempre resolve sem necessidade de diagnóstico.
- **Leaflet via CDN externo**: `cdnjs.cloudflare.com` é o CDN de Leaflet. Ambientes com política de rede restritiva (ex.: sandbox de desenvolvimento) bloqueiam essa URL, quebrando o mapa. Em produção isso não é problema (felogix.com.br tem acesso à internet irrestrito).
- **ADMIN_PASS hardcoded de fallback**: se `ADMIN_PASS` não estiver no `.env`, o fallback hardcoded em `server.js` é exposto. Nunca depender do fallback em produção.
- **`horario` (alertas por horário)**: toggle disponível no DB e na UI, mas o motor não avalia. O toggle não faz nada.

---

## 21. Roadmap

1. **Imediato** — SOS / botão de pânico (reaproveita infra de push já implementada); alertas por horário no Track.
2. **Curto prazo** — Sync offline PWA, check-in por foto, pausas com/sem foto, perfil Supervisor.
3. **Escala** — Hash de senhas (coordenar reset), RBAC 5 níveis, suíte de testes no CI, chat entre vigilante e central.
5. **Longo prazo** — Felogix Hub / SSO entre os 4 produtos; avaliar se Connect precisa ser vertical própria com base em demanda real.
