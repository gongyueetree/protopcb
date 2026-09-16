# 测试分层

| 目录 | 层 | 规则 |
|---|---|---|
| `tests/domain/` | Domain Unit | 纯逻辑；不 mock 网络 |
| `tests/schema/` | Schema / Migration / Contract | 文档往返、存储迁移、AI 输出契约 |
| `tests/provider-contract/` | Provider Contract | 注入或 stub `fetch`；验证 provider 行为与租户边界 |
| `tests/import-export-golden/` | Import / Export Golden | 真实 KiCad 文本/工程驱动 |
| `tests/architecture/` | Architecture Boundary | **唯一允许扫源码**的层：依赖方向、直连 API、阻塞弹窗、CSP |
| `api/__tests__/` | API Handler | 直接调用 handler，stub 上游，断言零上游调用/零扣费 |
| `src/**/__*.test.ts` | 与模块同址的单测 | 保留 |

行为断言优先于源码字符串断言：源码 grep 只用于架构边界。
