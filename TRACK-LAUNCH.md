# TRACK-LAUNCH.md — Auditoria comercial do Felogix Track

**Data da auditoria:** 30/06/2026
**Escopo:** exclusivamente o módulo **Track** (rastreamento veicular). Fleet, Connect e Patrol foram propositalmente ignorados nesta auditoria — seguem como "Em breve" no site, com o código preservado e intocado.
**Metodologia:** leitura completa do código-fonte real (`server.js`, `public/index.html` e arquivos relacionados), sem suposições. Cada achado abaixo é referenciado com arquivo e linha. **Nenhuma alteração de código foi feita neste trabalho** — este é um documento de análise.
**Referência de mercado:** Cobli, Sascar, OnixSat, Omnilink e demais plataformas profissionais de rastreamento de frotas B2B.

---

## Resumo executivo

O Track tem uma base técnica sólida: integração real com Traccar (bloqueio de ignição via comando real ao hardware, não simulado), motor de alertas funcional, geocercas operacionais, autenticação com lockout por força bruta, e uma identidade visual consistente. **Isso não é um protótipo.**

Mas hoje, na forma atual, o Track **não deve ser vendido**. Existem dois bugs que fabricam dados de localização falsos e os exibem como se fossem reais — em um produto cujo valor central é "saiba onde seu veículo está", isso é o pior tipo de defeito possível: não é uma tela que falta, é o produto mentindo para o cliente. Some isso a uma senha de administrador com fallback em texto puro no código-fonte, e o quadro fica claro: **a prioridade não é nenhuma funcionalidade nova — é parar de inventar dados e fechar os buracos de segurança crítica antes de qualquer coisa.**

Depois disso resolvido, o maior fosso competitivo frente a Cobli/Sascar/Omnilink é: histórico de trajetos preso a 24h sem exportação, alertas com limiar único e global (não configurável por veículo/cliente), geocercas apenas circulares, e cobrança 100% manual sem o cliente conseguir ver a própria fatura dentro do sistema.

---

## 1. BLOQUEADORES — impede o Track de ser vendido hoje

Itens que tornam a venda comercial irresponsável ou arriscada (confiança, segurança, ou risco legal) até serem corrigidos.

### B1. O mapa inventa movimento de veículo quando não há dado real (CRÍTICO)
**Onde:** `public/index.html`, função `applyPosicoes()`, linhas 936-942.
```js
} else {
  VEHICLES.forEach(v => {
    if (v.status==='moving' && !v.bloqueado) {
      v.lat += (Math.random()-.5)*.002; v.lng += (Math.random()-.5)*.002;
      v.speed = Math.round(Math.max(20,Math.min(90,v.speed+(Math.random()-.5)*10)));
    }
  });
}
```
Esse branch roda sempre que a API `/api/posicoes` devolve uma lista vazia — **inclusive quando a chamada falha** (`liveMove()`, linha 962-964, chama `applyPosicoes([])` dentro do `catch`). Ou seja: se o Traccar cair, a internet do servidor falhar, ou simplesmente não houver posição nova, o mapa **não mostra "offline" — ele simula o carro andando sozinho**, com velocidade e posição aleatórias, indistinguível de um sinal real para o usuário.

Isso parece resquício de um modo demo/simulação que não foi removido antes de ligar o rastreamento real. Em um produto vendido para recuperação de veículo roubado, segurança patrimonial ou prova jurídica de localização, isso é inaceitável: o cliente pode tomar uma decisão (acionar a polícia em um endereço, confiar numa rota) baseado numa posição fabricada.
**Complexidade da correção: Baixa.** Remover o branch de simulação; em vez disso, marcar os veículos como "offline"/"sem sinal" quando não há posição.

