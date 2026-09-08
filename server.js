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
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 25000);
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
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 25000);
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

/* Hacker News Algolia 代理：50+ 关键词搜索（AI 工具 / 跨境电商 趋势）；支持 tag 过滤如 show_hn */
app.get('/api/hn', async (req, res) => {
  const query = (req.query.query || '').toString().slice(0, 120);
  const tag = (req.query.tag || 'story').toString().slice(0, 32).replace(/[^a-z_]/g, '');
  const limit = Math.min(parseInt(req.query.limit || '4', 10) || 4, 20);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const url = (tag === 'show_hn')
      ? 'https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=' + limit
      : 'https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(query) + '&tags=' + tag + '&hitsPerPage=' + limit;
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; YellowDogHotBot/1.0; +https://bigyellowdog-web.onrender.com)' }
    });
    clearTimeout(t);
    if (!r.ok) return res.status(502).json({ error: 'HN returned ' + r.status });
    const j = await r.json();
    const items = (j.hits || []).map(h => ({
      id: h.objectID,
      title: h.title,
      url: h.url,
      score: h.points || 0
    })).filter(x => x.title);
    res.json({ source: 'hn:' + (query || tag), data: items });
  } catch (e) {
    res.status(502).json({ error: e.message || 'hn fetch failed' });
  }
});

/* RSS 代理：国内 AI 资讯（机器之心等），简单 XML→JSON 解析，只取 title/link/pubDate */
app.get('/api/rss', async (req, res) => {
  const url = (req.query.url || '').toString().slice(0, 300);
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'valid url required' });
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; YellowDogHotBot/1.0)' } });
    clearTimeout(t);
    if (!r.ok) return res.status(502).json({ error: 'rss upstream ' + r.status });
    const xml = await r.text();
    // 简单解析 <item> 或 <entry> 块
    const items = [];
    const itemRe = /<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/gi;
    const titleRe = /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i;
    const linkRe = /<link[^>]*?href=["']([^"']+)["']|<link[^>]*>([\s\S]*?)<\/link>/i;
    const pubRe = /<pubDate[^>]*>([\s\S]*?)<\/pubDate>|<published[^>]*>([\s\S]*?)<\/published>/i;
    let m;
    while ((m = itemRe.exec(xml))) {
      const block = m[0];
      const tm = block.match(titleRe);
      const lm = block.match(linkRe);
      const pm = block.match(pubRe);
      if (!tm) continue;
      const title = tm[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim().slice(0, 200);
      const link = (lm && (lm[1] || lm[2] || '').trim()) || '';
      const pub = (pm && (pm[1] || pm[2] || '').trim()) || '';
      if (title) items.push({ title, url: link, pubDate: pub });
      if (items.length >= 30) break;
    }
    res.json({ source: url, count: items.length, data: items });
  } catch (e) {
    res.status(502).json({ error: e.message || 'rss fetch failed' });
  }
});

/* ---------- 智谱代理（owner 在 Render 配 ZHIPU_KEY 一次，全团队免配 Key 即可用 AI） ---------- */
// 清洗 Key：去掉首尾空格 / 换行 / 以及用户可能误填的 "Bearer " 前缀（否则会变成 "Bearer Bearer xxx" 被智谱拒）
function normalizeZhipuKey(raw){
  let k=(raw||'').trim();
  k=k.replace(/^Bearer\s*/i, '');   // 去掉用户可能误填的 "Bearer " / "Bearer" 前缀
  return k.trim();
}
const ZHIPU_KEY = normalizeZhipuKey(process.env.ZHIPU_KEY || '');
const ZHIPU_MODELS = ['glm-5.3', 'glm-4-flash', 'glm-4-plus', 'glm-4-air'];

app.get('/api/zhipu/ping', (req, res) => {
  res.json({ ok: true, configured: !!ZHIPU_KEY, models: ZHIPU_MODELS });
});

