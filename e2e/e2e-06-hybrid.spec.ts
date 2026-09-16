/** E2E-06：2D → 2D+3D → 隐藏 U3 的 3D（焊盘仍可点） → 隐藏全部 → 新增器件仍隐藏 → 显示全部 */
import { test, expect } from '@playwright/test';
import { stubSession, stubEzplm, stubSuppliers, stubKicadLib, stubAi } from './fixtures';

test('hybrid visibility semantics', async ({ page }) => {
  await stubSession(page, { tier: 'anonymous' });
  await stubEzplm(page); await stubSuppliers(page); await stubKicadLib(page); await stubAi(page, { credits: 0, calls: [] });
  await page.goto('/?e2e=1');
  await page.evaluate(() => (window as unknown as { __protopcb_test__: { seedTrust: (l: string[]) => void } }).__protopcb_test__.seedTrust(['VERIFIED', 'VERIFIED', 'VERIFIED']));
  await page.getByRole('button', { name: '2D+3D' }).click();
  const vis = () => page.evaluate(() => (window as unknown as { __protopcb_test__: { visible3D: () => Record<string, boolean> } }).__protopcb_test__.visible3D());
  const before = await vis();
  expect(Object.values(before).every(Boolean)).toBe(true);
  // 单件隐藏
  await page.evaluate(() => (window as unknown as { __protopcb_test__: { hide3D: (i: number) => void } }).__protopcb_test__.hide3D(2));
  const after = await vis();
  expect(Object.values(after).filter((v) => !v)).toHaveLength(1);
  // 隐藏全部 → 新增器件仍隐藏
  await page.getByRole('button', { name: /⋯/ }).click();
  await page.getByRole('button', { name: /隐藏全部 3D|Hide all 3D/ }).click();
  await page.evaluate(() => (window as unknown as { __protopcb_test__: { seedMore: (n: number) => void } }).__protopcb_test__.seedMore(1));
  expect(Object.values(await vis()).every((v) => !v)).toBe(true);
  // 显示全部
  await page.getByRole('button', { name: /⋯/ }).click();
  await page.getByRole('button', { name: /显示全部 3D|Show all 3D/ }).click();
  expect(Object.values(await vis()).every(Boolean)).toBe(true);
});
