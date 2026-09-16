# ARCHITECTURE — protopcb（硬件原型工坊）

本文只描述**当前代码里真实存在**的结构。尚未接通的外部依赖统一列在文末 `NOT_CONNECTED`；
未来方向在 `docs/ROADMAP.md`，不在这里冒充已实现。

基线：main @ 2026-09-16（Phase 0–24 整理后）。测试 585、lint 0 error。

---

## 1. 分层与依赖方向

```
UI (src/modules/**, src/App.tsx)
   │  只能 import ↓
Application (src/application/*)           ← UI 唯一入口：parts / pricing / library / ai
   │
Provider 接口 (src/providers/types) + Registry (src/providers/factory.ts: getProviders())
   │
Infrastructure adapters (src/providers/{ezplm (index + live), digikey, suppliers, supplier-search,
                         kicad-library, reference-design, ai-client, gemini, http, mock})
   │
HTTP  →  api/* (Vercel Serverless)  →  ezPLM / DigiKey / Mouser / Iceasy / Gemini

Domain (src/design-core/**)：纯逻辑。不 import providers / modules / state / react / zustand。
Provider → Domain（Provider 依赖 Domain 的类型与规则），绝不反向。
State (src/state/*)：zustand store；Domain 的观察者桥接（libFileStore）也在这里。
```

由 ESLint `no-restricted-imports`（正则）与 `no-restricted-syntax` 强制，`tests/architecture-boundaries.test.ts` 二次校验：
- `design-core` 不得 import `providers/`、`modules/`、`state/`、`react`、`zustand`
- `modules/**` 与 `App.tsx` 不得 import `providers/mock`、`providers/gemini`、具体供应商/库适配器
- 生产源码不得 `fetch('/api/…')`（只有 providers 适配器可以）
- 生产源码不得 import `providers/mock`（`factory.ts` 是唯一装配点）
- `src/` 零循环依赖（`npm run check:cycles`，madge，已进 verify 与 CI）

## 2. Domain（design-core）— 单一来源的领域服务

| 概念 | 唯一定义 | 说明 |
|---|---|---|
| 可信度 | `trust/index.ts` `summarizeTrust()` `exportGate()` | PipelineBar / Overview / Review / 导出确认共用；CANDIDATE 也算未就绪 |
| 金额 | `money/index.ts` `formatMoney()` | locale 只改数字格式，不改币种；无币种显示"币种未知" |
| 定位孔 | `board/mounting-holes.ts` `effectiveMountingHoles()` | collision / 2D / 导出 / 3D / 外壳 / 报告都从这里取 |
| 器件语义 | `semantics/part.ts` `classifyPart()` | class / passiveKind / refPrefix / priceable / defaultSymbol；四个旧入口委托它 |
| 网络语义 | `semantics/net.ts` `classifyNet()` | 综合网络名 + 引脚类型 + 器件类别；VIN/VOUT 仅凭名字是 UNKNOWN |
| 型号匹配门禁 | `part-match-policy.ts` | lookup / substitute / browse；EXACT / FAMILY / FUZZY / REJECTED |
| 器件候选 DTO | `document/candidate.ts` `PartCandidate` | 显式携带 `source`；前缀推断仅 legacy |
| 方案行 | `scheme-lines.ts` | 评审阶段一行 × qty；Apply 时 `materializeSchemeLines` 展开 |
| 电路片段 | `fragment/extract.ts` + `fragment/schema.ts` | BFS 只记录实际遍历的网络；schema 与参考设计词汇表归 Domain |
| 兜底几何 | `geometry/fallback-geometry.ts` | 不再来自 mock |
| 权限语义 | `entitlements/index.ts` | `checkCapability()`；单价从 `contracts/ai-operations.json` 生成 |

## 3. 文档模型（Document Schema）

