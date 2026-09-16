/** E2E-02 + E2E-36：匿名搜 CH340C —— 只打 ezPLM public，不打分销商/组织；正式结果 CH340C 第一，垃圾不进列表 */
import { test, expect } from '@playwright/test';
import { stubSession, stubEzplm, stubSuppliers, stubKicadLib, stubAi } from './fixtures';

test('anonymous search hits ezPLM only and gates junk', async ({ page }) => {
  const ez: string[] = [], sup: string[] = [];
  await stubSession(page, { tier: 'anonymous' });
  await stubEzplm(page, ez);
  await stubSuppliers(page, sup, false);
  await stubKicadLib(page);
  await stubAi(page, { credits: 0, calls: [] });
  await page.goto('/?e2e=1');

  const search = page.getByPlaceholder(/型号|MPN|search/i).first();
  await search.fill('CH340C');
  await expect(page.getByText('CH340C', { exact: true }).first()).toBeVisible({ timeout: 10_000 });

  expect(ez.filter((p) => p === 'parts').length).toBeGreaterThan(0);
  expect(sup.filter((c) => !c.endsWith('status'))).toEqual([]);          // 匿名：零分销商调用
  await expect(page.getByText('Servo PHAT')).toHaveCount(0);              // 垃圾不进正式结果
});
