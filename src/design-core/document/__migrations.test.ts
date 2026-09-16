/**
 * 显式版本迁移链单测（此前 migrate 只改版本号，不是真迁移）
 */
import { describe, it, expect } from 'vitest';
import { migrateDocument, parseDocument, MIGRATIONS } from './schema';
import { createDocument } from './factory';

describe('schema 迁移链', () => {
  it('迁移链严格升序（乱序会导致中间步骤被跳过）', () => {
    for (let i = 1; i < MIGRATIONS.length; i++) {
      expect(MIGRATIONS[i - 1].to).toBe(MIGRATIONS[i].from);
    }
  });

  it('enabled=true 但无孔位的旧文档补出四角孔', () => {
    const doc = { schemaVersion: '3.0.0', board: { widthMm: 100, heightMm: 80, shape: 'rect', mountingHolesEnabled: true } };
    const out = migrateDocument(doc) as { board: { mountingHoles: { position: { x: number; y: number }; diameterMm: number }[] } };
    expect(out.board.mountingHoles).toHaveLength(4);
    expect(out.board.mountingHoles[0]).toEqual({ position: { x: 4, y: 4 }, diameterMm: 3.2 });
  });

  it('迁移链 from < to', () => {
    for (const m of MIGRATIONS) {
      expect(m.from < m.to || m.from.localeCompare(m.to, undefined, { numeric: true }) < 0).toBe(true);
    }
  });

  it('v1 golden：定位孔 {x,y,d} → {position,diameterMm} 结构迁移', () => {
    // golden fixture：1.0.0 时代的文档片段（board.mountingHoles 旧结构）
    const v1doc = {
      ...JSON.parse(JSON.stringify(createDocument({ name: 'legacy' }))),
      schemaVersion: '1.0.0',
      board: { ...createDocument({ name: 'x' }).board, mountingHoles: [{ x: 3, y: 4, d: 2.7 }] },
    };
    const out = migrateDocument(v1doc) as { schemaVersion: string; board: { mountingHoles: { position: { x: number; y: number }; diameterMm: number }[] } };
    expect(out.schemaVersion).toBe('3.2.0');
    expect(out.board.mountingHoles[0]).toEqual({ position: { x: 3, y: 4 }, diameterMm: 2.7 });
    // 迁移后整体过 Zod
    const parsed = parseDocument(v1doc);
    expect(parsed.ok).toBe(true);
  });

  it('v2 golden：track.layer F.Cu/B.Cu 字面量归一为 top/bottom', () => {
    const v2doc = {
      ...JSON.parse(JSON.stringify(createDocument({ name: 'legacy2' }))),
      schemaVersion: '2.0.0',
      tracks: [
        { x1: 0, y1: 0, x2: 1, y2: 1, w: 0.25, layer: 'F.Cu' },
        { x1: 0, y1: 0, x2: 1, y2: 1, w: 0.25, layer: 'B.Cu' },
        { x1: 0, y1: 0, x2: 1, y2: 1, w: 0.25, layer: 'In1.Cu' },
      ],
    };
    const out = migrateDocument(v2doc) as { tracks: { layer: string }[] };
    expect(out.tracks.map((t) => t.layer)).toEqual(['top', 'bottom', 'In1.Cu']);   // 内层保留原名
  });

  it('无版本文档：补齐容器字段后可通过校验', () => {
    const bare = { id: 'x', name: '旧原型', board: createDocument({ name: 'b' }).board };
    const parsed = parseDocument(bare);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.document.components).toEqual([]);
      expect(parsed.document.schemaVersion).toBe('3.2.0');
    }
  });

  it('迁移为纯函数：不修改输入对象', () => {
    const input = { schemaVersion: '1.0.0', board: { mountingHoles: [{ x: 1, y: 1, d: 3 }] } };
    const snapshot = JSON.stringify(input);
    migrateDocument(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('3.1 → 3.2：当前页不再复制进文档', () => {
  it('只有旧的 schematicSheet 单页 → 折成 schematicSheets + rootSheetFile', () => {
    const doc = { schemaVersion: '3.1.0', board: { widthMm: 100, heightMm: 80, shape: 'rect' },
      schematicSheet: { file: 'main.kicad_sch', instances: [], wires: [], junctions: [], labels: [], noConnects: [], libSymbols: {} } };
    const out = migrateDocument(doc) as { schematicSheet?: unknown; schematicSheets?: Record<string, unknown>; rootSheetFile?: string; schemaVersion: string };
    expect(out.schematicSheet).toBeUndefined();
    expect(Object.keys(out.schematicSheets ?? {})).toEqual(['main.kicad_sch']);
    expect(out.rootSheetFile).toBe('main.kicad_sch');
    expect(out.schemaVersion).toBe('3.2.0');
  });
  it('两者都有时以 schematicSheets 为准，只删复制的那份', () => {
    const doc = { schemaVersion: '3.1.0', board: { widthMm: 100, heightMm: 80, shape: 'rect' },
      rootSheetFile: 'root.kicad_sch',
      schematicSheets: { 'root.kicad_sch': { instances: [], wires: [], junctions: [], labels: [], noConnects: [], libSymbols: {} }, 'sub.kicad_sch': { instances: [], wires: [], junctions: [], labels: [], noConnects: [], libSymbols: {} } },
      schematicSheet: { file: 'sub.kicad_sch', instances: [], wires: [], junctions: [], labels: [], noConnects: [], libSymbols: {} } };
    const out = migrateDocument(doc) as { schematicSheet?: unknown; schematicSheets?: Record<string, unknown>; rootSheetFile?: string };
    expect(out.schematicSheet).toBeUndefined();
    expect(Object.keys(out.schematicSheets ?? {}).sort()).toEqual(['root.kicad_sch', 'sub.kicad_sch']);
    expect(out.rootSheetFile).toBe('root.kicad_sch');
  });
});
