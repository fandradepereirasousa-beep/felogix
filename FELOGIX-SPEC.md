# Felogix — Especificação do Ecossistema (Fonte Única da Verdade)

Este documento é a referência arquitetural para todo código, telas e
integrações do ecossistema Felogix a partir desta data. Qualquer trabalho
novo deve seguir esta estrutura. Atualizar este arquivo sempre que o escopo
de uma vertical mudar.

Domínio: felogix.com.br · Modelo: SaaS multisserviços sob um único guarda-chuva
tecnológico, focado em logística, rastreamento, gestão de frotas e segurança
operacional/patrimonial.

---

## VERTICAL 1 — Felogix Track
Telemetria básica, segurança e rastreamento de ativos veiculares físicos via
hardware/rastreador instalado (GPS+GSM, protocolo GT06 via Traccar).

**Funcionalidades:**
- Rastreamento em tempo real no mapa com atualização constante de posição.
- Geofencing (cercas virtuais) com alertas de entrada/saída.
- Bloqueio de ignição remoto via app/painel web.

**Acesso:**
- Perfil CPF: interface simplificada, só os veículos atrelados ao próprio documento.
- Perfil CNPJ: conta Master Admin com árvore hierárquica — gestor cria colaboradores
  e restringe visibilidade por veículo ou por grupo de veículos.

**Status de implementação:**
- ✅ Rastreamento em tempo real (mapa, WebSocket, histórico de trajeto)
- ✅ Bloqueio de ignição remoto real via Traccar (`engineStop`/`engineResume`),
  com fallback cosmético para veículos sem hardware (demo/compartilhamento)
- ✅ Vínculo por IMEI real (`traccar_device_id`)
- ✅ Perfil CPF vs CNPJ (`clientes.tipo`)
- ✅ Hierarquia CNPJ → colaboradores por grupo de veículos (`grupos_veiculos`,
  `colaboradores`), com nav e permissões restritas no front
- ✅ Motor de alertas: velocidade, offline, bloqueio (in-app, sem e-mail automático)
- ❌ Geofencing (geocercas) — toggle existe em `alertas_prefs.geocerca` mas não
  há motor avaliando nem UI para desenhar/cadastrar a cerca
- ❌ Alertas por horário (`alertas_prefs.horario`) — toggle existe, sem motor
  nem UI para configurar janelas permitidas

---

## VERTICAL 2 — Felogix Fleet
Cérebro operacional/financeiro da frota — auditoria e redução de custos.

**Módulos:**
- Checklist veicular digital (mobile, pré/pós-viagem, bloqueia/alerta em item crítico)
- Controle de quilometragem (odômetro, consumo, desgaste)
- Plano de manutenção (preventiva por KM/tempo, corretiva)
- Gestão financeira e compliance (multas, sinistros, vencimento de CRLV/seguro/ANTT)

**Status de implementação:** ❌ Nenhum módulo implementado. Rota `/fleet`
existe apenas como página "em construção" (`server.js:202`).

---

## VERTICAL 3 — Felogix Connect
Localização familiar P2P, hardware zero — GPS do próprio smartphone, modelo
Life360.

**Fluxo:**
- Usuário cria Círculos/Grupos privados, gera token/código de convite.
- Convidado loga no app, insere código, concede permissão de localização
  sempre ativa em segundo plano.
- Espelhamento cruzado: membros aprovados do círculo veem a posição uns dos
  outros em tempo real no mapa privado.

**Status de implementação:** ⚠️ Parcialmente construído, mas hoje vive dentro
do produto Track em vez de ser uma vertical própria. O que já existe sob
`/track/:token` + `compartilhamentos`/`grupos_rastreamento` cobre boa parte do
fluxo (grupos, convite por link, GPS do celular, posição em tempo real, lista
estilo Life360, senha por pessoa) — mas está namespaced/misturado com Track.
Rota `/connect` existe apenas como página "em construção" (`server.js:203`).
**Decisão pendente:** migrar/portar essa funcionalidade existente para viver
sob `/connect` como produto separado, ou manter como está dentro de Track.

