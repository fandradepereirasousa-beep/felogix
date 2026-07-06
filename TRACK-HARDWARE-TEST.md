# TRACK-HARDWARE-TEST.md

**Plano de Validação com Hardware — Felogix Track**
**Versão:** 1.1 — hardware recebido em 06/07
**Dispositivo alvo:** Rastreador **EC33** (GNSS 4G, protocolo família GT06 na porta 5023/TCP) — IMEI `867689067476640`
**Ambiente:** VPS de produção com Traccar nativo + PostgreSQL + Node.js (PM2)

> **Comece pelo `ATIVACAO-EC33.md`** — roteiro específico do aparelho recebido (chip, SMS de configuração, bancada, fiação do relé). Este documento é a validação completa que vem depois. Onde este plano diz "GT06", leia "EC33" — o protocolo é o mesmo.

---

## Como usar este documento

Execute os testes na ordem em que aparecem. Cada item tem:
- **Passo a passo** do que fazer
- **Comportamento esperado** do que deve acontecer
- **Campo de resultado** para anotar ✅ / ⚠️ / ❌ e observações

Ao final de cada seção, decida se o bloco está aprovado antes de avançar para o próximo.

---

## FASE 0 — Pré-requisitos

Antes de ligar o rastreador, confirme que o ambiente está saldo:

### 0.1 Servidor

| # | Verificação | Comando | Resultado esperado | Status |
|---|---|---|---|---|
| 0.1.1 | Felogix online | `pm2 status felogix` | `status: online` | |
| 0.1.2 | Sem restarts recentes | `pm2 info felogix` | `restarts: 0` (ou baixo) | |
| 0.1.3 | PostgreSQL online | `systemctl status postgresql` | `active (running)` | |
| 0.1.4 | Traccar online | `systemctl status traccar` | `active (running)` | |
| 0.1.5 | Porta 5023 aberta | `ss -tlnp | grep 5023` | linha com `LISTEN` e `traccar` | |
| 0.1.6 | Porta 443/80 aberta | `ss -tlnp | grep -E '443|80'` | linhas com `LISTEN` | |
| 0.1.7 | `.env` com todas as variáveis | `cat /srv/felogix/.env` | Ver `ADMIN_PASS`, `JWT_SECRET`, `VAPID_*`, `TRACCAR_*`, `DATABASE_URL` | |
| 0.1.8 | Logs limpos sem erros fatais | `pm2 logs felogix --lines 50` | Sem `FATAL` ou `Error:` | |

### 0.2 Rastreador GT06

| # | Verificação | Método | Resultado esperado | Status |
|---|---|---|---|---|
| 0.2.1 | SIM card com dados móveis ativo | Inserir SIM, ligar rastreador, observar LED | LED de rede piscando / sólido | |
| 0.2.2 | Tensão de alimentação correta | Multímetro no fio de alimentação | 9–40V DC (conforme spec do GT06) | |
| 0.2.3 | IMEI anotado | Etiqueta traseira do dispositivo | 15 dígitos | |
| 0.2.4 | APN configurado via SMS | `APN,apn,usuario,senha#` | SMS de confirmação `APN OK` | |
| 0.2.5 | IP/porta do servidor configurado | SMS `SERVER,0,seu.ip.vps,5023,0#` | SMS de confirmação `SERVER OK` | |
| 0.2.6 | Modo de heartbeat configurado | SMS `TIMER,30#` (envio a cada 30s) | SMS de confirmação `TIMER OK` | |

---

## FASE 1 — Traccar

### 1.1 Cadastro do dispositivo no Traccar

| # | Passo | Comportamento esperado | Status | Observações |
|---|---|---|---|---|
| 1.1.1 | Acessar `http://localhost:8082` (ou porta configurada) no servidor via SSH tunnel ou IP público | Interface web do Traccar carrega | | |
| 1.1.2 | Criar novo dispositivo com nome "GT06 Teste" e IMEI do rastreador | Dispositivo aparece na lista com status `Offline` | | |
| 1.1.3 | Ligar o rastreador com SIM ativo e antena GPS ao ar livre | Em até 2 minutos, status muda para `Online` no Traccar | | |
| 1.1.4 | Verificar "Última posição" no Traccar | Latitude/longitude válidas (não 0.0, não nulas) | | |
| 1.1.5 | Verificar velocidade exibida | `0 km/h` com veículo parado | | |
| 1.1.6 | Verificar horário da posição | Diferença < 60s em relação ao horário atual | | |

**Bloco 1.1 aprovado?** ☐ Sim ☐ Não

