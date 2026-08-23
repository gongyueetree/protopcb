import { describe, it, expect } from 'vitest';

/** 与 step-loader 同款：brep_faces → geometry groups（下标是「三角形」序号） */
function facesToGroups(faces: { first: number; last: number; color?: number[] | null }[]) {
  const groups: { start: number; count: number; matIdx: number }[] = [];
  const keyToIdx = new Map<string, number>();
  let matCount = 0;
  for (const f of faces.filter((x) => Array.isArray(x.color) && x.color.length >= 3)) {
    const c = f.color as number[];
    const key = `${c[0].toFixed(3)},${c[1].toFixed(3)},${c[2].toFixed(3)}`;
    let idx = keyToIdx.get(key);
    if (idx === undefined) { idx = matCount++; keyToIdx.set(key, idx); }
    groups.push({ start: f.first * 3, count: (f.last - f.first + 1) * 3, matIdx: idx });
  }
  return { groups, matCount };
}

/** 由颜色推断质感（与 materialFromColor 同款判据） */
function surfaceOf(r: number, g: number, b: number) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const sat = mx - mn, lum = (r + g + b) / 3;
  if (r > 0.45 && g > 0.32 && b < g * 0.75 && sat > 0.12) return 'gold';
  if (sat < 0.09 && lum > 0.42) return 'metal';
  return 'plastic';
}

describe('STEP 逐面颜色（此前只读 mesh 级 color，多色模型退化成一色）', () => {
  it('三角形下标正确转成顶点下标区间', () => {
    const { groups } = facesToGroups([
      { first: 0, last: 9, color: [0.1, 0.1, 0.1] },     // 10 个三角形 → 30 个顶点
      { first: 10, last: 19, color: [0.75, 0.75, 0.75] },
    ]);
    expect(groups[0]).toEqual({ start: 0, count: 30, matIdx: 0 });
    expect(groups[1]).toEqual({ start: 30, count: 30, matIdx: 1 });
  });

  it('同色面复用同一材质', () => {
    const { groups, matCount } = facesToGroups([
      { first: 0, last: 4, color: [0.1, 0.1, 0.1] },
      { first: 5, last: 9, color: [0.75, 0.75, 0.75] },
      { first: 10, last: 14, color: [0.1, 0.1, 0.1] },   // 与第一段同色
    ]);
    expect(matCount).toBe(2);
    expect(groups.map((g) => g.matIdx)).toEqual([0, 1, 0]);
  });

  it('无颜色的面被跳过', () => {
    const { groups } = facesToGroups([
      { first: 0, last: 4, color: null },
      { first: 5, last: 9, color: [0.2, 0.2, 0.2] },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].start).toBe(15);
  });

  it('质感判定：黑塑封/银引脚/金脚', () => {
    expect(surfaceOf(0.05, 0.05, 0.05)).toBe('plastic');   // 纯黑塑封（旧启发式会误杀）
    expect(surfaceOf(0.75, 0.75, 0.75)).toBe('metal');     // 立创模型常见引脚灰
    expect(surfaceOf(0.85, 0.68, 0.25)).toBe('gold');      // 镀金
    expect(surfaceOf(0.95, 0.95, 0.93)).toBe('metal');     // 近白仍是合法原色，不再被覆盖
  });
});