- 运行时 schema：`design-core/document/schema.ts`（Zod）；`SCHEMA_VERSION = 3.2.0`
- TS 类型：`design-core/document/types.ts` 全部由 `z.infer` 推导；枚举唯一定义在 `enums.ts`（有编译期结构等价测试 `__type-parity.test.ts`）
- 迁移链：`MIGRATIONS[]` 严格升序（有测试），2.x→3.0→3.1→3.2
  - 3.1：`mountingHolesEnabled=true` 但无孔位 → 补默认四角孔
  - 3.2：删除文档里的"当前页" `schematicSheet`，折入 `schematicSheets` + `rootSheetFile`
- 当前查看的原理图页是 UI 状态（`state/schematicViewStore`），不持久化
- `schemaVersion` 与 `package.json` 的 `version` 是两个概念：前者是文档格式，后者是软件版本，不要求相等

## 4. Session / Auth / Entitlements

唯一的服务端可信身份来源：`GET /api/session`（`api/_lib/session.js verifySession`）。

- `state/entitlementStore.ts`：会话状态（`anonymous | authenticated | auth-unavailable | expired`）、tier、credits
- `state/useAccessContext.ts`：**派生**自 entitlementStore，供 provider 调用；匿名返回 `null`
- `providers/factory.ts`：`HostAuthAdapter` 是宿主注入 Bearer 的唯一入口，默认不注入（靠同源 Cookie）
- 会话由 ezPLM / EEHub 签发（`ezplm_session` / `eehub_session` Cookie 或 Bearer）；本站只校验不签发
- `/api/auth/logout` 清 Cookie；AccountBar 有退出按钮、窗口回前台时刷新会话

两档权限：匿名（画布 / KiCad 导入 / ezPLM 公开检索 / 导出原型）与注册（+ 分销商检索、定制器件、AI 按 Credit）。

## 5. AI Operation Registry（唯一 AI 路径）

```
Browser  aiRequest(operation, input)  [src/providers/ai-client]
   → POST /api/ai { operation, operationId(UUID), input }      [api/ai.js]
   → AI_OPERATIONS[operation] 查表（api/_lib/ai-operations.js）
       校验 input → 会话 → 执行器已配置 → 扣费（幂等键 userId+operationId）→ 服务端拼 prompt
   → callGemini()                                               [api/_lib/ai/gemini-executor.js]
   → { data, usage: { charged, remaining, operationId } }
```

- 单价唯一来源：`contracts/ai-operations.json`（服务端注册表与前端 `CREDIT_COST` 都由它生成，有一致性测试）
- 浏览器不持有任何 prompt；未知 operation → 400，零扣费零模型调用
- `POST /api/gemini` 已下线（410），`api/gemini.js` 只剩 `GET ?path=status|diag`
- integrated/production 下 `AiAccessError` 原样抛出，不回退 Mock（demo 或 `VITE_ENABLE_AI_MOCK_FALLBACK=1` 的开发环境除外）
- 前端余额只认 `usage.remaining`，不自行扣减

## 6. API Boundary（api/*）

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `POST /api/ai` | 登录 + Credit | 唯一 AI 入口 |
| `GET /api/session` | — | 返回会话状态；后端未配置时如实 `BACKEND_NOT_CONNECTED` |
| `POST /api/auth/logout` | — | 清 Cookie |
| `GET /api/ezplm?path=parts\|reference-designs\|file` | — | 公开数据；`application-projects` → **501** |
| `GET /api/digikey`、`/api/suppliers` | 登录（不扣费） | `path=status` 匿名可访问 |
| `POST /api/ds2kicad` | 登录 | 提取引擎 |
| `GET /api/kicadlib` | — | KiCad 官方库代理 |

共享防护：`api/_lib/guard.js`（限流 / 体积 / 附件 MIME / PDF 魔数）、`api/_lib/safe-fetch.js`（SSRF / 重定向 / 大小 / 超时）。

## 7. KiCad 导入 / 导出

