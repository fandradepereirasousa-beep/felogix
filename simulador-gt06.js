#!/usr/bin/env node
/*
 ─────────────────────────────────────────────────────────────────────────────
 Simulador de rastreador GT06 — Felogix

 Fala o protocolo GT06 real (mesmos pacotes binários que o aparelho físico
 envia): login com IMEI em BCD, heartbeat de status e posições GPS com
 CRC-ITU. Serve para validar a cadeia completa ANTES do hardware chegar:

    simulador → porta 5023 (TCP) → Traccar → Felogix → mapa do Track

 USO
   node simulador-gt06.js <host> [imei] [lat] [lon] [opções]

 EXEMPLOS
   node simulador-gt06.js felogix.com.br                       # IMEI e posição padrão
   node simulador-gt06.js felogix.com.br 358899000000001 -23.55 -46.63
   node simulador-gt06.js felogix.com.br --turbo               # excede 100 km/h (testa alerta)
   node simulador-gt06.js --auto-teste                         # valida o próprio protocolo, sem rede externa

 OPÇÕES
   --porta N       porta TCP do listener GT06 (padrão: 5023)
   --intervalo N   segundos entre posições (padrão: 10)
   --turbo         acelera até ~120 km/h para disparar o alerta de velocidade
   --auto-teste    sobe um servidor local que decodifica como o Traccar e confere os pacotes

 PRÉ-REQUISITOS (ver SIMULADOR-GT06.md para o passo a passo completo)
   1. Device cadastrado no Traccar com Identificador = IMEI usado aqui
   2. Veículo cadastrado no Felogix (admin) com o mesmo IMEI
 ─────────────────────────────────────────────────────────────────────────────
*/

const net = require('net');

/* ─── argumentos ─── */
const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--') && !/^--(porta|intervalo)$/.test(a)));
function opcao(nome, padrao) {
  const i = args.indexOf('--' + nome);
  return i >= 0 && args[i + 1] ? parseFloat(args[i + 1]) : padrao;
}
const posicionais = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--porta' && args[i - 1] !== '--intervalo');

const AUTO_TESTE = flags.has('--auto-teste');
const TURBO      = flags.has('--turbo');
const HOST       = posicionais[0] || (AUTO_TESTE ? '127.0.0.1' : null);
const IMEI       = (posicionais[1] || '358899000000001').replace(/\D/g, '');
const LAT_INI    = posicionais[2] !== undefined ? parseFloat(posicionais[2]) : -23.5505;
const LON_INI    = posicionais[3] !== undefined ? parseFloat(posicionais[3]) : -46.6333;
const PORTA      = opcao('porta', 5023);
const INTERVALO  = Math.max(3, opcao('intervalo', 10));

if (!AUTO_TESTE && !HOST) {
  console.log('Uso: node simulador-gt06.js <host> [imei] [lat] [lon] [--porta N] [--intervalo N] [--turbo]');
  console.log('     node simulador-gt06.js --auto-teste');
  process.exit(1);
}
if (IMEI.length !== 15) { console.error(`IMEI deve ter 15 dígitos (recebi "${IMEI}" com ${IMEI.length})`); process.exit(1); }

/* ─── protocolo GT06 ─── */

// CRC-ITU (X.25): usado pelo GT06 sobre os bytes de comprimento até o serial
function crcItu(buf) {
  let crc = 0xFFFF;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? ((crc >>> 1) ^ 0x8408) : (crc >>> 1);
  }
  return (~crc) & 0xFFFF;
}

// Moldura: 78 78 | len | protocolo | payload | serial(2) | crc(2) | 0D 0A
function montarPacote(protocolo, payload, serial) {
  const len = 1 + payload.length + 2 + 2;
  const semCrc = Buffer.concat([
    Buffer.from([len, protocolo]),
    payload,
    Buffer.from([(serial >> 8) & 0xFF, serial & 0xFF]),
  ]);
  const crc = crcItu(semCrc);
  return Buffer.concat([Buffer.from([0x78, 0x78]), semCrc, Buffer.from([(crc >> 8) & 0xFF, crc & 0xFF, 0x0D, 0x0A])]);
}

// IMEI de 15 dígitos → 8 bytes BCD com zero à esquerda (padrão GT06)
function imeiBcd(imei) {
  const s = imei.padStart(16, '0');
  const out = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) out[i] = (parseInt(s[2 * i], 10) << 4) | parseInt(s[2 * i + 1], 10);
  return out;
}

