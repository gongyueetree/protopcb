import { defineConfig } from '@playwright/test';

/**
 * E2E：全部外部依赖（ezPLM / AI / 分销商 / 会话）通过 page.route() 用确定性 fixture 打桩，
 * 不需要真实 Key。运行：`npm run e2e`（需先 `npx playwright install chromium`）。
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure', viewport: { width: 1500, height: 900 } },
  webServer: { command: 'npm run preview -- --port 4173 --strictPort', port: 4173, reuseExistingServer: !process.env.CI, timeout: 60_000 },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