app.post('/api/zhipu/v4/chat/completions', async (req, res) => {
  if (!ZHIPU_KEY) return res.status(200).json({ ok: false, error: 'ZHIPU_KEY 未配置（请 owner 在 Render 控制台设置后端环境变量 ZHIPU_KEY）' });
  const { messages, model, stream } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(200).json({ ok: false, error: 'messages 为空' });
  const useModel = ZHIPU_MODELS.includes(model) ? model : 'glm-5.3';
  const wantStream = !!stream;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 120000);  // 智谱生成完整脚本最坏 ~80-100s，120s 留 buffer
  try {
    const r = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ZHIPU_KEY },
      body: JSON.stringify({ model: useModel, messages, temperature: 0.8, top_p: 0.8, max_tokens: 4000, stream: wantStream }),
      signal: ctrl.signal
    });
    if (!r.ok) {
      const errj = await r.json().catch(() => ({}));
      return res.status(200).json({ ok: false, error: (errj.error && errj.error.message) || ('HTTP ' + r.status) });
    }
    if (!wantStream) {
      const j = await r.json();
      return res.json({ ok: true, raw: j, model_used: useModel });
    }
    // ===== 流式转发 SSE（打字机效果）=====
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const reader = r.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const ping = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch (e) {} }, 12000);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
    } catch (e) { /* 流中断，静默结束 */ }
    clearInterval(ping);
    try { res.write('data: [DONE]\n\n'); } catch (e) {}
    try { res.end(); } catch (e) {}
  } catch (e) {
    if (!res.headersSent) {
      res.status(200).json({ ok: false, error: e.name === 'AbortError' ? '超时 120s' : (e.message || '智谱请求失败') });
    } else {
      try { res.write('data: ' + JSON.stringify({ error: e.message || 'stream error' }) + '\n\n'); } catch (_) {}
      try { res.end(); } catch (_) {}
    }
  } finally { clearTimeout(t); }
});

/* ---------- 硅基流动代理（稳定免费备用通道：一个 Key 调 100+ 开源模型，含 DeepSeek / Qwen3 / ERNIE / 混元 等免费档） ---------- */
const SILICONFLOW_KEY = normalizeZhipuKey(process.env.SILICONFLOW_KEY || '');

/* ---------- 火山引擎方舟（豆包 Doubao Seed-2.1-Pro · 长脚本生成主力） ----------
 *  必须配置在 Render 后端 Environment → ARK_KEY（火山方舟控制台 https://www.volcengine.com 开通）
 *  未配置时 Seed-2.1-pro 引擎不可用，前端会自动 fallback 到 Yellow Dog GLM-4-Flash
 *  接口路径：https://ark.cn-beijing.volces.com/api/v3/responses（OpenAI Responses 格式）
 *  模型默认：doubao-seed-2-1-pro-260628（260B MoE，长文本/脚本性能强）
 * ───────────────────────────────────────────────────────────────────────────── */
const ARK_KEY = normalizeZhipuKey(process.env.ARK_KEY || '');
const ARK_MODEL = process.env.ARK_MODEL || 'doubao-seed-2-1-pro-260628';
const ARK_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/responses';

app.get('/api/engines', (req, res) => {
  res.json({
    zhipu: { configured: !!ZHIPU_KEY, models: ZHIPU_MODELS },
    siliconflow: { configured: !!SILICONFLOW_KEY },
    ark: { configured: !!ARK_KEY, model: ARK_MODEL }
  });
});

// 把前端 chat 风格的 messages（content 是字符串）转成 ark 的 input（content 是 [{type,text}] 数组）
function toArkInput(messages){
  return (messages||[]).map(m=>{
    const role = m.role;
    let content;
    if(Array.isArray(m.content)){
      // 已经是数组（多模态或已经格式化）—— 直接透传
      content = m.content;
    } else {
      content = [{ type:'input_text', text: String(m.content||'') }];
    }
    return { role, content };
  });
}

// 从 ark 响应里抠出正文（兼容多种返回结构，跳过 reasoning 思考段）
function pickArkText(j){
  // 形式 A: { output: [{ type:'reasoning', summary:[...] }, { type:'message', content:[{text}] }] }
  if(Array.isArray(j.output)){
    const txts=[];
    for(const o of j.output){
      // ⭐ 跳过推理/思考段：只拿 type==='message' 的正文；reasoning 内容不暴露给用户
      if(o.type && o.type!=='message') continue;
      if(Array.isArray(o.content)){
        for(const c of o.content){
          if(typeof c.text === 'string') txts.push(c.text);
        }
      } else if(typeof o.text === 'string'){
        txts.push(o.text);
      }
    }
    if(txts.length) return txts.join('');
  }
  // 形式 B: { choices: [{ message: { content } }] }（ark 也兼容 OpenAI chat 格式）
  if(j.choices && j.choices[0]){
    const ch = j.choices[0];
    if(ch.message && typeof ch.message.content === 'string') return ch.message.content;
    if(typeof ch.text === 'string') return ch.text;
  }
  // 形式 C: { content: [{ type:'output_text', text }] }
  if(Array.isArray(j.content)){
    const txts = j.content.map(c=>c.text||'').filter(Boolean);
    if(txts.length) return txts.join('');
  }
  return '';
}

