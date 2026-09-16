/** E2E-07：导出 JSON → 导入 → 不编辑 → 再导出，规范化后无差异（除构建元数据） */
import { test, expect } from '@playwright/test';
import { stubSession, stubEzplm, stubSuppliers, stubKicadLib, stubAi } from './fixtures';

test('json export/import/export is stable', async ({ page }) => {
  await stubSession(page, { tier: 'anonymous' });
  await stubEzplm(page); await stubSuppliers(page); await stubKicadLib(page); await stubAi(page, { credits: 0, calls: [] });
  await page.goto('/?e2e=1');
  await page.evaluate(() => (window as unknown as { __protopcb_test__: { seedTrust: (l: string[]) => void } }).__protopcb_test__.seedTrust(['VERIFIED', 'CANDIDATE']));
  const a = await page.evaluate(() => (window as unknown as { __protopcb_test__: { getDocJson: () => string } }).__protopcb_test__.getDocJson());
  // 通过导入入口重新载入同一 JSON
  const input = page.locator('input[type=file]');
  await input.setInputFiles({ name: 'a.json', mimeType: 'application/json', buffer: Buffer.from(a, 'utf8') });
  await page.waitForTimeout(500);
  const b = await page.evaluate(() => (window as unknown as { __protopcb_test__: { getDocJson: () => string } }).__protopcb_test__.getDocJson());
  const strip = (s: string) => { const o = JSON.parse(s); delete o.metadata?.updatedAt; delete o.metadata?.exportedAt; delete o.metadata?.build; return JSON.stringify(o); };
  expect(strip(b)).toBe(strip(a));
});
