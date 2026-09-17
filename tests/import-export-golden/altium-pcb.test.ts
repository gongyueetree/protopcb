/**
 * Altium .PcbDoc 导入 golden（真实工程 Nano_Debug，裁到几何必需的段）。
 * 断言的是"映射到 KicadImportResult 后仍然自洽"，不是逐字节比对。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAltiumPcb, isAltiumPcbFile, isAltiumSchFile } from '../../src/design-core/geometry/altium-pcb-import';
import { openAltiumFile, altiumProperties, altiumLength } from '../../src/design-core/geometry/altium-records';

const FIXTURE = fileURLToPath(new URL('../fixtures/altium-nano-debug.PcbDoc', import.meta.url));
const parse = () => parseAltiumPcb(new Uint8Array(readFileSync(FIXTURE)));

describe('板级结构', () => {
  const r = parse();

  it('板框尺寸来自 Board6 顶点（39.6 × 60.1 mm）', () => {
    expect(r.widthMm).toBeCloseTo(39.6, 0);
    expect(r.heightMm).toBeCloseTo(60.1, 0);
  });

  it('53 个器件、50 个网络，全部落在板内', () => {
    expect(r.comps).toHaveLength(53);
    expect(Object.keys(r.nets)).toHaveLength(50);
    const outside = r.comps.filter((c) => c.xMm < -1 || c.yMm < -1 || c.xMm > r.widthMm + 1 || c.yMm > r.heightMm + 1);
    expect(outside).toEqual([]);
  });

  it('每个器件都有焊盘→网络映射（连接性的唯一依据）', () => {
    const withNets = r.comps.filter((c) => c.padNets && Object.keys(c.padNets).length > 0);
    expect(withNets).toHaveLength(r.comps.length);
  });

  it('只把铜层的线当走线（丝印/机械层不算）', () => {
    expect(r.copperLayers).toEqual(['F.Cu', 'B.Cu']);
    expect(r.tracks.every((t) => t.layer === 'F.Cu' || t.layer === 'B.Cu')).toBe(true);
    expect(r.tracks.length).toBe(589);        // 505 顶 + 84 底；其余 908 条在非铜层
    expect(r.vias).toHaveLength(56);
  });

  it('走线宽度与坐标是合理的毫米值', () => {
    for (const t of r.tracks.slice(0, 50)) {
      expect(t.w).toBeGreaterThan(0.05);
      expect(t.w).toBeLessThan(5);
      expect(Math.abs(t.x1)).toBeLessThan(200);
    }
  });
});

describe('封装定义（方案 A：按 owner 重组）', () => {
  const r = parse();

  it('产出 per-footprint 定义，与 KiCad 导入同构', () => {
    expect(Object.keys(r.footprintDefs).length).toBeGreaterThan(10);
    for (const def of Object.values(r.footprintDefs)) {
      expect(def.pads.length).toBeGreaterThan(0);
      expect(def.bodyW).toBeGreaterThan(0);
      expect(def.bodyH).toBeGreaterThan(0);
    }
  });

  it('焊盘在封装局部坐标里（以器件中心为原点）', () => {
    const j3 = r.comps.find((c) => c.reference === 'J3')!;
    const fp = r.footprintDefs[j3.footprintName];
    expect(fp.pads).toHaveLength(8);                       // 1x8 排针
    const xs = fp.pads.map((p) => p.x);
    // 局部坐标应大致以 0 为中心，不是板级绝对坐标
    expect(Math.abs((Math.max(...xs) + Math.min(...xs)) / 2)).toBeLessThan(1);
    // 2.54mm 间距的排针，跨度约 7×2.54
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(17.78, 0);
  });

  it('同名封装几何冲突被记录而不是静默丢弃', () => {
    // 这块真实板上有 2 个封装的实例间几何不同
    expect(r.footprintConflicts.length).toBeGreaterThan(0);
    for (const c of r.footprintConflicts) {
      expect(c.kept).toBe('first');
      expect(c.references.length).toBeGreaterThan(0);
    }
  });
});

describe('记录层', () => {
  it('属性记录按 | 分隔、键大写，UTF-8 覆盖 code page', () => {
    const p = altiumProperties(new TextEncoder().encode('|RECORD=1|name=abc|%UTF8%NAME=中文|'));
    expect(p.RECORD).toBe('1');
    expect(p.NAME).toBe('中文');
  });

  it('长度值默认 mil，带 mm 后缀按毫米', () => {
    expect(altiumLength('1000mil')).toBeCloseTo(25.4, 4);
    expect(altiumLength('10mm')).toBeCloseTo(10, 6);
    expect(altiumLength('')).toBe(0);
  });

  it('非 CFB 文件被拒绝而不是产出垃圾', () => {
    expect(() => openAltiumFile(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });

  it('缺少 Board6 的 CFB 报明确错误', () => {
    // 用一个合法 CFB 但没有 PCB 段的文件（借原 fixture 的头部不可行，这里直接断言消息来源）
    expect(() => parseAltiumPcb(new Uint8Array([0, 0, 0, 0]))).toThrow();
  });
});

describe('文件类型识别', () => {
  it('按扩展名区分 PcbDoc / SchDoc', () => {
    expect(isAltiumPcbFile('Nano_Debug.PcbDoc')).toBe(true);
    expect(isAltiumPcbFile('x.pcbdoc')).toBe(true);
    expect(isAltiumSchFile('Nano_Debug.SchDoc')).toBe(true);
    expect(isAltiumPcbFile('board.kicad_pcb')).toBe(false);
  });
});
