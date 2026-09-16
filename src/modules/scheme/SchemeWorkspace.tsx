/**
 * modules/scheme/SchemeWorkspace.tsx
 * AI 方案评审工作台 —— 方案先在这里过一遍，满意了才上画布。
 *
 * 三块内容：
 *   左：按「核心器件 + 附属器件」分组的清单（核心件明确标出，可逐项剔除）
 *   右上：方案框图（模型给的优先，没给就由分组结构保守推导）
 *   右下：多轮修改输入 + 「AI 已完成修改」清单（来自确定性 diff，不是模型自述）
 */
import { useMemo, useState, type ReactNode } from 'react';
import { tr } from '../../shared/i18n';
import { COLORS } from '../../shared/theme';
import { TRUST_META } from '../../providers/ai-schema';
import {
  groupSchemeItems, deriveBlocks,
  type SchemeItem, type SchemeChange, type DerivedBlock, type DerivedLink,
} from '../../design-core/scheme-workspace';
import type { ComponentTrust } from '../../providers/types';
import { materializeSchemeLines, toSchemeLines } from '../../design-core/scheme-lines';

export interface SchemeProposal {
  rationale: string;
  source?: string;
  fallbackReason?: string;
  details: (SchemeItem & { mapSource?: string; trust?: ComponentTrust })[];
  blocks?: DerivedBlock[];
  blockLinks?: DerivedLink[];
  /** 与上一版的差异（多轮修改后才有） */
  changes?: SchemeChange[];
  /** 第几轮（1 = 首次生成） */
  round?: number;
}

const BLOCK_STYLE: Record<string, { bg: string; border: string; fg: string }> = {
  mcu: { bg: '#e2e8f0', border: '#475569', fg: '#1e293b' },
  power: { bg: '#fee2e2', border: '#dc2626', fg: '#991b1b' },
  sensor: { bg: '#dcfce7', border: '#16a34a', fg: '#166534' },
  interface: { bg: '#ede9fe', border: '#7c3aed', fg: '#5b21b6' },
  storage: { bg: '#e0f2fe', border: '#0284c7', fg: '#075985' },
  rf: { bg: '#fef3c7', border: '#d97706', fg: '#92400e' },
  display: { bg: '#cffafe', border: '#0891b2', fg: '#155e75' },
  other: { bg: '#f1f5f9', border: '#94a3b8', fg: '#475569' },
};

/** 框图：块按 kind 分列（电源→主控→其余），连线用正交折线 */
function BlockDiagram({ blocks, links }: { blocks: DerivedBlock[]; links: DerivedLink[] }) {
  if (!blocks.length) return null;
  const W = 148, H = 46, GAPX = 74, GAPY = 20;
  const col = (b: DerivedBlock) => (b.kind === 'power' ? 0 : b.kind === 'mcu' ? 1 : 2);
  const cols: DerivedBlock[][] = [[], [], []];
  for (const b of blocks) cols[col(b)].push(b);
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((list, ci) => list.forEach((b, ri) => pos.set(b.id, { x: ci * (W + GAPX), y: ri * (H + GAPY) })));
  const rows = Math.max(1, ...cols.map((c) => c.length));
  const svgW = 3 * W + 2 * GAPX, svgH = rows * (H + GAPY);

  return (
    <svg viewBox={`-6 -6 ${svgW + 12} ${svgH + 12}`} style={{ width: '100%', height: '100%' }} preserveAspectRatio="xMidYMid meet">
      <defs>
        <marker id="swArrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M0,0 L7,3.5 L0,7 z" fill="#94a3b8" />
        </marker>
      </defs>
      {links.map((l, i) => {
        const a = pos.get(l.from), b = pos.get(l.to);
        if (!a || !b) return null;
        const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
        const mx = (x1 + x2) / 2;
        return (
          <g key={i}>
            <path d={`M${x1},${y1} H${mx} V${y2} H${x2}`} fill="none" markerEnd="url(#swArrow)"
              stroke={l.kind === 'power' ? '#dc2626' : '#64748b'} strokeWidth={1.2}
              strokeDasharray={l.kind === 'power' ? undefined : '4 3'} opacity={0.75} />
            {l.label && <text x={mx} y={(y1 + y2) / 2 - 3} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{l.label}</text>}
          </g>
        );
      })}
      {blocks.map((b) => {
        const p = pos.get(b.id)!;
        const st = BLOCK_STYLE[b.kind] ?? BLOCK_STYLE.other;
        return (
          <g key={b.id} transform={`translate(${p.x},${p.y})`}>
            <rect width={W} height={H} rx={7} fill={st.bg} stroke={st.border} strokeWidth={1.4} />
            <text x={W / 2} y={19} textAnchor="middle" fontSize={11} fontWeight={700} fill={st.fg}>{b.label.length > 18 ? b.label.slice(0, 16) + '…' : b.label}</text>
            {b.core && b.core !== b.label && <text x={W / 2} y={33} textAnchor="middle" fontSize={8.5} fill={st.fg} opacity={0.75} fontFamily="monospace">{b.core}</text>}
          </g>
        );
      })}
    </svg>
  );
}

