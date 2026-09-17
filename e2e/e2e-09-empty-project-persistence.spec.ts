/** E2E-09：0 器件 + 120×90 板框 + 自定义名 → 刷新后必须恢复 */
import { test, expect } from '@playwright/test';
import { stubSession, stubEzplm, stubSuppliers, stubKicadLib, stubAi } from './fixtures';

test('component-less project with custom board/name restores after reload', async ({ page }) => {
  await stubSession(page, { tier: 'anonymous' });
  await stubEzplm(page); await stubSuppliers(page); await stubKicadLib(page); await stubAi(page, { credits: 0, calls: [] });
  await page.goto('/?e2e=1');
  await page.evaluate(() => (window as unknown as { __protopcb_test__: { setBoard: (w: number, h: number) => void } }).__protopcb_test__.setBoard(120, 90));
  await page.getByTestId('project-name').click();
  const input = page.getByRole('dialog').getByRole('textbox');
  await input.fill('空板项目'); await input.press('Enter');
  // 不用 sleep 掩盖持久化缺陷：离开页面时会 flush（pagehide / visibilitychange）
  await page.reload();
  const doc = await page.evaluate(() => JSON.parse((window as unknown as { __protopcb_test__: { getDocJson: () => string } }).__protopcb_test__.getDocJson()));
  expect(doc.board.widthMm).toBe(120);
  expect(doc.board.heightMm).toBe(90);
  expect(doc.name).toBe('空板项目');
  expect(doc.components).toHaveLength(0);
});
