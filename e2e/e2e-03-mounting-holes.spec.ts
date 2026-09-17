/**
 * E2E-03：定位孔在文档与 KiCad 导出里一致。
 * 导出前会先过项目命名对话框（未命名工程的真实 gate）—— 测试完整走一遍，不绕过。
 */
import { test, expect } from '@playwright/test';
import { stubSession, stubEzplm, stubSuppliers, stubKicadLib, stubAi } from './fixtures';

test('mounting holes agree between document and PCB export', async ({ page }) => {
  await stubSession(page, { tier: 'anonymous' });
  await stubEzplm(page); await stubSuppliers(page); await stubKicadLib(page); await stubAi(page, { credits: 0, calls: [] });
  await page.goto('/?e2e=1');

  await page.evaluate(() => (window as unknown as { __protopcb_test__: { setBoard: (w: number, h: number) => void } }).__protopcb_test__.setBoard(100, 80));
  await page.getByTestId('toggle-mounting-holes').click();

  const holes = await page.evaluate(() => JSON.parse(
    (window as unknown as { __protopcb_test__: { getDocJson: () => string } }).__protopcb_test__.getDocJson(),
  ).board.mountingHoles as { position: { x: number; y: number } }[]);
  expect(holes).toHaveLength(4);
  expect(holes.map((h) => [h.position.x, h.position.y])).toEqual(
    expect.arrayContaining([[4, 4], [96, 4], [4, 76], [96, 76]]),
  );

  // 真实导出路径：先命名（未命名工程的 gate），再下载
  await page.getByTestId('open-export').click();
  const nameDialog = page.getByRole('dialog');
  await expect(nameDialog).toBeVisible();
  const input = nameDialog.getByRole('textbox');
  await input.fill('E2E 定位孔');
  await input.press('Enter');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-kicad-pcb').click(),
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');

  const ats = [...text.matchAll(/MountingHole[^(]*\(layer "F\.Cu"\)\s*\n?\s*\(at ([\d.]+) ([\d.]+)\)/g)]
    .map((m) => [Number(m[1]), Number(m[2])]);
  expect(ats).toHaveLength(4);
  expect(ats).toEqual(expect.arrayContaining([[4, 4], [96, 4], [4, 76], [96, 76]]));
});
