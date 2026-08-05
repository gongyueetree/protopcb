/**
 * modules/schematic/symbols.tsx
 * KiCad 风格原理图符号 —— 按器件类别/族绘制标准符号。
 * 视觉贴近 KiCad 符号库（电阻锯齿、电容双板、LDO 三端、IC 带引脚名等）。
 * 正式版可由 ezPLM 返回 .kicad_sym 解析结果替换，接口保持「给定器件 → 返回符号图元」。
 */
import type { PlacedComponent } from '../../design-core/document/types';
import { padFootprintFor as padFootprintForSym } from '../../design-core/geometry/footprint-pads';
import { symbolOverrideFor, symbolUnitsOverrideFor, type ParsedSymbol , ensureKicadSymbol} from '../../design-core/geometry/lib-file-registry';

const STROKE = '#334155';
const PIN = '#7c2d12';
const FILL = '#fffef7';

export interface SymbolDef {
  /** 符号包围盒（相对锚点左上角） */
  w: number;
  h: number;
  /** 连接端口（相对符号左上角），供连线吸附 */
  ports: { x: number; y: number; name?: string }[];
  /** 引脚桩长度：连线端点 = 端口沿外法线延伸 stubLen。
   *  画了引脚桩的符号（IC/稳压器等）为 10；无源符号图形即引脚，为 0。 */
  stubLen?: number;
  render: (refDes: string, label: string) => React.ReactNode;
}

/** 电阻：KiCad 锯齿符号 */
/** 二极管：三角+竖线；LED 追加两支出射箭头 */
function diode(isLed = false): SymbolDef {
  const w = 60, h = 20;
  return {
    w, h, ports: [{ x: 0, y: 10 }, { x: 60, y: 10 }], stubLen: 0,
    render: (ref, label) => (
      <g>
        <line x1={0} y1={10} x2={24} y2={10} stroke={STROKE} strokeWidth={1.5} />
        <path d="M24,2 L36,10 L24,18 Z" fill="none" stroke={STROKE} strokeWidth={1.8} strokeLinejoin="round" />
        <line x1={36} y1={2} x2={36} y2={18} stroke={STROKE} strokeWidth={2.2} />
        <line x1={36} y1={10} x2={60} y2={10} stroke={STROKE} strokeWidth={1.5} />
        {isLed && (
          <g stroke={STROKE} strokeWidth={1.2}>
            <path d="M30,-1 L36,-7 M36,-7 L32.5,-6 M36,-7 L35,-3.5" fill="none" />
            <path d="M36,1 L42,-5 M42,-5 L38.5,-4 M42,-5 L41,-1.5" fill="none" />
          </g>
        )}
        <text x={w / 2} y={isLed ? -12 : -4} textAnchor="middle" fontSize={9} fontWeight={700} fill="#0e7490" fontFamily="monospace">{ref}</text>
        <text x={w / 2} y={h + 10} textAnchor="middle" fontSize={8} fill="#334155" fontFamily="monospace">{label}</text>
      </g>
    ),
  };
}

function resistor(): SymbolDef {
  const w = 60, h = 20;
  const zig = 'M0,10 L8,10 L12,3 L20,17 L28,3 L36,17 L44,3 L48,10 L60,10';
  return {
    w, h, ports: [{ x: 0, y: 10 }, { x: 60, y: 10 }], stubLen: 0,
    render: (ref, label) => (
      <g>
        <path d={zig} fill="none" stroke={STROKE} strokeWidth={1.5} />
        <text x={w / 2} y={-4} textAnchor="middle" fontSize={9} fontWeight={700} fill="#0e7490" fontFamily="monospace">{ref}</text>
        <text x={w / 2} y={h + 12} textAnchor="middle" fontSize={8} fill="#334155" fontFamily="monospace">{label}</text>
      </g>
    ),
  };
}

