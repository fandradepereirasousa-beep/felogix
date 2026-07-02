# TRACK-UX-REVIEW.md

**Auditoria de Experiência do Usuário — Felogix Track**
**Perspectiva:** Cliente recém-contratado, abrindo o sistema pela primeira vez
**Data:** 2026-07-01 | Branch: `claude/felogix-dev-assistant-macmsv`
**Método:** Revisão do código-fonte (`public/index.html`) + análise de fluxo completo

> **Nota:** Nenhum código foi alterado para geração deste documento.

---

## Resumo Executivo

O Felogix Track tem uma base visual sólida — tipografia profissional (Inter + JetBrains Mono), dark theme consistente com sistema de design coerente (variáveis CSS), estados de loading e empty states bem construídos. A aparência geral transmite produto sério.

Porém, a auditoria identificou **1 problema crítico** (blocos `confirm()` nativos em iOS que quebram fluxos de exclusão), **5 problemas de alta prioridade** que transmitem produto inacabado, e **uma série de fricções de média/baixa prioridade** que afastam a percepção de produto premium.

A distância entre "funcionando" e "pronto para o primeiro cliente pagante" é pequena — a maioria dos itens de alta prioridade exige correções pontuais, não reescritas.

---

## 1. Primeira Impressão

### O que o cliente vê ao abrir `felogix.com.br/track`

A tela de login tem:
- Logo animada com boa proporção
- Wordmark "FELOGIX" + badge "Track" em vermelho
- Card de login com `border-radius: 16px` e fundo elevado
- Fundo com gradiente sutil radial vermelho

**O que transmite bem:**
- Produto sério, tech, dark-themed. Lembra Datadog, Linear, Vercel.
- Tipografia correta, espaçamento generoso.

**O que transmite pouco:**
- `<div class="logo-plan">Track</div>` — a palavra "Track" não diz nada para quem está acessando pela primeira vez. Um subtítulo como "Rastreamento de Frota" ou "Monitoramento de Veículos" contextualizaria o produto.
- `<div class="ltitle">Acesso à plataforma</div>` — genérico. Poderia ser "Painel do gestor" ou simplesmente retirado, já que o contexto do logo já comunica isso.
- `<div class="lsub">Entre com suas credenciais</div>` — frase padrão que não acrescenta valor.
- Não há nenhuma menção ao que o cliente vai encontrar após o login.

**Prioridade:** Baixa — não bloqueia uso, mas é a primeira impressão.

---

## 2. Tela de Login

### Pontos positivos
- `autocomplete="username"` e `autocomplete="current-password"` corretos — gerenciadores de senha funcionam.
- Botão Enter no campo de senha faz login (`onkeydown="if(event.key==='Enter')doLogin()"`).
- Feedback de erro via `.lerr` abaixo do botão.
- Link "Esqueci minha senha" presente.
- Loading state no botão (`btn.textContent = 'Entrando…'`).

### Problemas encontrados

**[BAIXO-1] Atributo `name` ausente nos inputs de login**

Os inputs não têm o atributo `name`. Embora `autocomplete` funcione na maioria dos browsers modernos, alguns gerenciadores de senha (Bitwarden, 1Password em modo legado) usam `name="email"` e `name="password"` para detecção.

```html
<!-- Atual -->
<input type="email" id="lEmail" placeholder="seu@email.com" autocomplete="username"/>
<!-- Sugerido -->
<input type="email" id="lEmail" name="email" placeholder="seu@email.com" autocomplete="username"/>
```

**[BAIXO-2] Sem opção "Lembrar de mim"**

O JWT expira em 12h. Um gestor que abre o app de manhã terá que fazer login novamente à noite. Para um sistema de frota que pode ser consultado a qualquer hora, isso é frictional. Nenhuma implementação imediata necessária, mas documentar para Sprint 2.

**[BAIXO-3] Mensagem de erro muito genérica após lockout**

