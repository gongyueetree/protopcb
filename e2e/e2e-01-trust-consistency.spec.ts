/** E2E-01：同一项目在 Pipeline / Review 里的 trust 结论一致（1 VERIFIED / 2 CANDIDATE / 1 PLACEHOLDER） */
import { test, expect } from '@playwright/test';
import { stubSession, stubEzplm, stubSuppliers, stubKicadLib, stubAi } from './fixtures';

test('trust summary is identical across pipeline and review', async ({ page }) => {
  await stubSession(page, { tier: 'anonymous' });
  await stubEzplm(page); await stubSuppliers(page); await stubKicadLib(page); await stubAi(page, { credits: 0, calls: [] });
  await page.goto('/?e2e=1');
  // 通过 store 直接放入四个已知 trust 的器件（比走 UI 更稳定，且这是"同一事实"的测试）
  await page.evaluate(() => {
    const w = window as unknown as { __protopcb_test__?: { seedTrust: (levels: string[]) => void } };
    w.__protopcb_test__?.seedTrust(['VERIFIED', 'CANDIDATE', 'CANDIDATE', 'PLACEHOLDER']);
  });
  const pipeline = page.locator('[data-testid="pipeline-sourcing"]');
  await expect(pipeline).toContainText('2');
  await expect(pipeline).toContainText('1');
  await page.getByRole('button', { name: /设计审查|Design Review/ }).click();
  const review = page.locator('[data-testid="review-trust"]');
  await expect(review).toContainText(/已验证.*1|Verified.*1/);
  await expect(review).toContainText(/待人工确认.*2|confirmation.*2/);
  await expect(review).toContainText(/未验证.*1|Unverified.*1/);
});