### B2. A aba "Veículos" contamina o mapa com coordenadas falsas (CRÍTICO)
**Onde:** `public/index.html`, função `renderVeiculos()`, linha 1172.
```js
VEHICLES = vs.map(v => ({ ...v, status: v.bloqueado?'blocked':'offline', speed:0,
  lat:-23.55+Math.random()*.08, lng:-46.63+Math.random()*.08, ignition:false, updated:'offline' }));
```
`VEHICLES` é o **mesmo array global** usado pelo mapa em tempo real (`addMkr`/`syncMkrs`, linhas ~748-781). Quando o usuário visita a aba "Veículos", essa função sobrescreve `VEHICLES` inteiro com coordenadas aleatórias próximas a São Paulo. Como `addMkr`/`syncMkrs` só checam `v.lat == null`, essas coordenadas falsas são plotadas como marcadores reais no mapa para qualquer veículo que não receba uma atualização de WebSocket logo em seguida para sobrescrever o valor.
Combinado com o B1, isso significa que **duas rotas distintas do app fabricam posição de veículo** — não é um bug isolado, é um padrão arquitetural ausente de isolamento de estado entre telas que compartilham a mesma variável global.
**Complexidade da correção: Baixa.** Não popular `lat`/`lng` com valor inventado (usar `null`, como já faz `loadVehicles()` corretamente); idealmente, isolar o estado da lista do estado do mapa em variáveis separadas.

### B3. Senha de administrador com fallback em texto puro no código-fonte
**Onde:** `server.js`, linha 29.
```js
const ADMIN_PASS = process.env.ADMIN_PASS || '95050578.Fege';
```
Se a variável de ambiente `ADMIN_PASS` não estiver setada em produção, o sistema usa essa senha fixa, visível para qualquer pessoa com acesso ao repositório (incluindo o histórico do git). É a chave mestra do sistema — acesso admin enxerga todos os clientes, todos os veículos, bloqueia/desbloqueia qualquer ignição.
**Complexidade da correção: Baixa.** Remover o fallback; falhar a inicialização do servidor se `ADMIN_PASS` não estiver definida.

### B4. Senhas de clientes e colaboradores armazenadas em texto puro
**Onde:** tabelas `clientes.senha` e `colaboradores.senha`, comparadas com `===` no login.
Já era debt técnica documentada antes desta auditoria, mas para um produto que está prestes a ser vendido comercialmente — e que lida com dados de localização e bloqueio remoto de veículos de terceiros — isso deixa de ser aceitável como "problema conhecido para depois". Qualquer vazamento de banco de dados expõe a senha de login de **todos** os clientes e colaboradores em texto legível.
**Complexidade da correção: Média.** Migrar para hash (bcrypt/scrypt — já existe `hashSenha()`/`verificarSenha()` implementado para senhas de link de rastreamento, é só reaproveitar o padrão), com migração das senhas existentes (forçar redefinição no próximo login, por exemplo).

### B5. Bloqueio remoto de ignição sem confirmação
**Onde:** `public/index.html`, `toggleBlock()`, linhas 912-922 — chamado direto pelo botão `🔒 Bloquear ignição` (linha 856-857), sem `confirm()` nem modal intermediário.
Cortar a ignição de um veículo é uma ação com potencial de risco físico real se o veículo estiver em movimento. Um toque acidental no botão (situação comum em telas mobile, que é o padrão de UI deste app) dispara o comando imediatamente. Sistemas como Cobli e Sascar exigem uma confirmação explícita para esse tipo de comando justamente por esse risco.
**Complexidade da correção: Baixa.** Adicionar um `confirm()`/modal de confirmação antes de chamar a API, com texto de aviso quando o veículo estiver em movimento.

---

## 2. MELHORIAS OBRIGATÓRIAS — necessárias antes do lançamento comercial, mas não bloqueiam uma venda imediata como os itens acima

### O1. Histórico de trajetos limitado a 24h, sem seleção de data
**Onde:** `server.js`, `/api/veiculos/:id/historico`, linhas 2125-2144 — a janela é hardcoded (`from = Date.now() - 24*60*60*1000`), sem nenhum parâmetro de data aceito pela API. O frontend (`loadHistorico()`, linha 806) também não oferece seletor de período — o rótulo é literalmente fixo em "Histórico de hoje".
Cobli, Sascar e Omnilink oferecem histórico de 30 a 90+ dias com seletor de data. Hoje, se um cliente do Track perde o veículo e quer ver onde ele esteve há 3 dias, **o sistema não tem essa informação acessível** — mesmo que o Traccar provavelmente tenha esse dado.
**Complexidade: Média.** Parametrizar `from`/`to` na API e adicionar seletor de data no frontend.

