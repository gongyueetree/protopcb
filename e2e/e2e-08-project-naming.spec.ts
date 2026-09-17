/** E2E-08：项目重命名走受控对话框，Enter 提交，刷新后仍在 */
import { test, expect } from '@playwright/test';
import { stubSession, stubEzplm, stubSuppliers, stubKicadLib, stubAi } from './fixtures';

test('rename via dialog persists across reload', async ({ page }) => {
  await stubSession(page, { tier: 'anonymous' });
  await stubEzplm(page); await stubSuppliers(page); await stubKicadLib(page); await stubAi(page, { credits: 0, calls: [] });
  await page.goto('/?e2e=1');
  await page.getByTestId('project-name').click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible();
  const input = dlg.getByRole('textbox');
  await input.fill('E2E 温控板');
  await input.press('Enter');
  await expect(dlg).toHaveCount(0);
  await expect(page.getByTestId('project-name')).toContainText('E2E 温控板');
  // 不用 sleep：pagehide flush 保证最后一笔已落盘（见 useProjectPersistence）
  await page.reload();
  await expect(page.getByTestId('project-name')).toContainText('E2E 温控板');
});
