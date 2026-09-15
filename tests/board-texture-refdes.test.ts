/**
 * 3D 板面贴图的位号必须受总开关控制（此前只看单个器件的 hidden）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('buildBoardTexture 位号开关', () => {
  const tex = readFileSync(new URL('../src/modules/board-editor/board-texture.ts', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../src/modules/board-editor/BoardView3D.tsx', import.meta.url), 'utf8');

  it('贴图函数接收 showRefDes，关掉时跳过整段位号绘制', () => {
    expect(tex).toMatch(/opts: \{ showRefDes\?: boolean \}/);
    expect(tex).toMatch(/if \(opts\.showRefDes === false\) break;/);
  });
  it('3D 视图把 store 的 hideAllRefDes 传给贴图，且开关变化触发重建', () => {
    expect(view).toMatch(/showRefDes = !useDesignStore\.getState\(\)\.hideAllRefDes/);
    expect(view).toMatch(/buildBoardTexture\(doc, 'top', \{ showRefDes \}\)/);
    expect(view).toMatch(/libVersion, hideAllRefDes\]\);/);
  });
});
