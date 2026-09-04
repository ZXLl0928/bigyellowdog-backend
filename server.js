/* ============================================================
 *  大黄狗运营看板 · 团队云端后端
 *  - 扒热点代理（服务端 fetch，解决同事电脑无本机服务 / 跨域）
 *  - 团队共享看板存储（JSON 文件，零外部数据库）
 *  - WebSocket 实时同步
 *  - 邮箱密码登录，首位注册者 = 管理员(owner)
 *  依赖：express + ws（纯 JS，无需编译）
 * ============================================================ */
const express = require('express');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');

const app = express();
app.use(express.json({ limit: '12mb' }));

/* ---------- CORS（允许前端 Netlify 域跨域） ---------- */
const ALLOW = (process.env.ALLOW_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const o = req.headers.origin;
  const allow = ALLOW.includes('*') || (o && ALLOW.includes(o));
  if (allow) {
    res.setHeader('Access-Control-Allow-Origin', ALLOW.includes('*') ? '*' : o);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ---------- 文件存储 ---------- */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const BOARD_FILE = path.join(DATA_DIR, 'board.json');
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const writeJSON = (f, o) => { fs.writeFileSync(f, JSON.stringify(o, null, 2)); };
let users = readJSON(USERS_FILE, []);
let board = readJSON(BOARD_FILE, { state: { videos: [], hotspots: [], accounts: [], festivals: [] }, updated_by: null, updated_at: null });

/* ---------- 密码 & Token ---------- */
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
function hashPwd(pwd) { const s = crypto.randomBytes(16).toString('hex'); const h = crypto.scryptSync(pwd, s, 64).toString('hex'); return s + ':' + h; }
function verifyPwd(pwd, stored) {
  const [s, h] = (stored || '').split(':'); if (!s || !h) return false;
  const hh = crypto.scryptSync(pwd, s, 64).toString('hex');
  try { return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hh, 'hex')); } catch (e) { return false; }
}
function signToken(uid) {
  const p = { uid, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 };
  const body = Buffer.from(JSON.stringify(p)).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(t) {
  try {
    const [b, s] = t.split('.');
    const sig = crypto.createHmac('sha256', JWT_SECRET).update(b).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(s))) return null;
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    if (p.exp < Date.now()) return null;
    return p.uid;
  } catch (e) { return null; }
}

/* ---------- 鉴权中间件 ---------- */
function auth(req, res, next) {
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/);
  const uid = m ? verifyToken(m[1]) : null;
  if (!uid) return res.status(401).json({ error: 'unauthorized' });
  const u = users.find(x => x.id === uid && !x.disabled);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  req.user = u; next();
}
const publicUser = u => ({ id: u.id, email: u.email, displayName: u.displayName, role: u.role, created_at: u.created_at });

/* ---------- 健康检查 ---------- */
app.get('/api/health', (req, res) => res.json({ ok: true, users: users.length, ts: Date.now() }));

/* ---------- 注册 / 登录 ---------- */
app.post('/api/signup', (req, res) => {
  const { email, password, displayName } = req.body || {};
  if (!email || !password || password.length < 6) return res.status(400).json({ error: '邮箱和密码(≥6位)必填' });
  if (users.find(u => u.email === email)) return res.status(400).json({ error: '该邮箱已注册' });
  const role = users.length === 0 ? 'owner' : 'member';
  const u = { id: crypto.randomUUID(), email, password: hashPwd(password), displayName: displayName || email.split('@')[0], role, created_at: new Date().toISOString(), disabled: false };
  users.push(u); writeJSON(USERS_FILE, users);
  res.json({ token: signToken(u.id), user: publicUser(u) });
});
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = users.find(x => x.email === email && !x.disabled);
  if (!u || !verifyPwd(password, u.password)) return res.status(401).json({ error: '邮箱或密码错误' });
  res.json({ token: signToken(u.id), user: publicUser(u) });
});

/* ---------- 共享看板 ---------- */
app.get('/api/board', auth, (req, res) => res.json({ state: board.state, updated_by: board.updated_by, updated_at: board.updated_at }));
app.post('/api/board', auth, (req, res) => {
  const st = req.body && req.body.state ? req.body.state : req.body;
  if (!st || typeof st !== 'object') return res.status(400).json({ error: 'invalid body' });
  board.state = st; board.updated_by = req.user.id; board.updated_at = new Date().toISOString();
  writeJSON(BOARD_FILE, board);
  broadcast({ type: 'board', state: board.state, updated_by: board.updated_by, updated_at: board.updated_at });
  res.json({ ok: true });
});

/* ---------- 成员管理（仅 owner） ---------- */
app.get('/api/members', auth, (req, res) => res.json(users.filter(u => !u.disabled).map(publicUser)));
app.patch('/api/members/:id', auth, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: '仅管理员可管理成员' });
  const t = users.find(u => u.id === req.params.id && !u.disabled); if (!t) return res.status(404).json({ error: 'not found' });
  if (req.body && req.body.role) t.role = req.body.role === 'owner' ? 'owner' : 'member';
  writeJSON(USERS_FILE, users); res.json({ ok: true });
});
app.delete('/api/members/:id', auth, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: '仅管理员可管理成员' });
  const t = users.find(u => u.id === req.params.id); if (!t) return res.status(404).json({ error: 'not found' });
  if (t.id === req.user.id) return res.status(400).json({ error: '不能移除自己' });
  t.disabled = true; writeJSON(USERS_FILE, users); res.json({ ok: true });
});

/* ---------- 扒热点代理（解决同事跨域 / 无本机服务） ---------- */
const HOT_SOURCES = [
  r => `https://api-hot.imsyy.top/${r}?limit=${'_LIMIT_'}&cache=false`,
  r => `https://api.vvhan.com/api/hotlist/douyin?type=${r}`,
  r => `https://60s.viki.moe/v2/${r}`
];
app.get('/api/hot', async (req, res) => {
  const route = (req.query.route || 'douyin').toString().replace(/[^a-z0-9-]/gi, '');
  const limit = Math.min(parseInt(req.query.limit || '20', 10) || 20, 50);
  for (const mk of HOT_SOURCES) {
    const u = mk(route).replace('_LIMIT_', String(limit));
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
      const r = await fetch(u, { signal: ctrl.signal }); clearTimeout(t);
      if (!r.ok) continue;
      const j = await r.json();
      const data = (j && j.data) || [];
      if (data.length) return res.json({ source: u, data });
    } catch (e) { /* 尝试下一个源 */ }
  }
  res.status(502).json({ error: '热点源暂不可用，请稍后重试' });
});

/* ---------- 启动 HTTP + WebSocket ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
function broadcast(obj) { const m = JSON.stringify(obj); wss.clients.forEach(c => { if (c.readyState === 1) try { c.send(m); } catch (e) { } }); }
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const uid = verifyToken(url.searchParams.get('token'));
  if (!uid) { try { ws.close(1008, 'unauthorized'); } catch (e) { } return; }
  const u = users.find(x => x.id === uid && !x.disabled);
  if (!u) { try { ws.close(1008, 'unauthorized'); } catch (e) { } return; }
  ws.uid = uid;
  ws.send(JSON.stringify({ type: 'hello', role: u.role }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('[bigyellowdog-api] listening on ' + PORT + ' · users=' + users.length));
