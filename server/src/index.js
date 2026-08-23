/**
 * server/src/index.js
 * Circuit Canvas standalone 后端骨架。
 *
 * 实现诊断第十三节定义的第一批 API 契约，与前端 Provider 接口对应：
 *   GET  /api/v1/me
 *   GET  /api/v1/components/search
 *   GET  /api/v1/components/:id
 *   GET  /api/v1/components/:id/footprints
 *   GET  /api/v1/components/:id/alternatives
 *   GET  /api/v1/reference-designs/peripheral-circuits?category=
 *   GET  /api/v1/projects/:id/design
 *   PUT  /api/v1/projects/:id/design
 *
 * 当前用内存 + 文件存储占位；正式版替换为 PostgreSQL + ezPLM 元器件库。
 * 前端切到此后端：设置 VITE_APP_MODE=standalone、VITE_API_BASE_URL=http://localhost:8787/api
 */
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPONENTS, ALTERNATIVES, SUBCIRCUITS, FOOTPRINTS } from './data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '.data');
fs.mkdirSync(DATA_DIR, { recursive: true });

/*
 * ⚠️ 定位声明（诚实边界）：
 * 本 standalone server 是【本地开发 / 演示】用途：文件存储、无真实 Auth、
 * 无 PostgreSQL/SSO。production 环境启动时若未显式声明知情
 * （STANDALONE_ALLOW_PROD=1），直接拒绝启动 —— 防止"看起来能生产部署"。
 */
if (process.env.NODE_ENV === 'production' && process.env.STANDALONE_ALLOW_PROD !== '1') {
  console.error('[standalone] 本服务为 dev/local 存储骨架（文件存储、无认证、无持久化保障），拒绝在 production 启动。');
  console.error('[standalone] 如确认仅作演示，设置 STANDALONE_ALLOW_PROD=1 后启动（自担风险）。');
  process.exit(1);
}

const app = express();

// CORS allowlist：默认仅本地开发来源；CORS_ORIGINS 环境变量逗号分隔扩展
const ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((s) => s.trim()).filter(Boolean),
);
app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.has(origin)) return cb(null, true);
    cb(new Error('CORS: origin 不在白名单'));
  },
}));
app.use(express.json({ limit: '5mb' }));
// JSON 解析失败（损坏 body）不 crash：统一 400
app.use((err, _req, res, next) => {
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  next(err);
});

/**
 * Auth middleware 抽象：当前为 dev 桩（固定本地身份）。
 * 正式接入 ezPLM Auth 时替换 verify 实现即可，路由代码不变。
 */
const auth = {
  verify(_req) { return { userId: 'local-user', displayName: '本地用户', organizationId: 'org-local', dev: true }; },
};
app.use((req, _res, next) => { req.identity = auth.verify(req); next(); });

// projectId 严格校验：防 path traversal（design-../../etc 之类）
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function requireProjectId(req, res, next) {
  if (!PROJECT_ID_RE.test(String(req.params.id ?? ''))) {
    return res.status(400).json({ error: 'invalid project id（仅允许 [A-Za-z0-9_-]，最长64）' });
  }
  next();
}

// 设计文档最小结构校验（无 Zod 依赖的骨架校验；正式版应复用前端 documentSchema）
function validateDesignDoc(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body 必须是对象';
  if (typeof body.schemaVersion !== 'string') return '缺少 schemaVersion';
  if (typeof body.id !== 'string' || typeof body.name !== 'string') return '缺少 id/name';
  if (!body.board || typeof body.board !== 'object') return '缺少 board';
  if (!Array.isArray(body.components)) return 'components 必须是数组';
  return null;
}

const v1 = express.Router();

/* ---------- 身份 ---------- */
v1.get('/me', (req, res) => {
  // 明确标注这是 dev 桩身份，不冒充"已实现登录"
  res.json({ userId: req.identity.userId, displayName: req.identity.displayName, organizationId: req.identity.organizationId, authMode: 'dev-stub' });
});

