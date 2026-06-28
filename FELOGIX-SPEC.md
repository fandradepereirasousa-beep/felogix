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
Gerenciamento, auditoria e fechamento de plantão de rondas patrimoniais
(segurança privada, portarias).

**Acesso:** gestor cria credenciais (Nome + RE) na web; login individual por
vigilante para auditoria legal do plantão.

**Modalidades de ronda (mobile):**
- Ronda a pé: leitura de QR Code nos Pontos de Interesse, validado contra
  horário + GPS do celular; permite anexar fotos como comprovação.
- Ronda veicular: GPS em segundo plano, gestor desenha microcercas virtuais
  nos pontos de interesse; baixa automática ao passar, sem precisar descer.

**Produtividade e relatório:**
- Controle de status (Almoço, Banheiro, QAP) com alerta de ociosidade
- Relatório de fechamento de plantão em PDF: identificação, taxa de
  eficiência, linha do tempo de passagens, ocorrências com fotos

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
