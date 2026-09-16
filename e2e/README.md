# E2E（Playwright）

- 全部外部依赖用 `page.route()` 打桩（`e2e/fixtures.ts`）：ezPLM / 分销商 / AI / 会话都不需要真实 Key。
- 页面用 `?e2e=1` 打开时会挂 `window.__protopcb_test__`（只有种入器件的钩子，不碰权限/计费）。
- 运行：`npm run e2e:install`（首次下载 Chromium）→ `npm run e2e`。
- CI 里作为独立 job 在 `verify` 之后运行。

**状态：这些场景在提交时尚未在本地跑过**（编写环境的网络白名单不含 `cdn.playwright.dev`，装不了浏览器）。
首次由 GitHub Actions 执行；如失败，trace 会作为 artifact 上传。九个场景已写：01 trust 一致性、02 匿名搜索门禁、03 定位孔导出、04 币种、05 部分报价、06 Hybrid 显隐、07 JSON 往返、08 项目命名、09 空项目恢复。
脚本仅通过 tsc 类型检查（除 Node 类型），**没有在浏览器里执行过**；首次执行在 CI。
