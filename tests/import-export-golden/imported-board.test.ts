/**
 * 真实 KiCad 5 工程（SimpleDDS_DAP）导入回归
 * 这些断言来自用户实际反馈的问题，防止回归。
 */
import { describe, it, expect } from 'vitest';
import { parseKicadPcb } from '../../src/design-core/geometry/kicad-pcb-import';
import { findOverlaps, componentExtentRect, componentRect, OVERLAP_GAP_MM, DEFAULT_GAP_MM } from '../../src/design-core/collision';
import { createDocument } from '../../src/design-core/document/factory';
import { searchResultToPlaced } from '../../src/design-core/document/services';
import type { ComponentSearchResult } from '../../src/providers/types';

/** 密集实板的典型间距：0402 之间常常只有 0.3~0.5mm */
function denseBoard() {
  const doc = createDocument({ name: 'dense' });
  doc.board.widthMm = 51; doc.board.heightMm = 23;
  for (let i = 0; i < 8; i++) {
    const c = searchResultToPlaced({
      componentId: 'x' + i, mpn: 'R-' + i, manufacturer: '—', category: 'passive',
      defaultFootprintName: 'R_0402_1005Metric', family: 'Resistor', pins: 2,
    } as ComponentSearchResult, 'R' + (i + 1));
    c.placement.xMm = 5 + i * 3.0;   // 3mm 中心距 → 0402 courtyard(2.5mm) 间还有 0.5mm，未相碰
    c.placement.yMm = 10;
    doc.components.push(c);
  }
  return doc;
}

describe('重叠判定不能用布局目标间距', () => {
  it('密集实板（courtyard 间仅 0.5mm）：不相交 → 0 个重叠', () => {
    const doc = denseBoard();
    expect(findOverlaps(doc.components).size).toBe(0);
  });

  it('若误用 3mm 布局间距，整排器件会被全部误判（本 bug 的成因）', () => {
    const doc = denseBoard();
    expect(findOverlaps(doc.components, DEFAULT_GAP_MM).size).toBe(doc.components.length);
  });

  it('真正叠在一起的器件仍然被判出', () => {
    const doc = denseBoard();
    doc.components[1].placement.xMm = doc.components[0].placement.xMm;
    doc.components[1].placement.yMm = doc.components[0].placement.yMm;
    expect(findOverlaps(doc.components).size).toBe(2);
  });

  it('重叠阈值常量为 0', () => {
    expect(OVERLAP_GAP_MM).toBe(0);
  });

  it('判重叠用实体外接矩形，比 courtyard 小 0.6mm 余量', () => {
    const doc = denseBoard();
    const c = doc.components[0];
    const court = componentRect(c), ext = componentExtentRect(c);
    expect(ext.width).toBeLessThan(court.width);
    expect(court.width - ext.width).toBeCloseTo(0.6, 3);
  });

  it('0402 按 1.5mm 中心距摆放（真实密集板）不算重叠', () => {
    const doc = denseBoard();
    doc.components.forEach((c, i) => { c.placement.xMm = 5 + i * 1.5; });
    expect(findOverlaps(doc.components).size).toBe(0);
  });
});

describe('KiCad 5 工程解析', () => {
  const PCB5 = `(kicad_pcb (version 20171130) (host pcbnew "(5.1.2-1)-1")
  (general (thickness 1.6))
  (layers (0 F.Cu signal) (31 B.Cu signal) (44 Edge.Cuts user))
  (net 0 "")
  (net 7 GND)
  (gr_line (start 100 100) (end 151 100) (layer Edge.Cuts) (width 0.05))
  (gr_line (start 151 100) (end 151 123) (layer Edge.Cuts) (width 0.05))
  (gr_line (start 151 123) (end 100 123) (layer Edge.Cuts) (width 0.05))
  (gr_line (start 100 123) (end 100 100) (layer Edge.Cuts) (width 0.05))
  (module Connector:USB_C_Receptacle (layer F.Cu) (at 104.37 111.41 270)
    (fp_text reference J1 (at 0 0) (layer F.SilkS))
    (fp_text value USB_C_2.0 (at 0 2) (layer F.Fab))
    (pad A1 smd rect (at 0 0) (size 1 1) (layers F.Cu) (net 7 GND))
  )
  (module Resistor_SMD:R_0402_1005Metric (layer B.Cu) (at 120 110 180)
    (fp_text reference R1 (at 0 0) (layer B.SilkS))
    (fp_text value 10k (at 0 1) (layer B.Fab))
    (pad 1 smd rect (at -0.5 0) (size 0.6 0.5) (layers B.Cu) (net 7 GND))
  ))`;

  it('module 关键字（KiCad 5）与 footprint（KiCad 6+）都能解析', () => {
    const r = parseKicadPcb(PCB5);
    expect(r.comps).toHaveLength(2);
    expect(r.widthMm).toBe(51);
    expect(r.heightMm).toBe(23);
  });

  it('器件层别正确区分 TOP / BOTTOM', () => {
    const r = parseKicadPcb(PCB5);
    expect(r.comps.find((c) => c.reference === 'J1')!.layer).toBe('top');
    expect(r.comps.find((c) => c.reference === 'R1')!.layer).toBe('bottom');
  });

  it('旋转角与 pad 网络保留', () => {
    const r = parseKicadPcb(PCB5);
    const j1 = r.comps.find((c) => c.reference === 'J1')!;
    expect(j1.rotation).toBe(270);
    expect(j1.padNets?.['A1']).toBe(7);
  });
});

