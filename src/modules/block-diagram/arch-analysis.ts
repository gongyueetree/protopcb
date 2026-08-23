/**
 * 系统框图的 AI 架构分析。
 *
 * 原实现只按 category 分组（"外设IC"/"接口"），看不出这块板到底在做什么。
 * 这里把器件清单 + 电气网络名交给模型，让它识别真实的功能子系统与信号流：
 *   - 网络名是极强的线索（/CLK、/SPI_MISO、+3V3、USB_DP…）
 *   - 位号 + 型号 + 封装能定位主控、电源链、模拟前端、接口
 * 输出：功能块（含成员位号）+ 块间连接（含信号名与方向）。
 */
import { geminiComplete, extractJson, geminiAvailable } from '../../providers/gemini';
import { curLang } from '../../shared/i18n';
import type { CircuitCanvasDocument } from '../../design-core/document/types';

export interface ArchBlock {
  id: string;
  label: string;
  /** 该块的职责，一句话 */
  role: string;
  /** 归属该块的器件位号 */
  refs: string[];
  kind: 'mcu' | 'power' | 'analog' | 'rf' | 'interface' | 'memory' | 'sensor' | 'clock' | 'protection' | 'other';
}

export interface ArchEdge {
  from: string;
  to: string;
  /** 信号或总线名（SPI / I2C / USB / +3V3 …） */
  signal: string;
  kind: 'power' | 'digital' | 'analog' | 'clock' | 'bus';
}

export interface ArchResult {
  blocks: ArchBlock[];
  edges: ArchEdge[];
  /** 对整块板功能的总体判断 */
  summary: string;
}

const KIND_COLORS: Record<ArchBlock['kind'], string> = {
  mcu: '#1a6b3c', power: '#b45309', analog: '#0e7490', rf: '#7c3aed',
  interface: '#6d28d9', memory: '#0369a1', sensor: '#059669',
  clock: '#a16207', protection: '#dc2626', other: '#4b5563',
};

export function colorForKind(k: ArchBlock['kind']): string {
  return KIND_COLORS[k] ?? KIND_COLORS.other;
}

