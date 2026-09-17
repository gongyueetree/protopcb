/** E2E-05：部分报价的 BOM 只显示覆盖度，不显示总价。用 testid 定位标签页，不依赖 emoji/i18n。 */
import { test, expect } from '@playwright/test';
import { stubSession, stubEzplm, stubSuppliers, stubKicadLib, stubAi } from './fixtures';

test('partial pricing shows coverage, never a total', async ({ page }) => {
  await stubSession(page, { tier: 'anonymous' });
  await stubEzplm(page); await stubSuppliers(page); await stubKicadLib(page); await stubAi(page, { credits: 0, calls: [] });
  await page.goto('/?e2e=1');
  await page.evaluate(() => (window as unknown as { __protopcb_test__: { seedTrust: (l: string[]) => void } })
    .__protopcb_test__.seedTrust(['VERIFIED', 'VERIFIED', 'PLACEHOLDER']));

  await page.getByTestId('tab-bom').click();
  await expect(page.getByText(/报价覆盖|Price coverage/)).toBeVisible();
  await expect(page.getByText(/BOM 总价|BOM total/)).toHaveCount(0);
});