### O2. Sem exportação de relatórios (CSV/PDF) no Track
Patrol já tem geração de PDF (fechamento de plantão) — Track não tem equivalente para trajetos ou eventos de alerta. Para fins de prestação de contas, prova em ocorrência policial ou auditoria interna do cliente, a ausência de exportação é uma lacuna real frente aos concorrentes.
**Complexidade: Média.**

### O3. Consulta de cliente do lado do gestor não existe na tela financeira
**Onde:** `server.js`, todos os endpoints `/api/financeiro/*` (linhas 2658+) são `adminOnly`. O gestor (cliente pagante) **não tem nenhuma tela para ver sua própria fatura, histórico de pagamento ou valor devido** dentro do sistema — confirmado também no frontend: a aba "Financeiro" só aparece em `adminTabs` (`index.html` linha 480), nunca em `gestorTabs`.
Um produto comercial não pode depender de o cliente confiar cegamente em cobrança enviada por e-mail sem conseguir conferir o histórico dentro do próprio painel.
**Complexidade: Média.** Endpoint `GET /api/financeiro/minhas-faturas` escopado por `cliente_id`, e uma aba simples de "Minhas Faturas" para o gestor.

### O4. Limiar de alerta de velocidade é único e global, não configurável
**Onde:** `server.js`, linha 54 (constante `ALERTA_VELOCIDADE_LIMITE = 100`), usada por todos os clientes e veículos sem exceção. Não existe campo no frontend (`renderAlertas()`) para ajustar esse valor por veículo ou por cliente.
Frotas reais têm perfis de uso muito diferentes (urbano vs. rodoviário, moto vs. caminhão) — um limiar fixo de 100km/h é inútil para boa parte dos casos de uso e é uma das primeiras coisas que um concorrente como Sascar permite configurar por veículo.
**Complexidade: Média.** Adicionar coluna de limiar por veículo (ou por cliente como padrão), com fallback para o valor global.

### O5. Alerta de "horário" é uma opção morta na interface
O toggle de alerta por "horário" existe na tela de Alertas, mas não há lógica correspondente de avaliação de janela de horário no motor de alertas (`avaliarAlertas()`). O cliente pode ativar uma opção que não faz nada — isso é pior do que não ter a opção, porque cria uma falsa expectativa de proteção.
**Complexidade: Baixa** (remover o toggle até a feature existir) **ou Alta** (implementar a feature de verdade).

### O6. Consulta de posições com N+1 queries a cada ciclo de 5 segundos
**Onde:** `server.js`, `getPosicoesEnriquecidas()`, linhas 1979-1997 — para cada posição recebida do Traccar, faz uma query separada ao Postgres dentro de um loop (`for (const pos of posicoes) { await pool.query(...) }`). Essa função roda a cada 5 segundos (`broadcastPosicoes()`) para alimentar WebSocket e o motor de alertas.
Com poucos veículos isso não é perceptível, mas é uma escolha que não escala: 50 veículos = 50 queries sequenciais a cada 5s, só para uma tarefa que é um único `JOIN`. Antes de vender para clientes com frotas maiores, isso precisa ser corrigido.
**Complexidade: Baixa.** Substituir o loop por um único `SELECT ... WHERE traccar_device_id = ANY($1)` ou `JOIN`.

### O7. Sem paginação nas principais listagens
`/api/alertas/eventos` tem `LIMIT 50` fixo e sem parâmetro de página (linha 2547); listas de veículos, clientes e histórico de alertas não têm paginação em lugar nenhum identificado. Funciona bem com poucos registros, mas é uma bomba-relógio de performance e usabilidade assim que a base de clientes crescer.
**Complexidade: Média.**

