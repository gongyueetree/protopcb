# Codebase Audit — protopcb（基线 f1bd19a，2026-09-16）

审计口径：只记录**实际测出**的数据与**实际读到**的代码事实。未测的项标 `未测`。

## D. 当前指标

| 指标 | 值 |
|---|---|
| 生产代码 LOC（src + api + server，TS/TSX/JS） | 24 168 |
| 测试 LOC | 5 797 |
| 测试数 | 522 |
| bundle（dist/assets/*.js） | 1 395 KB |
| 循环依赖（madge） | 3，全部在 design-core 内部（见下） |
| UI 直接 fetch `/api/*` 的调用点 | 19（kicadlib 14、ds2kicad 3、digikey 1、suppliers 1） |
| `@deprecated` 导出 | 5 |
| design-core 反向依赖违规文件 | 3（services.ts、fragment/extract.ts、custom-lib.ts） |

最大文件：`App.tsx` 1 492 行、`i18n.ts` 1 098、`designStore.ts` 742、`BomPanel.tsx` 558、`SchematicPanel.tsx` 522、`api/kicadlib.js` 499。

## A. 文件分类

### DELETE
- `api/_lib/credit-cost.js` — 价目表第二份来源；唯一真值应是 `AI_OPERATIONS[op].cost`
- `api/gemini.js` 里 POST 分支之后的整套旧实现 — 已 410，但不可达代码仍在
- `src/providers/gemini/index.ts` 的 `AiAccessError` re-export — 兼容垫片
- `src/modules/report/persistence.ts` 的 `autosave()` / `loadAutosave()` — 已被 ProjectPersistenceService 取代
- `src/state/entitlementStore.ts` 的 `noteConsumed()` — 空操作占位
- `api/suppliers.js` 的 B1B 分支 — 猜测的第三方 URL，无真实 contract

`_legacy_App.jsx`：**基线里已不存在**，无需处理。

### MERGE
- `providers/ezplm` + `providers/ezplm-live` — 同一后端两套客户端
- `providers/digikey` + `providers/suppliers` + `supplier-search` — 应收敛为 SupplierProvider
- `document/services.ts refPrefixFor` + `bom/part-class.ts classifyByRefDes` + `part-matching.ts classFromReference` + `kicad-passive-defaults.classifyPassive` + `sub-circuit` 里的无源判定 — **5 套位号/类别正则**
- `fragment/extract.ts` 与 `block-diagram/from-netlist.ts` 各自的 POWER 网络判定（且**互相矛盾**：前者不把 VIN/VOUT 当电源，后者把它们当电源）
- `entitlementStore` + `useAccessContext` + `providers.identity` + `localStorage cc:token` — 4 处身份来源

### REFACTOR / SPLIT
- `App.tsx`（1 492 行）→ AppShell / TopNavigation / LeftWorkspace / MainWorkspace / RightInspector + 控制器 hooks；CompDetail 与 KiCad 导入流程（zip/pcb/sch/legacy/STEP 绑定）应独立
- `design-core/document/types.ts` 与 `schema.ts` 手写两套几乎相同的 Document 结构 → 以 Zod 为准 `z.infer`
- `CircuitCanvasDocument` 根节点持续增加 optional 字段（schematicSheet / schematicSheets / rootSheetFile / enclosure …）
- `BoardView3D`：components / board / hideAllRefDes 任一变化都整板重建

### MIGRATE
- `schematicSheet`（当前页对象）**复制**了 `schematicSheets[activeFile]` — 当前页应是 UI 状态，文档只持久化 sheets + rootSheetFile
- localStorage `cc:*` 键 → `protopcb:*`（需一次性迁移，不能丢用户存档与自建器件）

### NOT_CONNECTED（代码与文档必须一致）
- ezPLM OAuth/SSO Session Bridge
- Credit reserve/commit/release（当前 consume 为 NON_TRANSACTIONAL）
- Cloud Project API、Cloud Custom Part API
- Application Projects 用户级端点（`api/ezplm.js` 已 501，但文件头注释仍写"透传 application-projects"——**注释过期**）

### KEEP（本轮不动，且不得回归）
Trust / Money / MountingHoles 领域服务、part-match-policy、AI_OPERATIONS + `/api/ai`、`aiRequest()`、分销商服务端门禁、租户私有缓存、Hybrid 材质隔离与增量重建、CSP blob 放行。

## B. 依赖方向（现状）

```
UI (modules/*, App.tsx)
  ├─ 直接 fetch /api/kicadlib, /api/ds2kicad, /api/digikey, /api/suppliers   ← 违规
  ├─ 直接 import providers/ezplm-live, providers/gemini                      ← 违规
  └─ state/*
Domain (design-core/*)
  ├─ import providers/types (ComponentSearchResult)                           ← 违规
  ├─ import providers/mock/data (geometryFor)                                 ← 违规（Mock 泄入 Domain）
  └─ import providers/reference-design/schema (fragment 类型)                 ← 违规
Infrastructure (providers/*) → design-core（正确方向）
API (api/*) — 独立 JS，与前端共享 contracts/（仅 custom-part-enums.json）
server/ — Express 骨架，README 标为"本地开发专用"，与 api/ 并行演进
```

design-core 内部循环：`custom-lib ↔ custom-symbol`、`footprint-pads ↔ kicad-name-parser`、`lib-file-registry ↔ footprint-pads`。

## C. 已确认的逻辑矛盾
1. `fragment/extract.ts`：support 器件被纳入后，其**全部** padNets 进入 touched → AD9837 fragment 出现 USB_DP（golden test 目前把它当"正确"断言）
2. `from-netlist.ts` 的 `POWER_NAME` 含 VIN/VOUT；`fragment/extract.ts` 不含 → 同一网络两种判定
3. `config/index.ts` 写 standalone AI=`claude`、integrated AI=`gateway`，factory 实际全部装配 Gemini
4. Scheme proposal 里 `qty=4` 把同一对象 push 4 次（展示层已归并，但数据层仍重复）
5. `services.ts` 按 componentId 前缀（`ez_`/`sup_`/`ai_`…）推断 source/trust

## 本轮执行顺序（按风险从低到高）
1. 本审计（commit）
2. 死代码与重复价目表（Phase 1/2）
3. Domain 反向依赖修复（Phase 4）
4. Fragment 遍历修复 + golden 纠正（Phase 12）
5. 过期注释与猜测集成清理（Phase 16/17）
6. 架构门禁（Phase 24）

Phase 5（App 拆分）、6（身份统一）、8/9（schema 收敛）、13（qty）、14（语义合并）、18（3D 生命周期）、20（品牌迁移）、21（ARCHITECTURE）本轮**未做**，见最终报告。
