// Carrega variáveis do .env (opcional — não quebra se o pacote não estiver instalado)
try { require('dotenv').config(); } catch (e) { console.warn('dotenv não instalado; usando env do sistema/PM2'); }

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const { Pool }   = require('pg');
const jwt        = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const http       = require('http');
const WebSocket  = require('ws');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ─── SEGREDOS — nunca hardcoded ─── */
const JWT_SECRET = process.env.JWT_SECRET || 'flx_' + require('crypto').randomBytes(32).toString('hex');
const PIX_KEY    = '54.054.345/0001-57';
const ADMIN_EMAIL = 'felipe.sousa@felogix.com.br';
const ADMIN_PASS  = process.env.ADMIN_PASS || '95050578.Fege';
const LEMBRETE_EMAIL = process.env.LEMBRETE_EMAIL || 'felogix.br@gmail.com'; // destino do lembrete mensal de faturas

/* ─── TRACCAR (GPS Tracking) ─── */
const TRACCAR_HOST = process.env.TRACCAR_HOST || 'localhost';
const TRACCAR_PORT = process.env.TRACCAR_PORT || 8082;
const TRACCAR_URL = `http://${TRACCAR_HOST}:${TRACCAR_PORT}`;
const TRACCAR_USER = process.env.TRACCAR_USER || 'admin';
const TRACCAR_PASS = process.env.TRACCAR_PASS || 'admin';

/* ─── BANCO ─── */
const pool = new Pool({
  user:     'postgres',
  host:     'localhost',
  database: 'felogix',
  password: process.env.DB_PASS || 'felogix2026',
  port:     5432,
});

/* ─── MAILER ─── */
const mailer = nodemailer.createTransport({
  host: 'smtp.gmail.com', port: 587, secure: false,
  auth: {
    user: process.env.MAIL_USER || 'felogix.br@gmail.com',
    pass: process.env.MAIL_PASS || 'zhqjivqtphsfldoh'
  }
});

/* ─── RATE LIMITING simples ─── */
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const h   = hits.get(key) || { count: 0, start: now };
    if (now - h.start > windowMs) { h.count = 0; h.start = now; }
    h.count++;
    hits.set(key, h);
    if (h.count > max) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde.' });
    next();
  };
}

/* ─── MIDDLEWARES ─── */
app.use(cors({ origin: ['https://felogix.com.br', 'https://www.felogix.com.br', 'http://localhost:3000'] }));
app.use(express.json({ limit: '100kb' }));

// Headers de segurança
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self' https://cdnjs.cloudflare.com https://fonts.googleapis.com; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; img-src 'self' data: https:; font-src 'self' https://fonts.gstatic.com");
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