Após muitas tentativas, o cliente recebe uma mensagem de erro do servidor — provavelmente algo como "Conta bloqueada temporariamente". Verificar se o texto orienta o cliente sobre quando poderá tentar novamente (ex: "Tente novamente em 15 minutos").

---

## 3. Onboarding — Primeiro Login

### Problema crítico de UX

Após o login, `initApp()` chama `goTab('mapa')`. Se o cliente não tem nenhum veículo cadastrado, o mapa mostra:

```
🚗
Nada para rastrear ainda
Veículos e celulares aparecerão aqui quando cadastrados
```

**O problema:** o cliente está na aba "Mapa" vendo uma tela vazia, mas a ação que precisa fazer (cadastrar um veículo) está em outra aba ("Veículos") — que nem aparece na navegação para o gestor, pois a nav começa em "Mapa". O usuário precisa descobrir sozinho onde está a aba Veículos.

Mais grave: um cliente gestor (não admin) não pode adicionar veículos por conta própria — apenas o admin cadastra veículos. Mas o empty state não informa isso. O gestor fica olhando para a tela vazia sem saber se é um bug ou se precisa esperar.

**[ALTO-3] Empty state do mapa não orienta o próximo passo**

Empty state atual: "Veículos e celulares aparecerão aqui quando cadastrados"
Empty state sugerido diferenciado por role:
- Para gestor: "Nenhum veículo ainda. Entre em contato com o administrador para cadastrar seus veículos."
- Para admin: "Nenhum veículo cadastrado. Adicione um veículo na aba Veículos para começar a rastrear."

**[ALTO-4] Sem tela de boas-vindas / primeiro acesso**

O cliente recebe login e senha por email, faz login e cai diretamente no mapa vazio. Não há:
- Mensagem de boas-vindas
- Passo a passo do que configurar primeiro
- Checklist de configuração inicial

Para um produto que cobra R$29,90/veículo/mês, a ausência de onboarding guiado aumenta o risco de churn nos primeiros dias.

**Sugestão futura (Sprint 2):** Um banner na primeira sessão com 3 passos:
1. ✅ Conta criada
2. 📡 Aguardando cadastro de veículo com IMEI
3. 📍 Configurar geocercas e alertas

---

## 4. Problema Crítico — `confirm()` nativo em iOS

**[CRÍTICO] Quatro fluxos de exclusão usam `confirm()` nativo e quebram em iOS PWA**

O fix R3 substituiu `confirm()` em `toggleBlock`, mas **quatro outros lugares continuam usando** o dialog nativo do browser:

| Localização | Operação | Código |
|---|---|---|
| `renderClientes` | Excluir cliente | `if(confirm('Excluir o cliente...'))deleteCliente(id)` |
| `openEditVeiculo` | Remover veículo | `if(confirm('Remover veículo?'))deleteVeiculo(id)` |
| `renderGeocercas` | Remover geocerca | `if(confirm('Remover a geocerca...'))deleteGeocerca(id)` |
| `renderPontosRonda` | Remover ponto de ronda | `if(confirm('Remover o ponto...'))deletePontoRonda(id)` |

**Cenário de falha real:** Gestor no iPhone abre o app como PWA (ícone na home screen), tenta excluir um veículo ou geocerca → `confirm()` retorna `false` silenciosamente → nada acontece → o cliente acha que há um bug e que o sistema não responde.

Todas essas operações são **destrutivas e irreversíveis** — excluir um cliente remove veículos, geocercas e histórico vinculados.

**Ação necessária antes do primeiro cliente:** Substituir todos os `confirm()` por `felogixConfirm()` (que já existe e funciona no iOS).

---

## 5. Cadastro do Primeiro Veículo

### Pontos positivos
- Formulário bem estruturado com radio buttons para tipo de rastreamento
- Texto explicativo para cada opção ("Rastreamento por GPS em tempo real")
- Upload de foto opcional
- Validação mínima presente (`if (!body.placa||!body.cliente_id)`)