### O8. Duplicação do código de verificação de propriedade (ownership check)
O padrão abaixo se repete quase identicamente em mais de 10 endpoints (geocercas, compartilhamentos, grupos, veículos, histórico):
```js
if (req.user.role !== 'admin' && X.cliente_id !== req.user.id)
  return res.status(403).json({ erro: 'Sem permissão...' });
```
Não é só estética — duplicação desse tipo é onde bugs de segurança nascem: basta um endpoint novo esquecer essa checagem (ou implementá-la com uma variação sutil) para abrir uma brecha de acesso entre clientes. Antes de crescer a base de código, vale a pena extrair isso para um middleware reutilizável (`requireOwnership(tabela, campo)`).
**Complexidade: Média.**

### O9. CSP permite `unsafe-inline` para scripts e estilos
**Onde:** `server.js`, cabeçalhos de segurança, linhas ~138-146. Isso neutraliza boa parte da proteção que um CSP deveria oferecer contra XSS, já que basta injetar uma tag `<script>` inline para executar código arbitrário caso exista qualquer brecha de injeção de HTML em outro lugar do sistema.
**Complexidade: Alta** (exige reescrever o frontend para não depender de `onclick="..."` inline e estilos inline, que são usados extensivamente em todo o `index.html` — esforço real, não trivial).

---

## 3. MELHORIAS RECOMENDADAS — fortalecem a posição competitiva, não bloqueiam o lançamento

### R1. Geocercas poligonais (além de circulares)
Hoje só existe geocerca circular (raio de 50-20.000m, `server.js` `/api/geocercas`). Concorrentes oferecem desenho livre de polígono no mapa, essencial para delimitar áreas irregulares (bairros, rotas autorizadas, pátios não circulares).
**Complexidade: Alta.**

### R2. Importação em massa de veículos (CSV)
Cadastro de veículo hoje é 100% manual, um por um, via modal (`openAddVeiculo()`). Para um cliente com frota de 30+ veículos, isso é um atrito de onboarding real.
**Complexidade: Média.**

### R3. Cobrança automática / gateway de pagamento online
O módulo financeiro (`server.js` linhas 2657+) é inteiramente manual: chave PIX estática (linha 27, hardcoded no código-fonte), disparo de cobrança por e-mail feito manualmente pelo admin, sem integração com gateway (Stripe, Mercado Pago, PagSeguro etc.), sem geração automática de fatura recorrente.
Funciona para uma base pequena de clientes geridos manualmente, mas não escala como motor de receita de um produto comercial de verdade.
**Complexidade: Alta.**

### R4. Exportação de chave PIX para configuração, não hardcoded
**Onde:** `server.js`, linha 27 — `const PIX_KEY = '54.054.345/0001-57';`. Mover para variável de ambiente ou tabela de configuração, especialmente se o negócio um dia precisar trocar de chave/conta bancária sem fazer deploy.
**Complexidade: Baixa.**

### R5. Autenticação de dois fatores (2FA) para admin e gestor
Hoje a única proteção contra acesso indevido é a senha (mesmo com lockout por força bruta). Para uma conta admin que controla bloqueio remoto de veículos de todos os clientes, 2FA é um padrão esperado em produtos de segurança patrimonial.
**Complexidade: Média.**

### R6. Log de auditoria de ações administrativas
Não existe registro de "quem fez o quê" para ações administrativas sensíveis (edição de cliente, exclusão, alteração de plano) além do que `alertas_eventos` cobre para eventos de veículo. Importante para suporte, disputas com cliente e conformidade.
**Complexidade: Média.**

### R7. Layout responsivo para desktop
**Onde:** `public/index.html` tem **exatamente 1 media query em 2710 linhas** (linha 103, `@media (max-width:680px)`), e nenhuma estratégia de grid/tabela/largura máxima para telas largas (`grep` por `grid-template-columns:repeat(auto`, `max-width:1`, `.list-grid` não retornou nenhum resultado). A interface é construída no padrão "app mobile esticado", com topbar fixa de 52px e bottom-nav fixa de 60px — um padrão de navegação por abas no rodapé, natural em celular, mas pouco usual e pouco eficiente em um monitor de desktop.
Isso importa porque o comprador típico de um produto como Track — gestor de frota olhando o painel o dia inteiro — majoritariamente usa desktop, assim como os usuários de Cobli/Sascar/Omnilink, que têm dashboards multi-coluna otimizados para tela grande.
**Complexidade: Alta** (não é um ajuste de CSS pontual — é redesenhar a disposição de telas-chave, como o mapa e as listas, para aproveitar telas largas sem refazer o app do zero).

