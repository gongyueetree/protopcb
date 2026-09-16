/**
 * §8 JSON 往返稳定 + §13 空器件项目也要恢复
 */
import { describe, it, expect } from 'vitest';
import { createDocument } from '../../src/design-core/document/factory';
import { runDesignReview, buildBom } from '../../src/design-core/document/services';
import { docHasContent } from '../../src/design-core/document/persistence-service';
import { parseDocument } from '../../src/design-core/document/schema';

describe('JSON 往返（§8）', () => {
  /** 复刻 store 的 refreshDerived：派生 BOM 与审查结果 */
  const derive = (doc: ReturnType<typeof createDocument>) =>
    ({ ...doc, bom: buildBom(doc), reviewResults: runDesignReview(doc) });
  const build = () => {
    const doc = createDocument({ name: '往返测试' });
    doc.board.widthMm = 120; doc.board.heightMm = 90;
    return derive(doc);
  };

  it('审查结果的 ID 是确定性的（同输入必得同 ID）', () => {
    const a = build();
    const b = build();
    expect(a.reviewResults.map((r) => r.id)).toEqual(b.reviewResults.map((r) => r.id));
    expect(a.reviewResults[0]?.id).toMatch(/^review:/);
  });

  it('导入→不编辑→导出，reviewResults 不产生无意义 diff', () => {
    const A = JSON.stringify(build());
    const loaded = parseDocument(JSON.parse(A));
    expect(loaded.ok).toBe(true);
    const B = JSON.stringify(derive(loaded.ok ? loaded.document : build()));
    const idsA = JSON.parse(A).reviewResults.map((r: { id: string }) => r.id);
    const idsB = JSON.parse(B).reviewResults.map((r: { id: string }) => r.id);
    expect(idsB).toEqual(idsA);
  });
});

describe('空器件项目也要恢复（§13）', () => {
  it('全新空文档：没有内容', () => {
    expect(docHasContent(createDocument({ name: '未命名设计' }))).toBe(false);
  });

  it('改了项目名 → 有内容', () => {
    expect(docHasContent(createDocument({ name: '我的温控板' }))).toBe(true);
  });

  it('改了板框（120×90）但没有器件 → 有内容', () => {
    const doc = createDocument({ name: '未命名设计' });
    doc.board.widthMm = 120; doc.board.heightMm = 90;
    expect(docHasContent(doc)).toBe(true);
  });

  it('改了板形 / 开了外壳 / 有定位孔 → 都算有内容', () => {
    const shape = createDocument({ name: '未命名设计' }); shape.board.shape = 'circle';
    expect(docHasContent(shape)).toBe(true);
    const enc = createDocument({ name: '未命名设计' });
    enc.enclosure = { enabled: true, wallMm: 2, sideClearanceMm: 1.5, standoffMm: 4, topClearanceMm: 2, bottomClearanceMm: 1, lidMm: 2 };
    expect(docHasContent(enc)).toBe(true);
    const holes = createDocument({ name: '未命名设计' });
    holes.board.mountingHoles = [{ position: { x: 4, y: 4 }, diameterMm: 3.2 }];
    expect(docHasContent(holes)).toBe(true);
  });

  it('记录了设计需求但还没上器件 → 有内容', () => {
    const doc = createDocument({ name: '未命名设计' });
    doc.designIntent = { requirement: 'USB 转串口', rationale: 'x', generatedAt: '' };
    expect(docHasContent(doc)).toBe(true);
  });
});