### Problemas encontrados

**[MÉDIO-1] IMEI sem validação de formato**

O campo IMEI aceita qualquer texto. Um erro comum é o instalador confundir IMEI (15 dígitos) com IMSI do chip SIM (20 dígitos). Sem feedback imediato, o cliente só descobre que o IMEI está errado quando o veículo não aparece no mapa — e não sabe por quê.

Sugestão: Adicionar validação de 15 dígitos numéricos com feedback inline antes do envio.

**[MÉDIO-2] Nenhuma instrução sobre como encontrar o IMEI**

O placeholder é `"Ex: 358899012345678"`, mas um primeiro cliente não sabe que o IMEI está na etiqueta traseira do rastreador, ou que pode ser obtido via SMS `IMEI#`. Uma linha de ajuda como "📡 Encontre no rastreador via SMS: IMEI#" reduziria dúvidas de suporte.

**[MÉDIO-3] Placa sem máscara de formato**

O campo placa tem `style="text-transform:uppercase"` (bom), mas não tem máscara para formatos `ABC-1234` (padrão antigo) ou `ABC1D23` (Mercosul). Um cliente pode digitar `ABC1234` (sem traço) e o formato fica inconsistente na lista.

---

## 6. Mapa

### Pontos positivos
- Marcadores com placa visível embaixo
- Cores semânticas: azul=em rota, âmbar=parado, vermelho=bloqueado, cinza=offline
- Clustering funcional para frotas grandes
- Sidebar com contadores (Online / Em rota / Parado)
- Busca por placa na sidebar
- Trail de histórico do dia em azul

### Problemas encontrados

**[ALTO-5] Chip "LIVE" visível apenas para admin**

```js
if (CU.role === 'admin') document.getElementById('liveChip').style.display = 'flex';
```

O chip verde piscante "● LIVE" que indica conexão em tempo real é mostrado **apenas para o admin**. Um gestor com veículos em rota não tem nenhum indicador visual de que o rastreamento está ativo. Ele não sabe se está vendo dados ao vivo ou uma captura estática de quando fez login.

Sugestão: Mostrar o chip para gestor também, especialmente quando o WS está conectado.

**[MÉDIO-4] Mapa mobile começa com sidebar fechada**

```js
mapSbOpen = window.innerWidth > 680;
```

Em telas menores que 680px (a maioria dos smartphones), a sidebar de veículos começa fechada. O botão ☰ para abri-la é um FAB discreto no canto inferior esquerdo. Um primeiro usuário mobile pode não perceber que existe uma lista de veículos acessível — especialmente se o mapa estiver vazio por falta de posições.

**[MÉDIO-5] FABs do mapa sem label ou tooltip**

Os três botões flutuantes usam:
- `☰` — abre/fecha sidebar (não óbvio)
- `⊙` — centraliza no mapa (completamente ambíguo)
- `📍` — minha localização

O `⊙` é o mais problemático: um cliente nunca vai adivinhar que esse símbolo significa "ver todos os veículos no mapa". Em desktop seria possível um tooltip; em mobile, ao menos a aria-label deveria ser descritiva.

**[BAIXO-4] Mapa inicializa centrado em São Paulo**

```js
map = L.map('map').setView([-23.549,-46.638], 13);
```

Para um cliente em Recife, Belém ou Porto Alegre, a primeira vez que o mapa abre mostra São Paulo — e então centraliza nos veículos (se existirem). Se não houver veículos, o mapa fica mostrando São Paulo indefinidamente.

Sugestão: Tentar usar `navigator.geolocation` para centralizar na localização do gestor na primeira abertura. Se não disponível, manter São Paulo.

**[ALTO-6] Texto hardcoded "EC33" no painel de eventos**

Na função `openBS` (painel de detalhes do veículo no mapa):

```js
<div class="ev-item">
  <div class="ev-ic">📡</div>
  <div class="ev-txt" style="color:var(--t2)">Aguardando conexão do rastreador EC33</div>
</div>
```

