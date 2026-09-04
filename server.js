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

/* ---------- GitHub 持久化存储（解决 Render 临时磁盘丢数据问题） ---------- */
const GH_TOKEN = process.env.GH_TOKEN || '';
const GH_REPO = process.env.GH_DATA_REPO || 'ZXLl0928/bigyellowdog-data';
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const ghH = { 'Authorization': 'Bearer ' + GH_TOKEN, 'User-Agent': 'bigyellowdog', 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' };

async function ghGet(p) {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(p)}?ref=${GH_BRANCH}`, { headers: ghH });
  if (r.status === 404) return { content: null, sha: null };
  if (!r.ok) throw new Error('gh GET ' + p + ' -> ' + r.status);
  const j = await r.json();
  return { content: Buffer.from(j.content, 'base64').toString('utf8'), sha: j.sha };
}
async function ghPut(p, content) {
  let sha = null;
  try { const cur = await ghGet(p); sha = cur.sha; } catch (e) {}
  const body = { message: 'update ' + p, content: Buffer.from(content, 'utf8').toString('base64'), branch: GH_BRANCH };
  if (sha) body.sha = sha;
  let r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(p)}`, { method: 'PUT', headers: ghH, body: JSON.stringify(body) });
  if (r.status === 409) {
    try { const cur = await ghGet(p); sha = cur.sha; } catch (e) {}
    const body2 = { message: 'update ' + p, content: Buffer.from(content, 'utf8').toString('base64'), branch: GH_BRANCH };
    if (sha) body2.sha = sha;
    r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(p)}`, { method: 'PUT', headers: ghH, body: JSON.stringify(body2) });
  }
  if (!r.ok) throw new Error('gh PUT ' + p + ' -> ' + r.status);
  const j = await r.json();
  return j.content ? j.content.sha : null;
}

let users = [];
let board = { state: { videos: [], hotspots: [], accounts: [], festivals: [] }, updated_by: null, updated_at: null };
let saveQueue = Promise.resolve();

async function loadStore() {
  try { const u = await ghGet('users.json'); if (u.content) users = JSON.parse(u.content); } catch (e) { console.error('[store] load users failed:', e.message); }
  try { const b = await ghGet('board.json'); if (b.content) board = JSON.parse(b.content); } catch (e) { console.error('[store] load board failed:', e.message); }
}
function saveUsers() {
  const snap = JSON.stringify(users, null, 2);
  saveQueue = saveQueue.then(() => ghPut('users.json', snap)).catch(e => console.error('[store] save users failed:', e.message));
  return saveQueue;
}
function saveBoard() {
  const snap = JSON.stringify(board, null, 2);
  saveQueue = saveQueue.then(() => ghPut('board.json', snap)).catch(e => console.error('[store] save board failed:', e.message));
  return saveQueue;
}

/* ---------- 密码 & Token ---------- */
let JWT_SECRET = process.env.JWT_SECRET || '';
async function ensureSecret() {
  if (JWT_SECRET) return;
  try { const s = await ghGet('secret.json'); if (s.content && s.content.trim()) { JWT_SECRET = s.content.trim(); return; } } catch (e) {}
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  try { await ghPut('secret.json', JWT_SECRET); } catch (e) { console.error('[store] save secret failed:', e.message); }
}
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
app.get('/api/health', (req, res) => res.json({ ok: true, users: users.length, ts: Date.now(), store: GH_TOKEN ? 'github:' + GH_REPO : 'memory' }));

/* ---------- 注册 / 登录 ---------- */
app.post('/api/signup', async (req, res) => {
  const { email, password, displayName } = req.body || {};
  if (!email || !password || password.length < 6) return res.status(400).json({ error: '邮箱和密码(≥6位)必填' });
  if (users.find(u => u.email === email)) return res.status(400).json({ error: '该邮箱已注册' });
  const role = users.length === 0 ? 'owner' : 'member';
  const u = { id: crypto.randomUUID(), email, password: hashPwd(password), displayName: displayName || email.split('@')[0], role, created_at: new Date().toISOString(), disabled: false };
  users.push(u); await saveUsers();
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
app.post('/api/board', auth, async (req, res) => {
  const st = req.body && req.body.state ? req.body.state : req.body;
  if (!st || typeof st !== 'object') return res.status(400).json({ error: 'invalid body' });
  board.state = st; board.updated_by = req.user.id; board.updated_at = new Date().toISOString();
  await saveBoard();
  broadcast({ type: 'board', state: board.state, updated_by: board.updated_by, updated_at: board.updated_at });
  res.json({ ok: true });
});

/* ---------- 成员管理（仅 owner） ---------- */
app.get('/api/members', auth, (req, res) => res.json(users.filter(u => !u.disabled).map(publicUser)));
app.patch('/api/members/:id', auth, async (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: '仅管理员可管理成员' });
  const t = users.find(u => u.id === req.params.id && !u.disabled); if (!t) return res.status(404).json({ error: 'not found' });
  if (req.body && req.body.role) t.role = req.body.role === 'owner' ? 'owner' : 'member';
  await saveUsers(); res.json({ ok: true });
});
app.delete('/api/members/:id', auth, async (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: '仅管理员可管理成员' });
  const t = users.find(u => u.id === req.params.id); if (!t) return res.status(404).json({ error: 'not found' });
  if (t.id === req.user.id) return res.status(400).json({ error: '不能移除自己' });
  t.disabled = true; await saveUsers(); res.json({ ok: true });
});

/* ---------- 扒热点代理（解决同事跨域 / 无本机服务） ---------- */
/* 混合源：uapis 用 async 函数（输出已标准化），旧源用 URL 模板 */
const HOT_SOURCES = [
  // 第一源：uapis.cn —— 免费、免 key、40+ 平台、Render 海外节点直连 OK
  // 6+ 平台全支持：douyin/weibo/zhihu/bilibili/xiaohongshu/toutiao/baidu/36kr/sspai/ithome/huxiu/kuaishou/csdn/thepaper/qq-news/netease-news
  async (r) => {
    const u = `https://uapis.cn/api/v1/misc/hotboard?type=${encodeURIComponent(r)}&limit=30`;
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const resp = await fetch(u, { signal: ctrl.signal }); clearTimeout(t);
      if (!resp.ok) return null;
      const j = await resp.json();
      if (!j || !j.list) return null;
      // 标准化输出：list → data, hot_value → hot
      const data = j.list.map(it => ({ title: it.title, url: it.url, hot: it.hot_value || 0 }));
      if (!data.length) return null;
      return { source: 'uapis', data };
    } catch (e) { clearTimeout(t); return null; }
  },
  // 旧源兜底（防 uapis 抽风或新增 uapis 不支持的平台）
  r => ({ url: `https://api-hot.imsyy.top/${r}?limit=${'_LIMIT_'}&cache=false`, transform: j => (j && j.data) || [] }),
  r => ({ url: `https://api.vvhan.com/api/hotlist/${r}`, transform: j => (j && j.data) || [] }),
  r => ({ url: `https://60s.viki.moe/v2/${r}`, transform: j => (j && j.data) || [] })
];
app.get('/api/hot', async (req, res) => {
  const route = (req.query.route || 'douyin').toString().replace(/[^a-z0-9-]/gi, '');
  const limit = Math.min(parseInt(req.query.limit || '20', 10) || 20, 50);
  for (const mk of HOT_SOURCES) {
    try {
      const out = await mk(route);
      if (!out) continue;
      // async 函数源（uapis）：直接返回 {source, data}
      if (out.source && out.data) {
        return res.json({ source: out.source + ':' + route, data: out.data.slice(0, limit) });
      }
      // 字符串模板源（旧的）：fetch + transform
      if (out.url) {
        const u = out.url.replace('_LIMIT_', String(limit));
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
        const r = await fetch(u, { signal: ctrl.signal }); clearTimeout(t);
        if (!r.ok) continue;
        const j = await r.json();
        const data = (out.transform ? out.transform(j) : (j && j.data)) || [];
        if (data.length) return res.json({ source: u, data });
      }
    } catch (e) { /* 尝试下一个源 */ }
  }
  res.status(502).json({ error: '热点源暂不可用，请稍后重试' });
});

