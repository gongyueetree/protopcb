# Codebase Audit — protopcb（当前状态，2026-09-17）

整理前的历史快照见 `CODEBASE_AUDIT_BEFORE_CONSOLIDATION.md`。本文只写**实测**数据。

## 指标

| 指标 | 整理前 | 当前 |
|---|---|---|
| 生产代码 LOC（src + api） | 24 168 | 25 299 |
| 测试文件 / 测试数 | — / 522 | 82 / 639 |
| `App.tsx` 行数 | 1 492 | **335** |
| bundle（dist/assets/*.js） | 1 395 KB | 1 417 KB |
| 循环依赖（madge） | 3 | **0**（已进 verify 与 CI） |
| UI 直连 `fetch('/api/*')` | 19 | **0** |
| `@deprecated` 导出 | 5 | **0** |
| design-core 反向依赖违规 | 3 个文件 | **0**（ESLint + 架构测试双重门禁） |
| application → modules 依赖 | — | **0**（本轮新增门禁） |

LOC 上升是预期的：删掉了 `server/` 与死代码，但新增了 application 层、语义模块、DialogService、E2E 与大量测试。目标从来不是更少的代码，而是每个概念只有一个归属。

## 架构边界（由 ESLint + `tests/architecture/` 强制）

- `design-core` 不 import `providers/` `modules/` `state/` `react` `zustand`
- `src/application/**` 不 import `src/modules/**`
- 生产源码不 import `providers/mock`（`factory.ts` 是唯一装配点）
- UI 不 `fetch('/api/…')`，不 import 具体供应商/库适配器
- 生产源码不 POST `/api/gemini`；客户端不持有 AI prompt

## 单一来源清单

| 概念 | 唯一归属 |
|---|---|
| 文档模型 | `design-core/document/schema.ts`（Zod canonical，types 由 `z.infer` 推导） |
| 枚举 | `design-core/document/enums.ts` |
| AI 操作与单价 | `contracts/ai-operations.json` + `api/_lib/ai-operations.js` |
| 身份 | `/api/session` → `entitlementStore` → `useAccessContext`（IdentityProvider 已删除） |
| localStorage 键 | `shared/storage.ts`（`KEYS` / `keyOf`） |
| 器件语义 / 网络语义 | `design-core/semantics/{part,net}.ts` |
| 可信度 / 金额 / 定位孔 | `design-core/{trust,money,board}` |
| 3D 资源 | `modules/board-editor/step-loader`（共享缓存）+ `infrastructure/model-assets`（blob 生命周期） |

## E2E

9 个场景（`e2e/`），全部外部依赖用 `page.route()` 打桩。**本轮修正**：
- E2E-02 不再断言"匿名零 supplier 调用"（产品规则已改为匿名可用 + 服务端限频，429 由 API handler 测试覆盖）
- E2E-03 完整走真实导出 gate（先过项目命名对话框再下载）
- 标签页与导出项改用 `data-testid`（`tab-*` / `export-*`），不依赖 emoji 与 i18n 文案
- 全部移除 `waitForTimeout`；持久化改由 pagehide flush 保证，不用 sleep 掩盖缺陷
- 无 `test.skip` / `test.only`

**状态：脚本已通过 tsc 类型检查；执行结果以 GitHub Actions 为准**（本地编写环境无法下载 Chromium）。

## 已知技术债

- `providers/ezplm/index.ts` 的 `getFootprintOptions` 等四项返回空并标 NOT_CONNECTED（上游端点不存在），不是真实能力
- 限流是 `MemoryRateLimiter`（`globallyStrict: false`）：serverless 每实例独立计数，不是全局严格限额
- Credit consume 为 NON_TRANSACTIONAL（模型超时不退费）
- `_legacy_App.jsx` 在当前基线中不存在（Git 历史保留）

## NOT_CONNECTED

ezPLM OAuth/SSO Session Bridge、Credit reserve/commit/release、Cloud Project API、Cloud Custom Part API、Application Projects 用户级端点、组织物料端点、百芯 B1B。