O texto "EC33" é o nome de um modelo de rastreador específico — provavelmente do período de desenvolvimento. Todo cliente vê essa mensagem com um modelo de hardware que pode não ser o dele (o rastreador do projeto é GT06). Além disso, a mensagem aparece mesmo quando o veículo está online e enviando posições, porque a seção de eventos não é dinâmica.

**Ação:** Remover ou substituir por "Aguardando eventos do rastreador" ou simplesmente omitir quando não há eventos.

---

## 7. Aba Veículos

### Pontos positivos
- Card com foto, placa, modelo, ano, cor
- KPI boxes mostrando velocidade e status
- Botão "Ver no mapa" navega para o mapa e abre o painel do veículo
- Admin vê nome do cliente e tipo de rastreamento

### Problemas encontrados

**[ALTO-7] Status dos veículos não atualiza em tempo real na aba Veículos**

Quando o usuário abre a aba Veículos, `renderVeiculos` é chamada e reinicia `VEHICLES` com `status: 'offline'`. Os KPI boxes mostram sempre `km/h: —` e `status: offline`, independente de o veículo estar em movimento.

O WebSocket e o `liveMove` atualizam o estado do objeto `VEHICLES`, mas a aba Veículos só exibe o HTML gerado no momento da renderização inicial — sem listeners para atualizar os cards em tempo real.

**Cenário real:** Gestor vai para aba Veículos para verificar a frota → vê todos os veículos como "offline" com velocidade "—" mesmo com veículos em rota → não confia nas informações.

**[MÉDIO-6] Campo IMEI editável sem confirmação de consequência**

No modal de edição de veículo (`openEditVeiculo`), o campo IMEI pode ser alterado livremente. Mudar o IMEI de um veículo com rastreamento ativo desvincula o rastreador sem aviso. Uma nota como "⚠️ Alterar o IMEI desvincula o rastreador atual" reduziria erros acidentais.

---

## 8. Alertas e Notificações Push

### Pontos positivos
- Seção bem organizada: push → email → tipos de alerta → histórico
- Toggles para cada tipo de alerta
- Histórico de eventos com data/hora

### Problemas encontrados

**[MÉDIO-7] Botão push com ícone semanticamente invertido**

```js
// Quando ativo:
btn.textContent = '🔔 Desativar notificações';
// Quando inativo:
btn.textContent = '🔕 Ativar notificações';
```

O ícone 🔔 (sino cheio) aparece quando as notificações estão **ativas** — mas o texto diz "Desativar". Um usuário intuitivo associa 🔔 = "notificações ligadas", não "clique aqui para desligar". O par correto seria:

- Ativas: `✅ Notificações ativas — Desativar`
- Inativas: `🔕 Notificações inativas — Ativar`

Ou uma lógica mais clara: estado descrito explicitamente, botão de ação separado.

**[MÉDIO-8] Geocercas instruem o usuário a navegar para outra aba**

Na tela de Geocercas há um texto de ajuda:

```
📍 Defina uma área no mapa. Quando o veículo entrar ou saír dela,
um alerta é registrado (ative em Alertas → Saída de geocerca).
```

O usuário precisa ir manualmente para a aba Alertas para ativar o alerta de geocerca. Poderia ser um link direto ou um toggle embutido na tela de geocercas.

**[MÉDIO-9] Tipo de alerta "Ignição fora do horário" sem campo de configuração**

```js
{k:'horario', ic:'🔑', nome:'Ignição fora do horário', desc:'Ligou fora do turno configurado'}
```

Existe um toggle para "Ignição fora do horário", mas não há campo para o gestor definir qual é o "turno". Ativar esse alerta sem configurar o horário provavelmente não dispara nada (ou dispara erroneamente). O toggle deveria ser desabilitado ou mostrar "Em breve" enquanto a configuração de horário não existe.

---

## 9. Textos e Mensagens de Erro

