# Circuit Canvas v3

电子产品早期架构与 PCB 预布局智能工具 — TypeScript 分层架构重构版。

## 快速开始

```bash
npm install
npm run dev      # http://localhost:5173 (demo 模式)
npm run build    # 生产构建 → dist/
npm run test     # 内核单元测试
npm run typecheck
```

## 部署 Vercel

已含 `vercel.json`，导入仓库后零配置部署。详见 docs/ARCHITECTURE.md。

## standalone 后端骨架

```bash
cd server && npm install && npm run dev   # http://localhost:8787
# 前端设 VITE_APP_MODE=standalone, VITE_API_BASE_URL=http://localhost:8787/api
```

## 目录

```
src/
├── design-core/   设计内核（纯函数：几何/碰撞/放置/文档模型）
├── providers/     数据源抽象层（接口契约 + Mock 实现 + 工厂）
├── state/         Zustand 状态管理
├── modules/       UI 功能模块（搜索/画布/BOM/顾问）
├── config/        三种运行模式配置
├── shared/        共享主题/常量
└── App.tsx        应用壳
server/            standalone 后端骨架 (Express)
docs/              架构文档
```

架构详解见 **docs/ARCHITECTURE.md**。

---

## 安全与运行边界（v3 加固后）

### 服务端接口防护
`/api/gemini`、`/api/digikey`、`/api/suppliers`、`/api/ezplm`、`/api/ds2kicad`、`/api/kicadlib`
背后是自有付费配额或大量上游资源，统一经 `api/_lib/guard.js` 做频率/并发/体积限制；
所有出站上游请求经 `api/_lib/net.js` 统一超时（`API_TIMEOUT_MS`）与响应体上限。

**调用方身份**：配额主体永远是可信 IP（平台注入头优先，`x-forwarded-for` 取链尾可信一跳）。
客户端自带的 `x-cc-session` **不参与配额**（可任意伪造，轮换即绕过，已在本轮修复）。
服务端验证过的身份（未来 ezPLM Auth）可经 `callerKey(req, auth)` 切换为 `userId/tenantId` 主体。

`GET /api/gemini?path=diag` 会触发真实付费调用：production 默认禁用，仅在服务端配置
`ADMIN_DIAG_TOKEN`（≥16 字符）且请求携带 `x-admin-token` 时可用，且同样过限流。
`path=status` 不打上游，保持免费开放。

> **已知限制（务必理解）**：memory limiter ≠ 全局配额。限流状态存在 Serverless 实例
> 内存中，属**单实例**限流；实例横向扩展时总配额被放大 N 倍。能挡脚本化滥刷，
> 不是分布式配额控制。需要全局限额请把 `guard.js` 的 `globalRateLimiter` 接
> Upstash Redis / Vercel KV（接口已预留）。当前**没有登录体系**，不要据此声称"已实现用户认证"。

### ZIP 导入防护
浏览器导入 KiCad 工程 ZIP 时：先手工解析中央目录（EOCD）做**inflate 前预检**
（条目数 / 逐条与累计声明解压量 / 压缩比 / zip-slip 路径 / ZIP64 拒绝），全部通过才解压；
解压在 Web Worker 内进行，大工程不阻塞 UI。默认限额：压缩 ≤50MB、解压总量 ≤200MB、
单文件 ≤64MB、≤2000 个文件、压缩比 ≤100。

### SSRF 防护
服务端按 URL 抓取（datasheet 链接）统一走 `api/_lib/safe-fetch.js`：
协议白名单、DNS 解析后判定真实 IP、逐跳重定向重新校验、大小/超时/Content-Type 限制，
拒绝环回、RFC1918、链路本地与云元数据地址（169.254.169.254）。

### 密钥
任何密钥都**不得**带 `VITE_` 前缀（会被打进前端 bundle）。
`npm run scan:secrets` 会扫描 `VITE_*KEY|SECRET|TOKEN` 与硬编码 Key，CI 中失败即阻断。

### 工程文件导入
ZIP 解压经 `safe-unzip.ts` 限制压缩包体积、解压总量、单文件大小、文件数量与压缩比，
并拒绝 zip-slip 路径。**目前仍在主线程解压**，超大工程可能出现短暂卡顿（Web Worker 化未做）。