// Pacote 0x12 (GPS+LBS): data/hora UTC, satélites, lat/lon (minutos × 30000),
// velocidade, curso/status e LBS fictício (MCC 724 = Brasil)
function payloadGps(data, lat, lon, velocidadeKmh, curso, satelites) {
  const b = Buffer.alloc(26);
  b[0] = data.getUTCFullYear() % 100; b[1] = data.getUTCMonth() + 1; b[2] = data.getUTCDate();
  b[3] = data.getUTCHours(); b[4] = data.getUTCMinutes(); b[5] = data.getUTCSeconds();
  b[6] = 0xC0 | (satelites & 0x0F);                       // nibble alto: tamanho da info GPS (12 bytes)
  b.writeUInt32BE(Math.round(Math.abs(lat) * 30000 * 60), 7);
  b.writeUInt32BE(Math.round(Math.abs(lon) * 30000 * 60), 11);
  b[15] = Math.min(255, Math.round(velocidadeKmh));
  let st = (Math.round(curso) % 360) & 0x03FF;
  st |= 0x1000;                                            // bit12: GPS posicionado (fix válido)
  if (lat >= 0) st |= 0x0400;                              // bit10: latitude Norte
  if (lon < 0)  st |= 0x0800;                              // bit11: longitude Oeste
  b.writeUInt16BE(st, 16);
  b.writeUInt16BE(724, 18);                                // MCC Brasil
  b[20] = 5;                                               // MNC
  b.writeUInt16BE(0x1234, 21);                             // LAC fictício
  b[23] = 0x01; b[24] = 0x23; b[25] = 0x45;                // Cell ID fictício
  return b;
}

// Pacote 0x13 (heartbeat/status): GPS ligado, bateria cheia, sinal GSM forte
function payloadStatus() {
  return Buffer.from([0x45, 0x06, 0x04, 0x00, 0x02]);
}

/* ─── simulação de rota (dead reckoning a partir do ponto inicial) ─── */
function criarRota(lat, lon) {
  let curso = 45, velocidade = 0;
  return {
    get lat() { return lat; }, get lon() { return lon; },
    get velocidade() { return velocidade; }, get curso() { return curso; },
    passo(intervaloS) {
      const alvo = TURBO ? 120 : 60;
      velocidade = Math.max(0, Math.min(alvo, velocidade + (Math.random() * 24 - 8)));
      curso = (curso + (Math.random() * 30 - 15) + 360) % 360;
      const distM = (velocidade / 3.6) * intervaloS;
      lat += (distM * Math.cos(curso * Math.PI / 180)) / 111320;
      lon += (distM * Math.sin(curso * Math.PI / 180)) / (111320 * Math.cos(lat * Math.PI / 180));
    },
  };
}

const hora = () => new Date().toLocaleTimeString('pt-BR');
const log = (...m) => console.log(`[${hora()}]`, ...m);

/* ─── cliente (o "rastreador") ─── */
function iniciarRastreador(host, porta, aoTerminar) {
  let serial = 1, logado = false, timerGps = null, timerHb = null, enviados = 0;
  const rota = criarRota(LAT_INI, LON_INI);

  log(`Conectando em ${host}:${porta} (IMEI ${IMEI})…`);
  const sock = net.createConnection({ host, port: porta, timeout: 15000 });

  const parar = (msg) => {
    clearInterval(timerGps); clearInterval(timerHb);
    if (msg) log(msg);
    sock.destroy();
    if (aoTerminar) aoTerminar(enviados);
  };

  sock.on('connect', () => {
    log('✓ TCP conectado — enviando login GT06…');
    sock.write(montarPacote(0x01, imeiBcd(IMEI), serial++));
  });

  sock.on('data', (dados) => {
    // ACKs do servidor: 78 78 05 <protocolo> <serial> <crc> 0d 0a
    for (let i = 0; i + 4 <= dados.length; i++) {
      if (dados[i] === 0x78 && dados[i + 1] === 0x78) {
        const proto = dados[i + 3];
        if (proto === 0x01 && !logado) {
          logado = true;
          log('✓ LOGIN ACEITO pelo servidor — o Traccar reconheceu o IMEI.');
          log(`Enviando posições a cada ${INTERVALO}s${TURBO ? ' (modo TURBO: vai passar de 100 km/h)' : ''}. Ctrl+C para parar.`);
          const enviarGps = () => {
            rota.passo(INTERVALO);
            sock.write(montarPacote(0x12, payloadGps(new Date(), rota.lat, rota.lon, rota.velocidade, rota.curso, 9), serial++));
            enviados++;
            log(`→ posição #${enviados}: ${rota.lat.toFixed(5)}, ${rota.lon.toFixed(5)} · ${Math.round(rota.velocidade)} km/h · curso ${Math.round(rota.curso)}°`);
            if (AUTO_TESTE && enviados >= 3) setTimeout(() => parar(), 300);
          };
          enviarGps();
          timerGps = setInterval(enviarGps, INTERVALO * 1000);
          timerHb = setInterval(() => { sock.write(montarPacote(0x13, payloadStatus(), serial++)); log('→ heartbeat de status'); }, 180000);
        } else if (proto === 0x12 || proto === 0x13) {
          // ACK de posição/heartbeat — silencioso (igual ao aparelho real)
        }
      }
    }
  });

  sock.on('timeout', () => parar('✗ Timeout de conexão — a porta 5023 pode estar bloqueada no firewall do VPS.'));
  sock.on('error', (e) => {
    if (e.code === 'ECONNREFUSED') parar(`✗ Conexão recusada — nada escutando em ${host}:${porta}. O Traccar está rodando? O listener GT06 (5023/tcp) está habilitado?`);
    else if (e.code === 'ENOTFOUND') parar(`✗ Host "${host}" não encontrado — confira o endereço.`);
    else parar(`✗ Erro de rede: ${e.message}`);
  });
  sock.on('close', () => { if (logado) log('Conexão encerrada.'); });

  process.on('SIGINT', () => { log(`Encerrando — ${enviados} posição(ões) enviada(s).`); parar(); process.exit(0); });
}