// 从 ark SSE 流 delta 中抠增量文本（只取 type='message' 的正文，跳过 reasoning）
function pickArkDelta(j){
  // 形式 B: { output: [{ type:'reasoning'|'message', content:[{delta|text}] }] }
  if(Array.isArray(j.output)){
    for(const o of j.output){
      if(o.type && o.type!=='message') continue;   // ⭐ 跳过 reasoning
      if(Array.isArray(o.content)){
        for(const c of o.content){
          if(typeof c.delta === 'string') return c.delta;
          if(typeof c.text === 'string') return c.text;
        }
      } else if(typeof o.delta === 'string') return o.delta;
      else if(typeof o.text === 'string') return o.text;
    }
  }
  // 形式 A: 顶层 delta/text（少见，但保留）
  if(typeof j.delta === 'string') return j.delta;
  if(typeof j.text === 'string') return j.text;
  // 形式 C: { choices: [{ delta: { content } }] }
  if(j.choices && j.choices[0]){
    const ch = j.choices[0];
    if(ch.delta && typeof ch.delta.content === 'string') return ch.delta.content;
  }
  return '';
}

app.post('/api/ark/v1/responses', async (req, res) => {
  if(!ARK_KEY) return res.status(200).json({ ok:false, error:'ARK_KEY 未配置' });
  const { messages, model: reqModel, stream } = req.body || {};
  if(!Array.isArray(messages) || !messages.length) return res.status(200).json({ ok:false, error:'messages 为空' });
  const useModel = reqModel || ARK_MODEL;
  const wantStream = !!stream;
  // max_tokens: 8192 避免长脚本（5 段+ N 段 beat）正文被截断
  // thinking: disabled 强制推理模型不进入思考（避免 reasoning 额度吃光正文额度）
  const body = { model: useModel, input: toArkInput(messages), max_tokens: 8192, thinking: { type: 'disabled' } };
  // 长生成脚本系统提示词很长，150s 留 buffer
  const ctrl = new AbortController(); const t = setTimeout(()=>ctrl.abort(), 150000);
  try{
    const r = await fetch(ARK_ENDPOINT, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+ARK_KEY },
      body: JSON.stringify({ ...body, stream: wantStream }),
      signal: ctrl.signal
    });
    if(!r.ok){
      const errj = await r.json().catch(()=>({}));
      return res.status(200).json({ ok:false, error: (errj.error && (errj.error.message||errj.error.code)) || ('HTTP '+r.status) });
    }
    if(!wantStream){
      const j = await r.json();
      const txt = pickArkText(j);
      if(!txt) return res.status(200).json({ ok:false, error:'返回内容为空' });
      return res.json({ ok:true, raw:j, model_used: useModel });
    }
    // ===== 流式 SSE 转发（打字机效果）=====
    res.writeHead(200, { 'Content-Type':'text/event-stream; charset=utf-8', 'Cache-Control':'no-cache, no-transform', 'Connection':'keep-alive', 'X-Accel-Buffering':'no' });
    const reader = r.body.getReader(); const decoder = new TextDecoder('utf-8');
    const ping = setInterval(()=>{ try{ res.write(': keep-alive\n\n'); }catch(_){} }, 12000);
    try{
      let buf='';
      while(true){
        const { done, value } = await reader.read();
        if(done) break;
        buf += decoder.decode(value, { stream:true });
        const lines = buf.split('\n'); buf = lines.pop();
        for(const line of lines){
          const t = line.trim();
          if(!t || !t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if(data==='[DONE]') continue;
          try{
            const j = JSON.parse(data);
            if(j.error){ try{ res.write('data: '+JSON.stringify({error:j.error.message||j.error})+'\n\n'); }catch(_){ } continue; }
            const delta = pickArkDelta(j);
            if(delta){
              try{ res.write('data: '+JSON.stringify({choices:[{delta:{content:delta}}]})+'\n\n'); }catch(_){}
            }
          }catch(_){ }
        }
      }
    }catch(_){ }
    clearInterval(ping);
    try{ res.write('data: [DONE]\n\n'); res.end(); }catch(_){ }
  }catch(e){
    if(!res.headersSent){
      res.status(200).json({ ok:false, error: e.name==='AbortError' ? '超时 150s' : (e.message||'ark 请求失败') });
    }else{
      try{ res.write('data: '+JSON.stringify({error:e.message||'stream error'})+'\n\n'); res.end(); }catch(_){ }
    }
  }finally{ clearTimeout(t); }
});

/* ---------- 标题批量翻译（用于 HN/英文热点的中文化；走智谱 glm-4-flash 免费档） ----------
 * POST /api/translate { texts: ["title1","title2",...], target: 'zh-CN' } → { translated: [...] }
 * - 已含中文字符占比 > 30% 的标题直接原样返回（不调模型，省 token + 提高稳定性）
 * - 一次最多 50 条；超出会被截断
 * - 失败时整批返回原文（不阻塞前端）
 * ─────────────────────────────────────────────────────────────────────────── */