describe('KiCad 5 原理图字段', () => {
  const SCH = `EESchema Schematic File Version 4
$Comp
L lib:MIC5504 U2
U 1 1 5FA3D202
P 3350 1000
F 0 "U2" H 3100 1315 50  0000 C CNN
F 1 "MIC5504-3.3YM5" H 3370 1245 50  0000 C CNN
F 2 "Package_TO_SOT_SMD:SOT-23-5" H 3350 600 50  0001 C CNN
	1    3350 1000
	1    0    0    -1
$EndComp
$Comp
L lib:C C2
U 1 1 5FA3D203
P 2600 1100
F 0 "C2" H 2691 1146 50  0000 L CNN
F 1 "1uF" H 2691 1055 50  0000 L CNN
$EndComp
Wire Bus Line
	7250 3850 7350 3950
Entry Wire Line
	7250 3950 7350 4050
$EndSCHEMATC`;

  it('字段位置/字号/对齐都按文件解析，隐藏字段（0001）跳过', async () => {
    const { parseLegacySch } = await import('../../src/design-core/geometry/kicad-sch-legacy');
    const r = parseLegacySch(SCH);
    const u2 = r.comps.find((c) => c.ref === 'U2')!;
    expect(u2.refField?.just).toBe('C');
    expect(u2.refField?.sizeMm).toBeCloseTo(1.27, 2);
    expect(u2.valueField?.x).toBeCloseTo(3370 * 0.0254, 2);
    const c2 = r.comps.find((c) => c.ref === 'C2')!;
    expect(c2.refField?.just).toBe('L');      // 左对齐必须照搬，否则文字整体偏半个宽度
  });

  it('Entry Wire Line 也算总线入口（KiCad 5 实际写法）', async () => {
    const { parseLegacySch } = await import('../../src/design-core/geometry/kicad-sch-legacy');
    const r = parseLegacySch(SCH);
    expect(r.buses).toHaveLength(1);
    expect(r.busEntries).toHaveLength(1);
  });
});

describe('字段方向矩阵变换（与 KiCad 自身渲染一致）', () => {
  const mk = (matLine: string, fields: string) => `EESchema Schematic File Version 4
$Comp
L eedevice:C C2
P 2600 1100
${fields}
	1    2600 1100
	${matLine}
$EndComp
$EndSCHEMATC`;

  it('矩阵 (1,0,0,-1)：位号在上、值在下', async () => {
    const { parseLegacySch } = await import('../../src/design-core/geometry/kicad-sch-legacy');
    const r = parseLegacySch(mk('1    0    0    -1  ',
      'F 0 "C2" H 2691 1146 50  0000 L CNN\nF 1 "1uF" H 2691 1055 50  0000 L CNN'));
    const c = r.comps[0];
    expect(c.refField!.y).toBeLessThan(c.y);      // 位号在上
    expect(c.valueField!.y).toBeGreaterThan(c.y); // 值在下
  });

  it('矩阵 (-1,0,0,1)：y 不翻转，且左右对齐镜像', async () => {
    const { parseLegacySch } = await import('../../src/design-core/geometry/kicad-sch-legacy');
    const r = parseLegacySch(mk('-1   0    0    1   ',
      'F 0 "C2" H 2480 1040 50  0000 L CNN\nF 1 "1uF" H 2480 1160 50  0000 L CNN'));
    const c = r.comps[0];
    expect(c.refField!.y).toBeLessThan(c.y);      // 1040 < 1100，y 不翻转
    expect(c.refField!.x).toBeGreaterThan(c.x);   // x 镜像到右侧
    expect(c.refField!.just).toBe('R');           // 左对齐镜像成右对齐
  });
});
