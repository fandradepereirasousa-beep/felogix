# ATIVACAO-EC33.md

**Roteiro de ativação do rastreador EC33 — do unboxing ao mapa do Track**

## O que chegou (conferido nas fotos de 06/07)

| Item | Detalhe |
|---|---|
| Rastreador **EC33** | GNSS Vehicle Terminal 4G · 9–90V · bateria interna 300mAh · homologado Anatel |
| **IMEI** | `867689067476640` (etiqueta traseira — QR code abre o manual) |
| Relé de corte | HKVF4-4C12-B · 12V · 40A, com soquete (fios amarelo, branco e 2 verdes) |
| Chicote | Conector multi-pinos, fio vermelho com porta-fusível |

> O EC33 fala o protocolo da **família GT06** — o mesmo que o listener do Traccar na porta 5023 e o mesmo que o `simulador-gt06.js` usa. Toda a cadeia já validável por simulação vale para ele.

---

## PASSO 1 — Chip (antes de tudo)

- Chip **nano-SIM** com plano de **dados** (qualquer operadora com sinal bom na sua região; um pré-pago comum serve para o piloto)
- **Desativar o PIN do chip** antes de inserir (coloque num celular → Configurações → Segurança do SIM → desativar bloqueio)
- Anotar o **número de telefone do chip** — é para ele que você manda os SMS de configuração
- Inserir no slot do EC33 (visível com a tampa aberta; trava "LOCK" desliza) e fechar a tampa

## PASSO 2 — Energizar na bancada (NÃO instale no carro ainda)

O teste de bancada isola problemas: se algo falhar, você sabe que não é a fiação do carro.

- **Vermelho** → +12V (bateria de carro/moto, ou fonte 12V) — o porta-fusível já vem no fio
- **Preto** → negativo/GND
- A bateria interna de 300mAh é só backup — para o primeiro boot use alimentação externa
- LED deve acender/piscar. Deixe **perto de janela ou área aberta** para pegar GPS

## PASSO 3 — Configurar por SMS

Mande os SMS abaixo **para o número do chip do rastreador**, um por vez, aguardando a resposta de cada um. Sintaxe da família GT06/Concox (confirme no manual pelo QR code do aparelho se alguma não responder):

```
APN,<apn da operadora>#
SERVER,1,felogix.com.br,5023,0#
TIMER,10#
RESET#
```

**APN por operadora (Brasil):**

| Operadora | Comando |
|---|---|
| Vivo | `APN,zap.vivo.com.br,vivo,vivo#` |
| Claro | `APN,claro.com.br,claro,claro#` |
| TIM | `APN,timbrasil.br,tim,tim#` |
| Oi | `APN,gprs.oi.com.br,oi,oi#` |

- `SERVER,1,...` usa domínio; se o aparelho não aceitar, use `SERVER,0,<IP do VPS>,5023,0#` (0 = por IP)
- `TIMER,10#` = posição a cada 10 segundos
- `RESET#` reinicia para aplicar
- Comandos úteis: `STATUS#` (estado geral) e `PARAM#` (configuração atual)
- Se os comandos não responderem, o manual (QR code na etiqueta) traz a sintaxe exata — alguns lotes usam senha padrão no início do comando (ex.: `666666APN,...`)

## PASSO 4 — Cadastrar nos dois sistemas

1. **Traccar** (`http://SEU_VPS:8082`): Dispositivos → **+** → Nome `EC33 Piloto` · Identificador `867689067476640`
2. **Felogix** (`https://felogix.com.br/track`, como admin): Veículos → **＋ Veículo** → tipo **Rastreador Real (IMEI)** → IMEI `867689067476640` → placa e cliente reais do piloto

## PASSO 5 — Ver o aparelho conectar

No VPS, acompanhe o log do Traccar:

```bash
tail -f /opt/traccar/logs/tracker-server.log | grep -i 8676890
```

**O que deve aparecer:** uma linha com o IMEI e o protocolo identificado (ex.: `[gt06]`). Em até ~2 min o device fica `Online` no painel do Traccar, e o veículo aparece no mapa do Track.

**Se conectar numa porta/protocolo diferente de gt06:** o log mostra qual — me avise que eu ajusto.

## PASSO 6 — Validação rápida (com o roteiro completo em TRACK-HARDWARE-TEST.md)

- [ ] Veículo no mapa do Track na posição correta (compare com o GPS do celular)
- [ ] Marcador se move ao caminhar ~100m com o aparelho
- [ ] Velocidade e "visto às" atualizando a cada ~10s
- [ ] Chip ● LIVE aceso no painel
- [ ] Alerta de offline: desligue o aparelho 30+ min → evento registrado

Só depois disso, siga para a instalação física no veículo.

## PASSO 7 — Instalação no veículo (com o relé de corte)

Fiação típica do EC33 (⚠️ **confirme as cores no diagrama do manual do seu lote antes de ligar**):

| Fio do EC33 | Vai para |
|---|---|
| Vermelho (com fusível) | +12V pós-chave ou bateria (constante) |
| Preto | GND (carroceria/negativo) |
| Laranja | Pós-chave (ACC) — detecção de ignição |
| Amarelo | Controle do relé de corte |

Relé HKVF4 (soquete): os 2 fios do contato (verdes) entram **em série** com o circuito da bomba de combustível ou da ignição usando o contato **normalmente fechado** — assim, se o rastreador falhar, o carro continua funcionando. Os fios da bobina (amarelo/branco do soquete) ligam no fio de corte do EC33 e no +12V, conforme o diagrama do manual.

> **Recomendação:** o corte é a única parte com risco real (mexer no circuito de combustível/ignição). Se não tiver prática com elétrica automotiva, vale um instalador de som/alarme para esse passo — é serviço de 30 minutos para quem faz todo dia. O rastreamento em si (passos 1–6) você valida sozinho.

## PASSO 8 — Teste do bloqueio remoto

**Só com o veículo PARADO e em local seguro:**

1. No Track, clicar em **🔒 Bloquear ignição** → confirmar
2. O comando vai via Traccar (`engineStop`) para o EC33
3. Tentar dar partida → não deve ligar
4. **✅ Desbloquear** → partida volta a funcionar

Se o comando não surtir efeito, o log do Traccar mostra se foi enviado/aceito — me mande a saída que eu diagnostico.

---

## Ordem resumida

```
chip sem PIN → bancada 12V → SMS (APN + SERVER + TIMER + RESET)
→ cadastro Traccar + Felogix → aparelho no mapa → caminhar e ver mover
→ instalar no carro → testar corte → rodar TRACK-HARDWARE-TEST.md
```

*Criado quando o hardware chegou (06/07) — IMEI e modelo conferidos por foto.*