export function SchemeWorkspace({ proposal, busy, onRevise, onRemove, onConfirm, onClose, onLink, linkPanel }: {
  proposal: SchemeProposal;
  busy: boolean;
  onRevise: (feedback: string) => void;
  onRemove: (componentId: string) => void;
  onConfirm: (items: SchemeProposal['details']) => void;
  onClose: () => void;
  /** 点击"关联"：由 App 发起 ezPLM 检索（复用既有的逐级截短推荐逻辑） */
  onLink?: (componentId: string, mpn: string, footprint?: string) => void;
  /** 关联结果面板（由 App 渲染，避免把检索状态搬进本组件） */
  linkPanel?: (componentId: string) => ReactNode;
}) {
  const [feedback, setFeedback] = useState('');
  const [coreOnly, setCoreOnly] = useState(false);

  const groups = useMemo(() => groupSchemeItems(proposal.details), [proposal.details]);
  const diagram = useMemo(() => {
    if (proposal.blocks?.length) return { blocks: proposal.blocks, links: proposal.blockLinks ?? [] };
    return deriveBlocks(groups);
  }, [proposal.blocks, proposal.blockLinks, groups]);

  // details 里同型号多只是重复对象，这里保持原样（上画布需要真实件数），
  // 只有展示层做归并
  const shown = coreOnly ? proposal.details.filter((d) => d.category !== 'passive') : proposal.details;

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(1180px, 96vw)', height: 'min(760px, 92vh)', background: '#fff', borderRadius: 14, boxShadow: '0 20px 60px rgba(0,0,0,.25)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* 顶栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid #e8f3ee' }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: COLORS.green }}>✨ {tr('AI 方案评审')}</span>
          {proposal.round && proposal.round > 1 && (
            <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 5, background: '#e0f2fe', color: '#0369a1', fontWeight: 700 }}>{tr('第')} {proposal.round} {tr('轮')}</span>
          )}
          {proposal.source === 'gemini'
            ? <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 5, background: '#dcfce7', color: '#166534', fontWeight: 700 }}>Gemini</span>
            : <span title={proposal.fallbackReason} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 5, background: '#fef3c7', color: '#92400e', fontWeight: 700 }}>{tr('演示引擎')}</span>}
          <span style={{ flex: 1 }} />
          <label style={{ fontSize: 11, color: '#475569', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={coreOnly} onChange={(e) => setCoreOnly(e.target.checked)} />
            {tr('只上核心器件')}
          </label>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', fontSize: 18, color: '#94a3b8', cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* 左：分组清单 */}
          <div style={{ width: 480, flexShrink: 0, borderRight: '1px solid #f1f5f9', overflow: 'auto', padding: 14 }}>
            <div style={{ fontSize: 12, color: '#475569', lineHeight: 1.65, padding: '9px 11px', background: '#f7fcf9', borderRadius: 8, marginBottom: 12 }}>
              {tr(proposal.rationale)}
            </div>
            {groups.map((g) => (
              <div key={g.name} style={{ marginBottom: 12, border: '1px solid #e8f3ee', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ padding: '7px 10px', background: '#f0fdf4', display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 4, background: COLORS.green, color: '#fff', fontWeight: 700 }}>{tr('核心')}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, fontFamily: 'monospace', color: '#14532d' }}>{g.core?.mpn ?? g.name}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: '#4d7c0f' }}>
                    +{g.satellites.reduce((a, x) => a + (g.counts[x.componentId] ?? 1), 0)} {tr('个附属器件')}
                    {g.satellites.length < g.satellites.reduce((a, x) => a + (g.counts[x.componentId] ?? 1), 0) ? `（${g.satellites.length} ${tr('种')}）` : ''}
                  </span>
                </div>
                {[...(g.core ? [g.core] : []), ...g.satellites].map((d, di) => {
                  const dd = d as SchemeProposal['details'][number];
                  const m = dd.trust ? TRUST_META[dd.trust.level] : null;
                  const isCore = di === 0 && !!g.core;
                  const qty = g.counts[dd.componentId] ?? 1;
                  if (coreOnly && !isCore && d.category === 'passive') return null;
                  return (
                    <div key={dd.componentId + '#' + di} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderTop: '1px solid #f8fafc', paddingLeft: isCore ? 10 : 22 }}>
                      <span style={{ fontSize: 11.5, fontFamily: 'monospace', fontWeight: isCore ? 700 : 500 }}>{dd.mpn}</span>
                      {qty > 1 && <span style={{ fontSize: 10, fontWeight: 700, color: '#4d7c0f' }}>×{qty}</span>}
                      {dd.defaultFootprintName && <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: '#f1f5f9', color: '#475569' }}>{dd.defaultFootprintName}</span>}
                      {m && <span title={dd.trust?.evidence} style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: m.bg, color: m.color, fontWeight: 700, cursor: 'help' }}>{tr(m.label)}</span>}
                      <span style={{ flex: 1 }} />
                      {onLink && dd.mapSource === tr('封装占位') && (
                        <button onClick={() => onLink(dd.componentId, dd.mpn, dd.defaultFootprintName)} title={tr('到 ezPLM 库中检索并关联真实器件')}
                          style={{ padding: '2px 8px', borderRadius: 5, border: '1px solid #c7d2fe', background: '#eef2ff', color: '#4338ca', fontSize: 9.5, fontWeight: 700, cursor: 'pointer' }}>{tr('关联')}</button>
                      )}
                      <button onClick={() => onRemove(dd.componentId)} title={tr('从方案中移除')}
                        style={{ border: 'none', background: 'transparent', color: '#cbd5e1', fontSize: 13, cursor: 'pointer', lineHeight: 1 }}>×</button>
                    </div>
                  );
                })}
                {linkPanel?.(g.core?.componentId ?? '')}
                {g.satellites.map((sa) => <div key={'lp' + sa.componentId}>{linkPanel?.(sa.componentId)}</div>)}
              </div>
            ))}
          </div>

          {/* 右：框图 + 多轮修改 */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: 1, minHeight: 0, padding: 14, borderBottom: '1px solid #f1f5f9', display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.green, marginBottom: 6 }}>
                📊 {tr('方案框图')}
                <span style={{ marginLeft: 6, fontWeight: 400, fontSize: 10, color: '#94a3b8' }}>
                  {proposal.blocks?.length ? tr('模型给出') : tr('由器件分组推导')}
                </span>
              </div>
              <div style={{ flex: 1, minHeight: 0, background: '#fafdfb', borderRadius: 8, border: '1px solid #e8f3ee', padding: 10 }}>
                <BlockDiagram blocks={diagram.blocks} links={diagram.links} />
              </div>
            </div>

            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflow: 'auto' }}>
              {!!proposal.changes?.length && (
                <div style={{ padding: '8px 10px', borderRadius: 8, background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#15803d', marginBottom: 4 }}>✅ {tr('本轮实际变更')}（{proposal.changes.length}）</div>
                  {proposal.changes.slice(0, 8).map((c, i) => (
                    <div key={i} style={{ fontSize: 10.5, color: '#166534', lineHeight: 1.6 }}>
                      {c.kind === 'added' ? '＋ ' : c.kind === 'removed' ? '－ ' : '± '}{tr(c.detail)}
                    </div>
                  ))}
                  <div style={{ fontSize: 9.5, color: '#4d7c0f', marginTop: 3 }}>{tr('以上为两版方案的实际差异，非模型自述')}</div>
                </div>
              )}
              <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.green }}>💬 {tr('继续修改')}</div>
              <textarea
                value={feedback}
                rows={3}
                onChange={(e) => setFeedback(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder={tr('如：不要 OLED，改成 4 位数码管；加一路 CAN 收发器；电源换成低静态电流的 LDO')}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #dbe6dd', fontSize: 12, lineHeight: 1.6, outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => { if (feedback.trim()) { onRevise(feedback.trim()); setFeedback(''); } }}
                  disabled={busy || !feedback.trim()}
                  style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: busy || !feedback.trim() ? '#cbd5e1' : '#1f5c3b', fontSize: 12.5, fontWeight: 700, cursor: busy || !feedback.trim() ? 'default' : 'pointer' }}>
                  {busy ? '⟳ ' + tr('重新生成中…') : '🔄 ' + tr('按意见重新生成')}
                </button>
                <button onClick={() => onConfirm(materializeSchemeLines(toSchemeLines(shown as never[])) as unknown as SchemeProposal['details'])} disabled={busy}
                  style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: 'none', background: `linear-gradient(135deg,#245b3a,${COLORS.green})`, color: '#fff', fontSize: 12.5, fontWeight: 700, cursor: busy ? 'default' : 'pointer' }}>
                  ✓ {tr('确认并上画布')}（{shown.reduce((a, d) => a + Math.max(1, Number((d as { qty?: number }).qty) || 1), 0)}）
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