/** 汇总送模型的工程摘要：控制体积，同时保留判别力最强的信息 */
function buildDigest(doc: CircuitCanvasDocument): string {
  const lines: string[] = [];
  // 有源器件逐个列出（这些决定架构）
  const active = doc.components.filter((c) => c.category !== 'passive');
  for (const c of active.slice(0, 60)) {
    const pins = c.display?.pins ? `${c.display.pins}脚` : '';
    lines.push(`${c.reference}\t${c.mpn}\t${c.footprint.name}\t${pins}\t${c.display?.description ?? ''}`.trim());
  }
  // 无源器件按类别计数即可
  const passive = doc.components.filter((c) => c.category === 'passive');
  if (passive.length) {
    const byPrefix = new Map<string, number>();
    for (const c of passive) {
      const p = c.reference.match(/^[A-Za-z]+/)?.[0] ?? '?';
      byPrefix.set(p, (byPrefix.get(p) ?? 0) + 1);
    }
    lines.push(`无源器件统计：${[...byPrefix].map(([k, v]) => `${k}×${v}`).join(' ')}`);
  }
  // 网络名：架构判断的关键线索，去掉自动命名的 Net-(…)
  const nets = Object.values(doc.nets ?? {})
    .filter((n) => n && !/^Net-\(/.test(n))
    .slice(0, 80);
  if (nets.length) lines.push(`命名网络：${nets.join(', ')}`);
  return lines.join('\n');
}

export async function analyzeArchitecture(doc: CircuitCanvasDocument): Promise<ArchResult> {
  if (!(await geminiAvailable())) throw new Error('未配置 Gemini（GEMINI_API_KEY）');
  const active = doc.components.filter((c) => c.category !== 'passive');
  if (active.length < 2) throw new Error('画布上有源器件太少，不足以分析架构');

  const en = curLang() === 'en';
  const raw = await geminiComplete(
    (en ? 'Answer in English: all labels, roles and the summary must be in English.\n' : '') +
    `你是硬件架构师。下面是一块 PCB 的器件清单与电气网络名，请分析它的系统架构。\n\n` +
    `${buildDigest(doc)}\n\n` +
    `要求：\n` +
    `1. 划分功能子系统（如"主控 MCU""USB 接口与保护""±3V 电源链""R-2R DAC 输出"），` +
    `不要简单按器件类别分组，要体现这块板实际在做什么\n` +
    `2. 每个块列出归属的器件位号（refs），位号必须来自上面清单\n` +
    `3. 给出块之间的连接：信号名尽量用清单里出现的网络名\n` +
    `4. summary 用一句话说明这块板的用途\n` +
    `严格输出 JSON，不要其它文字：\n` +
    `{"summary":"…","blocks":[{"id":"b1","label":"名称","role":"职责","kind":"mcu|power|analog|rf|interface|memory|sensor|clock|protection|other","refs":["U1","C1"]}],` +
    `"edges":[{"from":"b1","to":"b2","signal":"SPI","kind":"power|digital|analog|clock|bus"}]}`,
  );

  const parsed = extractJson<{ summary?: string; blocks?: Partial<ArchBlock>[]; edges?: Partial<ArchEdge>[] }>(raw);
  const validRefs = new Set(doc.components.map((c) => c.reference));

  const blocks: ArchBlock[] = (parsed.blocks ?? [])
    .filter((b) => b && b.label)
    .slice(0, 12)
    .map((b, i) => ({
      id: String(b.id ?? `b${i + 1}`),
      label: String(b.label).slice(0, 24),
      role: String(b.role ?? '').slice(0, 60),
      // 模型可能编造位号 —— 只保留画布上真实存在的
      refs: (b.refs ?? []).map(String).filter((r) => validRefs.has(r)),
      kind: (['mcu', 'power', 'analog', 'rf', 'interface', 'memory', 'sensor', 'clock', 'protection', 'other'] as const)
        .includes(b.kind as ArchBlock['kind']) ? (b.kind as ArchBlock['kind']) : 'other',
    }))
    .filter((b) => b.refs.length > 0);

  if (!blocks.length) throw new Error('未能从该工程识别出功能块');

  const ids = new Set(blocks.map((b) => b.id));
  const edges: ArchEdge[] = (parsed.edges ?? [])
    .filter((e) => e && ids.has(String(e.from)) && ids.has(String(e.to)) && e.from !== e.to)
    .slice(0, 24)
    .map((e) => ({
      from: String(e.from), to: String(e.to),
      signal: String(e.signal ?? '').slice(0, 20),
      kind: (['power', 'digital', 'analog', 'clock', 'bus'] as const).includes(e.kind as ArchEdge['kind'])
        ? (e.kind as ArchEdge['kind']) : 'digital',
    }));

  return { blocks, edges, summary: String(parsed.summary ?? '').slice(0, 200) };
}

/** 架构结果 → 画布功能块布局：主控居中，电源在上，接口在两侧，其余环绕 */
export function layoutArchBlocks(blocks: ArchBlock[]): Record<string, { x: number; y: number }> {
  const pos: Record<string, { x: number; y: number }> = {};
  const cx = 420, cy = 300;
  const mcu = blocks.filter((b) => b.kind === 'mcu');
  const power = blocks.filter((b) => b.kind === 'power');
  const iface = blocks.filter((b) => b.kind === 'interface' || b.kind === 'protection');
  const rest = blocks.filter((b) => !mcu.includes(b) && !power.includes(b) && !iface.includes(b));

  mcu.forEach((b, i) => { pos[b.id] = { x: cx, y: cy + i * 130 }; });
  power.forEach((b, i) => { pos[b.id] = { x: cx - 120 + i * 240, y: cy - 200 }; });
  iface.forEach((b, i) => { pos[b.id] = { x: cx - 300, y: cy - 80 + i * 130 }; });
  rest.forEach((b, i) => { pos[b.id] = { x: cx + 300, y: cy - 120 + i * 130 }; });
  return pos;
}
