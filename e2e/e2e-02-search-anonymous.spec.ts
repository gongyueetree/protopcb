/**
 * E2E-02：匿名检索。
 * 产品规则已变更：匿名**可以**用分销商检索（不耗 AI Token，服务端按小时限频），
 * 所以不再断言"零 supplier 调用"——限频的 429 由 api/__tests__ 覆盖。
 * 这里验证的是相关性门禁：CH340C 是高相关结果，Servo PHAT 这类垃圾不进正式结果。
 */
import { test, expect } from '@playwright/test';
import { stubSession, stubEzplm, stubSuppliers, stubKicadLib, stubAi } from './fixtures';

test('anonymous search uses ezPLM and may use suppliers, and filters junk', async ({ page }) => {
  const ez: string[] = [], sup: string[] = [];
  await stubSession(page, { tier: 'anonymous' });
  await stubEzplm(page, ez);
  await stubSuppliers(page, sup, true);          // 匿名也放行（限频在服务端）
  await stubKicadLib(page);
  await stubAi(page, { credits: 0, calls: [] });
  await page.goto('/?e2e=1');

  await page.getByPlaceholder(/型号|MPN|Search/i).first().fill('CH340C');

  // ezPLM 公开检索必须发生，且 CH340C 是高相关结果
  await expect(page.getByText('CH340C', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  expect(ez.filter((p) => p === 'parts').length).toBeGreaterThan(0);

  // 相关性门禁：同一批 fixture 里的 Servo PHAT 不得进入正式结果
  await expect(page.getByText('Servo PHAT')).toHaveCount(0);
});
