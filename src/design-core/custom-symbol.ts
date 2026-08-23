/**
 * 定制器件的原理图符号生成（确定性，不依赖大模型）。
 *
 * 布局规则移植自 ds2kicad 的 symbol 引擎，遵循 KiCad 库约定（KLC S4）：
 *   左侧：input / tri_state / open_collector（控制与输入）
 *   右侧：output / bidirectional / passive / unspecified，no_connect 沉底
 *   顶部：正电源（VCC/VDD/VIN…），KLC S4.2.3
 *   底部：地与散热焊盘（GND/VSS/EP…）
 *
 * 关键例外（来自 ds2kicad 的实战教训）：电流路径类 power 脚（IP±/SW/LX 这类）
 * 不算"正电源"，否则电流传感器的 8 个 IP 脚会全被顶到上边。按 KLC S4.2
 * 电源变换例外处理：power_in 靠左、power_out 靠右。
 */
import type { ParsedSymbol } from './geometry/lib-file-registry';
import type { CustomPin } from './custom-lib';

/** 一格 = KiCad 的 2.54mm（100mil）网格 */
const GRID = 2.54;

/** 看起来是正电源的名字 */
const SUPPLY = /^\+?V(CC|DD|DDA|DDD|BAT|IN\b|IO|REG|REF|S\b|\+|_)|^AVDD|^DVDD|^VCC|^VDD|^\+\d/;
/** 地与散热焊盘 */
const GROUNDY = /^(GND|VSS|VEE|AGND|DGND|PGND|EP$|PAD|EPAD|GNDA|GNDD|0V)/;

interface Side { left: CustomPin[]; right: CustomPin[]; top: CustomPin[]; bottom: CustomPin[] }

function classifyPins(pins: CustomPin[]): Side {
  const left: CustomPin[] = [], right: CustomPin[] = [], top: CustomPin[] = [], bottom: CustomPin[] = [];
  for (const p of pins) {
    const nm = (p.name || '').toUpperCase();
    // 用户在向导里显式指定过边，优先尊重
    if (p.side === 'left') { left.push(p); continue; }
    if (p.side === 'right') { right.push(p); continue; }
    if (p.side === 'top') { top.push(p); continue; }
    if (p.side === 'bottom') { bottom.push(p); continue; }

    if (nm === 'EP' || nm === 'EPAD' || /EXPOSED/.test(nm)) { bottom.push(p); continue; }
    if (p.type === 'power_in' || p.type === 'power_out') {
      if (GROUNDY.test(nm)) bottom.push(p);
      else if (SUPPLY.test(nm)) top.push(p);
      else (p.type === 'power_in' ? left : right).push(p);   // 电流路径：入左出右
      continue;
    }
    if (p.type === 'input' || p.type === 'tri_state' || p.type === 'open_collector') left.push(p);
    else right.push(p);
  }
  // 顶排退化保护：正电源通常 ≤3 个，多出的挪到左侧，避免顶部拥挤
  while (top.length > 3) left.push(top.pop()!);

  const byNum = (a: CustomPin, b: CustomPin) => {
    const na = Number(a.num), nb = Number(b.num);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a.num).localeCompare(String(b.num));
  };
  left.sort(byNum); top.sort(byNum); bottom.sort(byNum);
  // 右列：信号在前、NC 沉底（官方库惯例，图面更干净）
  const ncs = right.filter((p) => p.type === 'no_connect').sort(byNum);
  const sig = right.filter((p) => p.type !== 'no_connect').sort(byNum);
  right.length = 0; right.push(...sig, ...ncs);
  return { left, right, top, bottom };
}

/**
 * 由管脚定义生成原理图符号。
 * 坐标系与 ParsedSymbol 一致：左上原点、Y 向下、单位 mm。
 */
export function buildCustomSymbol(pins: CustomPin[]): ParsedSymbol | null {
  if (!pins.length) return null;
  const { left, right, top, bottom } = classifyPins(pins);

  const rows = Math.max(left.length, right.length, 1);
  // KLC S4.1：管脚长度由编号位数决定且全符号等长
  const maxNumChars = Math.max(1, ...pins.map((p) => String(p.num).length));
  const lenCells = maxNumChars <= 2 ? 1 : 2;
  const maxNameLen = Math.max(4, ...pins.map((p) => (p.name || '').length));
  const halfWcells = Math.max(4, Math.ceil(maxNameLen * 0.62) + 1);
  const halfHcells = Math.ceil((rows + 1) / 2) + 1;
  const topCols = Math.max(top.length, bottom.length);
  const halfW = Math.max(halfWcells, Math.ceil((topCols + 1) / 2) + 1);

  const pinLen = lenCells * GRID;
  const bodyHalfW = halfW * GRID;
  const bodyHalfH = halfHcells * GRID;
  // 画布留白：容纳管脚线与名字
  const pad = pinLen + GRID;
  const W = (bodyHalfW + pad) * 2;
  const H = (bodyHalfH + pad) * 2;
  const CX = W / 2, CY = H / 2;

  const outPins: ParsedSymbol['pins'] = [];
  const push = (p: CustomPin, tipX: number, tipY: number, endX: number, endY: number, dir: 'L' | 'R' | 'U' | 'D') => {
    // 名字在本体内侧、脚号在管脚线上方
    const nameOff = 1.4;
    const nameX = dir === 'R' ? endX + nameOff : dir === 'L' ? endX - nameOff : endX;
    const nameY = dir === 'D' ? endY + 2.6 : dir === 'U' ? endY - 1.4 : endY + 1.1;
    outPins.push({
      tipX, tipY, endX, endY,
      name: p.name || '', number: String(p.num),
      nameX, nameY,
      numX: (tipX + endX) / 2, numY: (tipY + endY) / 2 - 1,
    });
  };

  const yTop = CY - (halfHcells - 1) * GRID;
  left.forEach((p, i) => {
    const y = yTop + i * GRID;
    push(p, CX - bodyHalfW - pinLen, y, CX - bodyHalfW, y, 'R');
  });
  right.forEach((p, i) => {
    const y = yTop + i * GRID;
    push(p, CX + bodyHalfW + pinLen, y, CX + bodyHalfW, y, 'L');
  });
  const spread = (n: number) => Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * 2 * GRID);
  const tx = spread(top.length), bx = spread(bottom.length);
  top.forEach((p, i) => {
    const x = CX + tx[i];
    push(p, x, CY - bodyHalfH - pinLen, x, CY - bodyHalfH, 'D');
  });
  bottom.forEach((p, i) => {
    const x = CX + bx[i];
    push(p, x, CY + bodyHalfH + pinLen, x, CY + bodyHalfH, 'U');
  });

  return {
    w: W, h: H,
    rects: [{ x: CX - bodyHalfW, y: CY - bodyHalfH, w: bodyHalfW * 2, h: bodyHalfH * 2 }],
    polys: [],
    circles: [],
    pins: outPins,
  };
}

/** 供 UI 展示：各边分到几个脚（便于用户核对分类是否合理） */
export function symbolSideSummary(pins: CustomPin[]): { left: number; right: number; top: number; bottom: number } {
  const s = classifyPins(pins);
  return { left: s.left.length, right: s.right.length, top: s.top.length, bottom: s.bottom.length };
}