### 1.2 Comunicação GT06 → Traccar

| # | Passo | Comportamento esperado | Status | Observações |
|---|---|---|---|---|
| 1.2.1 | Verificar log do Traccar | `tail -f /opt/traccar/logs/tracker-server.log` → linha com o IMEI do rastreador | | |
| 1.2.2 | Verificar que o protocolo identificado é `gt06` | Log mostra `[gt06]` ao lado do IMEI | | |
| 1.2.3 | Simular movimento (caminhar ~100m com o dispositivo) | Posição atualiza no Traccar com nova latitude/longitude | | |
| 1.2.4 | Verificar intervalo de atualização | Posições chegam a cada ~30s (conforme TIMER configurado) | | |
| 1.2.5 | Verificar bateria/tensão nos atributos do dispositivo | Campo `power` ou `battery` presente nos atributos | | |

**Bloco 1.2 aprovado?** ☐ Sim ☐ Não

### 1.3 Reconexão e resiliência do Traccar

| # | Passo | Comportamento esperado | Status | Observações |
|---|---|---|---|---|
| 1.3.1 | Reiniciar Traccar: `systemctl restart traccar` | Após reinício, rastreador reconecta automaticamente em até 2 min | | |
| 1.3.2 | Desligar rastreador por 5 min e religar | Status volta para `Online` e posição atualiza | | |
| 1.3.3 | Bloquear porta 5023 por 30s via firewall e desbloquear | `ufw deny 5023 && sleep 30 && ufw delete deny 5023` → rastreador reconecta | | |
| 1.3.4 | Verificar eventos de conexão/desconexão no Traccar | Aba "Eventos" mostra `deviceOnline` / `deviceOffline` | | |

**Bloco 1.3 aprovado?** ☐ Sim ☐ Não

### 1.4 API Traccar → Felogix

| # | Passo | Comportamento esperado | Status | Observações |
|---|---|---|---|---|
| 1.4.1 | Verificar endpoint de posições do Traccar diretamente | `curl -u admin:admin http://localhost:8082/api/positions` → JSON com `lat`, `lon`, `speed`, `deviceId` | | |
| 1.4.2 | Verificar que `deviceId` do Traccar está vínculado ao veículo no Felogix | `SELECT id, placa, traccar_device_id FROM veiculos` no PostgreSQL | | |
| 1.4.3 | Verificar WebSocket do Traccar | `curl -u admin:admin "http://localhost:8082/api/socket"` → conexão WS estabelecida | | |

**Bloco 1.4 aprovado?** ☐ Sim ☐ Não

---

## FASE 2 — Felogix: Autenticação e Cadastro

### 2.1 Login

| # | Passo | Comportamento esperado | Status | Observações |
|---|---|---|---|---|
| 2.1.1 | Acessar `https://seudominio.com.br/track` | Tela de login carrega sem erros de console | | |
| 2.1.2 | Login com credenciais inválidas | Mensagem de erro clara; campo de senha não revela senha digitada | | |
| 2.1.3 | Login com gestor (e-mail + senha correta) | Redirecionado para dashboard; JWT armazenado no localStorage | | |
| 2.1.4 | Inspecionar token JWT | `atob(token.split('.')[1])` → `{ role: 'gestor', exp: ... }` | | |
| 2.1.5 | Verificar expiração de 12h | Token expira em ~12h; login automático não persiste após expiração | | |
| 2.1.6 | Logout | Token removido; redirecionado para tela de login | | |
| 2.1.7 | Tentar acessar rota protegida após logout | Redirecionado para login; não há dados expostos | | |

**Bloco 2.1 aprovado?** ☐ Sim ☐ Não

### 2.2 Cadastro de veículo e vínculo com IMEI

| # | Passo | Comportamento esperado | Status | Observações |
|---|---|---|---|---|
| 2.2.1 | Cadastrar veículo com placa, modelo e IMEI do GT06 | Veículo aparece na lista; `traccar_device_id` populado no banco | | |
| 2.2.2 | Verificar no banco | `SELECT placa, traccar_device_id FROM veiculos WHERE traccar_device_id IS NOT NULL` | | |
| 2.2.3 | Cadastrar veículo sem IMEI ("sem rastreador") | Veículo aparece na lista com status `offline`; nenhum marcador no mapa | | |
| 2.2.4 | Editar placa de veículo existente | Mudança refletida imediatamente na lista e no mapa | | |
| 2.2.5 | Vincular IMEI a veículo existente (edição) | Mapa começa a exibir posição após próximo ciclo de 5s | | |

**Bloco 2.2 aprovado?** ☐ Sim ☐ Não

