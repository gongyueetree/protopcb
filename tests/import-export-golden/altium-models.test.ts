/**
 * Altium 内嵌 3D 模型（真实工程 Nano_Debug）：目录、实例绑定、变换、解压。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAltiumPcb } from '../../src/design-core/geometry/altium-pcb-import';
import { openAltiumFile } from '../../src/design-core/geometry/altium-records';
import { readAltiumModelCatalog, unpackAltiumModel } from '../../src/design-core/geometry/altium-models';

const FIXTURE = fileURLToPath(new URL('../fixtures/altium-nano-debug.PcbDoc', import.meta.url));
/** 精简 fixture 里没有 Models/ 段（为了体积），完整文件只在本地存在 */
const FULL = '/home/claude/adproj/Nano_Debug/Nano_Debug.PcbDoc';
const hasFull = existsSync(FULL);

describe('模型目录与解压', () => {
  it.runIf(hasFull)('目录只收内嵌且有数据的条目', () => {
    const stream = openAltiumFile(new Uint8Array(readFileSync(FULL)));
    const cat = readAltiumModelCatalog(stream);
    expect(cat.length).toBeGreaterThan(10);
    for (const c of cat) {
      expect(c.key).toBe(c.key.toUpperCase());
      expect(c.fileName).toMatch(/\.(stp|step)$/i);
    }
  });

  it.runIf(hasFull)('解压出来必须是 STEP，否则报错而不是喂给 occt', () => {
    const stream = openAltiumFile(new Uint8Array(readFileSync(FULL)));
    const cat = readAltiumModelCatalog(stream);
    const step = unpackAltiumModel(stream(`Models/${cat[0].streamIndex}`));
    expect(new TextDecoder().decode(step.subarray(0, 20))).toContain('ISO-10303-21');
  });

  it('非 zlib 数据被拒绝', () => {
    expect(() => unpackAltiumModel(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });

  it('解压体积超限被拒绝（防畸形文件撑爆内存）', () => {
    // 用一个真实但限额设成 1 字节的场景
    expect(() => unpackAltiumModel(new Uint8Array([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]), 1)).toThrow();
  });
});

describe('实例绑定与变换', () => {
  it.runIf(hasFull)('绝大多数器件绑到自己的模型，变换是局部偏移而非板级坐标', () => {
    const warns: string[] = [];
    const r = parseAltiumPcb(new Uint8Array(readFileSync(FULL)), { onWarning: (m) => warns.push(m) });
    const withModel = r.comps.filter((c) => c.altiumModelKey);
    // 53 个器件里 52 个绑上；J2 的 Body 用了非封装原点的定位基准，宁可跳过也不画错位置
    expect(withModel.length).toBe(52);
    expect(warns.some((w) => w.includes('定位基准异常'))).toBe(true);

    for (const c of withModel) {
      const off = c.modelTransform!.offset!;
      // 局部偏移应在器件尺度内（毫米级），不是几十毫米的板级坐标
      expect(Math.abs(off[0])).toBeLessThan(30);
      expect(Math.abs(off[1])).toBeLessThan(30);
      expect(Math.abs(off[2])).toBeLessThan(30);
      expect(off.every(Number.isFinite)).toBe(true);
      expect(c.modelTransform!.rotate!.every(Number.isFinite)).toBe(true);
    }
  });

  it.runIf(hasFull)('同一模型被多个实例共用时只解压一次', () => {
    const r = parseAltiumPcb(new Uint8Array(readFileSync(FULL)));
    const keys = new Set(r.comps.map((c) => c.altiumModelKey).filter(Boolean));
    expect(r.altiumModels!.length).toBe(keys.size);
    // 0603 电阻/电容有多个实例，唯一模型数必然少于器件数
    expect(r.altiumModels!.length).toBeLessThan(r.comps.length);
  });

  it.runIf(hasFull)('模型字节是可用的 STEP', () => {
    const r = parseAltiumPcb(new Uint8Array(readFileSync(FULL)));
    for (const m of r.altiumModels!.slice(0, 3)) {
      expect(new TextDecoder().decode(m.step.subarray(0, 20))).toContain('ISO-10303-21');
    }
  });

  it('精简 fixture 没有 Models 段时不报错，PCB 几何照常', () => {
    const warns: string[] = [];
    const r = parseAltiumPcb(new Uint8Array(readFileSync(FIXTURE)), { onWarning: (m) => warns.push(m) });
    expect(r.comps).toHaveLength(53);
    expect(r.altiumModels).toEqual([]);
    expect(r.comps.every((c) => !c.altiumModelKey)).toBe(true);
  });
});
