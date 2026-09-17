/**
 * design-core/geometry/kicad-name-parser.ts
 * KiCad 封装名解析器 —— 从标准 KiCad 封装命名中解析出参数化真实焊盘。
 *
 * ezPLM 返回的封装名遵循 KiCad 库命名规范，名字里编码了全部关键几何：
 *   TSSOP-20_4.4x6.5mm_P0.65mm          → 双列 20脚 本体4.4×6.5 间距0.65
 *   ST_UFQFPN-20_3x3mm_P0.5mm           → 四边 20脚 本体3×3 间距0.5
 *   ST_WLCSP-12_1.70x1.42mm_P0.35mm     → 球栅 12球 本体1.70×1.42 间距0.35
 *   R_0402_1005Metric / C_0603_...      → 片式阻容
 *   PinHeader_2x05_P2.54mm              → 排针 2×5
 *   SOT-23-5 / SOT-223 / SOD-123        → 小外形三极管/二极管
 *
 * 焊盘尺寸按 IPC 风格近似（预布局精度足够；正式制造用 KiCad 打开导出的
 * .kicad_pcb 后可替换为库中精确封装）。
 */
import type { PadFootprint, Pad } from './pad-types';

const num = (s: string | undefined) => (s ? parseFloat(s) : undefined);

/** 从名字提取通用参数 */
function extract(name: string) {
  const body = name.match(/(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)mm/i);
  const pitch = num(name.match(/P(\d+(?:\.\d+)?)mm/i)?.[1]);
  const pins = num(name.match(/-(\d+)(?:[_-]|$)/)?.[1]);
  return { bodyW: num(body?.[1]), bodyH: num(body?.[2]), pitch, pins };
}

/** 双列（左右两排）：TSSOP/SSOP/SOIC/SOP/MSOP/SO-8 等 */
function dualRowPads(pins: number, pitch: number, bodyW: number, bodyH: number): PadFootprint {
  // 奇数脚（如 SOP-5 这类非常规双列件）：左列多一个，与 KiCad 的编号习惯一致
  // ——沿左列自上而下 1..ceil，再沿右列自下而上继续。绝不凑成偶数补出不存在的焊盘。
  const left = Math.ceil(pins / 2);
  const right = pins - left;
  const padLen = 1.2;
  const padW = Math.max(0.25, Math.min(0.6 * pitch, pitch - 0.2));
  const rowGap = bodyW + padLen; // 焊盘中心列距
  const rows = Math.max(left, right);
  const y0 = -((rows - 1) * pitch) / 2;
  const pads: Pad[] = [];
  for (let i = 0; i < left; i++) pads.push({ x: -rowGap / 2, y: y0 + i * pitch, w: padLen, h: padW, num: i + 1 });
  // 右列自下而上；数量少于左列时居中对齐，避免顶部悬空
  const rOff = (rows - right) / 2;
  for (let i = 0; i < right; i++) {
    pads.push({ x: rowGap / 2, y: y0 + (rows - 1 - rOff - i) * pitch, w: padLen, h: padW, num: left + i + 1 });
  }
  return { bodyW, bodyH, pads, pin1: { x: -rowGap / 2, y: y0 - pitch * 0.6 } };
}

/** 四边：LQFP/TQFP/QFP（鸥翼外伸）与 QFN/UFQFPN/VFQFPN/DFN（贴边）。
 *  长方形本体按边长比例分配引脚数（如 QFP-128 14×20 → 短边26 + 长边38），并校验跨度不超边长。 */