### Problemas encontrados

**[MÉDIO-10] Mensagens de erro genéricas**

A função `api()` lança `throw new Error(d.erro || 'Erro')`. Quando o backend retorna apenas `{ erro: 'Erro' }`, o cliente vê o toast "Erro" sem contexto algum.

Revisitar as mensagens de erro do `server.js` para garantir que todas sejam descritivas:
- ❌ "Erro" → ✅ "Falha ao salvar o veículo. Tente novamente."
- ❌ "Credenciais inválidas" (OK, mas poderia ser mais amigável) → ✅ "Email ou senha incorretos."

**[BAIXO-5] Campo "Nova senha" em modo edição de cliente é `type="text"`**

```html
<input id="eSenha" type="text" placeholder="Nova senha…"/>
```

A senha é exibida em texto plano no formulário de edição de cliente. Um admin que edita a senha de um cliente em uma tela compartilhada expõe a nova senha. Deveria ser `type="password"`.

**[BAIXO-6] Texto de evento no mapa não diferencia "sem histórico" de "sem rastreador"**

Quando um veículo não tem histórico do dia, o `loadHistorico` mostra:
```
Sem deslocamento registrado hoje
```

Para um veículo sem IMEI (sem rastreador), esta mensagem é enganosa — não há "sem deslocamento", há simplesmente ausência de rastreador. Deveria verificar se `v.imei` é null e mostrar mensagem apropriada.

---

## 10. Navegação e Responsividade

### Pontos positivos
- Bottom nav com `env(safe-area-inset-bottom)` para iOS com home bar
- Destaque vermelho no tab ativo
- Transição suave entre abas

### Problemas encontrados

**[BAIXO-7] `maximum-scale=1, user-scalable=no` no viewport**

```html
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
```

Desabilitar o zoom do usuário é uma violação da acessibilidade (WCAG 1.4.4) e considerada má prática. Usuários com baixa visão dependem do pinch-to-zoom. O iOS ignora essa restrição desde a versão 10, mas outros browsers (Android) ainda a respeitam.

**[BAIXO-8] Badge "Gestor" / "Colaborador" na topbar em toda página**

O badge de role ocupa espaço visual permanente na topbar. O usuário já sabe que é gestor. Esse espaço poderia ser melhor usado para indicadores de status (veículos online, alertas ativos).

**[BAIXO-9] Toast em `bottom: 80px` sem ajuste para safe area**

```css
.toast{position:fixed;bottom:80px;...}
```

A bottom nav tem `padding-bottom: env(safe-area-inset-bottom)`, mas o toast está fixo em `80px`. No iPhone 14/15 com home bar (~34px safe area), o toast pode ficar muito próximo ou sobrepor a bottom nav.

---

## 11. Aparência Profissional — Pontos de Atenção

| Aspecto | Avaliação | Observação |
|---|---|---|
| Design visual | ✅ Profissional | Dark theme consistente, boa hierarquia |
| Tipografia | ✅ Excelente | Inter + JetBrains Mono — escolha correta |
| Cores | ✅ Coerente | Vermelho da marca bem aplicado |
| Ícones | ⚠️ Emoji misto | Mix de emoji (🚗, 📍, ☰) e SVG custom — em desktop fica inconsistente |
| Animações | ✅ Discretas | Spinner, fade do toast, transições dos modais |
| Estados vazios | ✅ Bem construídos | Emoji + título + subtítulo |
| Estados de erro | ⚠️ Inconsistentes | Às vezes toast, às vezes empty state com ⚠️, às vezes inline |
| Loading | ✅ Presente | Spinner nas seções que carregam dados |
| Formulários | ✅ Bom | Labels uppercase, focus em vermelho |
| Feedback de ação | ⚠️ Dependente de toast | Toast desaparece rápido; ações críticas deveriam ter confirmação mais permanente |

---

## 12. Resumo Priorizado de Melhorias

### 🔴 Crítico — Bloqueia uso em iOS (corrigir antes do primeiro cliente)