/** 电容：两平行板 */
function capacitor(): SymbolDef {
  const w = 60, h = 20;
  return {
    w, h, ports: [{ x: 0, y: 10 }, { x: 60, y: 10 }], stubLen: 0,
    render: (ref, label) => (
      <g>
        <line x1={0} y1={10} x2={27} y2={10} stroke={STROKE} strokeWidth={1.5} />
        <line x1={27} y1={0} x2={27} y2={20} stroke={STROKE} strokeWidth={2.2} />
        <line x1={33} y1={0} x2={33} y2={20} stroke={STROKE} strokeWidth={2.2} />
        <line x1={33} y1={10} x2={60} y2={10} stroke={STROKE} strokeWidth={1.5} />
        <text x={w / 2} y={-4} textAnchor="middle" fontSize={9} fontWeight={700} fill="#0e7490" fontFamily="monospace">{ref}</text>
        <text x={w / 2} y={h + 10} textAnchor="middle" fontSize={8} fill="#334155" fontFamily="monospace">{label}</text>
      </g>
    ),
  };
}

/** 电感：四个半圆弧 */
function inductor(): SymbolDef {
  const w = 60, h = 20;
  const arc = 'M6,10 a6,6 0 0 1 12,0 a6,6 0 0 1 12,0 a6,6 0 0 1 12,0 a6,6 0 0 1 12,0';
  return {
    w, h, ports: [{ x: 0, y: 10 }, { x: 60, y: 10 }], stubLen: 0,
    render: (ref, label) => (
      <g>
        <line x1={0} y1={10} x2={6} y2={10} stroke={STROKE} strokeWidth={1.5} />
        <path d={arc} fill="none" stroke={STROKE} strokeWidth={1.5} />
        <line x1={54} y1={10} x2={60} y2={10} stroke={STROKE} strokeWidth={1.5} />
        <text x={w / 2} y={-4} textAnchor="middle" fontSize={9} fontWeight={700} fill="#0e7490" fontFamily="monospace">{ref}</text>
        <text x={w / 2} y={h + 10} textAnchor="middle" fontSize={8} fill="#334155" fontFamily="monospace">{label}</text>
      </g>
    ),
  };
}

/** LDO 稳压器：三端方框 IN / OUT / GND */
function regulator(): SymbolDef {
  const w = 100, h = 60;
  return {
    w, h, ports: [{ x: 0, y: 20, name: 'IN' }, { x: 100, y: 20, name: 'OUT' }, { x: 50, y: 60, name: 'GND' }],
    render: (ref, label) => (
      <g>
        <rect width={w} height={h} rx={2} fill={FILL} stroke={STROKE} strokeWidth={1.8} />
        {/* pins */}
        <line x1={-10} y1={20} x2={0} y2={20} stroke={PIN} strokeWidth={1.4} />
        <line x1={w} y1={20} x2={w + 10} y2={20} stroke={PIN} strokeWidth={1.4} />
        <line x1={50} y1={h} x2={50} y2={h + 10} stroke={PIN} strokeWidth={1.4} />
        <text x={6} y={24} fontSize={7} fill={PIN} fontFamily="monospace">IN</text>
        <text x={w - 6} y={24} textAnchor="end" fontSize={7} fill={PIN} fontFamily="monospace">OUT</text>
        <text x={53} y={h - 4} fontSize={7} fill={PIN} fontFamily="monospace">GND</text>
        <text x={w / 2} y={-4} textAnchor="middle" fontSize={9} fontWeight={700} fill="#0e7490" fontFamily="monospace">{ref}</text>
        <text x={w / 2} y={h / 2 + 3} textAnchor="middle" fontSize={9} fontWeight={600} fill="#334155" fontFamily="monospace">{label.length > 12 ? label.slice(0, 11) + '..' : label}</text>
      </g>
    ),
  };
}