function quadPads(pins: number, pitch: number, bodyW: number, bodyH: number, noLead: boolean): PadFootprint {
  const half = pins / 2;
  // 每对边的引脚数按边长比例分配；再校正保证 (n-1)*pitch ≤ 边长-1（留边距）
  let nY = Math.round((half * bodyH) / (bodyW + bodyH)); // 左/右各 nY（沿 H 分布）
  let nX = half - nY;                                     // 上/下各 nX（沿 W 分布）
  const fits = (n: number, dim: number) => (n - 1) * pitch <= dim - 0.8;
  while (nY > 1 && !fits(nY, bodyH)) { nY--; nX++; }
  while (nX > 1 && !fits(nX, bodyW)) { nX--; nY++; }
  const padLen = noLead ? 0.8 : 1.2;
  const padW = Math.max(0.22, Math.min(0.6 * pitch, pitch - 0.15));
  const cxL = noLead ? bodyW / 2 - padLen / 2 + 0.3 : bodyW / 2 + padLen / 2;
  const cyT = noLead ? bodyH / 2 - padLen / 2 + 0.3 : bodyH / 2 + padLen / 2;
  const spanY = (nY - 1) * pitch, spanX = (nX - 1) * pitch;
  const pads: Pad[] = [];
  let n = 1;
  for (let i = 0; i < nY; i++) pads.push({ x: -cxL, y: -spanY / 2 + i * pitch, w: padLen, h: padW, num: n++ }); // 左，上→下
  for (let i = 0; i < nX; i++) pads.push({ x: -spanX / 2 + i * pitch, y: cyT, w: padW, h: padLen, num: n++ }); // 下，左→右
  for (let i = 0; i < nY; i++) pads.push({ x: cxL, y: spanY / 2 - i * pitch, w: padLen, h: padW, num: n++ }); // 右，下→上
  for (let i = 0; i < nX; i++) pads.push({ x: spanX / 2 - i * pitch, y: -cyT, w: padW, h: padLen, num: n++ }); // 上，右→左
  return { bodyW, bodyH, pads, pin1: { x: -cxL - 0.4, y: -spanY / 2 - 0.4 } };
}

/** JEDEC/KiCad 常见 BGA 行字母：跳过 I O Q S X Z（避免与数字/其它字母混淆） */
const BGA_ROW_LETTERS = 'ABCDEFGHJKLMNPRTUVWY'.split('');
export function bgaRowLetter(row: number): string {
  // 行数超出单字母范围时按 AA/AB… 续排（JEDEC 双字母惯例）
  const L = BGA_ROW_LETTERS.length;
  if (row < L) return BGA_ROW_LETTERS[row];
  return BGA_ROW_LETTERS[Math.floor(row / L) - 1] + BGA_ROW_LETTERS[row % L];
}

/**
 * 球栅（WLCSP/BGA）：按本体与间距铺球，近似矩形阵列。
 * 球号使用真实 BGA 命名 A1/A2/…/B1/B2…（行字母跳过 I O Q S X Z）。
 *
 * ⚠️ 诚实标注：由 body size + pitch + pinCount 推出的 ball map 只是**近似**
 * （真实 BGA 常有中央空腔/去球），此 footprint 只能算 CANDIDATE/PLACEHOLDER，
 * 不能视为 VERIFIED；有 datasheet ball map 或官方 KiCad footprint 时优先用真实数据。
 */
function ballGridPads(pins: number, pitch: number, bodyW: number, bodyH: number): PadFootprint {
  const cols = Math.max(2, Math.round(bodyW / pitch));
  const rows = Math.max(2, Math.ceil(pins / cols));
  const d = Math.max(0.15, 0.55 * pitch);
  const x0 = -((cols - 1) * pitch) / 2, y0 = -((rows - 1) * pitch) / 2;
  const pads: Pad[] = [];
  let n = 0;
  for (let r = 0; r < rows && n < pins; r++) for (let c = 0; c < cols && n < pins; c++) {
    pads.push({ x: x0 + c * pitch, y: y0 + r * pitch, w: d, h: d, num: `${bgaRowLetter(r)}${c + 1}`, round: true });
    n++;
  }
  return { bodyW, bodyH, pads, pin1: { x: x0, y: y0 }, approximate: true };
}

/** 排针/排母：PinHeader_2x05_P2.54mm */
function headerPads(cols: number, rows: number, pitch: number): PadFootprint {
  const pads: Pad[] = [];
  const x0 = -((cols - 1) * pitch) / 2, y0 = -((rows - 1) * pitch) / 2;
  let n = 1;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    pads.push({ x: x0 + c * pitch, y: y0 + r * pitch, w: 1.7, h: 1.7, num: n++, round: true });
  }
  return { bodyW: cols * pitch, bodyH: rows * pitch, pads, pin1: { x: x0, y: y0 } };
}