## KiCad 数据保真的真实边界

**导出定位：可继续编辑的初始/简化工程，不是原工程的无损往返。**

| 数据 | 导入 | 导出 |
|---|---|---|
| 板框 Edge.Cuts | ✅ | ✅ |
| 器件位置/旋转/层 | ✅ | ✅ |
| 真实焊盘几何 | ✅ | ✅ |
| 网络表与焊盘 net | ✅ | ✅（导入工程带来的） |
| 铜箔走线 / 过孔 | ✅ | ✅（原样写回，线宽与层保留） |
| 定位孔 | ✅（真实坐标） | ✅ |
| 丝印 / 阻焊 / 敷铜区 / 规则设置 | ❌ | ❌ |
| 原理图连接关系 | 只读渲染 | ❌ |

画布上**从零新建**的设计没有走线，导出的 PCB 焊盘 net 为 0，需要在 KiCad 中按原理图布线。
导入工程的走线与过孔会按原始线宽和层原样写回。
不宣称 KiCad 6–10 全量无损兼容。

## AI 输出的可信边界

**原则：数据事实由数据库 / KiCad / datasheet 提供，模型只负责推理；模型的猜测不允许悄悄变成工程事实。**

- 所有 LLM 返回先过 Zod（`src/providers/ai-schema.ts`），结构不符**整条拒绝**，不进 store
- 每个器件带可信等级，详情面板显示徽标，导出 PCB 前列出未验证器件清单：
  - **✓ 已验证**：ezPLM 库内 / 分销商 API 精确匹配
  - **? 待确认**：KiCad 官方封装（型号需自定）、自建器件
  - **⚠ 未验证**：AI 建议的通用件，投产前必须人工核对 datasheet
- AI 顾问：规则引擎即时出结果，Gemini 深度分析 3 秒防抖 + 设计指纹缓存，同一设计不重复调用

## 尚未达到生产级的部分
- 分布式限流、登录/租户体系
- Web Worker 解压
- eslint 未引入（`npm run lint` 为占位，CI 以 typecheck + test 为准）
- CECPort / B1B 国产渠道为骨架，待 API 文档校准
- 设计审查仍以「方案完整度检查」为主，不是专业 ERC/DFM


## 工程边界（诚实声明）

- **ProtoPCB 定位**：AI Hardware Design Front-End / PCB 原型设计工具。不是 KiCad，
  也不承诺无损 EDA round-trip。
- **KiCad 保真现状（本轮之后）**：track/via 的 net、via drill/layers/blind、内层铜
  （In1.Cu/In2.Cu…）、定位孔真实孔径均已往返保真，并有 golden fixture 回归测试
  （`tests/fixtures/kicad/`）。**仍不保真**的部分：铺铜 zone、圆弧走线、异形板框
  只以包围盒导入（导出为矩形/预设形状）、文本/尺寸标注、DRC 规则、teardrop 等。
  这些属于"不支持无损编辑"的范围，导入工程再导出时请以 KiCad 内 diff 复核。
- **正确性验证口径**：round-trip 测试使用本项目 parser 验证本项目 exporter 的字段
  保真，尚未接入 kicad-cli 解析/DRC 验证（CI 未安装 KiCad）。
- **standalone server（server/）= 本地开发/演示专用**：文件存储、dev 桩身份、无
  PostgreSQL/SSO。production 环境默认拒绝启动（`STANDALONE_ALLOW_PROD=1` 可显式放行，自担风险）。
- **BGA 合成封装**：由 body+pitch+pinCount 推出的 ball map 是近似（`approximate` 标记），
  只能作为 CANDIDATE/PLACEHOLDER；有 datasheet ball map 或官方 KiCad footprint 时以真实数据为准。
- **AI 数据信任**：所有 LLM 返回经 Zod 校验后才入 store（`providers/ai-schema.ts`、
  `design-core/custom-part-schema.ts`）；型号 VERIFIED 仅限规范化后 exact match，
  前缀相似只作 CANDIDATE 供人工确认。
