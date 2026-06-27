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

### 1. Instalar Traccar no VPS

```bash
# No VPS felogix.com.br
ssh root@felogix.com.br

# Instalar Docker (se não tiver)
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Executar Traccar
docker run -d \
  --name traccar \
  -p 8082:8082 \
  -p 5023:5023/udp \
  -v traccar-data:/opt/traccar/data \
  traccar/traccar:latest

# Verificar logs
docker logs -f traccar
```

### 2. Acessar Interface Traccar

```
URL: http://felogix.com.br:8082
Usuário: admin
Senha: admin
```

**⚠️ Importante:** Mude a senha padrão!

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