---

## FASE 3 — Felogix: Mapa e Rastreamento em Tempo Real

### 3.1 Mapa e marcadores

| # | Passo | Comportamento esperado | Status | Observações |
|---|---|---|---|---|
| 3.1.1 | Abrir aba Mapa com GT06 ligado ao ar livre | Marcador do veículo aparece em até 10s na posição correta | | |
| 3.1.2 | Comparar coordenadas com GPS do celular no mesmo local | Diferença < 30 metros | | |
| 3.1.3 | Verificar popup do marcador | Exibe placa, velocidade, status e horário da última atualização | | |
| 3.1.4 | Zoom in / zoom out | Mapa responde sem travar; marcador permanece visível | | |
| 3.1.5 | Trocar para aba Veículos e voltar para aba Mapa | Marcador presente; sem duplicatas (fix R1 ativo) | | |
| 3.1.6 | Verificar clustering com veículo muito próximo | Cluster agrupa marcadores; clicar desagrupa | | |
| 3.1.7 | Botão "Minha localização" | Mapa centraliza na posição do browser; circle de precisão visível | | |
| 3.1.8 | Testar em Android Chrome | Mapa responsivo; marcadores clicáveis; sem overflow horizontal | | |
| 3.1.9 | Testar em iPhone Safari (iOS 16.4+) | Mapa responsivo; sem bloqueios de UI | | |

**Bloco 3.1 aprovado?** ☐ Sim ☐ Não

### 3.2 WebSocket e atualização em tempo real

| # | Passo | Comportamento esperado | Status | Observações |
|---|---|---|---|---|
| 3.2.1 | Abrir DevTools → Network → WS | Conexão WebSocket ativa com `wss://seudominio.com.br/ws` | | |
| 3.2.2 | Observar mensagens recebidas | Mensagens `{ type: 'posicoes', data: [...] }` chegam a cada ~5s | | |
| 3.2.3 | Simular movimento (percorrer 200m a pé ou de carro) | Marcador se move no mapa em tempo real; velocidade atualiza | | |
| 3.2.4 | Verificar velocidade exibida | Velocidade em km/h coerente com deslocamento real (± 10 km/h) | | |
| 3.2.5 | Verificar status do veículo em movimento | Status muda para `online` / velocidade > 0 | | |
| 3.2.6 | Parar o veículo por 30s | Velocidade volta para 0; ignição mantida como `on` ou `off` conforme GT06 | | |
| 3.2.7 | Desligar ignição do veículo | Status muda para `stopped` ou `offline` no próximo ciclo | | |
| 3.2.8 | Desligar internet do browser por 30s e reconectar | WS reconecta automaticamente; toast "Sem sinal" após 3 falhas, some ao reconectar | | |
| 3.2.9 | Verificar fallback para polling REST | Durante queda do WS, `/api/posicoes` é chamado a cada 5s (observar Network) | | |
| 3.2.10 | Reconectar internet | WS restabelecido; `liveErrCount` zerado; toast desaparece | | |

**Bloco 3.2 aprovado?** ☐ Sim ☐ Não

### 3.3 Histórico de posições

| # | Passo | Comportamento esperado | Status | Observações |
|---|---|---|---|---|
| 3.3.1 | Com veículo em movimento, abrir painel lateral do veículo | Botão "Ver histórico" visível | | |
| 3.3.2 | Selecionar intervalo de tempo (última hora) | Trilha de posições desenhada no mapa | | |
| 3.3.3 | Verificar pontos do histórico | Pontos alinhados com rota real percorrida | | |
| 3.3.4 | Selecionar intervalo sem posições (madrugada, veículo parado) | Trilha vazia; mensagem amigável exibida | | |
| 3.3.5 | Histórico de 24h | Carrega em < 3s; mapa não trava com muitos pontos | | |
| 3.3.6 | Verificar dados no banco | `SELECT COUNT(*) FROM posicoes_historico WHERE veiculo_id = X AND registrado_em > NOW() - INTERVAL '24h'` → resultado não vazio | | |

**Bloco 3.3 aprovado?** ☐ Sim ☐ Não

---

## FASE 4 — Alertas e Geocercas

### 4.1 Alertas automáticos