- 导入：`.kicad_pcb`（`geometry/kicad-pcb-import.ts`）、`.kicad_sch`（多页层级，`kicad-sch-import.ts`）、KiCad 5 `.sch/.lib`（legacy 解析器）、zip（`safeUnzip`，中央目录预检）
- 工程自带 3D：`.kicad_pcb` 里 `${KIPRJMOD}/…` 引用按文件名匹配 zip 内 STEP，经 `model-blob-registry` 登记为 blob URL（会话内有效；重新导入 / 清空时撤销）
- 导出：`pcbExport.ts`（`.kicad_pcb`，定位孔来自 `effectiveMountingHoles`）、JSON、Markdown 报告、BOM CSV、外壳 STL / CadQuery 脚本
- 导入唯一入口：`application/project-import.ts`（`importProjectFile`：zip / pcb / sch / legacy / JSON 分派）

## 8. 3D 资源生命周期

- STEP 缓存（`step-loader.ts`）拥有 geometry/material，打 `userData.sharedResource`；视图拿到的是 clone
- `BoardView3D.disposeViewOwned()` 跳过共享资源；参数化模型每次新建、归视图
- `PcbProjection3DLayer` 材质按实例克隆（`cloneMaterialsForView`），透明度不污染其它视图
- 位号开关只换板面贴图，不重建器件模型
- blob URL：`model-blob-registry`（同封装重复登记先撤旧；撤销时驱逐缓存）

## 9. Reference Design

- 公开参考设计：`getProviders().referenceDesigns.getRelatedReferenceDesigns()`，匿名可查
- 组织物料（orgOnly 检索）需要 ezPLM 组织级端点 —— 未提供，`searchComponents({orgOnly})` 返回空并标 `ORGANIZATION_MATERIALS_NOT_CONNECTED`
- 应用项目（私有）：`getApplicationProjects(componentId, mpn, ctx)`，匿名不发请求；缓存键含 tenant + user（`private-cache.ts`），登出清空
- 服务端 `application-projects` 明确 501（`APPLICATION_PROJECTS_NOT_CONNECTED`），不用全局 Key 冒充用户

## 10. 持久化

- `ProjectPersistenceService`（`design-core/document/persistence-service.ts`）是唯一自动存档；schema 校验 + 迁移 + 损坏备份
- localStorage 键唯一定义在 `shared/storage.ts`；`cc_*` / `cc:*` → `protopcb:*` 一次性迁移（读→写→校验→删，失败保留旧键），模块加载时执行
- 恢复时清掉会话内的 blob stepUrl 并标记 `sessionModelLost`

## 11. 已知技术债（未做，如实列出）

- `App.tsx` ≈300 行的 shell：装配 stores / 控制器 hook / 布局，渲染 `modules/app/{TopNavigation, LeftWorkspace, MainWorkspace, RightInspector, ExportDialog}` 与方案评审弹窗、向导。目标已达成（<300~500）
- Playwright E2E 九个场景已写，**尚未在任何环境实际执行过**（编写环境无法下载浏览器；首次执行在 CI，见 e2e/README.md）
- Credit consume 为 NON_TRANSACTIONAL（模型超时不退费）

## NOT_CONNECTED（外部后端尚未提供）

- ezPLM OAuth / SSO Session Bridge（`proto_session` 由本站签发）— 未实现；当前只校验 ezPLM/EEHub 签发的会话
- Credit reserve / commit / release
- Cloud Project API（保存到我的空间 / 打开我的设计）
- Cloud Custom Part API（定制器件目前在本浏览器）
- Application Projects 用户级端点
- 百芯 B1B 分销商 API（无 contract，适配器返回 NOT_CONNECTED）

## Run Modes（与 `src/config/index.ts` 一致，有测试）

| mode | component / reference | project | identity | ai |
|---|---|---|---|---|
| demo | mock | local | demo（Mock） | mock（允许回退） |
| standalone | ezplm（HTTP，指向 `/api`） | local | ezplm | gemini-via-api |
| integrated | ezplm | ezplm | ezplm | gemini-via-api |
