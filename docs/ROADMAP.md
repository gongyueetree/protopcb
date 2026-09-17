# ROADMAP — 未来方向

只写**尚未实现**的方向。当前真实架构见 `docs/ARCHITECTURE.md`，现状指标见 `docs/CODEBASE_AUDIT.md`。

## 近期（有明确外部依赖，等对方接通）

| 方向 | 阻塞在 |
|---|---|
| SSO Session Bridge | ezPLM 提供 OAuth authorize/token 端点后，由本站签发 `proto_session` |
| Transactional Credit | reserve / commit / release 三段式，模型超时可退费 |
| Cloud Project API | 设计保存到账户空间、跨设备打开 |
| Cloud Custom Part API | 自建器件从本浏览器升级为账户资产 |
| Application Projects | ezPLM 用户级端点（当前明确 501） |

## 中期（产品能力）

- **Reference Design → Block Apply**：把参考设计的电路片段直接落到画布，而不只是看
- **CircuitComposition Engine**：多个子电路按接口自动拼接与冲突检查
- **VirtualHardwareBlock**：把"功能块"提升为可参数化、可替换实现的一等对象
- **Auto Routing**：预布局之后的自动布线（需先想清与 KiCad 的分工边界）

## 远期（外部工具链集成）

- **Simulation IR / ngspice**：从文档模型生成仿真网表，跑直流/交流工作点
- **KiCad MCP**：直接驱动 KiCad 完成导入导出与 DRC，而不是文件往返
- **Mechanical MCP**：FreeCAD 侧的外壳协同

## 不做

- 完整 EDA 的板层管理、原理图 → PCB 正向流程、其它 EDA 格式导入 —— 与"AI 方案生成 + 预布局，成品交给 KiCad"的定位冲突。