| # | Passo | Comportamento esperado | Status | Observações |
|---|---|---|---|---|
| 4.1.1 | Verificar configuração do limite de velocidade | `ALERTA_VELOCIDADE_LIMITE = 100` km/h em `server.js` | | |
| 4.1.2 | Deslocar veículo acima de 100 km/h (ou ajustar limite para teste) | Alerta de velocidade excessiva aparece no painel de alertas | | |
| 4.1.3 | Verificar cooldown de alerta | Alerta não se repete em menos de 15 minutos para o mesmo veículo | | |
| 4.1.4 | Desligar rastreador por 30+ minutos | Alerta de "veículo offline" disparado | | |
| 4.1.5 | Religar rastreador | Alerta de offline para; veículo volta ao status online | | |
| 4.1.6 | Verificar alerta de bloqueio | Após bloqueio confirmado, alerta de bloqueio registrado nos eventos | | |
| 4.1.7 | Verificar painel de alertas na UI | Lista de alertas mostra tipo, veículo, horário e status (ativo/resolvido) | | |
| 4.1.8 | Verificar persistência no banco | `SELECT * FROM alertas_eventos ORDER BY criado_em DESC LIMIT 10` | | |

**Bloco 4.1 aprovado?** ☐ Sim ☐ Não

### 4.2 Push Notifications

| # | Passo | Comportamento esperado | Status | Observações |
|---|---|---|---|---|
| 4.2.1 | Confirmar VAPID vars no `.env` | `VAPID_PUBLIC_KEY` e `VAPID_PRIVATE_KEY` definidos (não temporários) | | |
| 4.2.2 | Ativar notificações no browser | Popup de permissão aparece; após aceitar, botão muda para "Desativar" | | |
| 4.2.3 | Verificar inscrição no banco | `SELECT * FROM push_subscriptions` → linha com `endpoint` do browser | | |
| 4.2.4 | Disparar alerta de velocidade | Notificação push recebida no dispositivo mesmo com browser em segundo plano | | |
| 4.2.5 | Clicar na notificação | Abre o app Felogix na aba correta | | |
| 4.2.6 | Desativar notificações | Inscrição removida do banco | | |
| 4.2.7 | Testar em Android Chrome | Push recebido corretamente | | |
| 4.2.8 | Testar em iOS Safari 16.4+ | Push recebido (requer iOS 16.4+; versões anteriores: botão oculto ou mensagem de incompatibilidade) | | |

**Bloco 4.2 aprovado?** ☐ Sim ☐ Não

### 4.3 Geocercas

| # | Passo | Comportamento esperado | Status | Observações |
|---|---|---|---|---|
| 4.3.1 | Criar geocerca ao redor de uma área conhecida (ex.: estacionamento) | Polígono desenhado e salvo; aparece no mapa | | |
| 4.3.2 | Levar o rastreador para dentro da geocerca | Alerta de "entrada em geocerca" disparado | | |
| 4.3.3 | Levar o rastreador para fora da geocerca | Alerta de "saída de geocerca" disparado | | |
| 4.3.4 | Entrar e sair rapidamente (< 30s dentro) | Alerta disparado apenas uma vez por transição (cooldown ativo) | | |
| 4.3.5 | Criar segunda geocerca sobreposta | Ambas as geocercas avaliam corretamente de forma independente | | |
| 4.3.6 | Editar nome/área de geocerca existente | Mudança refletida imediatamente; motor de alertas usa nova área | | |
| 4.3.7 | Deletar geocerca | Removida do mapa; alertas relacionados cessam | | |
| 4.3.8 | Verificar persistência no banco | `SELECT * FROM geocercas` → lista correta | | |

**Bloco 4.3 aprovado?** ☐ Sim ☐ Não

---

## FASE 5 — Bloqueio e Desbloqueio Remoto

### 5.1 Fluxo de bloqueio

| # | Passo | Comportamento esperado | Status | Observações |
|---|---|---|---|---|
| 5.1.1 | **ATENÇÃO:** confirmar que veículo está PARADO antes de testar bloqueio | Veículo com velocidade = 0 km/h no mapa | | |
| 5.1.2 | Clicar em "Bloquear" na lista de veículos ou painel lateral | Modal de confirmação `felogixConfirm` aparece (não `confirm()` nativo) | | |
| 5.1.3 | Clicar "Cancelar" no modal | Nenhuma requisição enviada; veículo permanece desbloqueado | | |
| 5.1.4 | Clicar "Bloquear" e confirmar | Toast "🔒 [PLACA] bloqueado" aparece; botão muda para "Desbloquear" | | |
| 5.1.5 | Verificar comando enviado ao Traccar | Log do Traccar mostra comando de bloqueio para o IMEI | | |
| 5.1.6 | Verificar status no banco | `SELECT bloqueado FROM veiculos WHERE id = X` → `true` | | |
| 5.1.7 | Tentar ligar a ignição do veículo fisicamente | Ignição não deve iniciar (validação depende da fiação do relé do GT06) | | |
| 5.1.8 | Verificar comportamento do marcador no mapa | Ícone muda para estado "bloqueado" | | |