/* ---------- 智谱代理（owner 在 Render 配 ZHIPU_KEY 一次，全团队免配 Key 即可用 AI） ---------- */
const ZHIPU_KEY = process.env.ZHIPU_KEY || '';
const ZHIPU_MODELS = ['glm-5.3', 'glm-4-flash', 'glm-4-plus', 'glm-4-air'];

app.get('/api/zhipu/ping', (req, res) => {
  res.json({ ok: true, configured: !!ZHIPU_KEY, models: ZHIPU_MODELS });
});

app.post('/api/zhipu/v4/chat/completions', async (req, res) => {
  if (!ZHIPU_KEY) return res.status(200).json({ ok: false, error: 'ZHIPU_KEY 未配置（请 owner 在 Render 控制台设置后端环境变量 ZHIPU_KEY）' });
  const { messages, model } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(200).json({ ok: false, error: 'messages 为空' });
  const useModel = ZHIPU_MODELS.includes(model) ? model : 'glm-5.3';
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 50000);
  try {
    const r = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ZHIPU_KEY },
      body: JSON.stringify({ model: useModel, messages, temperature: 0.8, top_p: 0.8, max_tokens: 4000, stream: false }),
      signal: ctrl.signal
    });
    const j = await r.json();
    if (!r.ok) return res.status(200).json({ ok: false, error: (j.error && j.error.message) || ('HTTP ' + r.status) });
    res.json({ ok: true, raw: j, model_used: useModel });
  } catch (e) {
    res.status(200).json({ ok: false, error: e.name === 'AbortError' ? '超时 50s' : (e.message || '智谱请求失败') });
  } finally { clearTimeout(t); }
});