| ID | Problema | Impacto |
|---|---|---|
| C-1 | `confirm()` nativo em 4 fluxos de exclusão (cliente, veículo, geocerca, ponto de ronda) | Operações destrutivas não funcionam no iOS PWA; dados não são excluídos mas o usuário não recebe feedback |

### 🟠 Alto — Transmite produto inacabado

| ID | Problema | Impacto |
|---|---|---|
| A-1 | Texto hardcoded "EC33" no painel de eventos do veículo | Transmite produto incompleto / de desenvolvimento |
| A-2 | Empty state do mapa não orienta o próximo passo por role | Primeiro usuário fica perdido sem saber o que fazer |
| A-3 | Chip "LIVE" só para admin; gestor não sabe se o rastreamento está ativo | Falta de confiança nos dados exibidos |
| A-4 | Status dos veículos na aba Veículos não atualiza em tempo real | Gestor vê todos como "offline" mesmo com frota em rota |
| A-5 | Campo "Nova senha" no formulário de edição é `type="text"` | Exposição de senha em tela compartilhada |

### 🟡 Médio — Fricção na experiência

| ID | Problema | Impacto |
|---|---|---|
| M-1 | IMEI sem validação de formato (15 dígitos) | Erros de digitação só descobertos depois |
| M-2 | Nenhuma instrução de como obter o IMEI | Chamadas de suporte desnecessárias |
| M-3 | Placa sem máscara de formato | Inconsistência nos dados |
| M-4 | Mapa mobile começa com sidebar fechada | Usuário não descobre a lista de veículos |
| M-5 | FABs ☰, ⊙, 📍 sem label ou tooltip | ⊙ especialmente ambíguo |
| M-6 | Botão push com ícone semanticamente invertido | Usuário confunde "ativar" e "desativar" |
| M-7 | Geocerca instrui navegação para outra aba para ativar alerta | Fricção desnecessária no fluxo |
| M-8 | Toggle "Ignição fora do horário" sem campo de configuração de turno | Funcionalidade incompleta exposta |
| M-9 | Mensagens de erro genéricas ("Erro") | Usuário não sabe o que falhou |
| M-10 | Campo IMEI editável sem aviso de consequência | Risco de desvincular rastreador acidentalmente |
| M-11 | Sem tela/banner de onboarding no primeiro login | Churn nos primeiros dias por falta de direcionamento |

### 🔵 Baixo — Polimento

| ID | Problema | Impacto |
|---|---|---|
| B-1 | Sem atributo `name` nos inputs de login | Alguns gerenciadores de senha não preenchem automaticamente |
| B-2 | Sem "Lembrar de mim" / sessão longa | Login obrigatório a cada 12h |
| B-3 | Mapa inicializa centrado em São Paulo | Primeiro load confuso para clientes em outras regiões |
| B-4 | Badge de role na topbar (redundante para o usuário) | Ocupa espaço que poderia ser usado para status |
| B-5 | `maximum-scale=1, user-scalable=no` no viewport | Acessibilidade prejudicada |
| B-6 | Toast sem ajuste de safe area no iOS | Pode sobrepor bottom nav |
| B-7 | Subtítulo da login ("Acesso à plataforma") genérico | Não comunica valor do produto |
| B-8 | Mix de emoji e SVG para ícones | Inconsistência visual em desktop |
| B-9 | Sem "lembrar de mim" | — (duplicata do B-2) |
| B-10 | Histórico mostra "Sem deslocamento" mesmo sem rastreador | Mensagem enganosa |

---

## 13. Fluxo Completo — Como o Primeiro Cliente Experimenta