/* ─── auto-teste: servidor local que decodifica exatamente como o Traccar ─── */
function autoTeste() {
  console.log('AUTO-TESTE do protocolo GT06 (nenhum pacote sai desta máquina)\n');

  // 1) CRC contra o vetor de login da documentação oficial do GT06
  //    (IMEI 123456789012345, serial 0001):
  //    78 78 0D 01 01 23 45 67 89 01 23 45 00 01 8C DD 0D 0A  →  CRC esperado 0x8CDD
  const vetor = Buffer.from([0x0D, 0x01, 0x01, 0x23, 0x45, 0x67, 0x89, 0x01, 0x23, 0x45, 0x00, 0x01]);
  const crc = crcItu(vetor);
  if (crc !== 0x8CDD) { console.error(`✗ CRC-ITU incorreto: 0x${crc.toString(16)} (esperado 0x8cdd)`); process.exit(1); }
  console.log('✓ CRC-ITU confere com pacote GT06 real conhecido (0x8CDD)');

  // 2) Servidor local que faz o mesmo decode do Traccar e confere lat/lon/velocidade
  const decodificados = [];
  const servidor = net.createServer((c) => {
    c.on('data', (d) => {
      let i = 0;
      while (i + 4 <= d.length) {
        if (d[i] !== 0x78 || d[i + 1] !== 0x78) { i++; continue; }
        const len = d[i + 2], proto = d[i + 3];
        const fim = i + 2 + 1 + len + 2;                    // até 0D 0A
        const semCrc = d.slice(i + 2, i + 2 + 1 + len - 2); // len..serial
        const crcRx = d.readUInt16BE(i + 2 + 1 + len - 2);
        if (crcItu(semCrc) !== crcRx) { console.error('✗ CRC inválido num pacote recebido'); process.exit(1); }
        const serial = d.readUInt16BE(i + 2 + 1 + len - 4);
        if (proto === 0x01) {
          const imeiRx = d.slice(i + 4, i + 12).toString('hex').replace(/^0/, '');
          if (imeiRx !== IMEI) { console.error(`✗ IMEI decodificado errado: ${imeiRx}`); process.exit(1); }
          console.log(`✓ Login decodificado com IMEI correto (${imeiRx})`);
          c.write(montarPacote(0x01, Buffer.alloc(0), serial)); // ACK igual ao Traccar
        } else if (proto === 0x12) {
          const p = i + 4;
          const lat = d.readUInt32BE(p + 7) / 30000 / 60;
          const lon = d.readUInt32BE(p + 11) / 30000 / 60;
          const vel = d[p + 15];
          const st = d.readUInt16BE(p + 16);
          const latS = (st & 0x0400) ? lat : -lat;           // bit10: Norte
          const lonS = (st & 0x0800) ? -lon : lon;           // bit11: Oeste
          if (!(st & 0x1000)) { console.error('✗ flag de GPS válido ausente'); process.exit(1); }
          decodificados.push({ lat: latS, lon: lonS, vel });
          c.write(montarPacote(0x12, Buffer.alloc(0), serial));
        }
        i = fim;
      }
    });
  });

  servidor.listen(0, '127.0.0.1', () => {
    const porta = servidor.address().port;
    iniciarRastreador('127.0.0.1', porta, (enviados) => {
      servidor.close();
      if (decodificados.length < 3) { console.error(`✗ Só ${decodificados.length} posição(ões) decodificada(s)`); process.exit(1); }
      const ok = decodificados.every(p =>
        Math.abs(p.lat - LAT_INI) < 0.2 && Math.abs(p.lon - LON_INI) < 0.2 && p.vel <= 255);
      for (const p of decodificados) console.log(`✓ decodificado como o Traccar: ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} · ${p.vel} km/h`);
      if (!ok) { console.error('✗ Coordenadas decodificadas fora da região esperada'); process.exit(1); }
      console.log(`\n✅ AUTO-TESTE PASSOU — ${enviados} posições codificadas e decodificadas byte a byte como o Traccar faz.`);
      console.log('Agora rode contra o VPS:  node simulador-gt06.js felogix.com.br');
      process.exit(0);
    });
  });
}

if (AUTO_TESTE) autoTeste();
else iniciarRastreador(HOST, PORTA);