### R8. Compressão HTTP e cache de assets estáticos
`package.json` não lista `compression` nem nenhuma estratégia de cache-control para os arquivos estáticos servidos por Express. Ganho de performance simples e de baixo risco.
**Complexidade: Baixa.**

### R9. Deploy sem zero-downtime
**Onde:** `.github/workflows/deploy.yml` — `pm2 restart felogix-server` reinicia o processo único na VPS a cada deploy (sem cluster mode, sem blue-green). Há uma janela de indisponibilidade a cada deploy, e nenhuma estratégia de rollback automático além de reverter o commit manualmente.
**Complexidade: Média.**

### R10. Trilha do histórico sem indicação de paradas/ociosidade
O `loadHistorico()` desenha apenas uma polyline simples (linha 817) — não diferencia trechos parados, velocidade por trecho (cor variável), nem marca pontos de parada prolongada. Recurso padrão em concorrentes para análise de jornada.
**Complexidade: Média.**

---

## 4. MELHORIAS FUTURAS — roadmap pós-lançamento, não necessárias para a primeira venda

### F1. Aplicativo mobile nativo (iOS/Android)
Hoje o Track é um PWA/web app responsivo apenas para mobile, sem app nativo na loja. Cobli e Sascar têm apps dedicados — relevante para retenção e percepção de qualidade, mas não bloqueia a venda inicial.
**Complexidade: Alta.**

### F2. Pontuação de comportamento do motorista (curvas bruscas, freadas, aceleração)
Recurso de diferenciação competitiva comum em players maduros do setor, depende de dados de telemetria mais granulares do que o Traccar expõe hoje por padrão.
**Complexidade: Alta.**

### F3. Dashboards com gráficos (km rodado, tempo parado, consumo estimado)
Hoje a interface é majoritariamente baseada em cards de status, sem visualizações analíticas/gráficos de série temporal.
**Complexidade: Média.**

### F4. Alertas de desvio de rota/horário programado
Geofencing temporal (ex: "alerte se o veículo sair da garagem fora do horário comercial") — distinto do toggle "horário" morto mencionado em O5; essa seria a implementação completa da ideia.
**Complexidade: Alta.**

### F5. Multi-idioma / expansão internacional
Hoje todo o texto está hardcoded em português no frontend. Só relevante se houver intenção de expandir para fora do Brasil.
**Complexidade: Alta.**

---

## 5. Ordem ideal de implementação

A ordem abaixo prioriza: (1) parar de mentir para o usuário, (2) fechar buracos de segurança crítica, (3) entregar paridade competitiva básica, (4) só então recursos de diferenciação.

1. **B1 + B2** — remover toda simulação/fabricação de posição de veículo (mapa e lista). *Sem isso, nada mais importa.*
2. **B3** — remover senha admin hardcoded do código-fonte.
3. **B5** — confirmação antes de bloquear ignição remotamente.
4. **B4** — migrar senhas de clientes/colaboradores para hash.
5. **O6** — corrigir N+1 query em `getPosicoesEnriquecidas()` (simples e evita degradação silenciosa de performance enquanto a base cresce).
6. **O5** — decidir entre remover ou implementar o toggle de alerta por horário (não deixar uma opção falsa no ar).
7. **O1 + O2** — histórico de trajetos com seleção de data + exportação CSV/PDF.
8. **O4** — limiar de alerta configurável por veículo/cliente.
9. **O3** — tela de "minhas faturas" para o gestor.
10. **O7** — paginação nas listagens principais.
11. **O8** — extrair middleware de ownership check (facilita manutenção de tudo que vem depois).
12. **O9** — endurecer CSP (remover `unsafe-inline`).
13. **R7** — layout responsivo para desktop (item grande, mas de altíssimo impacto comercial dado o perfil do comprador).
14. **R1 + R2** — geocercas poligonais + importação em massa de veículos.
15. **R3 + R4** — cobrança automática/gateway de pagamento, mover chave PIX para configuração.
16. **R5 + R6** — 2FA e log de auditoria.
17. **R8 + R9 + R10** — performance/infra/UX de histórico, em paralelo conforme capacidade.
18. **F1–F5** — roadmap pós-lançamento, conforme demanda de clientes reais.