/* ─── VALIDAÇÃO ─── */
function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function isDoc(s)   { return /^[\d.\-\/]+$/.test(s) && s.length >= 11; }
function isSafe(s)  { return typeof s === 'string' && s.length < 200 && !/[<>"'`]/.test(s); }

/* ─── HELPERS ─── */
function gerarSenha() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({length: 10}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function auth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ erro: 'Não autorizado' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' }); }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ erro: 'Sem permissão' });
  next();
}

async function sendMail(to, subject, html) {
  try {
    await mailer.sendMail({ from: '"Felogix" <felogix.br@gmail.com>', to, subject, html });
  } catch(e) { console.error('Email error:', e.message); }
}

/* ─── INTEGRAÇÃO COM TRACCAR ─── */
async function traccarAPI(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${TRACCAR_USER}:${TRACCAR_PASS}`).toString('base64');
    const url = new URL(TRACCAR_URL + path);
    const options = {
      hostname: url.hostname,
      port: url.port || 8082,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      timeout: 5000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Traccar timeout')); });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function sincronizarVeiculosTraccar() {
  try {
    const res = await traccarAPI('GET', '/api/devices');
    if (res.status !== 200 || !Array.isArray(res.data)) return;

    for (const device of res.data) {
      const placa = device.name?.toUpperCase() || `DEVICE-${device.id}`;
      const existente = await pool.query(
        'SELECT id FROM veiculos WHERE imei=$1',
        [String(device.id)]
      );

      if (!existente.rows.length) {
        await pool.query(
          'INSERT INTO veiculos (cliente_id, placa, imei, modelo, ano, cor, ativo) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [1, placa, String(device.id), 'Rastreador', 2024, 'Preto', true]
        ).catch(() => {});
      }
    }
  } catch (e) {
    console.error('Erro sincronizando veículos Traccar:', e.message);
  }
}

async function obterPosicoesTraccar() {
  try {
    const res = await traccarAPI('GET', '/api/positions');
    if (res.status === 200 && Array.isArray(res.data)) {
      return res.data.map(p => ({
        id: p.deviceId,
        lat: p.latitude,
        lon: p.longitude,
        velocidade: Math.round(p.speed || 0),
        direcao: p.course || 0,
        timestamp: p.serverTime
      }));
    }
    return [];
  } catch (e) {
    console.error('Erro obtendo posições Traccar:', e.message);
    return [];
  }
}

// Sincronizar veículos a cada 5 minutos
setInterval(sincronizarVeiculosTraccar, 5 * 60 * 1000);

/* ─── FATURAMENTO ─── */
const TRACK_VALOR_VEICULO = 29.90; // R$ por veículo/mês no plano Track

const MESES = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
function fmtMoeda(v)   { return 'R$ ' + (parseFloat(v) || 0).toFixed(2).replace('.', ','); }
function fmtMesRef(m)  { const [a, x] = m.split('-').map(Number); return `${MESES[x - 1]}/${a}`; }
function diasNoMes(ano, mes) { return new Date(ano, mes, 0).getDate(); }              // mes 1-12
function mesRefAnterior(base = new Date()) {                                          // 'YYYY-MM' do mês passado
  const d = new Date(base.getFullYear(), base.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Calcula a fatura de um cliente para um mês de referência (YYYY-MM).
// 1º mês de cada veículo (track/por_veiculo) ou do contrato (personalizado fixo) é
// cobrado pró-rata pelos dias reais usados; depois disso, valor cheio.
async function calcularFatura(cli, mesRef) {
  if (cli.plano === 'cortesia') return { valor: 0, qtd: 0, cortesia: true };

  const [ano, mes] = mesRef.split('-').map(Number);    // mes 1-12
  const dim        = diasNoMes(ano, mes);
  const inicioMes  = new Date(ano, mes - 1, 1);
  const fimMes     = new Date(ano, mes - 1, dim, 23, 59, 59);
  const round2     = (n) => Math.round(n * 100) / 100;

  const fracao = (inicio) => {                          // fração do mês usada por um item
    const d = new Date(inicio);
    if (d <= inicioMes) return 1;                       // já existia antes → cobra cheio
    if (d > fimMes)     return 0;                       // só começou depois → não cobra
    return (dim - d.getDate() + 1) / dim;               // pró-rata (inclui o dia inicial)
  };

  const porVeiculo = cli.plano === 'track' || (cli.plano === 'personalizado' && cli.cobranca_modo === 'por_veiculo');
  if (porVeiculo) {
    const rate = cli.plano === 'track' ? TRACK_VALOR_VEICULO : (parseFloat(cli.valor_plano) || 0);
    const { rows: veics } = await pool.query('SELECT criado_em FROM veiculos WHERE cliente_id=$1 AND criado_em<=$2', [cli.id, fimMes]);
    let valor = 0;
    for (const v of veics) valor += rate * fracao(v.criado_em);
    return { valor: round2(valor), qtd: veics.length };
  }

  // Personalizado FIXO (padrão do personalizado): total fixo, pró-rata pelo início do contrato
  const total = parseFloat(cli.valor_plano) || 0;
  const qv = await pool.query('SELECT COUNT(*) FROM veiculos WHERE cliente_id=$1 AND criado_em<=$2', [cli.id, fimMes]);
  return { valor: round2(total * fracao(cli.criado_em)), qtd: parseInt(qv.rows[0].count) };
}

async function enviarFatura(cli, mesRef, valor, qtd) {
  const planoTxt = cli.plano === 'track' ? 'Track' : cli.plano === 'personalizado' ? 'Personalizado' : cli.plano;
  await sendMail(cli.email, `Fatura Felogix — ${fmtMesRef(mesRef)}`,
    `<div style="font-family:sans-serif;max-width:500px;margin:auto">
      <h2 style="color:#D91A1A">Felogix Track</h2>
      <p>Olá, <b>${cli.nome}</b>!</p>
      <p>Segue sua fatura referente a <b>${fmtMesRef(mesRef)}</b>:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr style="background:#f9f9f9"><td style="padding:8px">Plano</td><td style="padding:8px"><b>${planoTxt}</b></td></tr>
        <tr><td style="padding:8px">Veículos</td><td style="padding:8px"><b>${qtd}</b></td></tr>
        <tr style="background:#f9f9f9"><td style="padding:8px">Valor</td><td style="padding:8px"><b style="font-size:20px;color:#D91A1A">${fmtMoeda(valor)}</b></td></tr>
        <tr><td style="padding:8px">Vencimento</td><td style="padding:8px"><b>Dia ${cli.dia_vencimento}</b></td></tr>
      </table>
      <div style="background:#0C0C0C;color:#fff;padding:16px;border-radius:8px;margin-top:16px">
        <p style="margin:0;font-size:12px;color:#888">Chave PIX</p>
        <p style="margin:4px 0;font-size:18px;font-weight:bold">${PIX_KEY}</p>
        <p style="margin:0;font-size:11px;color:#555">CNPJ — Felogix</p>
      </div>
      <p style="font-size:11px;color:#999;margin-top:16px">Dúvidas? Responda este email.</p>
    </div>`);
}

async function enviarCortesia(cli, mesRef) {
  await sendMail(cli.email, `Felogix — obrigado por mais um mês! 💚`,
    `<div style="font-family:sans-serif;max-width:500px;margin:auto">
      <h2 style="color:#D91A1A">Felogix Track</h2>
      <p>Olá, <b>${cli.nome}</b>!</p>
      <p>Passando para agradecer por mais um mês com a Felogix em <b>${fmtMesRef(mesRef)}</b>. 🚗💨</p>
      <p>Seu plano é <b>Cortesia</b>, então não há nada a pagar este mês — é por nossa conta!</p>
      <p>Continue contando com a gente para acompanhar seus veículos em tempo real.</p>
      <p style="font-size:11px;color:#999;margin-top:16px">Equipe Felogix</p>
    </div>`);
}

/* ─── COBRANÇA: RASCUNHOS, MODELO E LEMBRETE (sem envio automático) ─── */
const TPL_ASSUNTO_PADRAO = 'Fatura Felogix — {mes}';
const TPL_CORPO_PADRAO = 'Olá, {nome}!\n\nSegue sua fatura referente a {mes}, no valor de {valor}.\nO pagamento pode ser feito via PIX (chave no final do e-mail).\n\nQualquer dúvida, é só responder esta mensagem. Obrigado por confiar na Felogix! 🚗';

function escapeHtml(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function aplicarVars(txt, v){
  return String(txt == null ? '' : txt)
    .replace(/\{nome\}/g, v.nome).replace(/\{valor\}/g, v.valor)
    .replace(/\{mes\}/g, v.mes).replace(/\{pix\}/g, v.pix);
}

// HTML do e-mail de fatura: mensagem (editável) por cima + bloco fixo de valor e PIX.
function montarHtmlFatura(msg, valor, cli, mesRef){
  const planoTxt = cli.plano === 'track' ? 'Track' : cli.plano === 'personalizado' ? 'Personalizado' : cli.plano;
  const corpo = escapeHtml(msg).replace(/\n/g, '<br>');
  return `<div style="font-family:sans-serif;max-width:500px;margin:auto">
      <h2 style="color:#D91A1A">Felogix Track</h2>
      <div style="font-size:14px;color:#222;margin:8px 0 16px">${corpo}</div>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr style="background:#f9f9f9"><td style="padding:8px">Plano</td><td style="padding:8px"><b>${planoTxt}</b></td></tr>
        <tr><td style="padding:8px">Referência</td><td style="padding:8px"><b>${fmtMesRef(mesRef)}</b></td></tr>
        <tr style="background:#f9f9f9"><td style="padding:8px">Valor</td><td style="padding:8px"><b style="font-size:20px;color:#D91A1A">${fmtMoeda(valor)}</b></td></tr>
        <tr><td style="padding:8px">Vencimento</td><td style="padding:8px"><b>Dia ${cli.dia_vencimento}</b></td></tr>
      </table>
      <div style="background:#0C0C0C;color:#fff;padding:16px;border-radius:8px;margin-top:16px">
        <p style="margin:0;font-size:12px;color:#888">Chave PIX</p>
        <p style="margin:4px 0;font-size:18px;font-weight:bold">${PIX_KEY}</p>
        <p style="margin:0;font-size:11px;color:#555">CNPJ — Felogix</p>
      </div>
    </div>`;
}

// Lista de rascunhos de um mês (NÃO envia nada). Marca quem já foi enviado e e-mail inválido.
async function montarRascunhos(mesRef){
  const { rows: clientes } = await pool.query('SELECT * FROM clientes WHERE ativo=true ORDER BY nome');
  const out = [];
  for (const cli of clientes){
    const env = await pool.query('SELECT enviado_em FROM pagamentos WHERE cliente_id=$1 AND mes_ref=$2', [cli.id, mesRef]);
    const ja_enviado = !!(env.rows[0] && env.rows[0].enviado_em);
    const email_ok = isEmail(cli.email || '');
    if (cli.plano === 'cortesia'){
      out.push({ cliente_id: cli.id, nome: cli.nome, email: cli.email, plano: 'cortesia', cobranca_modo: null, cortesia: true, valor: 0, qtd: 0, ja_enviado, email_ok });
    } else {
      const f = await calcularFatura(cli, mesRef);
      out.push({ cliente_id: cli.id, nome: cli.nome, email: cli.email, plano: cli.plano, cobranca_modo: cli.cobranca_modo, cortesia: false, valor: f.valor, qtd: f.qtd, ja_enviado, email_ok });
    }
  }
  return out;
}

async function registrarEmailLog(cli, mesRef, tipo, assunto, valor){
  await pool.query(
    'INSERT INTO emails_log (cliente_id,cliente_nome,email,mes_ref,tipo,assunto,valor) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [cli.id, cli.nome, cli.email, mesRef, tipo, String(assunto).slice(0,200), valor || 0]
  );
}

// Roda no startup e a cada 6h: avisa SOMENTE o admin (uma vez por mês) que há faturas a revisar.
// Nada é enviado aos clientes automaticamente.
async function verificarLembreteMensal(){
  try {
    const cfg = await pool.query(`SELECT chave,valor FROM config WHERE chave IN ('cobranca_auto_desde','lembrete_mes')`);
    const map = Object.fromEntries(cfg.rows.map(r => [r.chave, r.valor]));
    const baseline = map['cobranca_auto_desde'];
    const mesRef = mesRefAnterior();
    if (!baseline || mesRef < baseline) return;          // ainda não chegou a hora
    if (map['lembrete_mes'] === mesRef) return;          // já avisei sobre este mês
    const drafts = await montarRascunhos(mesRef);
    const cobr = drafts.filter(d => !d.cortesia && !d.ja_enviado && d.valor > 0);
    const total = cobr.reduce((s, d) => s + d.valor, 0);
    await sendMail(LEMBRETE_EMAIL, `Felogix — faturas de ${fmtMesRef(mesRef)} prontas para revisar`,
      `<div style="font-family:sans-serif;max-width:500px;margin:auto">
        <h2 style="color:#D91A1A">Felogix</h2>
        <p>Olá, Felipe!</p>
        <p>As faturas de <b>${fmtMesRef(mesRef)}</b> estão prontas para revisão.</p>
        <p><b>${cobr.length}</b> cobrança(s) a enviar, somando <b>${fmtMoeda(total)}</b>.</p>
        <p>Acesse <a href="https://felogix.com.br">felogix.com.br</a> → <b>Financeiro › Cobranças do mês</b> para revisar, selecionar e enviar.</p>
        <p style="font-size:11px;color:#999">Nenhum e-mail é enviado automaticamente aos clientes.</p>
      </div>`);
    await pool.query(`INSERT INTO config (chave,valor) VALUES ('lembrete_mes',$1) ON CONFLICT (chave) DO UPDATE SET valor=$1`, [mesRef]);
    console.log(`Lembrete de faturamento (${mesRef}) enviado ao admin`);
  } catch (e) { console.error('verificarLembreteMensal:', e.message); }
}

/* ─── INIT DB ─── */
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id SERIAL PRIMARY KEY,
      tipo VARCHAR(4) DEFAULT 'cpf',
      documento VARCHAR(20) UNIQUE NOT NULL,
      nome VARCHAR(150) NOT NULL,
      email VARCHAR(150) UNIQUE NOT NULL,
      senha VARCHAR(100) NOT NULL,
      plano VARCHAR(30) DEFAULT 'cortesia',
      valor_plano DECIMAL(10,2) DEFAULT 0,
      dia_vencimento INTEGER DEFAULT 10,
      ativo BOOLEAN DEFAULT true,
      tentativas_login INTEGER DEFAULT 0,
      bloqueado_ate TIMESTAMP,
      criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS veiculos (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
      placa VARCHAR(20) UNIQUE NOT NULL,
      imei VARCHAR(20),
      modelo VARCHAR(100),
      ano INTEGER,
      cor VARCHAR(50),
      bloqueado BOOLEAN DEFAULT false,
      criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS alertas_prefs (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE UNIQUE,
      email_alertas VARCHAR(150),
      velocidade BOOLEAN DEFAULT true,
      bloqueio BOOLEAN DEFAULT true,
      geocerca BOOLEAN DEFAULT true,
      offline BOOLEAN DEFAULT true,
      horario BOOLEAN DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS pagamentos (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
      mes_ref VARCHAR(7) NOT NULL,
      valor DECIMAL(10,2) NOT NULL,
      pago BOOLEAN DEFAULT false,
      data_pagamento TIMESTAMP,
      criado_em TIMESTAMP DEFAULT NOW(),
      UNIQUE(cliente_id, mes_ref)
    );
    CREATE TABLE IF NOT EXISTS logs_acesso (
      id SERIAL PRIMARY KEY,
      ip VARCHAR(50),
      email VARCHAR(150),
      sucesso BOOLEAN,
      criado_em TIMESTAMP DEFAULT NOW()
    );
  `);
  // Migração: garante a restrição única em pagamentos (tabelas antigas podem não ter,
  // pois CREATE TABLE IF NOT EXISTS não altera tabelas já existentes). Sem isso o
  // ON CONFLICT da cobrança falha com o erro 42P10.
  try {
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS pagamentos_cliente_mes_uniq ON pagamentos (cliente_id, mes_ref)`);
  } catch (e) { console.warn('Migração pagamentos (índice único):', e.message); }
  // Migração: modo de cobrança do personalizado (fixo | por_veiculo) e tabela de config
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS cobranca_modo VARCHAR(20)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS config (chave VARCHAR(50) PRIMARY KEY, valor TEXT)`);
  // Baseline: mês em que o faturamento automático passou a valer (evita cobrança retroativa).
  await pool.query(`INSERT INTO config (chave,valor) VALUES ('cobranca_auto_desde', to_char(NOW(),'YYYY-MM')) ON CONFLICT (chave) DO NOTHING`);
  // Faturamento por aprovação: marca de envio + histórico de e-mails + modelo padrão
  await pool.query(`ALTER TABLE pagamentos ADD COLUMN IF NOT EXISTS enviado_em TIMESTAMP`);
  await pool.query(`CREATE TABLE IF NOT EXISTS emails_log (
    id SERIAL PRIMARY KEY,
    cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
    cliente_nome VARCHAR(150),
    email VARCHAR(150),
    mes_ref VARCHAR(7),
    tipo VARCHAR(20),
    assunto VARCHAR(200),
    valor DECIMAL(10,2) DEFAULT 0,
    enviado_em TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`INSERT INTO config (chave,valor) VALUES ('tpl_assunto',$1) ON CONFLICT (chave) DO NOTHING`, [TPL_ASSUNTO_PADRAO]);
  await pool.query(`INSERT INTO config (chave,valor) VALUES ('tpl_corpo',$1) ON CONFLICT (chave) DO NOTHING`, [TPL_CORPO_PADRAO]);
  await pool.query(`
    INSERT INTO clientes (tipo,documento,nome,email,senha,plano,ativo)
    VALUES ('cnpj','54.024.215/0001-00','Impacto Segurança','frota@grupoimpacto.com.br','Frota@123','track',true)
    ON CONFLICT (email) DO NOTHING
  `);
  console.log('DB iniciado');
}

/* ─── LOGIN ─── */
app.post('/api/login', rateLimit(10, 60000), async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha || !isEmail(email)) return res.status(400).json({ erro: 'Dados inválidos' });
  if (senha.length > 100) return res.status(400).json({ erro: 'Dados inválidos' });

  // Log de acesso
  const logAcesso = async (sucesso) => {
    await pool.query('INSERT INTO logs_acesso (ip,email,sucesso) VALUES ($1,$2,$3)', [req.ip, email, sucesso]).catch(() => {});
  };

  // Admin
  if (email === ADMIN_EMAIL && senha === ADMIN_PASS) {
    await logAcesso(true);
    const token = jwt.sign({ id: 0, role: 'admin', nome: 'Felipe Andrade' }, JWT_SECRET, { expiresIn: '12h' });
    return res.json({ token, role: 'admin', nome: 'Felipe Andrade', initials: 'FA' });
  }

  try {
    const r = await pool.query('SELECT * FROM clientes WHERE email=$1 AND ativo=true', [email]);
    if (!r.rows.length) { await logAcesso(false); return res.status(401).json({ erro: 'Email ou senha incorretos' }); }
    const c = r.rows[0];

    // Verifica bloqueio por tentativas
    if (c.bloqueado_ate && new Date(c.bloqueado_ate) > new Date()) {
      return res.status(401).json({ erro: 'Conta temporariamente bloqueada. Tente em 15 minutos.' });
    }

    if (c.senha !== senha) {
      const tentativas = (c.tentativas_login || 0) + 1;
      const bloqueio = tentativas >= 5 ? new Date(Date.now() + 15*60*1000) : null;
      await pool.query('UPDATE clientes SET tentativas_login=$1, bloqueado_ate=$2 WHERE id=$3', [tentativas, bloqueio, c.id]);
      await logAcesso(false);
      const msg = tentativas >= 5 ? 'Muitas tentativas. Conta bloqueada por 15 minutos.' : `Email ou senha incorretos (${tentativas}/5)`;
      return res.status(401).json({ erro: msg });
    }

    // Login ok — reseta tentativas
    await pool.query('UPDATE clientes SET tentativas_login=0, bloqueado_ate=NULL WHERE id=$1', [c.id]);
    await logAcesso(true);
    const token = jwt.sign({ id: c.id, role: 'gestor', nome: c.nome, empresa: c.nome }, JWT_SECRET, { expiresIn: '12h' });
    const initials = c.nome.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    res.json({ token, role: 'gestor', nome: c.nome, empresa: c.nome, initials, plano: c.plano });
  } catch (err) { console.error(err); res.status(500).json({ erro: 'Erro interno' }); }
});

/* ─── ESQUECI SENHA ─── */
app.post('/api/esqueci-senha', rateLimit(3, 300000), async (req, res) => {
  const { email } = req.body;
  if (!email || !isEmail(email)) return res.status(400).json({ erro: 'Email inválido' });
  try {
    const r = await pool.query('SELECT * FROM clientes WHERE email=$1 AND ativo=true', [email]);
    // Sempre retorna ok pra não revelar emails cadastrados
    if (r.rows.length) {
      const nova = gerarSenha();
      await pool.query('UPDATE clientes SET senha=$1, tentativas_login=0, bloqueado_ate=NULL WHERE email=$2', [nova, email]);
      await sendMail(email, 'Sua nova senha — Felogix',
        `<div style="font-family:sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#D91A1A">Felogix</h2>
          <p>Olá, <b>${r.rows[0].nome}</b>!</p>
          <p>Sua nova senha temporária é:</p>
          <div style="background:#f5f5f5;padding:16px;border-radius:8px;text-align:center;font-size:24px;font-weight:bold;letter-spacing:4px">${nova}</div>
          <p>Acesse <a href="https://felogix.com.br">felogix.com.br</a> e altere sua senha após o login.</p>
          <p style="font-size:11px;color:#999">Se você não solicitou isso, ignore este email.</p>
        </div>`);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

/* ─── ALTERAR SENHA ─── */
app.post('/api/alterar-senha', auth, async (req, res) => {
  if (req.user.role === 'admin') return res.status(400).json({ erro: 'Use outro método para alterar senha admin' });
  const { senha_atual, nova_senha } = req.body;
  if (!senha_atual || !nova_senha) return res.status(400).json({ erro: 'Preencha todos os campos' });
  if (nova_senha.length < 6) return res.status(400).json({ erro: 'Senha deve ter pelo menos 6 caracteres' });
  if (nova_senha.length > 100) return res.status(400).json({ erro: 'Senha muito longa' });
  try {
    const r = await pool.query('SELECT * FROM clientes WHERE id=$1', [req.user.id]);
    if (!r.rows.length || r.rows[0].senha !== senha_atual)
      return res.status(400).json({ erro: 'Senha atual incorreta' });
    await pool.query('UPDATE clientes SET senha=$1 WHERE id=$2', [nova_senha, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

/* ─── VERIFICAR TOKEN (auto-login) ─── */
app.get('/api/verify-token', auth, async (req, res) => {
  if (req.user.role === 'admin') {
    return res.json({ token: '', role: 'admin', nome: 'Felipe Andrade', initials: 'FA' });
  }
  try {
    const r = await pool.query('SELECT nome, empresa, plano FROM clientes WHERE id=$1 AND ativo=true', [req.user.id]);
    if (!r.rows.length) return res.status(401).json({ erro: 'Usuário inativo' });
    const c = r.rows[0];
    const initials = c.nome.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    res.json({ token: '', role: 'gestor', nome: c.nome, empresa: c.nome, initials, plano: c.plano });
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

/* ─── CLIENTES ─── */
app.get('/api/clientes', auth, adminOnly, async (req, res) => {
  const r = await pool.query('SELECT id,tipo,documento,nome,email,plano,valor_plano,cobranca_modo,dia_vencimento,ativo,criado_em FROM clientes ORDER BY criado_em DESC');
  res.json(r.rows);
});

app.post('/api/clientes', auth, adminOnly, async (req, res) => {
  const { tipo, documento, nome, email, plano, valor_plano, cobranca_modo, dia_vencimento } = req.body;
  if (!documento || !nome || !email) return res.status(400).json({ erro: 'Preencha todos os campos' });
  if (!isEmail(email)) return res.status(400).json({ erro: 'Email inválido' });
  if (!isDoc(documento)) return res.status(400).json({ erro: 'Documento inválido' });
  if (!isSafe(nome)) return res.status(400).json({ erro: 'Nome inválido' });
  const senha = gerarSenha();
  try {
    const modo = plano === 'personalizado' ? (cobranca_modo === 'por_veiculo' ? 'por_veiculo' : 'fixo') : null;
    const r = await pool.query(
      'INSERT INTO clientes (tipo,documento,nome,email,senha,plano,valor_plano,cobranca_modo,dia_vencimento) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,nome,email,plano',
      [tipo||'cpf', documento.trim(), nome.trim(), email.trim().toLowerCase(), senha, plano||'cortesia', valor_plano||0, modo, dia_vencimento||10]
    );
    await sendMail(email, 'Bem-vindo ao Felogix!',
      `<div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#D91A1A">Felogix Track</h2>
        <p>Olá, <b>${nome}</b>! Seu acesso foi criado.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:8px;color:#666">Email</td><td style="padding:8px"><b>${email}</b></td></tr>
          <tr style="background:#f9f9f9"><td style="padding:8px;color:#666">Senha</td><td style="padding:8px"><b>${senha}</b></td></tr>
          <tr><td style="padding:8px;color:#666">Plano</td><td style="padding:8px"><b>${plano||'Cortesia'}</b></td></tr>
        </table>
        <a href="https://felogix.com.br" style="display:inline-block;background:#D91A1A;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold">Acessar plataforma</a>
        <p style="font-size:11px;color:#999;margin-top:16px">Recomendamos alterar sua senha no primeiro acesso.</p>
      </div>`);
    res.json({ ...r.rows[0], senha_gerada: senha });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'Email ou documento já cadastrado' });
    res.status(500).json({ erro: 'Erro interno' });
  }
});

app.put('/api/clientes/:id', auth, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ erro: 'ID inválido' });
  const { nome, email, plano, valor_plano, cobranca_modo, dia_vencimento, ativo, senha } = req.body;
  try {
    const sets = []; const vals = []; let i = 1;
    if (nome !== undefined && isSafe(nome))           { sets.push(`nome=$${i++}`);           vals.push(nome.trim()); }
    if (email !== undefined && isEmail(email))         { sets.push(`email=$${i++}`);          vals.push(email.trim().toLowerCase()); }
    if (plano !== undefined)                           { sets.push(`plano=$${i++}`);          vals.push(plano); }
    if (valor_plano !== undefined)                     { sets.push(`valor_plano=$${i++}`);    vals.push(parseFloat(valor_plano)||0); }
    if (cobranca_modo !== undefined)                   { sets.push(`cobranca_modo=$${i++}`);  vals.push(cobranca_modo === 'por_veiculo' ? 'por_veiculo' : (cobranca_modo === 'fixo' ? 'fixo' : null)); }
    if (dia_vencimento !== undefined)                  { sets.push(`dia_vencimento=$${i++}`); vals.push(parseInt(dia_vencimento)||10); }
    if (ativo !== undefined)                           { sets.push(`ativo=$${i++}`);          vals.push(!!ativo); }
    if (senha !== undefined && senha.length >= 6)      { sets.push(`senha=$${i++}`);          vals.push(senha); }
    if (!sets.length) return res.status(400).json({ erro: 'Nada a atualizar' });
    vals.push(id);
    const r = await pool.query(`UPDATE clientes SET ${sets.join(',')} WHERE id=$${i} RETURNING id,nome,email,plano,valor_plano,dia_vencimento,ativo`, vals);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

/* ─── VEÍCULOS ─── */
app.get('/api/veiculos', auth, async (req, res) => {
  let q, p;
  if (req.user.role === 'admin') {
    q = 'SELECT v.*,c.nome as cliente_nome,c.plano FROM veiculos v JOIN clientes c ON v.cliente_id=c.id ORDER BY v.criado_em DESC';
    p = [];
  } else {
    q = 'SELECT v.*,c.nome as cliente_nome,c.plano FROM veiculos v JOIN clientes c ON v.cliente_id=c.id WHERE v.cliente_id=$1 ORDER BY v.criado_em DESC';
    p = [req.user.id];
  }
  const r = await pool.query(q, p);
  res.json(r.rows);
});

app.post('/api/veiculos', auth, adminOnly, async (req, res) => {
  const { placa, imei, modelo, ano, cor, cliente_id } = req.body;
  if (!placa || !cliente_id) return res.status(400).json({ erro: 'Placa e cliente são obrigatórios' });
  if (!/^[A-Z0-9\-]{4,10}$/i.test(placa)) return res.status(400).json({ erro: 'Placa inválida' });
  try {
    const r = await pool.query(
      'INSERT INTO veiculos (cliente_id,placa,imei,modelo,ano,cor) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [parseInt(cliente_id), placa.toUpperCase().trim(), imei?.trim()||null, modelo?.trim()||'Veículo', parseInt(ano)||2024, cor?.trim()||'—']
    );
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'Placa já cadastrada' });
    res.status(500).json({ erro: 'Erro interno' });
  }
});

app.put('/api/veiculos/:id', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ erro: 'ID inválido' });
  // Gestor só pode bloquear veículos da própria empresa
  if (req.user.role !== 'admin') {
    const check = await pool.query('SELECT cliente_id FROM veiculos WHERE id=$1', [id]);
    if (!check.rows.length || check.rows[0].cliente_id !== req.user.id)
      return res.status(403).json({ erro: 'Sem permissão para este veículo' });
  }
  const { bloqueado, modelo, ano, cor, imei } = req.body;
  try {
    const sets = []; const vals = []; let i = 1;
    if (bloqueado !== undefined) { sets.push(`bloqueado=$${i++}`); vals.push(!!bloqueado); }
    if (modelo) { sets.push(`modelo=$${i++}`); vals.push(modelo.trim()); }
    if (ano)    { sets.push(`ano=$${i++}`);    vals.push(parseInt(ano)); }
    if (cor)    { sets.push(`cor=$${i++}`);    vals.push(cor.trim()); }
    if (imei)   { sets.push(`imei=$${i++}`);   vals.push(imei.trim()); }
    if (!sets.length) return res.status(400).json({ erro: 'Nada a atualizar' });
    vals.push(id);
    const r = await pool.query(`UPDATE veiculos SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

app.delete('/api/veiculos/:id', auth, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ erro: 'ID inválido' });
  await pool.query('DELETE FROM veiculos WHERE id=$1', [id]);
  res.json({ ok: true });
});

