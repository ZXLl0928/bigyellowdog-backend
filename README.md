# 大黄狗运营看板 · 后端部署指南

这个目录是团队云端的**后端服务**，一个 Node 程序同时提供：

1. **扒热点代理** `/api/hot` —— 服务端去抓国内热点源，解决「同事电脑没跑你的本地服务、也受浏览器跨域限制」导致一键扒不了的问题。
2. **团队共享存储** `/api/board` —— 所有登录成员读写同一份看板数据（视频 / 热点 / 账号 / 节日）。
3. **实时同步** `/ws` —— 任何人改动，队友页面几秒内自动刷新。
4. **登录与权限** `/api/signup|login|members` —— 邮箱密码登录，**第一个注册的人是管理员(owner)**，可管理成员、设角色、移除。

> 前端（Netlify 上的 `index.html`）会连这个后端。二者是独立部署的，前端免费托管在 Netlify，后端免费托管在下面的任意平台。

---

## 一、免费平台怎么选（都免费、基本都免信用卡）

| 平台 | 免费层 | 是否需要信用卡 | 部署方式 |
|------|--------|----------------|----------|
| **Render** | ✅ 有（shared CPU，会休眠） | ❌ 用 GitHub 登录免卡 | Git 仓库 / Blueprint |
| **Railway** | ✅ 有 $5 试用额度 | ⚠️ 需绑定支付方式 | Git 仓库 / CLI |
| **Koyeb** | ✅ 有（2 个服务） | ❌ 免卡 | GitHub / Docker |
| **Fly.io** | ✅ 有（小流量） | ⚠️ 需卡验证 | `fly deploy` 本地目录 |

> 推荐 **Render**（免卡、最省心）。下面以 Render 为例，其他平台同理（都有「上传/连 Git → 跑 `npm install` → `node server.js`」）。

---

## 二、方式 A：让我直接帮你部署（最省事，推荐）

把下面任意一个发我，我直接帮你一键上线，连网址都给你：

- **Render**：Render 后台 → Account Settings → API Keys → 生成 Token 发我
- **Railway**：`railway` 登录后的 User API Key

发我之后我会：建服务、部署、把后端网址（如 `https://bigyellowdog-api.onrender.com`）返回给你，并确认健康检查通过。

---

## 三、方式 B：自己动手（Render，免信用卡）

1. 把 `server-backend/` 这个目录推到一个 **GitHub 公开仓库**（或用本机 `git` 推上去）。
2. 打开 https://dashboard.render.com → 用 GitHub 登录 → **New + → Blueprint** → 选中你的仓库 → Render 会读 `render.yaml` 自动建好服务。
3. 或手动：**New + → Web Service** → 连仓库 → Build Command 填 `npm install`、Start Command 填 `node server.js`、Instance 选 **Free**。
4. 在 Environment 里把 `ALLOW_ORIGINS` 设为你的前端地址，例如：
   ```
   ALLOW_ORIGINS=https://bigyellowdog.netlify.app
   ```
   （多个用逗号：`https://a.netlify.app,https://b.netlify.app`；临时调试可用 `*`）
5. Deploy 完成后，复制 Render 给你的网址（形如 `https://bigyellowdog-api.onrender.com`）。

> 注意：Render 免费实例**长时间无访问会休眠**，首次访问要等几秒唤醒，属正常。

---

## 四、把后端网址填进前端（关键）

部署好后端后，打开你的看板（`https://bigyellowdog.netlify.app`）：

1. 点右上角 **「☁️ 团队云：未连接」**（或 **⚙️** 按钮）→ 弹窗里**先填「服务器地址」**那一栏，粘贴后端网址，例如 `https://bigyellowdog-api.onrender.com`。
2. 然后**用你自己邮箱注册**（首位注册者 = 管理员 owner）。
3. 把看板网址和「服务器地址」发给另外 4 位同事，各自注册登录即可。
4. 之后任何人加视频 / 改热点状态，队友页面会自动实时同步；同事在他电脑点「一键扒热点」也会走后端代理，不再失败。

---

## 五、本地开发 / 自测

```bash
cd server-backend
npm install
PORT=3000 JWT_SECRET=随便一串 node server.js
# 健康检查
curl http://localhost:3000/api/health
# 注册
curl -X POST http://localhost:3000/api/signup -H 'Content-Type: application/json' -d '{"email":"a@b.com","password":"123456"}'
```

---

## 六、数据在哪 / 会丢吗

- 看板数据存在后端服务器的 `data/board.json`，成员存在 `data/users.json`（Render 实例文件系统持久，休眠唤醒不丢；如需绝对保险可自行备份这两个文件，或换 Postgres）。
- 智谱 Key 仍**只存在各人浏览器本地**（`localStorage.flyelep_zhipu_key`），**不上传服务器**，每人用自己的 Key 跑 AI。
- 重新部署前端（拖 Netlify zip）**不会影响**后端数据——两者完全独立。

## 七、接口一览

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/api/health` | 健康检查 | 否 |
| POST | `/api/signup` | 注册（首位=owner） | 否 |
| POST | `/api/login` | 登录 | 否 |
| GET | `/api/board` | 拉共享看板 | ✅ |
| POST | `/api/board` | 保存共享看板 | ✅ |
| GET | `/api/members` | 成员列表 | ✅ |
| PATCH | `/api/members/:id` | 改成员角色（owner） | ✅ owner |
| DELETE | `/api/members/:id` | 移除成员（owner） | ✅ owner |
| GET | `/api/hot?route=&limit=` | 扒热点代理 | 否 |
| WS | `/ws?token=` | 实时同步 | ✅ |

---

## 八、常见问题

- **实时不同步**：确认后端 `/ws` 可达；前端需已登录且「服务器地址」填对。休眠唤醒后 WS 会自动重连（代码里已处理 3 秒重连）。
- **CORS 报错**：检查后端 `ALLOW_ORIGINS` 是否包含你的 Netlify 域；开发临时可设 `*`。
- **想换数据库（更稳）**：把 `server.js` 里 `readJSON/writeJSON` 换成 Postgres 客户端即可，接口不变。
