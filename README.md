# protopcb — 硬件原型工坊

> 当前架构：`docs/ARCHITECTURE.md`（按代码重写）；规划：`docs/ROADMAP.md`；审计：`docs/CODEBASE_AUDIT.md`。
> 仓库 / 包名 `protopcb`；产品显示名「硬件原型工坊」。旧名 Circuit Canvas 仅存于 Git 历史。

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


## Reference Design Intelligence（本轮新增，P0 范围）

- **统一模型**：`src/providers/reference-design/schema.ts`（ReferenceDesign / CircuitFragment，全 Zod）。
  应用项目（私有：USER/ORGANIZATION/EZPLM_PROJECT）与公开参考设计严格区分来源类别。
- **Provider**：`EzplmReferenceDesignProvider`。相关参考设计走已上线的 ezPLM 端点（真实接通）；
  应用项目的 API contract 与解析已就绪，**ezPLM 开放接口尚未确认提供该端点** —— 上游 404 时
  UI 如实显示 BACKEND_NOT_CONNECTED，绝不渲染假项目。私有数据仅本会话内存缓存。
- **排序**：来源优先级（用户项目 > 组织 > 量产 > 原型 > 厂商 > 仿真 > 公开工程 > PDF > AI）
  + anchor MPN 精确命中 + 资产完整度 + 置信度，纯函数可解释（`ranking.ts`）。
- **功能块提取**：`design-core/fragment/extract.ts` 在导入 KiCad 工程的真实净表上做图遍历
  （电源/地网不作桥、高扇出总线不扩张、连接器排除），产出 CircuitFragment（器件/网络/边界端口）。
  画布手搭方案暂无连接性数据，提取会如实提示。
- **供应商渠道**：Iceasy 与 OURIC 已按官方对接文档真实实现（`api/_lib/vendor-auth.js`，
  认证算法有离线固定样例回归），配好凭据即启用；OURIC 价格币种文档未明确，UI 不冒充币种。
- **尚未实现**（方案 P1–P3）：VirtualHardwareBlock、CircuitCompositionEngine、Composition ERC、
  PlacementPattern 提取、PDF Reference Extractor、Simulation IR/Ngspice —— 均未开工，不存在假实现。

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
- **后端只有一套：`api/`（Vercel Serverless）**。曾并行存在的 `server/` Express 骨架已删除（Git 历史可查），避免两套后端各自演进。
- **BGA 合成封装**：由 body+pitch+pinCount 推出的 ball map 是近似（`approximate` 标记），
  只能作为 CANDIDATE/PLACEHOLDER；有 datasheet ball map 或官方 KiCad footprint 时以真实数据为准。
- **AI 数据信任**：所有 LLM 返回经 Zod 校验后才入 store（`providers/ai-schema.ts`、
  `design-core/custom-part-schema.ts`）；型号 VERIFIED 仅限规范化后 exact match，
  前缀相似只作 CANDIDATE 供人工确认。

## ezPLM 查询接口（按官方《API 密钥查询接口用户操作手册》）

只读，两个端点，**一把 API Key 同时作身份与 HMAC 密钥**（没有单独的 secret）：

- `GET /api/v1/api-key/parts?keyword=&pageSize=` — 系统库物料，仅返回白名单供应商数据；
  条目的 `id` 即后续的 `partlibId`
- `GET /api/v1/api-key/reference-designs?partlibId=&pageSize=` — 该物料的参考设计
  （`name` / `link` / `image` / `description`）

签名：`X-Signature = base64url(HMAC-SHA256(API_Key, canonical))`，
canonical 为 `方法 \n 路径 \n 字典序 query \n X-Timestamp \n X-Nonce`；
**X-Timestamp 是 Unix 秒级**，X-Nonce 一次性防重放。服务端实现见 `api/ezplm.js`。

配置：Vercel → Environment Variables 添加 `EZPLM_API_KEY`（不带 VITE_ 前缀）。

联调自查（直连 ezPLM，不经 Vercel，复用生产签名实现）：

```bash
EZPLM_API_KEY=xxx node scripts/check-ezplm-refdesign.mjs TPS79301DBVR
```

返回码语义（手册 §5）：400/401 = 签名头缺失或无效；404 = partlibId 不存在；
429 = 当天调用次数达上限；空 `data` = 该物料没有参考设计（不是错误）。

> **应用项目**（组织内部用过该器件的历史项目）目前**不在**这两个公开接口里。
> 前端的 `getApplicationProjects` 已写好完整 contract，端点未提供时如实显示
> `BACKEND_NOT_CONNECTED`，不渲染任何假项目。上面的脚本会顺带探测三个候选路径。

## 访问层级：匿名体验 / 注册用 AI

面向两种投放场景（电子森林、tindie.com 内嵌）设计了两档权限：