```
1. Acessa felogix.com.br/track
   → Vê login profissional ✅
   → Não entende o que é "Track" por subtítulo genérico ⚠️

2. Faz login com credenciais recebidas por email
   → Cai no mapa vazio "Nada para rastrear ainda" ⚠️
   → Não sabe o que fazer a seguir ⚠️

3. Navega para "Veículos"
   → Vê tela vazia "Aguarde o administrador cadastrar seus veículos" ⚠️
   → (o admin precisa ser acionado separadamente)

4. Admin cadastra veículo com IMEI
   → IMEI sem validação; cliente digita errado sem saber ⚠️
   → Veículo aparece na lista como "Offline" ✅

5. Rastreador GT06 liga e conecta
   → Mapa começa a mostrar posição ✅
   → Gestor não sabe se os dados são ao vivo (sem chip LIVE) ⚠️
   → Velocidade e status nunca atualizam na aba Veículos ⚠️

6. Gestor tenta excluir veículo de teste no iPhone
   → Clica "Remover" → confirm() retorna false silenciosamente → nada acontece 🔴
   → Cliente acha que é bug

7. Gestor cria geocerca
   → Cria com sucesso ✅
   → Tela instrui "ative em Alertas → Saída de geocerca" ⚠️
   → Vai para Alertas, ativa toggle, salva ✅

8. Alerta de velocidade dispara
   → Aparece em "Últimos alertas" ✅
   → Notificação push funciona no Android ✅
   → No iPhone: funciona apenas iOS 16.4+ ✅ (com aviso de incompatibilidade)
```

---

## 14. Sugestões para Tornar o Produto Mais Profissional

### Curto prazo (antes do primeiro cliente)

1. **Corrigir todos os `confirm()` nativos** para `felogixConfirm()` — bloqueia iOS.
2. **Remover texto "EC33"** do painel de eventos — transmite desenvolvimento.
3. **Tornar chip "LIVE" visível para gestor** — confiança no dado em tempo real.
4. **Campo senha em edição de cliente** → `type="password"`.
5. **Empty state do mapa com call-to-action por role** — orienta o próximo passo.

### Médio prazo (Sprint 2 — antes da segunda venda)

6. **Atualização de status em tempo real na aba Veículos** — gestor precisa confiar nos dados.
7. **Validação de IMEI** (15 dígitos numéricos) com feedback inline.
8. **Instrução de como obter o IMEI** embutida no formulário.
9. **Banner de onboarding** no primeiro login com 3 passos.
10. **Corrigir semântica do botão push** (ativo/inativo mais claro).
11. **Desabilitar toggle "Ignição fora do horário"** até que a configuração de turno exista.

### Longo prazo (Sprint 3)

12. Substituir emoji por ícones SVG consistentes na navegação e nos FABs.
13. Adicionar tooltips nos FABs do mapa.
14. Centralizar mapa na localização do gestor (geolocalização do browser).
15. Link direto de "Geocercas → Alertas" para ativar sem mudar de aba.
16. Máscaras de formatação para placa e IMEI.
17. Sessão longa / "lembrar de mim" para não exigir login a cada 12h.

---

## 15. Veredito

### ⚠️ Aprovado com ressalvas — Quase pronto para o primeiro cliente

O Felogix Track tem **aparência de produto profissional** e **funcionalidade real e útil**. As bases estão corretas.

Os **5 itens que precisam ser resolvidos antes do primeiro cliente pagante**:

| Prioridade | Item |
|---|---|
| 🔴 Crítico | `confirm()` em exclusão de veículo, cliente, geocerca e ponto de ronda (iOS PWA) |
| 🟠 Alto | Texto "EC33" hardcoded no painel de eventos |
| 🟠 Alto | Chip "LIVE" visível apenas para admin |
| 🟠 Alto | Status na aba Veículos não atualiza em tempo real |
| 🟠 Alto | Campo senha em edição (`type="text"`) |

Com esses 5 itens resolvidos, o produto está em condição de receber os primeiros clientes piloto com confiança.

---

*Auditoria realizada em `claude/felogix-dev-assistant-macmsv` @ 2026-07-01.*
*Escopo: `public/index.html` (~2750 linhas). Nenhum código foi alterado.*
