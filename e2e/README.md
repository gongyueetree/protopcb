# E2E（Playwright）

- 全部外部依赖用 `page.route()` 打桩（`e2e/fixtures.ts`）：ezPLM / 分销商 / AI / 会话都不需要真实 Key。
- 页面用 `?e2e=1` 打开时会挂 `window.__protopcb_test__`（只有种入器件的钩子，不碰权限/计费）。
- 运行：`npm run e2e:install`（首次下载 Chromium）→ `npm run e2e`。
- CI 里作为独立 job 在 `verify` 之后运行。

**状态**：首次由 GitHub Actions 执行（run #12）并失败；本轮已按失败原因修正：
E2E-02 的匿名 supplier 断言随产品规则更新，E2E-03 走真实导出 gate，标签/导出项改用 `data-testid`，
全部移除 `waitForTimeout`（持久化改由 pagehide flush 保证）。
编写环境仍无法下载 Chromium（网络白名单不含 `cdn.playwright.dev`），
所以本地只做到 **tsc 类型检查**，是否真正通过以 Actions 为准；失败时 trace 会作为 artifact 上传。九个场景已写：01 trust 一致性、02 匿名搜索门禁、03 定位孔导出、04 币种、05 部分报价、06 Hybrid 显隐、07 JSON 往返、08 项目命名、09 空项目恢复。
脚本仅通过 tsc 类型检查（除 Node 类型），**没有在浏览器里执行过**；首次执行在 CI。