/* ---------- 爆款链接解析（让爆款库能「链接 → 自动取标题+文案」） ----------
 * 当前支持能力：
 *  - 抖音：iesdouyin share 页 SSR（方案来自 douyin-downloader skill），提取 videoInfoRes.item_list[0]
 *          的 desc / author.nickname（desc 通常是用户简介，往往不是完整口播文案，仅作识别用）
 *  - 小红书 / B站 / 视频号 / TikTok：当前仅识别 platform（反爬严，提示用户手动粘文案）
 * 失败 / 反爬时返回 script: '' 并给 msg，前端降级显示「请手动粘文案」
 * ─────────────────────────────────────────────────────────────────────────── */
async function _parseDouyinById(videoId) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`https://www.iesdouyin.com/share/video/${videoId}/?region=CN&aid=6383`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': 'https://www.douyin.com/'
      },
      signal: ctrl.signal
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const html = await r.text();
    // 兼容两种：window._ROUTER_DATA = {...}; 或 window.__INIT_PROPS__ 形式
    const m1 = html.match(/window\._ROUTER_DATA\s*=\s*(\{.+?\});\s*<\/script>/);
    const m2 = m1 ? null : html.match(/"videoInfoRes":\s*(\{.+?\})\s*,\s*"(?:tagList|commentList|shareUrl)"/);
    if (m1) {
      const router = JSON.parse(m1[1]);
      for (const key of Object.keys(router?.loaderData || {})) {
        const vi = router.loaderData[key]?.videoInfoRes?.item_list?.[0];
        if (vi) return { title: (vi.desc||'').slice(0, 200), script: vi.desc || '', author: vi.author?.nickname || '', cover: (vi.video?.cover?.[0]?.url_list?.[0]) || '' };
      }
    }
    if (m2) {
      try {
        const info = JSON.parse(m2[1]);
        const it = info?.item_list?.[0];
        if (it) return { title: (it.desc||'').slice(0, 200), script: it.desc || '', author: it.author?.nickname || '', cover: (it.video?.cover?.[0]?.url_list?.[0]) || '' };
      } catch (e) {}
    }
    return null;
  } catch (e) { try { clearTimeout(t); } catch (e2) {} return null; }
}

app.get('/api/blowout/parse', async (req, res) => {
  const url = (req.query.url || '').toString().trim();
  if (!url) return res.status(400).json({ ok: false, error: 'url 不能为空' });
  const data = { platform: '其他', title: '', script: '', author: '', cover: '', videoId: '', source: 'none', msg: '' };
  try {
    if (/douyin\.com|iesdouyin\.com/.test(url)) {
      data.platform = '抖音';
      const m = url.match(/video\/(\d+)/) || url.match(/(\d{10,20})/);
      if (m) {
        data.videoId = m[1];
        const r = await _parseDouyinById(m[1]);
        if (r) {
          data.title = r.title; data.script = r.script; data.author = r.author; data.cover = r.cover;
          data.source = 'iesdouyin';
        } else {
          data.msg = '抖音：未能拿到 desc（可能反爬限速）；视频号/B站等请手动粘文案。';
          data.source = 'fallback';
        }
      } else {
        data.msg = '抖音链接里没找到 videoId';
      }
    } else if (/xiaohongshu\.com|xhslink\.com/.test(url)) {
      data.platform = '小红书'; data.msg = '小红书反爬严，自动识别受限，请手动粘文案';
    } else if (/bilibili\.com|b23\.tv/.test(url)) {
      data.platform = 'B站'; data.msg = 'B站自动识别受限，请手动粘文案';
    } else if (/mp\.video\.weixin|视频号|channels\.weixin/.test(url)) {
      data.platform = '视频号'; data.msg = '视频号自动识别受限，请手动粘文案';
    } else if (/tiktok\.com/.test(url)) {
      data.platform = 'TikTok'; data.msg = 'TikTok 自动识别受限，请手动粘文案';
    } else {
      data.msg = '未识别的平台';
    }
    res.json({ ok: true, data });
  } catch (e) {
    res.json({ ok: false, error: e.message || '解析失败' });
  }
});

/* ---------- 启动（先加载持久化数据，再监听端口） ---------- */
const PORT = process.env.PORT || 3000;
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

(async () => {
  await loadStore();
  await ensureSecret();
  server.listen(PORT, () => console.log('[bigyellowdog-api] listening on ' + PORT + ' · users=' + users.length + (GH_TOKEN ? ' · store=github:' + GH_REPO : ' · store=MEMORY-ONLY')));
})();