| | 匿名（未登录） | 注册（ezplm.cn / eehub.io） |
|---|---|---|
| 画布、导入 KiCad、3D、外壳、导出原型文件 | ✅ | ✅ |
| 器件库检索（ezPLM / 分销商） | ✅ | ✅ |
| 浏览器本地自动存档（刷新不丢） | ✅ | ✅ |
| **AI 功能**（方案生成、子电路推荐、顾问分析、估价…） | ❌ | 按 Credit 计费 |
| **云端保存 / 打开我的设计** | ❌ | ✅ |

新注册赠送 `WELCOME_CREDITS`（默认 100）体验额度，用完需购买。

### 强制点在服务端

UI 的按钮门禁只为体验（少一次白跑的请求）。**真正的拦截在 `api/_lib/session.js`**：
`/api/gemini` 在调用上游之前先 `requireAiAccess()` —— 未登录返回 401，
额度不足返回 402，且**不产生任何上游计费调用**（有测试断言零次调用）。
客户端传来的 `cost` 不可信，服务端以 `api/_lib/credit-cost.js` 的价目表为准。

### 需要的环境变量

- `EZPLM_AUTH_BASE` — 鉴权与额度服务基址（如 `https://ezplm.cn/api/v1`），
  需提供 `GET /me`（返回 userId / credits）与 `POST /credits/consume`（余额不足返回 402）
- `AI_REQUIRE_AUTH` — 默认 `1`。未配置 `EZPLM_AUTH_BASE` 时 AI 一律不可用；
  设为 `0` 仅供本地开发，响应里会标 `authBypassed`

会话由 ezPLM / EEHub 签发，本应用只校验不签发，读取
`Authorization: Bearer` 或 `ezplm_session` / `eehub_session` Cookie。

## AI 调用与计费边界（服务端）

浏览器**不发送 prompt**，只发 `POST /api/ai { operation, operationId, input }`：

- `operation` 在 `api/_lib/ai-operations.js` 注册表里查表：固定价格、输入校验、**服务端拼 prompt**
- 未知 operation → 400，零扣费零模型调用（没有 `?? 1` 这类兜底价）
- `operationId` 为 UUID，作为账本幂等键 `(userId, operationId)` 透传给 ezPLM
- 响应 `{ data, usage: { operation, charged, remaining, operationId } }`；前端余额**只认** `usage.remaining`
- 旧的 `POST /api/gemini { prompt, capability }` 已下线（410）——浏览器决定 capability 是计费漏洞

客户端唯一入口：`src/providers/ai-client/aiRequest()`。测试会拒绝任何生产代码里的 `fetch('/api/gemini')`、`geminiComplete(`、或客户端持有的 prompt 模板。

分销商接口（`/api/digikey`、`/api/suppliers`）除 `status` 外要求登录（不扣 Credit）；匿名直接 curl 返回 401 且零上游调用。

### NOT_CONNECTED（外部后端尚未提供）

- ezPLM OAuth/SSO Session Bridge（`proto_session` 由本站签发）— 未实现，当前只校验 ezPLM/EEHub 签发的会话
- Credit reserve/commit/release — 当前为 legacy consume，**NON_TRANSACTIONAL**：模型超时时费用不会自动退还
- Cloud Project API（保存到我的空间 / 打开我的设计）
- Cloud Custom Part API — 定制器件目前保存在本浏览器
- Application Projects 用户级端点 — `api/ezplm.js` 仍用全局 `EZPLM_API_KEY` 转发，租户边界依赖后端按 partlibId 的可见性

### 定制器件提取契约

`contracts/custom-part-enums.json` 是 family / category / pin type / side 的唯一来源：
前端 `custom-lib.ts` 与服务端 `api/_lib/ai-operations.js` 都从它读；
提取结果的结构由 `design-core/custom-part-extract-contract.ts` 定义（尺寸在 `package{}` 下），
模型输出先过该契约再进表单。测试会比对两边枚举与 prompt 形状。

### part.extract 的服务端行为

- `mode` 判别校验：text 需 ≥20 字正文、url 需 https、image/pdf 需对应附件；`input={}` → 400
- 附件走 `checkAiPayload`：大小上限、MIME 白名单、PDF 魔数
- `mode=url`：服务端 `safeFetch`（SSRF/重定向/大小/超时防护）抓取，PDF 转内联、HTML 剥标签取正文后再交模型，**不让模型只凭 URL 猜内容**
- 顺序：校验 → 会话 → 执行器已配置 → 扣费 → 执行；`GEMINI_API_KEY` 未配置时 0 Credit
- `/api/ds2kicad` 外部匿名 POST → 401；`/api/ezplm?path=application-projects` → 501（不再用全局 Key 代理私有数据）
- integrated/production 模式下 AI 权限/计费错误原样抛出，**不再回退 Mock**（demo 或 `VITE_ENABLE_AI_MOCK_FALLBACK=1` 的开发环境除外）