/** IC / MCU：方框 + 左右引脚桩 + 引脚名 */
function ic(pinsPerSide: number, pinNames?: { left: string[]; right: string[] }): SymbolDef {
  const pitch = 20, pad = 10;
  const h = Math.max(60, pad * 2 + (pinsPerSide - 1) * pitch);
  const w = 120;
  // 名字为 '' 的槽位：不画引脚桩、不建端口（支持奇数脚数左右不对称，如 SOT-23-5）
  const hasL = (i: number) => !pinNames || !!pinNames.left[i];
  const hasR = (i: number) => !pinNames || !!pinNames.right[i];
  const ports: { x: number; y: number }[] = [];
  for (let i = 0; i < pinsPerSide; i++) {
    if (hasL(i)) ports.push({ x: 0, y: pad + i * pitch });
    if (hasR(i)) ports.push({ x: w, y: pad + i * pitch });
  }
  return {
    w, h, ports,
    render: (ref, label) => (
      <g>
        <rect width={w} height={h} rx={2} fill={FILL} stroke={STROKE} strokeWidth={1.8} />
        {Array.from({ length: pinsPerSide }).map((_, i) => (
          <g key={i}>
            {hasL(i) && <line x1={-10} y1={pad + i * pitch} x2={0} y2={pad + i * pitch} stroke={PIN} strokeWidth={1.4} />}
            {hasR(i) && <line x1={w} y1={pad + i * pitch} x2={w + 10} y2={pad + i * pitch} stroke={PIN} strokeWidth={1.4} />}
            {pinNames?.left[i] && <text x={4} y={pad + i * pitch + 3} fontSize={6.5} fill={PIN} fontFamily="monospace">{pinNames.left[i]}</text>}
            {pinNames?.right[i] && <text x={w - 4} y={pad + i * pitch + 3} textAnchor="end" fontSize={6.5} fill={PIN} fontFamily="monospace">{pinNames.right[i]}</text>}
          </g>
        ))}
        <text x={w / 2} y={-4} textAnchor="middle" fontSize={9} fontWeight={700} fill="#0e7490" fontFamily="monospace">{ref}</text>
        <text x={w / 2} y={h / 2 + 3} textAnchor="middle" fontSize={9} fontWeight={600} fill="#334155" fontFamily="monospace">{label.length > 14 ? label.slice(0, 12) + '..' : label}</text>
      </g>
    ),
  };
}

/** 连接器：方框 + 右侧引脚 */
function connector(pins: number): SymbolDef {
  const pitch = 20, pad = 10;
  const h = Math.max(60, pad * 2 + (pins - 1) * pitch);
  const w = 80;
  const ports = Array.from({ length: pins }).map((_, i) => ({ x: w, y: pad + i * pitch }));
  return {
    w, h, ports,
    render: (ref, label) => (
      <g>
        <rect width={w} height={h} rx={2} fill={FILL} stroke={STROKE} strokeWidth={1.8} />
        {Array.from({ length: pins }).map((_, i) => (
          <g key={i}>
            <line x1={w} y1={pad + i * pitch} x2={w + 10} y2={pad + i * pitch} stroke={PIN} strokeWidth={1.4} />
            <text x={w - 5} y={pad + i * pitch + 3} textAnchor="end" fontSize={6.5} fill={PIN} fontFamily="monospace">{i + 1}</text>
          </g>
        ))}
        <text x={w / 2} y={-4} textAnchor="middle" fontSize={9} fontWeight={700} fill="#0e7490" fontFamily="monospace">{ref}</text>
        <text x={w / 2} y={h / 2 + 3} textAnchor="middle" fontSize={8} fontWeight={600} fill="#334155" fontFamily="monospace">{label.length > 12 ? label.slice(0, 11) + '..' : label}</text>
      </g>
    ),
  };
}

/** 用户上传的自定义 SVG 符号：固定 90×50 框，左右各一端口（5 栅格） */
function customSvgSymbol(svg: string): SymbolDef {
  const w = 100, h = 60;
  const uri = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
  return {
    w, h, ports: [{ x: 0, y: 30 }, { x: 100, y: 30 }],
    render: (ref, label) => (
      <g>
        <line x1={-10} y1={30} x2={0} y2={30} stroke={PIN} strokeWidth={1.4} />
        <line x1={w} y1={30} x2={w + 10} y2={30} stroke={PIN} strokeWidth={1.4} />
        <image href={uri} x={0} y={0} width={w} height={h} preserveAspectRatio="xMidYMid meet" />
        <text x={w / 2} y={-4} textAnchor="middle" fontSize={9} fontWeight={700} fill="#0e7490" fontFamily="monospace">{ref}</text>
        <text x={w / 2} y={h + 12} textAnchor="middle" fontSize={8} fill="#334155" fontFamily="monospace">{label.length > 14 ? label.slice(0, 12) + '..' : label}</text>
      </g>
    ),
  };
}


