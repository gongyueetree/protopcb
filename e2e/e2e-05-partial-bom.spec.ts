/** E2E-05：部分报价的 BOM 不显示"总价"，只显示覆盖度 */
import { test, expect } from '@playwright/test';
import { stubSession, stubEzplm, stubSuppliers, stubKicadLib, stubAi } from './fixtures';

test('partial pricing shows coverage, never a total', async ({ page }) => {
  await stubSession(page, { tier: 'anonymous' });
  await stubEzplm(page); await stubSuppliers(page); await stubKicadLib(page); await stubAi(page, { credits: 0, calls: [] });
  await page.goto('/?e2e=1');
  await page.evaluate(() => (window as unknown as { __protopcb_test__?: { seedTrust: (l: string[]) => void } }).__protopcb_test__?.seedTrust(['VERIFIED', 'VERIFIED', 'PLACEHOLDER']));
  await page.getByRole('button', { name: /^BOM/ }).click();
  await expect(page.getByText(/报价覆盖|Price coverage/)).toBeVisible();
  await expect(page.getByText(/BOM 总价|BOM total/)).toHaveCount(0);
});
