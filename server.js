const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'felogix_secret_2026';
const PIX_KEY = '54.054.345/0001-57';

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'felogix',
  password: '',
  port: 5432,
});

// Mailer — configurar quando tiver email
const mailer = nodemailer.createTransport({
  host: 'smtp.gmail.com', port: 587, secure: false,
  auth: { user: process.env.MAIL_USER || '', pass: process.env.MAIL_PASS || '' }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ─── HELPERS ─── */
function gerarSenha() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

function auth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ erro: 'Não autorizado' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ erro: 'Token inválido' }); }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ erro: 'Sem permissão' });
  next();
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
      cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
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
      criado_em TIMESTAMP DEFAULT NOW()
    );
  `);
  // Garante cliente Impacto
  await pool.query(`
    INSERT INTO clientes (tipo,documento,nome,email,senha,plano,ativo)
    VALUES ('cnpj','54.024.215/0001-00','Impacto Segurança','frota@grupoimpacto.com.br','Frota@123','track',true)
    ON CONFLICT (email) DO NOTHING
  `);
  console.log('DB iniciado');
}

/* ─── LOGIN ─── */
app.post('/api/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ erro: 'Preencha email e senha' });

  // Admin fixo
  if (email === 'felipe.sousa@felogix.com.br' && senha === '95050578.Fege') {
    const token = jwt.sign({ id: 0, role: 'admin', nome: 'Felipe Andrade' }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token, role: 'admin', nome: 'Felipe Andrade', initials: 'FA' });
  }

  try {
    const r = await pool.query('SELECT * FROM clientes WHERE email=$1 AND ativo=true', [email]);
    if (!r.rows.length || r.rows[0].senha !== senha)
      return res.status(401).json({ erro: 'Email ou senha incorretos' });
    const c = r.rows[0];
    const token = jwt.sign({ id: c.id, role: 'gestor', nome: c.nome, empresa: c.nome }, JWT_SECRET, { expiresIn: '7d' });
    const initials = c.nome.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    res.json({ token, role: 'gestor', nome: c.nome, empresa: c.nome, initials, plano: c.plano });
  } catch (err) { console.error(err); res.status(500).json({ erro: 'Erro interno' }); }
});

/* ─── ESQUECI SENHA ─── */
app.post('/api/esqueci-senha', async (req, res) => {
  const { email } = req.body;
  try {
    const r = await pool.query('SELECT * FROM clientes WHERE email=$1', [email]);
    if (!r.rows.length) return res.json({ ok: true }); // não revela se existe
    const nova = gerarSenha();
    await pool.query('UPDATE clientes SET senha=$1 WHERE email=$2', [nova, email]);
    try {
      await mailer.sendMail({
        from: '"Felogix" <noreply@felogix.com.br>',
        to: email,
        subject: 'Sua nova senha — Felogix',
        html: `<p>Olá, <b>${r.rows[0].nome}</b>!</p>
               <p>Sua nova senha é: <b style="font-size:20px">${nova}</b></p>
               <p>Acesse <a href="https://felogix.com.br">felogix.com.br</a> e altere sua senha após o login.</p>`
      });
    } catch (mailErr) { console.error('Email error:', mailErr.message); }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

/* ─── ALTERAR SENHA ─── */
app.post('/api/alterar-senha', auth, async (req, res) => {
  const { senha_atual, nova_senha } = req.body;
  if (req.user.role === 'admin') {
    return res.status(400).json({ erro: 'Admin não pode alterar senha aqui' });
  }
  try {
    const r = await pool.query('SELECT * FROM clientes WHERE id=$1', [req.user.id]);
    if (!r.rows.length || r.rows[0].senha !== senha_atual)
      return res.status(400).json({ erro: 'Senha atual incorreta' });
    await pool.query('UPDATE clientes SET senha=$1 WHERE id=$2', [nova_senha, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

/* ─── CLIENTES (admin) ─── */
app.get('/api/clientes', auth, adminOnly, async (req, res) => {
  const r = await pool.query('SELECT id,tipo,documento,nome,email,plano,valor_plano,dia_vencimento,ativo,criado_em FROM clientes ORDER BY criado_em DESC');
  res.json(r.rows);
});

app.post('/api/clientes', auth, adminOnly, async (req, res) => {
  const { tipo, documento, nome, email, plano, valor_plano, dia_vencimento } = req.body;
  if (!documento || !nome || !email) return res.status(400).json({ erro: 'Preencha todos os campos' });
  const senha = gerarSenha();
  try {
    const r = await pool.query(
      'INSERT INTO clientes (tipo,documento,nome,email,senha,plano,valor_plano,dia_vencimento) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,nome,email,plano',
      [tipo||'cpf', documento, nome, email, senha, plano||'cortesia', valor_plano||0, dia_vencimento||10]
    );
    // tenta enviar senha por email
    try {
      await mailer.sendMail({
        from: '"Felogix" <noreply@felogix.com.br>',
        to: email,
        subject: 'Bem-vindo ao Felogix!',
        html: `<p>Olá, <b>${nome}</b>!</p>
               <p>Seu acesso ao Felogix foi criado.</p>
               <p>Email: <b>${email}</b><br>Senha: <b>${senha}</b></p>
               <p>Acesse: <a href="https://felogix.com.br">felogix.com.br</a></p>`
      });
    } catch (e) { console.error('Email:', e.message); }
    res.json({ ...r.rows[0], senha_gerada: senha });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'Email ou documento já cadastrado' });
    res.status(500).json({ erro: 'Erro interno' });
  }
});

app.put('/api/clientes/:id', auth, adminOnly, async (req, res) => {
  const { nome, email, plano, valor_plano, dia_vencimento, ativo, senha } = req.body;
  try {
    const sets = []; const vals = []; let i = 1;
    if (nome !== undefined)           { sets.push(`nome=$${i++}`);           vals.push(nome); }
    if (email !== undefined)          { sets.push(`email=$${i++}`);          vals.push(email); }
    if (plano !== undefined)          { sets.push(`plano=$${i++}`);          vals.push(plano); }
    if (valor_plano !== undefined)    { sets.push(`valor_plano=$${i++}`);    vals.push(valor_plano); }
    if (dia_vencimento !== undefined) { sets.push(`dia_vencimento=$${i++}`); vals.push(dia_vencimento); }
    if (ativo !== undefined)          { sets.push(`ativo=$${i++}`);          vals.push(ativo); }
    if (senha !== undefined)          { sets.push(`senha=$${i++}`);          vals.push(senha); }
    if (!sets.length) return res.status(400).json({ erro: 'Nada a atualizar' });
    vals.push(req.params.id);
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
  try {
    const r = await pool.query(
      'INSERT INTO veiculos (cliente_id,placa,imei,modelo,ano,cor) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [cliente_id, placa.toUpperCase(), imei||null, modelo||'Veículo', ano||2024, cor||'—']
    );
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'Placa já cadastrada' });
    res.status(500).json({ erro: 'Erro interno' });
  }
});

app.put('/api/veiculos/:id', auth, async (req, res) => {
  const { bloqueado, modelo, ano, cor, imei } = req.body;
  try {
    const sets = []; const vals = []; let i = 1;
    if (bloqueado !== undefined) { sets.push(`bloqueado=$${i++}`); vals.push(bloqueado); }
    if (modelo) { sets.push(`modelo=$${i++}`); vals.push(modelo); }
    if (ano)    { sets.push(`ano=$${i++}`);    vals.push(ano); }
    if (cor)    { sets.push(`cor=$${i++}`);    vals.push(cor); }
    if (imei)   { sets.push(`imei=$${i++}`);   vals.push(imei); }
    vals.push(req.params.id);
    const r = await pool.query(`UPDATE veiculos SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