/** ezPLM 真实 .kicad_sym 解析结果 → 符号（真实引脚名/编号，端口=引脚连接点，stubLen=0） */
function parsedSymbol(ps: ParsedSymbol): SymbolDef {
  return {
    w: ps.w, h: ps.h, stubLen: 0,
    ports: ps.pins.map((p) => ({ x: p.tipX, y: p.tipY, name: p.name })),
    render: (ref, label) => (
      <g>
        {ps.rects.map((r, i) => <rect key={'r' + i} x={r.x} y={r.y} width={r.w} height={r.h} rx={1} fill={FILL} stroke={STROKE} strokeWidth={1.6} />)}
        {ps.polys.map((d, i) => <path key={'p' + i} d={d} fill={FILL} stroke={STROKE} strokeWidth={1.6} strokeLinejoin="round" />)}
        {ps.circles.map((ci, i) => <circle key={'c' + i} cx={ci.x} cy={ci.y} r={ci.r} fill="none" stroke={STROKE} strokeWidth={1.4} />)}
        {ps.pins.map((p, i) => (
          <g key={i}>
            <line x1={p.tipX} y1={p.tipY} x2={p.endX} y2={p.endY} stroke={PIN} strokeWidth={1.3} />
            {p.name && <text x={p.nameX} y={p.nameY} textAnchor={p.endX >= p.tipX ? 'start' : 'end'} fontSize={6.5} fill={PIN} fontFamily="monospace">{p.name}</text>}
            {p.number && <text x={p.numX} y={p.numY} textAnchor="middle" fontSize={5.5} fill="#94a3b8" fontFamily="monospace">{p.number}</text>}
          </g>
        ))}
        <text x={ps.w / 2} y={-5} textAnchor="middle" fontSize={9} fontWeight={700} fill="#0e7490" fontFamily="monospace">{ref}</text>
        <text x={ps.w / 2} y={ps.h + 12} textAnchor="middle" fontSize={8} fill="#334155" fontFamily="monospace">{label.length > 18 ? label.slice(0, 16) + '..' : label}</text>
      </g>
    ),
  };
}