/** SOT-23 家族标准落点。
 *  SOT-23-3：左2右1；SOT-23-5：左3(1,2,3 上→下) + 右2 在【外侧两格】(4 下、5 上，中间空)；
 *  SOT-23-6：左右各3；SOT-23-8(TSOT)：左右各4。 */
function sot23(variant: number): PadFootprint {
  if (variant === 3) {
    return { bodyW: 2.9, bodyH: 1.3, pads: [
      { x: -0.95, y: 1.1, w: 0.9, h: 0.8, num: 1 }, { x: 0.95, y: 1.1, w: 0.9, h: 0.8, num: 2 }, { x: 0, y: -1.1, w: 0.9, h: 0.8, num: 3 },
    ], pin1: { x: -0.95, y: 1.6 } };
  }
  const per = Math.ceil(variant / 2);
  const pitch = 0.95;
  const y0 = -((per - 1) * pitch) / 2;
  const pads: Pad[] = [];
  // 左列：1..per 上→下
  for (let i = 0; i < per; i++) pads.push({ x: -1.3, y: y0 + i * pitch, w: 1.0, h: 0.6, num: i + 1 });
  // 右列：下→上编号；奇数脚(如5脚)时右侧只占【外侧】格位，中间空
  const rightN = variant - per;
  const rightSlots = rightN === per ? Array.from({ length: per }, (_, i) => i)
    : [0, per - 1].slice(0, rightN); // 5脚 → 槽位 0(上) 和 per-1(下)
  // 编号从下往上：pin per+1 在最下
  rightSlots.sort((a, b) => b - a); // 下→上
  rightSlots.forEach((slot, k) => pads.push({ x: 1.3, y: y0 + slot * pitch, w: 1.0, h: 0.6, num: per + k + 1 }));
  return { bodyW: 1.6, bodyH: 2.9, pads, pin1: { x: -1.3, y: y0 - 0.6 } };
}

/** 片式两端（阻容感/二极管）：按公制/英制代号 */
const CHIP_SIZES: Record<string, [number, number]> = {
  '0201': [0.6, 0.3], '0402': [1.0, 0.5], '0603': [1.6, 0.8], '0805': [2.0, 1.25], '1206': [3.2, 1.6], '1210': [3.2, 2.5], '2512': [6.3, 3.2],
};
function chipPads(code: string): PadFootprint | null {
  const size = CHIP_SIZES[code];
  if (!size) return null;
  const [w, h] = size;
  const padW = w * 0.45, gap = w * 0.55;
  return { bodyW: w, bodyH: h, pads: [
    { x: -(gap / 2 + padW / 2), y: 0, w: padW, h: h * 1.1, num: 1 },
    { x: gap / 2 + padW / 2, y: 0, w: padW, h: h * 1.1, num: 2 },
  ] };
}