app.delete('/api/veiculos/:id', auth, adminOnly, async (req, res) => {
  await pool.query('DELETE FROM veiculos WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

/* ─── ALERTAS PREFS ─── */
app.get('/api/alertas', auth, async (req, res) => {
  const id = req.user.role === 'admin' ? null : req.user.id;
  if (!id) return res.json({});
  const r = await pool.query('SELECT * FROM alertas_prefs WHERE cliente_id=$1', [id]);
  if (r.rows.length) return res.json(r.rows[0]);
  // cria default
  const n = await pool.query(
    'INSERT INTO alertas_prefs (cliente_id,email_alertas) VALUES ($1,$2) RETURNING *',
    [id, req.user.email || '']
  );
  res.json(n.rows[0]);
});

app.put('/api/alertas', auth, async (req, res) => {
  if (req.user.role === 'admin') return res.status(403).json({ erro: 'Sem permissão' });
  const { email_alertas, velocidade, bloqueio, geocerca, offline, horario } = req.body;
  try {
    const r = await pool.query(`
      INSERT INTO alertas_prefs (cliente_id,email_alertas,velocidade,bloqueio,geocerca,offline,horario)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (cliente_id) DO UPDATE SET
        email_alertas=$2,velocidade=$3,bloqueio=$4,geocerca=$5,offline=$6,horario=$7
      RETURNING *`,
      [req.user.id, email_alertas, velocidade, bloqueio, geocerca, offline, horario]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

/* ─── FINANCEIRO ─── */
app.get('/api/financeiro', auth, adminOnly, async (req, res) => {
  const r = await pool.query(`
    SELECT c.id,c.nome,c.email,c.plano,c.valor_plano,c.dia_vencimento,
      (SELECT COUNT(*) FROM veiculos WHERE cliente_id=c.id) as qtd_veiculos,
      (SELECT json_agg(p ORDER BY p.criado_em DESC) FROM pagamentos p WHERE p.cliente_id=c.id) as pagamentos
    FROM clientes c WHERE c.ativo=true ORDER BY c.nome
  `);
  res.json({ clientes: r.rows, pix: PIX_KEY });
});

app.post('/api/financeiro/cobrar', auth, adminOnly, async (req, res) => {
  const { cliente_id } = req.body;
  try {
    const c = await pool.query('SELECT * FROM clientes WHERE id=$1', [cliente_id]);
    if (!c.rows.length) return res.status(404).json({ erro: 'Cliente não encontrado' });
    const cli = c.rows[0];
    const qtdV = await pool.query('SELECT COUNT(*) FROM veiculos WHERE cliente_id=$1', [cliente_id]);
    const qtd = parseInt(qtdV.rows[0].count);
    const valor = cli.valor_plano > 0 ? cli.valor_plano : 0;
    const mesRef = new Date().toISOString().slice(0,7);

    const p = await pool.query(
      'INSERT INTO pagamentos (cliente_id,mes_ref,valor) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *',
      [cliente_id, mesRef, valor]
    );

    // envia email cobrança
    try {
      await mailer.sendMail({
        from: '"Felogix" <noreply@felogix.com.br>',
        to: cli.email,
        subject: `Fatura Felogix — ${mesRef}`,
        html: `<div style="font-family:sans-serif;max-width:500px;margin:auto">
          <h2 style="color:#D91A1A">Felogix Track</h2>
          <p>Olá, <b>${cli.nome}</b>!</p>
          <p>Segue sua fatura referente a <b>${mesRef}</b>:</p>
          <table style="width:100%;border-collapse:collapse">
            <tr><td>Plano</td><td><b>${cli.plano.toUpperCase()}</b></td></tr>
            <tr><td>Veículos</td><td><b>${qtd}</b></td></tr>
            <tr><td>Valor</td><td><b style="font-size:20px;color:#D91A1A">R$ ${valor.toFixed(2).replace('.',',')}</b></td></tr>
            <tr><td>Vencimento</td><td><b>Dia ${cli.dia_vencimento}</b></td></tr>
          </table>
          <div style="background:#f5f5f5;padding:16px;border-radius:8px;margin-top:16px">
            <p style="margin:0;font-size:12px;color:#666">Chave PIX</p>
            <p style="margin:4px 0;font-size:18px;font-weight:bold">${PIX_KEY}</p>
            <p style="margin:0;font-size:11px;color:#999">CNPJ — Felogix</p>
          </div>
          <p style="font-size:11px;color:#999;margin-top:16px">Dúvidas? Responda este email.</p>
        </div>`
      });
    } catch (e) { console.error('Email cobrança:', e.message); }

    res.json({ ok: true, valor, mes_ref: mesRef });
  } catch (err) { console.error(err); res.status(500).json({ erro: 'Erro interno' }); }
});

app.post('/api/financeiro/pago', auth, adminOnly, async (req, res) => {
  const { pagamento_id } = req.body;
  await pool.query('UPDATE pagamentos SET pago=true,data_pagamento=NOW() WHERE id=$1', [pagamento_id]);
  res.json({ ok: true });
});

/* ─── HEALTH ─── */
app.get('/api/health', (req, res) => res.json({ status: 'ok', sistema: 'Felogix', versao: '2.1' }));

app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDB().then(() => {
  app.listen(PORT, () => console.log('Felogix rodando na porta ' + PORT));
}).catch(err => { console.error('DB error:', err); process.exit(1); });