/** 根据器件选符号 */
export function symbolFor(c: PlacedComponent): SymbolDef {
  if (c.customSymbolSvg) return customSvgSymbol(c.customSymbolSvg);
  // ezPLM 真实符号文件解析结果优先（真实引脚名）
  const symKey = c.display?.symbolFromMpn ?? c.mpn; // 仅关联符号时借用库中型号的符号
  ensureKicadSymbol(symKey); // KICADSYM: 前缀且内存缺失时自动重拉（刷新/导入后自愈）
  // 封装占位器件：没有真实管脚定义，画电阻/IC 都是误导 —— 显式空态，引导去关联
  if (c.display?.family === 'Footprint' && !c.customSymbolSvg && !symbolOverrideFor(symKey)) {
    return unlinkedSymbol();
  }
  const parsed = symbolOverrideFor(symKey);
  if (parsed) return parsedSymbol(parsed);
  // ezPLM 实时物料：族/引脚名未知，按真实引脚数生成编号符号（不套内置模板）
  if (c.componentId.startsWith('ez_') && c.category !== 'passive') {
    const pinCount = c.display?.pins ?? padFootprintForSym(c.footprint.name)?.pads.length ?? 6;
    const leftN = Math.min(12, Math.ceil(pinCount / 2));
    const rightN = Math.min(12, pinCount - Math.ceil(pinCount / 2));
    const per = Math.max(leftN, rightN, 2);
    const left = Array.from({ length: per }, (_, i) => (i < leftN ? String(i + 1) : ''));
    // 右列自下而上编号：leftN+1 在最下
    const right = Array.from({ length: per }, (_, i) => (i < rightN ? String(pinCount - i) : ''));
    if (pinCount > 24) { left[per - 1] = '…'; right[per - 1] = right[per - 1] ? '…' : ''; }
    return ic(per, { left, right });
  }
  const fam = c.display?.family ?? '';
  if (c.category === 'passive') {
    if (fam === 'MLCC' || fam.includes('Cap')) return capacitor();
    if (fam.includes('Induct')) return inductor();
    if (fam === 'LED') return diode(true);
    if (fam === 'Diode') return diode();
    return resistor();
  }
  if (c.category === 'power') {
    if (fam === 'LDO') return regulator();
    return regulator(); // Buck 也用三端框（简化）
  }
  if (c.category === 'connector') {
    if (fam.includes('USB')) return connector(4);
    return connector(Math.min(6, Math.max(2, Math.ceil((c.display?.pins ?? 4) / 2))));
  }
  // mcu / ic
  if (c.category === 'mcu') {
    return ic(4, { left: ['VDD', 'GND', 'PA0', 'PA1'], right: ['SWD', 'TX', 'RX', 'RST'] });
  }
  if (fam.includes('USB-UART') || fam.includes('UART')) {
    return ic(3, { left: ['VCC', 'D+', 'D-'], right: ['TXD', 'RXD', 'GND'] });
  }
  if (fam.includes('Flash')) {
    return ic(3, { left: ['CS', 'CLK', 'DI'], right: ['DO', 'VCC', 'GND'] });
  }
  if (fam.includes('CAN')) {
    return ic(3, { left: ['TXD', 'RXD', 'VCC'], right: ['CANH', 'CANL', 'GND'] });
  }
  // ezPLM 实时物料 / 未知族：按真实引脚数生成（引脚号 1..N 分左右两列）
  // 真实引脚名需解析器件的 symbol 符号文件，当前接口未提供文件内容，先以编号呈现
  const pinCount = c.display?.pins ?? padFootprintForSym(c.footprint.name)?.pads.length ?? 6;
  const leftN = Math.min(12, Math.ceil(pinCount / 2));
  const rightN = Math.min(12, pinCount - Math.ceil(pinCount / 2));
  const per = Math.max(leftN, rightN, 2);
  const left = Array.from({ length: per }, (_, i) => (i < leftN ? String(i + 1) : ''));
  const right = Array.from({ length: per }, (_, i) => (i < rightN ? String(pinCount - i) : ''));
  if (pinCount > 24) { left[per - 1] = '…'; right[per - 1] = right[per - 1] ? '…' : ''; }
  return ic(per, { left, right });
}

/** 多单元符号拆分：LM358 等返回 [运放A, 运放B, 电源] 各自独立的 SymbolDef；普通器件返回单元素数组 */
export function symbolUnitsFor(c: PlacedComponent): SymbolDef[] {
  if (!c.customSymbolSvg) {
    const units = symbolUnitsOverrideFor(c.display?.symbolFromMpn ?? c.mpn);
    if (units && units.length > 1) return units.map(parsedSymbol);
  }
  return [symbolFor(c)];
}

/** 未关联符号的占位：虚线框 + 提示（在详情面板关联 ezPLM / KiCad 符号 / 创建后替换） */
function unlinkedSymbol(): SymbolDef {
  const w = 120, h = 50;
  return {
    w, h, ports: [], stubLen: 0,
    render: (ref) => (
      <g>
        <rect x={0} y={0} width={w} height={h} rx={6} fill="#f8fafc" stroke="#cbd5e1" strokeWidth={1.2} strokeDasharray="5 4" />
        <text x={w / 2} y={h / 2 - 4} textAnchor="middle" fontSize={9} fill="#94a3b8">{'\u672a\u5173\u8054\u7b26\u53f7'}</text>
        <text x={w / 2} y={h / 2 + 8} textAnchor="middle" fontSize={7.5} fill="#cbd5e1">{'\u5728\u53f3\u4fa7\u5173\u8054\u5668\u4ef6 / \u7b26\u53f7'}</text>
        <text x={w / 2} y={-4} textAnchor="middle" fontSize={9} fontWeight={700} fill="#0e7490" fontFamily="monospace">{ref}</text>
      </g>
    ),
  };
}