**Bloco 5.1 aprovado?** ☐ Sim ☐ Não

### 5.2 Fluxo de desbloqueio

| # | Passo | Comportamento esperado | Status | Observações |
|---|---|---|---|---|
| 5.2.1 | Com veículo bloqueado, clicar "Desbloquear" | Modal de confirmação aparece com mensagem de desbloqueio | | |
| 5.2.2 | Confirmar desbloqueio | Toast "✅ [PLACA] desbloqueado" aparece; botão volta para "Bloquear" | | |
| 5.2.3 | Verificar status no banco | `SELECT bloqueado FROM veiculos WHERE id = X` → `false` | | |
| 5.2.4 | Tentar ligar ignição fisicamente | Ignição funciona normalmente após desbloqueio | | |

**Bloco 5.2 aprovado?** ☐ Sim ☐ Não

### 5.3 Teste em iOS PWA (validação do fix R3)

| # | Passo | Comportamento esperado | Status | Observações |
|---|---|---|---|---|
| 5.3.1 | Adicionar à Tela de Início no iPhone | Ícone do Felogix Track na home screen | | |
| 5.3.2 | Abrir pelo ícone (modo PWA, não Safari) | App carrega sem barra de URL; sem barra inferior do Safari | | |
| 5.3.3 | Tentar bloquear veículo | Modal `felogixConfirm` aparece e é clicável (sem travamento — fix R3 ativo) | | |
| 5.3.4 | Confirmar e cancelar o modal | Ambas as ações funcionam; UI não trava | | |

**Bloco 5.3 aprovado?** ☐ Sim ☐ Não

---

## FASE 6 — Testes de Falha e Resiliência

> Para cada teste, anote o comportamento observado e compare com o comportamento esperado.

### 6.1 Perda de internet do browser

**Procedimento:** Desativar Wi-Fi/dados do dispositivo com o app aberto.

| Tempo | Comportamento esperado |
|---|---|
| 0–5s | Nenhuma mudança visível (WS ainda ativo no buffer) |
| 5–15s | WS fecha; polling REST via `/api/posicoes` inicia como fallback |
| 15s | Primeira falha de polling; `liveErrCount` = 1 (sem toast) |
| 30s | `liveErrCount` = 3; toast "Sem sinal do servidor. Verificando conexão…" aparece |
| Reconexão | WS restabelece; `liveErrCount` zerado; toast desaparece; marcadores voltam a atualizar |

**Resultado observado:** ___________________________________________

**Status:** ☐ Conforme ☐ Divergente

---

### 6.2 Desligar o rastreador GT06

**Procedimento:** Cortar alimentação do GT06 (ou retirar SIM).

| Tempo | Comportamento esperado |
|---|---|
| 0–30s | Última posição mantida no mapa (veículo "congelado") |
| 30–60s | Traccar marca dispositivo como `Offline` |
| ~5min | Felogix recebe status offline do Traccar; marcador muda para cinza/offline |
| 30min | Alerta de "veículo offline" disparado (conforme `ALERTA_OFFLINE_MIN`) |
| Religamento | Rastreador reconecta; posição atualiza; status volta para `online` |

**Resultado observado:** ___________________________________________

**Status:** ☐ Conforme ☐ Divergente

---

### 6.3 Reiniciar o servidor Felogix

**Procedimento:** `pm2 restart felogix` com o app aberto em browser.

| Fase | Comportamento esperado |
|---|---|
| Restart iniciado | WS fecha; polling REST entra em modo fallback |
| Durante restart (~2–5s) | Requisições REST falham; `liveErrCount` incrementa |
| Após restart | Servidor aceita conexões; WS reconecta automaticamente |
| Sem ação do usuário | Mapa volta a atualizar sem reload de página |
| Verificar logs | `pm2 logs felogix --lines 20` → sem `FATAL`; `DB iniciado` presente |

**Resultado observado:** ___________________________________________

**Status:** ☐ Conforme ☐ Divergente

---

### 6.4 Reiniciar o Traccar

**Procedimento:** `systemctl restart traccar` com rastreador ativo.

| Fase | Comportamento esperado |
|---|---|
| Restart do Traccar (~10–30s) | Rastreador perde conexão TCP; dados de posição param de chegar |
| Felogix durante restart | `getPosicoesEnriquecidas` retorna vazio ou erro; nenhum crash |
| Após restart do Traccar | Rastreador reconecta em até 2 min; posições voltam |
| Felogix após reconexão | Mapa volta a atualizar normalmente no próximo ciclo de 5s |

