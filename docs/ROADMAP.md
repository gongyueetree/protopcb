# ROADMAP — 未来方向（不是当前架构）

> 本文件由旧的 ARCHITECTURE.md 改名而来：它描述的是**规划**与部分历史设想，
> 不代表代码现状。当前真实架构见 `docs/ARCHITECTURE.md`（按代码重写，2026-09-16）。
>
> 规划中：Simulation（ngspice-wasm）、VirtualHardwareBlock、KiCad MCP、FreeCAD MCP、
> Hardware IR、自动布线、Session Bridge（等 ezPLM OAuth）、Credit reserve/commit/release。

---

# Circuit Canvas v3 — 架构说明

> 电子产品早期架构与 PCB 预布局智能工具
> 本版本基于诊断报告完成 **P0 工程化重构**：TypeScript + 分层架构 + Provider 抽象 + 单元测试 + standalone 后端骨架。

## 设计目标

把原先集中在单个 `App.jsx` 的「数据 + 规则 + AI + 画布 + UI」拆成清晰分层，使其：

- 可替换数据源（Mock → 本地 API → ezPLM），UI 不变；
- 设计内核（几何/碰撞/放置）可独立测试；
- 设计状态统一为 `CircuitCanvasDocument` JSON，可保存、导入导出、未来回写 ezPLM；
- 支持三种运行模式 demo / standalone / integrated。

## 分层架构

```
┌─────────────────────────────────────────────┐
│ UI 层  (src/modules, src/App.tsx)            │  React 组件，只读 store / 调 Provider
├─────────────────────────────────────────────┤
│ 状态层 (src/state/designStore.ts)            │  Zustand + immer，持有 Document + 撤销重做
├─────────────────────────────────────────────┤
│ 设计内核 (src/design-core)                   │  纯函数，无 React
│   ├── document/   统一文档模型 + Schema + 服务 │
│   ├── geometry/   毫米几何 / courtyard 计算   │
│   ├── collision/  碰撞检测                    │
│   ├── placement/  规则驱动放置引擎            │
│   └── rules/      放置规则配置                │
├─────────────────────────────────────────────┤
│ Provider 层 (src/providers)                  │  数据源契约 + Mock 实现 + 工厂
│   ├── types/      接口契约                    │
│   ├── mock/       内存实现（演示数据）         │
│   └── factory.ts  按运行模式装配              │
├─────────────────────────────────────────────┤
│ 配置层 (src/config)                          │  三种运行模式预设
└─────────────────────────────────────────────┘
            │ (standalone/integrated)
┌───────────▼─────────────────────────────────┐
│ 后端骨架 (server/)                           │  Express，实现 API 契约（文件存储占位）
└─────────────────────────────────────────────┘
```

## 关键设计

### 统一设计文档 `CircuitCanvasDocument`
见 `src/design-core/document/types.ts`。本地保存、导入导出、后端存储、ezPLM 附件、AI 输入、未来 KiCad 导出都用这一个 JSON 结构。用 Zod (`schema.ts`) 做运行时校验和版本迁移。

### Provider 抽象
所有外部数据通过 `src/providers/types/index.ts` 的接口获取。当前 `factory.ts` 全部回退到 Mock；接入真实后端只需在工厂里替换实现，UI 与内核零改动。

### 规则驱动放置
原先写死的 `ZONES` 改为 `PlacementRule[]` 配置（`design-core/rules`）。放置引擎 `solvePlacement` 读取规则求解坐标，可由 SYSTEM / AI / USER / 参考设计 来源叠加。

### 封装几何
不再用类别级示意尺寸，改为真实 `FootprintGeometry`（body + courtyard，单位 mm）。碰撞用 courtyard，显示用 body，板面积估算有工程意义。

## 运行模式

| 模式 | 组件数据 | 项目存储 | AI | 用途 |
|---|---|---|---|---|
| demo | Mock | localStorage | Mock | 演示 |
| standalone | 本地 API | 本地 API | Claude | 高校/团队试用 |
| integrated | ezPLM | ezPLM | Gateway | 接入 ezPLM 项目 |

通过 `VITE_APP_MODE` 切换（见 `.env.example`）。

## 开发

```bash
npm install
npm run dev        # 前端 (demo 模式)
npm run typecheck  # 类型检查
npm run test       # 单元测试 (内核)
npm run build      # 生产构建

# standalone 后端骨架
cd server && npm install && npm run dev   # http://localhost:8787
```

## 已完成（P0）与后续（P1-P3）

**本轮已完成**：TypeScript 迁移、分层拆分、统一文档模型 + Zod、设计内核抽离、配置化放置规则、Mock Provider、三模式骨架、导入导出 + 自动保存、单元测试、standalone 后端骨架。

**后续**（依赖你们后端/数据）：真实 ezPLM Provider、PostgreSQL、OIDC/SSO、参考设计相似度、KiCad 导出、Playwright E2E。详见诊断报告 P1-P3。