/* ---------- 元器件 ---------- */
v1.get('/components/search', (req, res) => {
  const { keyword = '', category, orgOnly } = req.query;
  let items = [...COMPONENTS];
  if (orgOnly === 'true') items = items.filter((c) => c.isOrg);
  if (category) items = items.filter((c) => c.category === category);
  if (keyword) {
    const q = String(keyword).toLowerCase();
    items = items.filter((c) =>
      c.mpn.toLowerCase().includes(q) || c.description.toLowerCase().includes(q) ||
      c.family.toLowerCase().includes(q) || c.manufacturer.toLowerCase().includes(q));
  }
  items.sort((a, b) => (b.isOrg ? 1 : 0) - (a.isOrg ? 1 : 0));
  res.json({ items, total: items.length, page: 1, pageSize: items.length });
});

v1.get('/components/:id', (req, res) => {
  const c = COMPONENTS.find((x) => x.component_id === req.params.id);
  if (!c) return res.status(404).json({ error: 'component not found' });
  res.json(c);
});

v1.get('/components/:id/footprints', (req, res) => {
  const c = COMPONENTS.find((x) => x.component_id === req.params.id);
  if (!c) return res.status(404).json({ error: 'component not found' });
  res.json(FOOTPRINTS.filter((f) => f.name === c.default_footprint));
});

/** 封装库浏览 */
v1.get('/footprints', (req, res) => {
  const { category } = req.query;
  res.json(category ? FOOTPRINTS.filter((f) => f.category === category) : FOOTPRINTS);
});

/** 组织物料上下文 */
v1.get('/organizations/:orgId/materials/:componentId', (req, res) => {
  const c = COMPONENTS.find((x) => x.component_id === req.params.componentId);
  if (!c || !c.isOrg) return res.status(404).json({ error: 'not an org material' });
  res.json({
    organization_id: req.params.orgId,
    material_id: c.componentId,
    internal_part_number: `INT-${c.componentId.toUpperCase()}`,
    approved: true,
    preferred: true,
    stock_quantity: 500,
    project_usage_count: 3,
  });
});

v1.get('/components/:id/alternatives', (req, res) => {
  const c = COMPONENTS.find((x) => x.component_id === req.params.id);
  res.json(c ? ALTERNATIVES[c.mpn] ?? [] : []);
});

/* ---------- 参考设计 / 子电路 ---------- */
v1.get('/reference-designs/peripheral-circuits', (req, res) => {
  res.json(SUBCIRCUITS[req.query.category] ?? []);
});

/* ---------- 项目设计文档（写回） ---------- */
const designPath = (id) => path.join(DATA_DIR, `design-${id}.json`);

v1.get('/projects/:id/design', requireProjectId, async (req, res) => {
  const p = designPath(req.params.id);
  try {
    const text = await fsp.readFile(p, 'utf-8');
    try {
      res.json(JSON.parse(text));
    } catch {
      // 磁盘上的 JSON 损坏：不 crash，报 500 且保留原文件供人工恢复
      res.status(500).json({ error: 'stored design corrupted', hint: `请人工检查 ${path.basename(p)}` });
    }
  } catch (e) {
    if (e?.code === 'ENOENT') return res.json(null);
    res.status(500).json({ error: 'read failed' });
  }
});

v1.put('/projects/:id/design', requireProjectId, async (req, res) => {
  const bad = validateDesignDoc(req.body);
  if (bad) return res.status(422).json({ error: `design 文档校验失败：${bad}` });
  try {
    // 原子写：先写临时文件再 rename，中断不会留下半个 JSON
    const p = designPath(req.params.id);
    const tmp = `${p}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(req.body, null, 2));
    await fsp.rename(tmp, p);
    res.json({ ref: `local:design-${req.params.id}`, savedAt: new Date().toISOString(), storage: 'local-file (dev only)' });
  } catch {
    res.status(500).json({ error: 'write failed' });
  }
});

app.use('/api/v1', v1);
app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Circuit Canvas API on http://localhost:${PORT}`);
  console.warn('[standalone] 注意：文件存储 + dev 桩身份，仅限本地开发/演示，不可用于生产。');
});