**Resultado observado:** ___________________________________________

**Status:** ☐ Conforme ☐ Divergente

---

### 6.5 Reiniciar o PostgreSQL

**Procedimento:** `systemctl restart postgresql` com Felogix em execução.

| Fase | Comportamento esperado |
|---|---|
| Durante restart (~5–10s) | Queries ao banco falham; Felogix loga erros de conexão mas não crasha |
| WS broadcasts | `broadcastPosicoes` loga erro mas continua tentando no próximo ciclo |
| Após restart | Pool de conexões do Felogix se reconecta automaticamente |
| Verificar logs | Erros de conexão registrados; nenhum `FATAL` nem `process exited` |

**Resultado observado:** ___________________________________________

**Status:** ☐ Conforme ☐ Divergente

---

### 6.6 Token JWT expirado

**Procedimento:** Forçar expiração editando `exp` do token no localStorage ou aguardar 12h.

| Cenário | Comportamento esperado |
|---|---|
| Token expirado ao fazer request | Servidor retorna `401 Unauthorized` |
| Frontend ao receber 401 | Toast de "Sessão expirada" + redirecionamento automático para login |
| Dados do cliente não expostos | Nenhum dado sensível visível após sessão expirada |
| Login novamente | Novo token emitido; app funciona normalmente |

**Resultado observado:** ___________________________________________

**Status:** ☐ Conforme ☐ Divergente

---

### 6.7 GPS sem sinal (rastreador em ambiente fechado)

**Procedimento:** Levar GT06 para dentro de um prédio ou área sem sinal GPS.

| Cenário | Comportamento esperado |
|---|---|
| Sinal GPS perdido | Rastreador mantém última posição (sem transmitir novas coordenadas) |
| Traccar | Posição "congelada" na última coordenada válida |
| Felogix | Marcador permanece na última posição; `updated` mostra horário antigo |
| Sinal GPS restaurado (ao ar livre) | Nova posição transmitida; marcador se move para posição correta |

**Resultado observado:** ___________________________________________

**Status:** ☐ Conforme ☐ Divergente

---

### 6.8 Rastreador sem alimentação (bateria/fio)

**Procedimento:** Desconectar completamente a alimentação do GT06.

| Cenário | Comportamento esperado |
|---|---|
| Imediato | GT06 desliga; nenhuma mensagem de "desligamento gracioso" enviada |
| Traccar em 60–120s | Dispositivo marcado como `Offline` por timeout de conexão TCP |
| Felogix em ~5min | Status do veículo muda para `offline` |
| Em 30min | Alerta de veículo offline disparado |
| Após religar | Rastreador reinicia (boot ~20–60s), reconecta, envia posição |

**Resultado observado:** ___________________________________________

**Status:** ☐ Conforme ☐ Divergente

---

### 6.9 Tentativas de login com força bruta

**Procedimento:** Tentar login com senha errada 10+ vezes consecutivas.

| Cenário | Comportamento esperado |
|---|---|
| 1–4 tentativas erradas | `401 Unauthorized`; mensagem genérica "Credenciais inválidas" |
| 5ª tentativa | Conta bloqueada por período definido; mensagem de bloqueio exibida |
| Durante bloqueio | Mesmo com senha correta: acesso negado até expirar o bloqueio |
| Após bloqueio expirar | Login normal funciona com senha correta |
| Verificar no banco | `SELECT tentativas_login, bloqueado_ate FROM clientes WHERE email = '...'` |

**Resultado observado:** ___________________________________________

**Status:** ☐ Conforme ☐ Divergente

---

## FASE 7 — Testes de Longa Duração

### 7.1 Plano de 24 horas

**Objetivo:** Verificar estabilidade básica, sem memory leak óbvio e sem crash.

**Início:** Anotar estado inicial antes de começar.

```
pm2 info felogix | grep -E 'memory|restarts|uptime'
# Anotar: memória inicial, restarts = 0, uptime = 0
```

**Verificações a cada 4 horas:**

| Hora | Memória (MB) | Restarts PM2 | WS ativo? | Posições chegando? | Erros nos logs? |
|---|---|---|---|---|---|
| H+4 | | | | | |
| H+8 | | | | | |
| H+12 | | | | | |
| H+16 | | | | | |
| H+20 | | | | | |
| H+24 | | | | | |

**Critérios de aprovação (24h):**