---

## 6. Tabela-resumo de complexidade

| Item | Categoria | Complexidade |
|---|---|---|
| B1 — Simulação de movimento falso | Bloqueador | Baixa |
| B2 — Coordenadas falsas em renderVeiculos | Bloqueador | Baixa |
| B3 — Senha admin hardcoded | Bloqueador | Baixa |
| B4 — Senhas em texto puro | Bloqueador | Média |
| B5 — Bloqueio remoto sem confirmação | Bloqueador | Baixa |
| O1 — Histórico limitado a 24h | Obrigatória | Média |
| O2 — Sem exportação de relatórios | Obrigatória | Média |
| O3 — Sem tela financeira para o gestor | Obrigatória | Média |
| O4 — Limiar de alerta não configurável | Obrigatória | Média |
| O5 — Toggle "horário" morto | Obrigatória | Baixa / Alta* |
| O6 — N+1 query nas posições | Obrigatória | Baixa |
| O7 — Sem paginação | Obrigatória | Média |
| O8 — Duplicação de ownership check | Obrigatória | Média |
| O9 — CSP unsafe-inline | Obrigatória | Alta |
| R1 — Geocercas poligonais | Recomendada | Alta |
| R2 — Importação em massa (CSV) | Recomendada | Média |
| R3 — Cobrança automática/gateway | Recomendada | Alta |
| R4 — Chave PIX em configuração | Recomendada | Baixa |
| R5 — 2FA | Recomendada | Média |
| R6 — Log de auditoria | Recomendada | Média |
| R7 — Layout responsivo desktop | Recomendada | Alta |
| R8 — Compressão/cache de assets | Recomendada | Baixa |
| R9 — Deploy zero-downtime | Recomendada | Média |
| R10 — Trilha de histórico enriquecida | Recomendada | Média |
| F1 — App mobile nativo | Futura | Alta |
| F2 — Pontuação de comportamento | Futura | Alta |
| F3 — Dashboards/gráficos | Futura | Média |
| F4 — Alertas de rota/horário programado | Futura | Alta |
| F5 — Multi-idioma | Futura | Alta |

*O5: Baixa se a decisão for remover o toggle; Alta se a decisão for implementar a funcionalidade de verdade.

---

## O que já está bem (não precisa retrabalho)

Para deixar claro que isto não é uma crítica genérica: os seguintes pontos foram verificados como sólidos e **não** entram na lista de problemas:

- Bloqueio remoto de ignição é **real** — chama comando `engineStop`/`engineResume` no Traccar e só persiste o novo estado se o hardware confirmar, não é um toggle de fachada (`server.js`, `PUT /api/veiculos/:id`, linhas 1395-1449).
- Checagem de propriedade (ownership) em endpoints sensíveis está presente e correta em todos os pontos revisados — apenas duplicada (ver O8), não ausente ou furada.
- Login com bloqueio por força bruta (5 tentativas → 15 min de lock) implementado de forma consistente para clientes e colaboradores.
- `/api/esqueci-senha` não revela se um e-mail existe na base — boa prática contra enumeração de contas.
- Geocercas circulares têm UI funcional e bem resolvida (mini-mapa com preview do raio em tempo real).
- WebSocket com fallback de polling, reconexão automática e escopo de dados por papel (admin/gestor/colaborador) implementado corretamente.
- JWT com expiração de 12h para sessões normais (não fica aberto indefinidamente).
- Cadastro de cliente e veículo tem validação de entrada real no backend (e-mail, documento, placa, telefone) — não é só validação client-side.

---

*Documento gerado como parte de auditoria de pré-lançamento comercial. Nenhuma alteração de código foi realizada — apenas leitura e análise.*
