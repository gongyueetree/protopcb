# 部署到 Vercel

Circuit Canvas v3 是标准 Vite + React + TypeScript 应用，Vercel 零配置识别。
**先决定部署哪种运行模式**，再选对应步骤。

---

## 一、demo 模式部署（推荐先用这个）

纯前端，内存 Mock 数据，**不需要任何后端**。

### 方式 A：连接 GitHub 自动部署（最推荐）

1. 把项目推到 GitHub 仓库（不含 node_modules / dist，已在 .gitignore）：
   ```bash
   git init
   git add .
   git commit -m "circuit canvas v3"
   git branch -M main
   git remote add origin https://github.com/你的用户名/circuit-canvas.git
   git push -u origin main
   ```
2. 打开 https://vercel.com → 用 GitHub 登录
3. **Add New → Project** → 选择该仓库导入
4. Vercel 自动识别为 Vite 项目（配置已由 vercel.json 指定），直接点 **Deploy**
5. 约 1 分钟后得到 `https://xxx.vercel.app`
6. 之后每次 `git push` 自动重新部署

### 方式 B：Vercel CLI

```bash
npm i -g vercel
cd circuit-canvas
vercel --prod
```

构建配置（已在 vercel.json，无需手动填）：
- Build Command: `npm run build`
- Output Directory: `dist`
- Framework: Vite

---

## 二、standalone / integrated 模式部署

前端要调后端 API。Vercel 部署的仍是**前端**，后端需另行处理。

### 前端环境变量

在 Vercel 项目 **Settings → Environment Variables** 添加：

| 变量 | 值（示例） |
|---|---|
| `VITE_APP_MODE` | `standalone` 或 `integrated` |
| `VITE_API_BASE_URL` | `https://你的后端域名/api` |

改完需 **Redeploy** 生效。

### 后端怎么部署？三选一

**选项 1：后端单独部署在别处**
（`server/` Express 骨架已删除；如需自托管，把 `api/` 的 handler 用任意 Node HTTP 框架挂载即可，
拿到公网地址后填进 `VITE_API_BASE_URL`。注意后端要开 CORS（已内置）。

**选项 2：integrated 模式直接对接 ezPLM**
`VITE_API_BASE_URL` 指向 ezPLM 真实后端，不需要部署 server/。
对接细节见 docs/EZPLM_INTEGRATION.md。

**选项 3：把后端改写成 Vercel Serverless Functions**
在项目根建 `api/` 目录，把 server/ 的路由改写为 Vercel 函数，
前后端同域部署。需要时可另外协助改造。

---

## 三、绑定自定义域名

部署后在 **Settings → Domains** 添加域名（如 `canvas.ezplm.cn`），
按提示在域名服务商加 CNAME 记录。可作为 ezPLM 平台的子站。

---

## 常见问题

- **构建失败**：确认 Node 版本 ≥ 18（Vercel 默认满足）。构建命令 `npm run build` 包含 `tsc -b && vite build`，本地已验证通过。
- **页面刷新 404**：vercel.json 的 rewrites 已处理 SPA 路由，无需额外配置。
- **不要上传 node_modules / dist**：已在 .gitignore，Vercel 会自己安装构建。
- **server / docs 不参与前端构建**：已在 .vercelignore 排除。
