/**
 * design-core/enclosure/cadquery.ts
 * 生成 CadQuery 参数化脚本 —— 在 CadQuery / FreeCAD 里跑一下即可得到真实 STEP。
 *
 * 为什么是"出脚本"而不是"出 STEP"：
 *   STEP 是 B-rep 实体格式，需要 OCCT 内核做布尔运算与倒角，浏览器端做不了。
 *   我们能做的、也确实有价值的，是把已经算准的几何（外形、壁厚、支柱位、
 *   每个开孔的位置与尺寸）写成一份可执行、可版本化、可二次编辑的 CadQuery 脚本。
 *   工程师拿到脚本可以直接改参数、加倒角与加强筋——比拿一个不可编辑的网格有用得多。
 *
 * 脚本里的每个开孔都带来源位号注释，方便与 PCB 对照。
 */
import type { EnclosureSpec, EnclosureDims } from './index';
import type { Opening, MountingPlan } from './openings';

const f = (n: number) => Number(n.toFixed(3));

export function buildCadQueryScript(opts: {
  name: string;
  spec: EnclosureSpec;
  dims: EnclosureDims;
  openings: Opening[];
  mounting: MountingPlan;
  board: { widthMm: number; heightMm: number };
  pcbThicknessMm: number;
}): string {
  const { name, spec, dims, openings, mounting, board, pcbThicknessMm } = opts;
  const L = (s: string) => s;
  const lines: string[] = [];

  lines.push(L(`# ${name} —— 外壳参数化模型（由 ProtoPCB 生成）`));
  lines.push(L('#'));
  lines.push(L('# 运行： pip install cadquery && python 本文件'));
  lines.push(L('# 产出： 同目录下 <name>-bottom.step / <name>-lid.step'));
  lines.push(L('#'));
  lines.push(L('# 注意：以下尺寸来自 PCB 外形与器件高度包络，开孔位置来自器件坐标。'));
  lines.push(L('#       倒角、加强筋、拔模、螺纹柱内孔等工艺细节未包含，请按需补充。'));
  lines.push('');
  lines.push('import cadquery as cq');
  lines.push('');
  lines.push('# ── 参数 ──');
  lines.push(`OUTER_W = ${f(dims.outerW)}      # 外形宽`);
  lines.push(`OUTER_H = ${f(dims.outerH)}      # 外形长`);
  lines.push(`INNER_W = ${f(dims.innerW)}      # 内腔宽`);
  lines.push(`INNER_H = ${f(dims.innerH)}      # 内腔长`);
  lines.push(`CAVITY_D = ${f(dims.innerDepth)} # 内腔深（支柱+板厚+器件高+净空）`);
  lines.push(`WALL = ${f(spec.wallMm)}         # 壁厚`);
  lines.push(`LID = ${f(spec.lidMm)}           # 顶盖厚`);
  lines.push(`STANDOFF = ${f(spec.standoffMm)} # 支柱高（PCB 底面到内腔底）`);
  lines.push(`PCB_T = ${f(pcbThicknessMm)}     # PCB 厚`);
  lines.push(`BOARD_W, BOARD_H = ${f(board.widthMm)}, ${f(board.heightMm)}`);
  lines.push('');
  lines.push('# ── 底壳：外盒挖内腔 ──');
  lines.push('bottom = (');
  lines.push('    cq.Workplane("XY")');
  lines.push('    .box(OUTER_W, OUTER_H, CAVITY_D + WALL, centered=(True, True, False))');
  lines.push('    .faces(">Z").workplane()');
  lines.push('    .rect(INNER_W, INNER_H).cutBlind(-CAVITY_D)');
  lines.push(')');
  lines.push('');

  // 支柱 / 卡扣
  if (mounting.kind === 'screw-post' && mounting.positions.length) {
    lines.push(`# ── 螺柱（${mounting.detail}）──`);
    lines.push('posts = [');
    for (const p of mounting.positions) {
      lines.push(`    (${f(p.x - board.widthMm / 2)}, ${f(-(p.y - board.heightMm / 2))}),  # 板坐标 (${f(p.x)}, ${f(p.y)})`);
    }
    lines.push(']');
    lines.push('for (px, py) in posts:');
    lines.push('    bottom = (');
    lines.push('        bottom.faces("<Z").workplane(offset=WALL, origin=(px, py, 0))');
    lines.push('        .circle(3.2).extrude(STANDOFF)          # 柱外径 Ø6.4');
    lines.push('        .faces(">Z").workplane(origin=(px, py, 0))');
    lines.push('        .circle(1.1).cutBlind(-STANDOFF * 0.8)   # M2.5 自攻底孔 Ø2.2');
    lines.push('    )');
  } else {
    lines.push(`# ── 卡扣（${mounting.detail}）──`);
    lines.push('# 简化为墙内侧的凸台，实际卡扣需按材料与壁厚调整悬臂长度与倒扣量');
    lines.push('snaps = [');
    for (const p of mounting.positions) {
      lines.push(`    (${f(p.x - board.widthMm / 2)}, ${f(-(p.y - board.heightMm / 2))}),`);
    }
    lines.push(']');
  }
  lines.push('');

  // 开孔
  const side = openings.filter((o) => o.face !== 'top');
  const top = openings.filter((o) => o.face === 'top');
  if (side.length) {
    lines.push('# ── 侧壁开孔（对外接口）──');
    for (const o of side) {
      const faceSel = o.face === 'left' ? '"<X"' : o.face === 'right' ? '">X"' : o.face === 'front' ? '"<Y"' : '">Y"';
      // 墙面局部坐标：水平 = 沿墙方向偏移；垂直 = PCB 上表面之上的高度
      const zCenter = `WALL + STANDOFF + PCB_T + ${f(o.cy)}`;
      lines.push(`# ${o.reference}（${o.mpn}）：${o.reason}`);
      lines.push('bottom = (');
      lines.push(`    bottom.faces(${faceSel}).workplane(centerOption="CenterOfBoundBox")`);
      lines.push(`    .center(${f(o.face === 'left' || o.face === 'right' ? -o.cx : o.cx)}, ${zCenter} - (CAVITY_D + WALL) / 2)`);
      lines.push(`    .rect(${f(o.w)}, ${f(o.h)}).cutThruAll()`);
      lines.push(')');
    }
    lines.push('');
  }

  lines.push('# ── 顶盖 ──');
  lines.push('lid = (');
  lines.push('    cq.Workplane("XY").workplane(offset=CAVITY_D + WALL)');
  lines.push('    .box(OUTER_W, OUTER_H, LID, centered=(True, True, False))');
  lines.push(')');
  lines.push('');
  if (top.length) {
    lines.push('# ── 顶盖开窗/开孔 ──');
    for (const o of top) {
      lines.push(`# ${o.reference}（${o.mpn}）：${o.reason}`);
      lines.push('lid = (');
      lines.push('    lid.faces(">Z").workplane(centerOption="CenterOfBoundBox")');
      lines.push(`    .center(${f(o.cx)}, ${f(-o.cy)})`);
      lines.push(o.shape === 'circle' ? `    .circle(${f(o.w / 2)}).cutThruAll()` : `    .rect(${f(o.w)}, ${f(o.h)}).cutThruAll()`);
      lines.push(')');
    }
    lines.push('');
  }

  lines.push('# ── 导出 ──');
  lines.push(`cq.exporters.export(bottom, "${name}-bottom.step")`);
  lines.push(`cq.exporters.export(lid, "${name}-lid.step")`);
  lines.push(`cq.exporters.export(bottom, "${name}-bottom.stl")`);
  lines.push('print("done: bottom/lid STEP + STL")');
  lines.push('');
  return lines.join('\n');
}
