/** E2E-04：切换中英文，金额数值与币种不变（CNY 不会变成 $） */
import { test, expect } from '@playwright/test';
import { stubSession, stubEzplm, stubSuppliers, stubKicadLib, stubAi } from './fixtures';

test('currency identity survives language switch', async ({ page }) => {
  await stubSession(page, { tier: 'anonymous' });
  await stubEzplm(page); await stubSuppliers(page); await stubKicadLib(page); await stubAi(page, { credits: 0, calls: [] });
  await page.goto('/?e2e=1');
  // 用领域格式化函数在页面上下文里验证（这是"同一事实"的单点）
  const zh = await page.evaluate(() => (window as unknown as { __protopcb_test__: { formatMoney: (m: unknown, l: string) => string } }).__protopcb_test__.formatMoney({ amount: 12.5, currency: 'CNY' }, 'zh'));
  await page.getByTestId('toggle-lang').click();
  const en = await page.evaluate(() => (window as unknown as { __protopcb_test__: { formatMoney: (m: unknown, l: string) => string } }).__protopcb_test__.formatMoney({ amount: 12.5, currency: 'CNY' }, 'en'));
  expect(zh).toBe('¥12.50');
  expect(en).toBe('CN¥12.50');
  expect(en).not.toMatch(/^\$/);
});