/** 主入口：解析 KiCad 封装名 → 参数化焊盘；不认识返回 null */
export function parseKicadFootprintName(name: string): PadFootprint | null {
  const N = name.toUpperCase();
  const { bodyW, bodyH, pitch, pins } = extract(name);

  /**
   * 测试点 / 定位孔 / 安装件：单焊盘或无焊盘，绝不是"默认两脚"。
   * TestPoint_Pad_D1.0mm = 一个 φ1.0 圆形 SMD 焊盘；TestPoint_THTPad_D1.5mm_Drill0.7mm = 单个插装盘。
   * 此前落到默认分支，画成两脚方块，和 KiCad 工程对不上。
   */
  const tpSmd = N.match(/^TESTPOINT_PAD_D(\d+(?:\.\d+)?)MM/);
  if (tpSmd) {
    const d = parseFloat(tpSmd[1]);
    return { bodyW: d, bodyH: d, pads: [{ num: '1', x: 0, y: 0, w: d, h: d, round: true }] };
  }
  const tpTht = N.match(/^TESTPOINT_THTPAD_D(\d+(?:\.\d+)?)MM/);
  if (tpTht) {
    const d = parseFloat(tpTht[1]);
    return { bodyW: d, bodyH: d, pads: [{ num: '1', x: 0, y: 0, w: d, h: d, round: true }] };
  }
  // 环形/方形测试点、探针垫：同样单盘
  if (/^TESTPOINT/.test(N)) {
    return { bodyW: 1.5, bodyH: 1.5, pads: [{ num: '1', x: 0, y: 0, w: 1.5, h: 1.5, round: true }] };
  }
  // 定位孔：没有电气焊盘（MountingHole_3.2mm_M3 这类）
  if (/^MOUNTINGHOLE/.test(N)) {
    const d = parseFloat(N.match(/MOUNTINGHOLE_(\d+(?:\.\d+)?)MM/)?.[1] ?? '3.2');
    return { bodyW: d, bodyH: d, pads: [] };
  }

  // 片式阻容感/二极管：R_0402_1005Metric / C_0603 / L_0805 / D_1206
  const chip = N.match(/^(?:[RCLD]|LED|FB)_(\d{4})(?:_|$)/);
  if (chip) return chipPads(chip[1]);
  // 纯代号（内置库兜底之外的 0805 等）
  if (/^\d{4}$/.test(N)) return chipPads(N);

  // 排针/排母：PinHeader_2x05_P2.54mm
  const hdr = N.match(/PIN(?:HEADER|SOCKET)_(\d+)X(\d+)_P(\d+(?:\.\d+)?)MM/);
  if (hdr) return headerPads(parseInt(hdr[1]), parseInt(hdr[2]), parseFloat(hdr[3]));

  // SOT 家族
  const sot = N.match(/SOT-?23-?(\d)?/);
  if (sot && !N.includes('SOT-223')) return sot23(sot[1] ? parseInt(sot[1]) : 3);
  // SC-70 / SOT-353(5脚) / SOT-363(6脚)：与 SOT-23 同族，尺寸更小
  const sc70 = N.match(/SC-?70-?(\d)|SOT-?35(3)|SOT-?36(3)/);
  if (sc70) {
    const n = sc70[1] ? parseInt(sc70[1]) : (sc70[2] ? 5 : 6);
    const base = sot23(n);
    // SC-70 本体约为 SOT-23 的 65%
    const k = 0.65;
    return {
      bodyW: +(base.bodyW * k).toFixed(2), bodyH: +(base.bodyH * k).toFixed(2),
      pads: base.pads.map((pd) => ({ ...pd, x: +(pd.x * k).toFixed(3), y: +(pd.y * k).toFixed(3), w: +(pd.w * k).toFixed(3), h: +(pd.h * k).toFixed(3) })),
      pin1: base.pin1 ? { x: base.pin1.x * k, y: base.pin1.y * k } : undefined,
    };
  }
  // SOT-89（3 脚，中间脚带散热片）
  if (/SOT-?89/.test(N)) {
    return { bodyW: 4.5, bodyH: 4.0, pads: [
      { x: -1.5, y: 1.6, w: 1.2, h: 1.4, num: 1 },
      { x: 0, y: 1.6, w: 1.2, h: 1.4, num: 2 },
      { x: 1.5, y: 1.6, w: 1.2, h: 1.4, num: 3 },
      { x: 0, y: -1.4, w: 3.4, h: 1.8, num: 2 },   // 中间脚与散热片相连
    ], pin1: { x: -1.5, y: 2.6 } };
  }
  // TO-252(DPAK) / TO-263(D2PAK)：3 脚 + 大散热焊盘
  const dpak = N.match(/TO-?(252|263)-?(\d)?/);
  if (dpak) {
    const big = dpak[1] === '263';
    const n = dpak[2] ? parseInt(dpak[2]) : 2;
    const sp = big ? 2.54 : 2.28;
    const pads = [] as PadFootprint['pads'];
    const lead = n >= 3 ? [-1, 0, 1] : [-1, 1];
    lead.forEach((k, i) => pads.push({ x: k * sp, y: big ? 4.6 : 3.2, w: big ? 1.6 : 1.2, h: big ? 2.2 : 1.8, num: i + 1 }));
    pads.push({ x: 0, y: big ? -1.6 : -1.1, w: big ? 10.2 : 6.2, h: big ? 9.1 : 6.2, num: lead.length + 1 });
    return { bodyW: big ? 10.4 : 6.5, bodyH: big ? 12 : 9, pads, pin1: { x: lead[0] * sp, y: big ? 5.9 : 4.3 } };
  }
  // TO-220 / TO-247：插件功率器件，2.54mm 直插
  const to220 = N.match(/TO-?(220|247)-?(\d)?/);
  if (to220) {
    const n = to220[2] ? parseInt(to220[2]) : 3;
    const sp = to220[1] === '247' ? 5.45 : 2.54;
    const pads = Array.from({ length: n }, (_, i) => ({
      x: (i - (n - 1) / 2) * sp, y: 0, w: 1.8, h: 1.8, num: i + 1, round: true,
    }));
    return { bodyW: to220[1] === '247' ? 15.9 : 10.2, bodyH: to220[1] === '247' ? 21 : 15, pads, pin1: { x: pads[0].x, y: -1.6 } };
  }
  if (N.includes('SOT-223')) {
    return { bodyW: 6.5, bodyH: 3.5, pads: [
      { x: -2.3, y: 2.7, w: 1.2, h: 1.6, num: 1 }, { x: 0, y: 2.7, w: 1.2, h: 1.6, num: 2 }, { x: 2.3, y: 2.7, w: 1.2, h: 1.6, num: 3 },
      { x: 0, y: -2.7, w: 3.6, h: 1.6, num: 4 },
    ], pin1: { x: -2.3, y: 3.6 } };
  }
  // SOD 二极管
  if (/SOD-?123/.test(N)) return { bodyW: 2.7, bodyH: 1.6, pads: [{ x: -1.75, y: 0, w: 0.9, h: 1.2, num: 1 }, { x: 1.75, y: 0, w: 0.9, h: 1.2, num: 2 }], pin1: { x: -2.2, y: 0 } };
  if (/SOD-?323/.test(N)) return { bodyW: 1.7, bodyH: 1.25, pads: [{ x: -1.05, y: 0, w: 0.7, h: 0.6, num: 1 }, { x: 1.05, y: 0, w: 0.7, h: 0.6, num: 2 }], pin1: { x: -1.4, y: 0 } };

  // 四边无引脚 QFN（含长方形本体）；DFN/SON 本身是双列封装
  if (/(U|V|HV|W)?QFN/.test(N) && pins && pitch && bodyW && bodyH && pins % 4 === 0) {
    return quadPads(pins, pitch, bodyW, bodyH, true);
  }
  if (/(DFN|SON)/.test(N) && pins && pitch && bodyW && bodyH && pins % 2 === 0) {
    return dualRowPads(pins, pitch, bodyW, bodyH);
  }
  // 四边鸥翼：LQFP / TQFP / QFP
  if (/(L|T)?QFP/.test(N) && pins && pitch && bodyW && bodyH && pins % 4 === 0) {
    return quadPads(pins, pitch, bodyW, bodyH, false);
  }
  // 球栅：WLCSP / BGA / CSP
  if (/(WLCSP|BGA|CSP)/.test(N) && pins && pitch && bodyW && bodyH) {
    return ballGridPads(pins, pitch, bodyW, bodyH);
  }
  // 双列鸥翼：TSSOP / SSOP / MSOP / HTSSOP / SOIC / SOP / SO-N
  if (/(TSSOP|SSOP|MSOP|HTSSOP|SOIC|SOP|SO)-?\d+/.test(N) && pins && pitch && bodyW && bodyH) {
    // 引脚沿长边分布：若名字给的 W > H，交换使排列方向正确
    return bodyH >= bodyW ? dualRowPads(pins, pitch, bodyW, bodyH) : dualRowPads(pins, pitch, bodyH, bodyW);
  }
  // 兜底：有 pins+pitch+body 的双列
  if (pins && pitch && bodyW && bodyH && pins % 2 === 0 && pins <= 64) {
    return bodyH >= bodyW ? dualRowPads(pins, pitch, bodyW, bodyH) : dualRowPads(pins, pitch, bodyH, bodyW);
  }
  return null;
}
