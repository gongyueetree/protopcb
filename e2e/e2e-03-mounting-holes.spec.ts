/** E2E-03：100×80 开四角定位孔 → JSON 与 KiCad PCB 导出里孔数与坐标一致 */
import { test, expect } from '@playwright/test';
import { stubSession, stubEzplm, stubSuppliers, stubKicadLib, stubAi } from './fixtures';

test('mounting holes agree between document and PCB export', async ({ page }) => {
  await stubSession(page, { tier: 'anonymous' });
  await stubEzplm(page); await stubSuppliers(page); await stubKicadLib(page); await stubAi(page, { credits: 0, calls: [] });
  await page.goto('/?e2e=1');
  await page.evaluate(() => (window as unknown as { __protopcb_test__: { setBoard: (w: number, h: number) => void } }).__protopcb_test__.setBoard(100, 80));
  await page.getByTestId('toggle-mounting-holes').click();
  const holes = await page.evaluate(() => JSON.parse((window as unknown as { __protopcb_test__: { getDocJson: () => string } }).__protopcb_test__.getDocJson()).board.mountingHoles as { position: { x: number; y: number } }[]);
  expect(holes).toHaveLength(4);
  expect(holes.map((h) => [h.position.x, h.position.y])).toEqual(expect.arrayContaining([[4, 4], [96, 4], [4, 76], [96, 76]]));
  // 导出的 KiCad PCB 里同样 4 个孔、同样坐标
  await page.getByRole('button', { name: /导出设计|Export/ }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /kicad_pcb|PCB 布局文件|KiCad/i }).first().click(),
  ]);
  const text = await (await download.createReadStream())?.toArray().then((b) => Buffer.concat(b as Buffer[]).toString('utf8'));
  const ats = [...(text ?? '').matchAll(/CircuitCanvas:MountingHole_[^"]*"[^(]*\(layer "F\.Cu"\)\s*\n\s*\(at ([\d.]+) ([\d.]+)\)/g)].map((m) => [+m[1], +m[2]]);
  expect(ats).toHaveLength(4);
  expect(ats).toEqual(expect.arrayContaining([[4, 4], [96, 4], [4, 76], [96, 76]]));
});