- [ ] Memória cresce < 50MB entre H+0 e H+24 (sem memory leak progressivo)
- [ ] Restarts PM2 = 0 (processo não crashou)
- [ ] WS ativo em todas as verificações (ou reconectou automaticamente)
- [ ] Posições chegando normalmente em todas as verificações
- [ ] Nenhum erro `FATAL` nos logs
- [ ] Banco de dados respondendo (verificar com query simples)
- [ ] Alertas disparando corretamente quando condições são atingidas

**Status do teste de 24h:** ☐ Aprovado ☐ Reprovado

---

### 7.2 Plano de 48 horas

**Objetivo:** Detectar vazamentos de memória lentos, acúmulo de conexões WS e degradação de performance.

**Pré-condição:** Teste de 24h aprovado.

**Verificações a cada 8 horas:**

| Hora | Memória (MB) | Restarts | Conexões WS ativas | Query lenta? | Alertas OK? |
|---|---|---|---|---|---|
| H+8 | | | | | |
| H+16 | | | | | |
| H+24 | | | | | |
| H+32 | | | | | |
| H+40 | | | | | |
| H+48 | | | | | |

**Verificações adicionais aos 48h:**

```sql
-- Verificar crescimento de tabelas:
SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC;

-- Verificar alertas duplicados (cooldown funcionando?):
SELECT tipo, veiculo_id, COUNT(*) FROM alertas_eventos
WHERE criado_em > NOW() - INTERVAL '48h' GROUP BY tipo, veiculo_id;

-- Verificar push_subscriptions sem acúmulo indevido:
SELECT COUNT(*) FROM push_subscriptions;
```

**Critérios de aprovação (48h):**

- [ ] Memória cresce < 100MB entre H+0 e H+48
- [ ] Sem restarts automáticos do PM2
- [ ] Sem conexões WS "zumbi" acumulando (verificar `netstat -an | grep :443 | wc -l`)
- [ ] Banco de dados sem tabelas crescendo de forma anormal
- [ ] Alertas com cooldown funcionando (sem spam de alertas repetidos)
- [ ] Performance de resposta da API < 200ms em rotas principais (medir com `curl -w "%{time_total}"`)

**Status do teste de 48h:** ☐ Aprovado ☐ Reprovado

---

### 7.3 Plano de 7 dias

**Objetivo:** Validação completa de produção — estabilidade real, picos de uso, casos extremos.

**Pré-condição:** Testes de 24h e 48h aprovados.

**Verificações diárias:**

| Dia | Memória (MB) | Uptime | Posições/dia (banco) | Alertas disparados | Observações |
|---|---|---|---|---|---|
| Dia 1 | | | | | |
| Dia 2 | | | | | |
| Dia 3 | | | | | |
| Dia 4 | | | | | |
| Dia 5 | | | | | |
| Dia 6 | | | | | |
| Dia 7 | | | | | |

**Eventos a simular ao longo da semana:**

- [ ] **Dia 2:** Reiniciar servidor Felogix → verificar recuperação automática
- [ ] **Dia 3:** Reiniciar PostgreSQL → verificar reconexão do pool
- [ ] **Dia 4:** Reiniciar Traccar → verificar reconexão do GT06
- [ ] **Dia 5:** Simular pico de requisições (5 usuários abrindo o mapa simultaneamente)
- [ ] **Dia 6:** Desligar GT06 por 4h → verificar alertas de offline + reconexão
- [ ] **Dia 7:** Análise completa de logs e banco

**Consultas de diagnóstico finais (Dia 7):**

```sql
-- Total de posições históricas gravadas na semana:
SELECT DATE(registrado_em), COUNT(*) FROM posicoes_historico
WHERE registrado_em > NOW() - INTERVAL '7d' GROUP BY 1 ORDER BY 1;

-- Alertas por tipo na semana:
SELECT tipo, COUNT(*) FROM alertas_eventos
WHERE criado_em > NOW() - INTERVAL '7d' GROUP BY tipo;

-- Tamanho do banco:
SELECT pg_size_pretty(pg_database_size(current_database()));

-- Conexões ativas ao banco:
SELECT COUNT(*) FROM pg_stat_activity WHERE state = 'active';
```

**Critérios de aprovação (7 dias):**

- [ ] Memória estável (variação < 150MB ao longo da semana)
- [ ] Uptime do Felogix ≥ 99% (excluindo restarts planejados)
- [ ] Nenhum crash não-planejado do processo Node.js
- [ ] Banco cresceu de forma linear e previsível (sem explosão de tamanho)
- [ ] Todos os alertas disparados foram justificados (sem falsos positivos)
- [ ] WebSocket se recuperou automaticamente em todos os eventos de reinício
- [ ] Performance da API não degradou ao longo da semana

