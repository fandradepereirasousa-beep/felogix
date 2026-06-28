# 📡 Integração Traccar + Felogix

Guia completo para integrar rastreadores GPS (Trackerking EC33) com a plataforma Felogix.

## 🎯 Visão Geral

```
Trackerking EC33 (Porta 5023)
  ↓ (Protocolo GT06)
Traccar Server (Porta 8082)
  ↓ (API REST)
Felogix Backend
  ↓
Frontend Mapa
```

## 📋 Equipamentos

- **Modelo**: Trackerking EC33 4G
- **Quantidade**: 3 unidades
- **Protocolo**: GT06
- **Conexão**: 4G/GPS
- **Chegada**: 1-5 de julho

## 🚀 Instalação

### 1. Instalar Traccar no VPS (automatizado)

A instalação já está automatizada pelo workflow `.github/workflows/setup-traccar.yml`
(disparo manual pela aba Actions do GitHub → "Configurar Traccar no VPS" → Run workflow).
Ele é idempotente — pode ser rodado de novo a qualquer momento sem risco.

O que o workflow faz:
- Instala Docker no VPS se ainda não tiver
- Sobe o container `traccar/traccar:latest` com `--restart unless-stopped`
- **Painel admin (8082) fica acessível só via `localhost`** — não exposto à internet
- **Porta GT06 (5023/UDP) fica pública**, para os rastreadores se conectarem
- Libera 5023/UDP no `ufw` se estiver ativo no VPS
- Sincroniza a senha do usuário `admin` do Traccar com o valor de `TRACCAR_PASS`
  já configurado no `.env` de produção (se houver um diferente do padrão)

Se preferir rodar manualmente:

```bash
ssh root@felogix.com.br

curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

docker run -d \
  --name traccar \
  --restart unless-stopped \
  -p 127.0.0.1:8082:8082 \
  -p 5023:5023/udp \
  -v traccar-data:/opt/traccar/data \
  traccar/traccar:latest

docker logs -f traccar
```

### 2. Acessar Interface Traccar

O painel admin não fica mais exposto publicamente (só `localhost:8082` no VPS).
Para acessar de fora, abra um túnel SSH:

```bash
ssh -L 8082:localhost:8082 root@felogix.com.br
# depois acesse http://localhost:8082 no seu navegador local
```

```
Usuário: admin
Senha: admin (ou o valor de TRACCAR_PASS no .env de produção, se já tiver sido customizado)
```

**⚠️ Importante:** Mude a senha padrão pelo túnel SSH e atualize `TRACCAR_PASS` no
`.env` de produção (depois rode o workflow de novo para sincronizar, ou troque manualmente
e reinicie a app com `pm2 restart felogix-server --update-env`).

### 3. Configurar Trackerking EC33

#### 3.1. Conexão Inicial

1. Remova o SIM card do equipamento
2. Insira um SIM card com dados 4G ativo
3. Insira novamente no equipamento
4. Aguarde 30-60 segundos para conectar

#### 3.2. Servidor

Na interface Traccar (Admin Panel):

1. **Devices** → Clique no ícone de engrenagem
2. **Add Device** (ou identifique pelo protocolo GT06)
3. Configure:
   - **Name**: `ABC-1234` (placa do veículo)
   - **Unique ID**: número do IMEI do equipamento
   - **Protocol**: GT06
   - **Server address**: `felogix.com.br:5023`

#### 3.3 Configurar Equipamento

O Trackerking EC33 precisa ser configurado via SMS ou app:

**Via SMS (padrão):**
```
# Resetar para padrão
APN,apn_name,username,password

# Exemplo para VIVO
APN,zap.vivo.com.br,vivo,vivo

# Definir servidor
SERVER,felogix.com.br,5023

# Salvar configuração
SAVE
```

**Ou via app Trackerking** (se disponível)

### 4. Verificar Funcionamento

```bash
# No terminal (VPS)
docker logs -f traccar | grep "GT06"

# Deve aparecer:
# [GT06] DeviceID received: <IMEI>
# [GT06] Connected from <IP>
```

## 🔗 Integração Felogix

### Variáveis de Ambiente

Adicione ao `.env`:

```env
TRACCAR_HOST=felogix.com.br
TRACCAR_PORT=8082
TRACCAR_USER=admin
TRACCAR_PASS=SuaSenhaSegura
```

### Endpoints Disponíveis

**1. Sincronizar Veículos**
```bash
curl -X POST http://felogix.com.br:3000/api/traccar/sync \
  -H "Authorization: Bearer $TOKEN"
```

**2. Obter Posições**
```bash
curl -X GET http://felogix.com.br:3000/api/posicoes \
  -H "Authorization: Bearer $TOKEN"
```

**3. Status da Conexão**
```bash
curl -X GET http://felogix.com.br:3000/api/traccar/status \
  -H "Authorization: Bearer $TOKEN"
```

## 📍 Funcionamento

### Automático

- A cada 5 minutos: Sincroniza novos veículos do Traccar
- A cada 5 segundos: Atualiza posições no mapa
- Em tempo real: Mostra status online/moving/offline

### No Frontend

1. Acesse **Dashboard → Mapa**
2. Veja os 3 rastreadores com localizações em tempo real
3. Clique em um veículo para detalhes
4. Velocidade, direção e timestamp atualizados

## 🔧 Troubleshooting

### "Traccar não conecta"

```bash
# Verificar se porta está aberta
telnet felogix.com.br 5023

# Ver logs do Traccar
docker logs traccar | tail -50

# Reiniciar Traccar
docker restart traccar
```

### "Equipamento não se conecta"

1. Verificar SIM card (dados ativo)
2. Verificar APN (operadora correta)
3. Verificar servidor e porta (felogix.com.br:5023)
4. Enviar SMS de reset: `RESET`

### "Posições antigas/não atualizam"

- Traccar: limpar histórico antigo
- Felogix: aguardar próxima sincronização (5min)
- Recarregar navegador (F5)

## 📊 Dashboard Traccar

**Principais funcionalidades:**

- **Devices**: Ver todos os rastreadores conectados
- **Map**: Mapa do Traccar com todas as posições
- **Reports**: Histórico, trajetos, paradas
- **Geofencing**: Criar alertas de área
- **Maintenance**: Alertas de manutenção

## 🎯 Próximos Passos (Quando Chegarem)

1. **1º julho**: Equipamentos chegam
2. **Instalar SIM cards** com dados 4G
3. **Configurar APN** (operadora do SIM)
4. **Definir servidor** para felogix.com.br:5023
5. **Testar conexão** no Traccar
6. **Verificar** no mapa do Felogix

## ✅ Checklist Final

- [ ] Traccar instalado e rodando (porta 8082)
- [ ] Porta 5023/UDP aberta no firewall
- [ ] 3x Trackerking EC33 com SIM e APNs configurados
- [ ] Veículos sincronizados no Felogix
- [ ] Posições atualizando no mapa
- [ ] Histórico de trajetos disponível
- [ ] Alertas funcionando (opcional)

## 📞 Suporte

Qualquer dúvida durante a instalação:
1. Verificar logs: `docker logs traccar`
2. Consultar docs: https://traccar.org/
3. Testar conectividade: `telnet felogix.com.br 5023`

---

**Status**: Pronto para integração em 1º de julho! 🚀
