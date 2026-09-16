import { describe, it, expect } from 'vitest';
import { parseDocument } from './schema';
import { createDocument } from './factory';
import { parseLegacySch } from '../geometry/kicad-sch-legacy';
import { parseLegacyLib } from '../geometry/kicad-lib-legacy';

// KiCad 5 工程片段（取自真实工程 SimpleDDS_DAP）
const SCH = `EESchema Schematic File Version 4
$Descr A4 11693 8268
encoding utf-8
Sheet 1 1
Title "Mini DDS AWG Generator"
Date "2020-07-15"
Rev "V2.0"
Comp "EETree Sci & Tech"
$EndDescr
$Comp
L Device:R_Small R19
U 1 1 5F1A2B3C
P 8200 4750
F 0 "R19" H 8259 4796 50  0000 L CNN
F 1 "2k" H 8259 4705 50  0000 L CNN
F 2 "Resistor_SMD:R_0603_1608Metric" H 8200 4750 50  0001 C CNN
	1    8200 4750
	1    0    0    -1
$EndComp
Wire Wire Line
	8200 4650 8200 4500
Wire Bus Line
	5400 1300 5400 2100
Connection ~ 8200 4500
Text Label 7950 2650 0    50   ~ 0
D11
$EndSCHEMATC`;

const LIB = `EESchema-LIBRARY Version 2.4
#
# Device_R_Small
#
DEF Device_R_Small R 0 10 N N 1 F N
F0 "R" 30 20 50 H V L CNN
F1 "Device_R_Small" 30 -40 50 H V L CNN
DRAW
S -30 70 30 -70 0 1 8 N
X ~ 1 0 100 30 D 50 50 1 1 P
X ~ 2 0 -100 30 U 50 50 1 1 P
ENDDRAW
ENDDEF
#End Library`;

describe('原理图数据在持久化往返中不丢失（Zod 会剥掉未声明字段）', () => {
  it('总线/图框/器件值/旧库符号 全部存活', () => {
    const sch = parseLegacySch(SCH);
    const lib = parseLegacyLib(LIB);
    expect(sch.buses.length).toBe(1);
    expect(sch.comps[0].value).toBe('2k');

    const doc = createDocument({ name: 't' });
    doc.rootSheetFile = 'legacy.sch';
    doc.schematicSheets = { 'legacy.sch': {
      instances: sch.comps.map((c) => ({ ref: c.ref, libId: c.libId, value: c.value, x: c.x, y: c.y, rot: c.rot, mirror: c.mirror, unit: c.unit })),
      wires: sch.wires, buses: sch.buses, busEntries: sch.busEntries,
      junctions: sch.junctions, labels: sch.labels, noConnects: sch.noConnects,
      libSymbols: {}, legacySymbols: lib, frame: sch.sheet,
    } };

    // 模拟「保存到 localStorage → 刷新页面 → 校验恢复」
    const round = parseDocument(JSON.parse(JSON.stringify(doc)));
    if (!round.ok) throw new Error(round.error);
    const sheet = (round as { document: typeof doc }).document.schematicSheets!['legacy.sch'];
    expect(sheet.buses?.length).toBe(1);                        // 总线
    expect(sheet.frame?.title).toBe('Mini DDS AWG Generator');  // 图框标题栏
    expect(sheet.instances[0].value).toBe('2k');                // 器件值（曾因 schema 缺字段被剥掉）
    expect(Object.keys(sheet.legacySymbols ?? {}).length).toBe(1);
    expect(sheet.legacySymbols!['Device_R_Small'].pins.length).toBe(2);
  });
});