**Status do teste de 7 dias:** ☐ Aprovado ☐ Reprovado

---

## FASE 8 — Critérios para Aprovação Comercial

O Felogix Track está pronto para os primeiros clientes pagantes quando **todos** os itens abaixo estiverem marcados:

### 8.1 Funcionalidade Core (obrigatório — todos os itens)

- [ ] Rastreador GT06 conecta ao Traccar e envia posições sem intervenção manual
- [ ] Mapa atualiza em tempo real com atraso < 10s
- [ ] Histórico de posições disponível e preciso
- [ ] Geocercas disparam alertas corretamente na entrada e na saída
- [ ] Alertas de velocidade excessiva funcionam com threshold configurável
- [ ] Alertas de veículo offline funcionam após período configurável
- [ ] Bloqueio e desbloqueio remoto funcionam **com veículo parado** (validado com relé do GT06)
- [ ] Login seguro com lockout após tentativas excessivas

### 8.2 Confiabilidade (obrigatório — todos os itens)

- [ ] Sistema ficou estável por 7 dias contínuos sem crash
- [ ] Sem memory leak progressivo detectado
- [ ] Sem falsos positivos de alerta em volume excessivo
- [ ] Recuperação automática após restart do servidor, Traccar e PostgreSQL
- [ ] WS reconecta sem necessidade de reload do browser

### 8.3 Segurança (obrigatório — todos os itens)

- [ ] Senhas armazenadas com `scrypt` (nenhuma plaintext no banco)
- [ ] `VAPID_PRIVATE_KEY` não aparece em logs de produção
- [ ] JWT expira em 12h e não pode ser reutilizado após expiração
- [ ] Bloqueio requer confirmação explícita (modal — sem `confirm()` nativo)
- [ ] Rotas protegidas retornam 401 para token inválido/expirado

### 8.4 Compatibilidade (obrigatório — todos os itens)

- [ ] Android Chrome: mapa + alertas + push funcionam
- [ ] iOS Safari 16.4+: mapa + alertas + push funcionam (PWA)
- [ ] Desktop Chrome/Firefox/Edge: funcionalidade completa
- [ ] Tela de bloqueio iOS (PWA): modal não trava a UI

### 8.5 Desempenho (obrigatório — todos os itens)

- [ ] Login responde em < 500ms
- [ ] Mapa carrega posições em < 2s
- [ ] Histórico de 24h carrega em < 3s
- [ ] CPU < 30% em idle com 1 rastreador ativo
- [ ] Memória do processo Node.js < 200MB após 7 dias

### 8.6 Operacional (recomendado antes do primeiro cliente)

- [ ] Procedimento de backup do PostgreSQL documentado e testado
- [ ] Renovação automática do certificado SSL (Let's Encrypt) configurada
- [ ] PM2 configurado para reiniciar automaticamente após reboot do VPS
- [ ] `.env` de produção armazenado em local seguro (fora do repositório)
- [ ] Plano de resposta a incidentes documentado (o que fazer se o servidor cair)

---

## FASE 9 — Registro Final

### Resumo de resultados

| Fase | Descrição | Status |
|---|---|---|
| 0 | Pré-requisitos | |
| 1 | Traccar — cadastro, comunicação, reconexão | |
| 2 | Felogix — autenticação e cadastro | |
| 3 | Mapa e tempo real | |
| 4 | Alertas, push e geocercas | |
| 5 | Bloqueio e desbloqueio | |
| 6 | Testes de falha | |
| 7.1 | Longa duração — 24h | |
| 7.2 | Longa duração — 48h | |
| 7.3 | Longa duração — 7 dias | |
| 8 | Critérios de aprovação comercial | |

### Veredito

☐ **✅ Aprovado para comercialização** — todos os critérios obrigatórios cumpridos

☐ **⚠️ Aprovado com restrições** — funcionalidade core aprovada; itens pendentes documentados e com prazo

☐ **❌ Reprovado** — um ou mais critérios obrigatórios não cumpridos; listar abaixo

**Itens pendentes / observações:**

```
[preencher após os testes]
```

**Data de início dos testes com hardware:** _______________
**Data de conclusão:** _______________
**Responsável pelos testes:** _______________

---

*Documento gerado em 2026-07-01 — branch `claude/felogix-dev-assistant-macmsv` pós-Sprint 1.*
*Versão do Felogix: commit `c04ec14`. Nenhum código foi alterado para geração deste documento.*