app.post('/api/translate', async (req, res) => {
  const { texts, target = 'zh-CN' } = req.body || {};
  if (!Array.isArray(texts) || !texts.length) return res.status(400).json({ ok: false, error: 'texts 必须是非空数组' });
  if (!ZHIPU_KEY) return res.status(200).json({ ok: false, error: 'ZHIPU_KEY 未配置', translated: texts }); // 静默降级
  const items = texts.slice(0, 50).map(t => String(t || '').slice(0, 280));
  // 过滤：含中文字符占比 > 30% 的标题不翻译
  const hasChinese = s => (s.match(/[一-龥]/g) || []).length / Math.max(1, s.length);
  const needIdx = items.map((t, i) => hasChinese(t) > 0.3 ? -1 : i).filter(i => i >= 0);
  if (!needIdx.length) return res.json({ ok: true, translated: items, skipped: items.length });
  const prompt = `请把下面 ${needIdx.length} 条英文/外文标题翻译成简洁通顺的简体中文，适合做短视频脚本标题（不超过 24 字，不要 emoji，不要加引号）。
原标题用 <i>0</i>、<i>1</i>、<i>2</i>……占位符分隔（不要保留占位符本身），按相同顺序输出，每行一条，只输出翻译结果。
${needIdx.map((i, k) => `<i>${k}</i> ${items[i]}`).join('\n')}`;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ZHIPU_KEY },
      body: JSON.stringify({ model: 'glm-4-flash', messages: [{ role: 'user', content: prompt }], temperature: 0.3, top_p: 0.9, max_tokens: 2000 }),
      signal: ctrl.signal
    });
    clearTimeout(t);
    if (!r.ok) { const ej = await r.json().catch(() => ({})); return res.status(200).json({ ok: false, error: (ej.error && ej.error.message) || ('HTTP ' + r.status), translated: items }); }
    const j = await r.json();
    const txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    // 按行拆；允许 <i>N</i> 前缀残留；也清理纯数字前缀 "0 "、"1."、"2)"
    const lines = txt.split(/\n+/).map(s => s.trim()).filter(Boolean).map(s => s.replace(/^(?:<i>\d+<\/i>|\[\d+\]|\(\d+\)|\d+[\.\)、])\s*/, ''));
    const out = items.slice();
    needIdx.forEach((origIdx, k) => { out[origIdx] = (lines[k] || items[origIdx]).trim(); });
    res.json({ ok: true, translated: out, model_used: 'glm-4-flash' });
  } catch (e) {
    try { clearTimeout(t); } catch (_) {}
    res.status(200).json({ ok: false, error: e.name === 'AbortError' ? '翻译超时' : (e.message || '翻译失败'), translated: items });
  }
});

app.post('/api/siliconflow/v4/chat/completions', async (req, res) => {
  if (!SILICONFLOW_KEY) return res.status(200).json({ ok: false, error: 'SILICONFLOW_KEY 未配置（owner 在 Render 控制台设置环境变量 SILICONFLOW_KEY 即可启用免费备用通道）' });
  const { messages, model = 'deepseek-ai/DeepSeek-V3', stream } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(200).json({ ok: false, error: 'messages 为空' });
  const useModel = model;
  const wantStream = !!stream;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SILICONFLOW_KEY },
      body: JSON.stringify({ model: useModel, messages, temperature: 0.8, top_p: 0.8, max_tokens: 4000, stream: wantStream }),
      signal: ctrl.signal
    });
    if (!r.ok) {
      const errj = await r.json().catch(() => ({}));
      return res.status(200).json({ ok: false, error: (errj.error && errj.error.message) || ('HTTP ' + r.status) });
    }
    if (!wantStream) {
      const j = await r.json();
      return res.json({ ok: true, raw: j, model_used: useModel });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const reader = r.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const ping = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch (e) {} }, 12000);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
    } catch (e) { /* 流中断，静默结束 */ }
    clearInterval(ping);
    try { res.write('data: [DONE]\n\n'); } catch (e) {}
    try { res.end(); } catch (e) {}
  } catch (e) {
    if (!res.headersSent) {
      res.status(200).json({ ok: false, error: e.name === 'AbortError' ? '超时 120s' : (e.message || '硅基流动请求失败') });
    } else {
      try { res.write('data: ' + JSON.stringify({ error: e.message || 'stream error' }) + '\n\n'); } catch (_) {}
      try { res.end(); } catch (_) {}
    }
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