/* ─── POSIÇÕES (Traccar Integration) ─── */
app.get('/api/posicoes', auth, async (req, res) => {
  const posicoes = await obterPosicoesTraccar();

  // Enriquecer com dados do banco
  const result = [];
  for (const pos of posicoes) {
    const v = await pool.query('SELECT id,placa,modelo,cliente_id FROM veiculos WHERE imei=$1', [String(pos.id)]);
    if (v.rows.length) {
      result.push({
        ...pos,
        veiculo_id: v.rows[0].id,
        placa: v.rows[0].placa,
        modelo: v.rows[0].modelo,
        cliente_id: v.rows[0].cliente_id
      });
    }
  }
  res.json(result);
});

app.post('/api/traccar/sync', auth, adminOnly, async (req, res) => {
  await sincronizarVeiculosTraccar();
  res.json({ ok: true, message: 'Veículos sincronizados com Traccar' });
});

app.get('/api/traccar/status', auth, adminOnly, async (req, res) => {
  try {
    const result = await traccarAPI('GET', '/api/server');
    res.json({ conectado: result.status === 200, info: result.data });
  } catch (e) {
    res.status(503).json({ conectado: false, erro: e.message });
  }
});

/* ─── ALERTAS ─── */
app.get('/api/alertas', auth, async (req, res) => {
  if (req.user.role === 'admin') return res.json({});
  const r = await pool.query('SELECT * FROM alertas_prefs WHERE cliente_id=$1', [req.user.id]);
  if (r.rows.length) return res.json(r.rows[0]);
  const n = await pool.query(
    'INSERT INTO alertas_prefs (cliente_id,email_alertas) VALUES ($1,$2) RETURNING *',
    [req.user.id, '']
  );
  res.json(n.rows[0]);
});