---

## VERTICAL 4 — Felogix Patrol
Sistema de auditoria de produtividade, gerenciamento de rondas e controle
operacional para vigilantes e supervisores (segurança privada, portarias).

**Acesso:** gestor cria credenciais (Nome + RE) na web; login individual por
vigilante para auditoria legal do plantão.

### A. Fluxo de jornada e rastreamento ativo
- Início do plantão: check-in com validação de localização; ativa
  rastreamento contínuo em segundo plano (logs de trajeto, velocidade e
  tempo de permanência em cada coordenada).
- Fechamento do plantão: ao encerrar, o sistema compila os dados em um
  relatório PDF consolidado.
- ⚠️ **Conflito com política vigente, sinalizado e não resolvido
  silenciosamente:** o pedido original prevê esse PDF sendo enviado
  *automaticamente* por e-mail ao gestor/coordenador do grupo. Isso colide
  direto com a regra "proibido disparar e-mail automático de qualquer
  alerta/evento sem autorização explícita" (ver Notas de arquitetura, abaixo
  — mesma regra já aplicada ao motor de alertas do Track). Até segunda
  ordem: o PDF de fechamento fica disponível para download/visualização
  manual no painel do gestor, **sem envio automático por e-mail**. Abrir uma
  exceção pontual de envio automático para este relatório exige autorização
  explícita antes de qualquer implementação.

### B. Gestão de pausas e justificativas (módulo vigilante)
Botões específicos para o colaborador pausar a atividade e justificar o
tempo ocioso:
- Pausas sem foto (privacidade): "Almoço/Refeição" e "Banheiro/Pausa
  Fisiológica" — registra apenas geolocalização e duração.
- Pausas com foto (operacionais): "Atendimento de Ocorrência" (exige foto
  da anormalidade) e "Manutenção/Abastecimento da Viatura" (exige foto do
  odômetro ou cupom).

### C. Adaptação de perfil (Vigilante de posto vs. Supervisor)
- **Perfil Vigilante** (operação local): valida pontos de interesse por três
  métodos configuráveis — 1) leitura de QR Code gerado pelo painel Patrol e
  colado no cliente; 2) foto do ponto de interesse, cruzada com a coordenada
  GPS no momento da captura (antifraude); 3) passagem veicular automatizada
  (geocerca).
- **Perfil Supervisor/Coordenador** (visita e fiscalização): foco na
  auditoria de postos e clientes — app exige registro fotográfico na frente
  do cliente ou junto com a equipe/vigilante do posto visitado; localização
  exata capturada em segundo plano no momento da foto.

### D. Regra de contagem para ronda veicular
O rastreador integrado ao app computa de forma **cumulativa** todas as
passagens pelas cercas virtuais dos pontos de interesse — se o veículo
passar pelo mesmo ponto 10 vezes, o sistema registra os 10 carimbos de
data/hora individualmente na linha do tempo, além do tempo exato que o
veículo permaneceu parado em cada localidade.

**Relatório de fechamento de plantão (PDF):** identificação, taxa de
eficiência, linha do tempo de passagens (QR/foto/geocerca), ocorrências com
fotos — disponível para download manual no painel (ver conflito de e-mail
automático no item A).

**Status de implementação:** ❌ Nada implementado. Vertical inteiramente nova.

---

## Notas de arquitetura existentes (não alterar sem necessidade)
- Backend único (`server.js`, Express + Postgres + WS) atende todas as
  verticais sob o mesmo domínio, com rotas dedicadas por produto.
- `clientes.tipo` (`cpf`/`cnpj`) já é o discriminador de perfil em Track.
- Política de e-mail automático: **proibido** disparar e-mail automático de
  qualquer alerta/evento sem autorização explícita. Único envio automático
  hoje tolerado (pré-existente): `/api/esqueci-senha` e cadastro de cliente
  (`POST /api/clientes`). Qualquer nova vertical (Fleet, Connect, Patrol)
  segue a mesma regra até segunda ordem.
