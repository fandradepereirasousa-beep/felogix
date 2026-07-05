# SIMULADOR-GT06.md

**Simulador de rastreador GT06 — validar a cadeia completa antes do hardware chegar**

O script `simulador-gt06.js` se comporta exatamente como um rastreador GT06 físico: abre conexão TCP na porta 5023, faz login com IMEI no formato BCD, envia posições GPS com CRC-ITU e responde como o aparelho real. Se ele funcionar de ponta a ponta, o dia da instalação vira só "parafusar o aparelho no carro".

```
simulador (seu PC) ──TCP──▶ VPS:5023 ──▶ Traccar ──▶ Felogix ──▶ mapa do Track
```

---

## Passo 0 — Validar o protocolo (sem tocar no VPS)

Em qualquer máquina com Node.js:

```bash
node simulador-gt06.js --auto-teste
```

Deve terminar com `✅ AUTO-TESTE PASSOU`. Isso confirma que os pacotes são gerados byte a byte no formato que o Traccar espera (CRC verificado contra pacote da documentação oficial do GT06).

## Passo 1 — Cadastrar o device no Traccar

O Traccar **não aceita IMEI desconhecido** por padrão — igual vai acontecer com o rastreador real.

1. Acesse o painel do Traccar: `http://SEU_VPS:8082` (usuário admin do Traccar)
2. Dispositivos → **+** (adicionar)
3. **Nome:** `Teste Simulador` · **Identificador:** `358899000000001`
4. Salvar

## Passo 2 — Cadastrar o veículo no Felogix

1. Entre em `https://felogix.com.br/track` como **admin**
2. Aba Veículos → **＋ Veículo**
3. Placa `TST-0001` · tipo **Rastreador Real (IMEI)** · IMEI `358899000000001` · escolha um cliente de teste
4. Salvar

O vínculo Felogix↔Traccar (`traccar_device_id`) é resolvido automaticamente na criação do veículo; se não pegar de primeira, o sync roda sozinho a cada 5 minutos.

## Passo 3 — Ligar o simulador

De **qualquer computador com internet** (de propósito — assim você também valida que a porta 5023 está aberta para o mundo, como o chip do rastreador vai precisar):

```bash
node simulador-gt06.js felogix.com.br 358899000000001 -23.55 -46.63
```

Substitua `-23.55 -46.63` pelas coordenadas da sua cidade se quiser ver o "carro" andando perto de você.

**O que deve aparecer no terminal:**

```
✓ TCP conectado — enviando login GT06…
✓ LOGIN ACEITO pelo servidor — o Traccar reconheceu o IMEI.
→ posição #1: -23.55050, -46.63330 · 0 km/h · curso 48°
→ posição #2: ...
```

## Passo 4 — Conferir no Track

Com o simulador rodando, abra o Track no celular ou PC:

- [ ] O veículo `TST-0001` aparece no mapa
- [ ] O marcador **se move** a cada ~10 segundos
- [ ] A velocidade muda no painel lateral e na aba Veículos
- [ ] O chip **● LIVE** está aceso
- [ ] Clicar no veículo abre o painel de detalhe sem erro

## Passo 5 — Testar os alertas (opcional)

**Alerta de velocidade** (limite: 100 km/h):

```bash
node simulador-gt06.js felogix.com.br 358899000000001 -23.55 -46.63 --turbo
```

Com o cliente logado e o alerta de velocidade ativado (aba Alertas), deve chegar o evento "velocidade de XXX km/h" — e push no navegador, se ativado.

**Alerta de geocerca:** crie uma geocerca pequena (raio 500 m) centrada no ponto inicial do simulador. Como o "carro" anda, ele vai sair da área e o alerta de saída deve disparar.

**Alerta de offline:** pare o simulador (Ctrl+C) e aguarde 30+ minutos — o alerta de veículo offline deve ser registrado.

## Passo 6 — Limpeza

Quando terminar: exclua o veículo `TST-0001` no Felogix e o device `Teste Simulador` no Traccar.

---

## Se algo der errado

| Sintoma | Causa provável | Solução |
|---|---|---|
| `✗ Conexão recusada` | Traccar parado ou listener GT06 desabilitado | No VPS: `systemctl status traccar` e conferir `gt06.port` em `/opt/traccar/conf/traccar.xml` (o workflow `setup-traccar.yml` configura) |
| `✗ Timeout de conexão` | Porta 5023 bloqueada no firewall | Liberar 5023/tcp no `ufw`/firewall do provedor — **o rastreador real vai precisar disso de qualquer jeito** |
| Login aceito mas veículo não aparece no mapa | IMEI do device no Traccar ≠ IMEI do veículo no Felogix, ou vínculo ainda não sincronizado | Conferir os dois cadastros; aguardar o sync de 5 min |
| Posição chega no Traccar (visível em `:8082`) mas não no Track | `traccar_device_id` nulo no veículo | Aguardar sync ou recriar o veículo com o IMEI correto |

> **Importante:** cada problema que a simulação revelar agora é um problema a menos no dia da instalação com o cliente esperando.

---

## Opções do script

```
node simulador-gt06.js <host> [imei] [lat] [lon] [opções]

--porta N       porta TCP (padrão: 5023)
--intervalo N   segundos entre posições (padrão: 10)
--turbo         acelera até ~120 km/h (dispara o alerta de velocidade)
--auto-teste    valida o protocolo localmente, sem rede externa
```

*Gerado junto com o commit do simulador — atualizar se o protocolo do listener mudar.*