app.put('/api/alertas', auth, async (req, res) => {
  if (req.user.role === 'admin') return res.status(403).json({ erro: 'Sem permissão' });
  const { email_alertas, velocidade, bloqueio, geocerca, offline, horario } = req.body;
  if (email_alertas && !isEmail(email_alertas)) return res.status(400).json({ erro: 'Email inválido' });
  try {
    const r = await pool.query(`
      INSERT INTO alertas_prefs (cliente_id,email_alertas,velocidade,bloqueio,geocerca,offline,horario)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (cliente_id) DO UPDATE SET
        email_alertas=$2,velocidade=$3,bloqueio=$4,geocerca=$5,offline=$6,horario=$7
      RETURNING *`,
      [req.user.id, email_alertas||'', !!velocidade, !!bloqueio, !!geocerca, !!offline, !!horario]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

/* ─── FINANCEIRO ─── */
app.get('/api/financeiro', auth, adminOnly, async (req, res) => {
  const r = await pool.query(`
    SELECT c.id,c.nome,c.email,c.plano,c.valor_plano,c.cobranca_modo,c.dia_vencimento,
      (SELECT COUNT(*) FROM veiculos WHERE cliente_id=c.id) as qtd_veiculos,
      (SELECT json_agg(p ORDER BY p.criado_em DESC) FROM pagamentos p WHERE p.cliente_id=c.id) as pagamentos
    FROM clientes c WHERE c.ativo=true ORDER BY c.nome
  `);
  res.json({ clientes: r.rows, pix: PIX_KEY });
});

app.post('/api/financeiro/cobrar', auth, adminOnly, async (req, res) => {
  const cliente_id = parseInt(req.body.cliente_id);
  const mesRef = (typeof req.body.mes_ref === 'string' && /^\d{4}-\d{2}$/.test(req.body.mes_ref)) ? req.body.mes_ref : mesRefAnterior();
  if (!cliente_id) return res.status(400).json({ erro: 'ID inválido' });
  try {
    const c = await pool.query('SELECT * FROM clientes WHERE id=$1 AND ativo=true', [cliente_id]);
    if (!c.rows.length) return res.status(404).json({ erro: 'Cliente não encontrado' });
    const cli = c.rows[0];

    if (cli.plano === 'cortesia') {
      await pool.query('INSERT INTO pagamentos (cliente_id,mes_ref,valor,pago,data_pagamento) VALUES ($1,$2,0,true,NOW()) ON CONFLICT (cliente_id,mes_ref) DO NOTHING', [cliente_id, mesRef]);
      await enviarCortesia(cli, mesRef);
      return res.json({ ok: true, cortesia: true, valor: 0, mes_ref: mesRef });
    }

    const f = await calcularFatura(cli, mesRef);
    await pool.query(
      'INSERT INTO pagamentos (cliente_id,mes_ref,valor) VALUES ($1,$2,$3) ON CONFLICT (cliente_id,mes_ref) DO UPDATE SET valor=$3',
      [cliente_id, mesRef, f.valor]
    );
    await enviarFatura(cli, mesRef, f.valor, f.qtd);
    res.json({ ok: true, valor: f.valor, qtd: f.qtd, mes_ref: mesRef });
  } catch (err) { console.error(err); res.status(500).json({ erro: 'Erro interno' }); }
});

app.post('/api/financeiro/pago', auth, adminOnly, async (req, res) => {
  const pagamento_id = parseInt(req.body.pagamento_id);
  if (!pagamento_id) return res.status(400).json({ erro: 'ID inválido' });
  await pool.query('UPDATE pagamentos SET pago=true,data_pagamento=NOW() WHERE id=$1', [pagamento_id]);
  res.json({ ok: true });
});

// Rascunhos do mês para revisão (não envia nada) + modelo de e-mail salvo
app.get('/api/financeiro/rascunhos', auth, adminOnly, async (req, res) => {
  const mesRef = (typeof req.query.mes === 'string' && /^\d{4}-\d{2}$/.test(req.query.mes)) ? req.query.mes : mesRefAnterior();
  try {
    const clientes = await montarRascunhos(mesRef);
    const cfg = await pool.query(`SELECT chave,valor FROM config WHERE chave IN ('tpl_assunto','tpl_corpo')`);
    const map = Object.fromEntries(cfg.rows.map(r => [r.chave, r.valor]));
    res.json({
      mes_ref: mesRef,
      pix: PIX_KEY,
      template: { assunto: map.tpl_assunto || TPL_ASSUNTO_PADRAO, corpo: map.tpl_corpo || TPL_CORPO_PADRAO },
      clientes
    });
  } catch (err) { console.error(err); res.status(500).json({ erro: 'Erro interno' }); }
});

// Envia o lote selecionado (e só ele). Salva o modelo para reuso e registra no histórico.
app.post('/api/financeiro/enviar', auth, adminOnly, async (req, res) => {
  const mesRef = (typeof req.body.mes_ref === 'string' && /^\d{4}-\d{2}$/.test(req.body.mes_ref)) ? req.body.mes_ref : mesRefAnterior();
  const itens = Array.isArray(req.body.itens) ? req.body.itens : [];
  const tpl = (req.body.template && typeof req.body.template === 'object') ? req.body.template : {};
  if (!itens.length) return res.status(400).json({ erro: 'Nenhum cliente selecionado' });
  try {
    if (typeof tpl.assunto === 'string' && tpl.assunto.length <= 200)
      await pool.query(`INSERT INTO config (chave,valor) VALUES ('tpl_assunto',$1) ON CONFLICT (chave) DO UPDATE SET valor=$1`, [tpl.assunto]);
    if (typeof tpl.corpo === 'string' && tpl.corpo.length <= 4000)
      await pool.query(`INSERT INTO config (chave,valor) VALUES ('tpl_corpo',$1) ON CONFLICT (chave) DO UPDATE SET valor=$1`, [tpl.corpo]);

    let enviados = 0; const falhas = [];
    for (const it of itens) {
      const cid = parseInt(it.cliente_id);
      try {
        const c = await pool.query('SELECT * FROM clientes WHERE id=$1 AND ativo=true', [cid]);
        if (!c.rows.length) { falhas.push({ cliente_id: cid, motivo: 'cliente não encontrado' }); continue; }
        const cli = c.rows[0];
        if (!isEmail(cli.email || '')) { falhas.push({ cliente_id: cid, nome: cli.nome, motivo: 'e-mail inválido' }); continue; }

        if (cli.plano === 'cortesia') {
          await enviarCortesia(cli, mesRef);
          await pool.query('INSERT INTO pagamentos (cliente_id,mes_ref,valor,pago,data_pagamento,enviado_em) VALUES ($1,$2,0,true,NOW(),NOW()) ON CONFLICT (cliente_id,mes_ref) DO UPDATE SET enviado_em=NOW()', [cli.id, mesRef]);
          await registrarEmailLog(cli, mesRef, 'cortesia', 'Felogix — obrigado por mais um mês!', 0);
          enviados++; continue;
        }

        let valor = (it.valor !== undefined && it.valor !== null && !isNaN(parseFloat(it.valor))) ? parseFloat(it.valor) : (await calcularFatura(cli, mesRef)).valor;
        if (valor < 0) valor = 0;
        const vars = { nome: cli.nome, valor: fmtMoeda(valor), mes: fmtMesRef(mesRef), pix: PIX_KEY };
        const assunto = aplicarVars(((typeof it.assunto === 'string' && it.assunto.trim()) ? it.assunto : (tpl.assunto || TPL_ASSUNTO_PADRAO)), vars).slice(0, 200);
        const corpo   = aplicarVars(((typeof it.corpo === 'string' && it.corpo.trim()) ? it.corpo : (tpl.corpo || TPL_CORPO_PADRAO)), vars);
        await sendMail(cli.email, assunto, montarHtmlFatura(corpo, valor, cli, mesRef));
        await pool.query('INSERT INTO pagamentos (cliente_id,mes_ref,valor,enviado_em) VALUES ($1,$2,$3,NOW()) ON CONFLICT (cliente_id,mes_ref) DO UPDATE SET valor=$3, enviado_em=NOW()', [cli.id, mesRef, valor]);
        await registrarEmailLog(cli, mesRef, 'fatura', assunto, valor);
        enviados++;
      } catch (e) { falhas.push({ cliente_id: cid, motivo: e.message }); }
    }
    res.json({ ok: true, enviados, falhas });
  } catch (err) { console.error(err); res.status(500).json({ erro: 'Erro interno' }); }
});

// Histórico de e-mails enviados
app.get('/api/financeiro/emails', auth, adminOnly, async (req, res) => {
  const r = await pool.query('SELECT id,cliente_nome,email,mes_ref,tipo,assunto,valor,enviado_em FROM emails_log ORDER BY enviado_em DESC LIMIT 200');
  res.json(r.rows);
});

/* ─── HEALTH ─── */
app.get('/api/health', (req, res) => res.json({ status: 'ok', sistema: 'Felogix', versao: '2.3' }));

/* ─── 404 / CATCH ALL ─── */
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ erro: 'Rota não encontrada' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ─── ERROR HANDLER ─── */
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ erro: 'Erro interno do servidor' });
});

initDB().then(() => {
  app.listen(PORT, '127.0.0.1', () => console.log(`Felogix v2.3 rodando na porta ${PORT}`));
  verificarLembreteMensal();                                   // lembra o admin (não envia ao cliente)
  setInterval(verificarLembreteMensal, 6 * 60 * 60 * 1000);    // e a cada 6 horas
}).catch(err => { console.error('DB error:', err); process.exit(1); });
