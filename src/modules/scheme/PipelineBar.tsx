/**
 * modules/scheme/PipelineBar.tsx
 * 设计流程状态条 —— 顶部一行显示当前设计走到了哪一步。
 *
 * 关键原则：每一格的状态都由**文档里可核实的事实**推导，不是流程摆设。
 * 比如"已布局"看的是有没有放置违规，"结构就绪"看的是外壳干涉检查有没有 error。
 * 做不到的一律显示"未开始/不适用"，绝不打一个绿勾充数。
 */
import { useMemo } from 'react';
import { tr } from '../../shared/i18n';
import { COLORS } from '../../shared/theme';
import { useDesignStore } from '../../state/designStore';
import { DEFAULT_ENCLOSURE, checkEnclosure } from '../../design-core/enclosure';
import { findOverlaps } from '../../design-core/collision';
import { summarizeTrust, trustHeadline } from '../../design-core/trust';

type StepState = 'done' | 'warn' | 'todo';

export function PipelineBar() {
  const doc = useDesignStore((s) => s.doc);
  const placementViolations = useDesignStore((s) => s.placementViolations);

  const steps = useMemo(() => {
    const n = doc.components.length;
    const overlaps = findOverlaps(doc.components);
    const vio = Object.keys(placementViolations).length;
    const netCount = Object.keys(doc.nets ?? {}).filter((k) => k !== '0').length;
    const enc = { ...DEFAULT_ENCLOSURE, ...(doc.enclosure ?? {}) };
    const encErr = enc.enabled ? checkEnclosure(doc, enc).filter((i) => i.level === 'error').length : -1;
    const trust = summarizeTrust(doc.components);   // 唯一口径

    const out: { label: string; note: string; state: StepState; testId?: string }[] = [
      {
        label: '方案',
        note: n ? `${n} ${tr('个器件')}` : tr('未生成'),
        state: n ? 'done' : 'todo',
      },
      {
        label: '布局',
        note: !n ? tr('无器件') : vio ? `${vio} ${tr('个未找到合法位置')}` : overlaps.size ? `${overlaps.size} ${tr('个重叠')}` : tr('无冲突'),
        state: !n ? 'todo' : (vio || overlaps.size) ? 'warn' : 'done',
      },
      {
        label: '连接',
        note: netCount ? `${netCount} ${tr('个网络')}` : tr('未导入 netlist'),
        state: netCount ? 'done' : 'todo',
      },
      {
        label: '结构',
        note: encErr < 0 ? tr('未启用外壳') : encErr ? `${encErr} ${tr('项干涉')}` : tr('无干涉'),
        state: encErr < 0 ? 'todo' : encErr ? 'warn' : 'done',
      },
      {
        label: '选型',
        testId: 'pipeline-sourcing',
        note: !n ? tr('无器件') : tr(trustHeadline(trust)),
        state: !n ? 'todo' : trust.engineeringReady ? 'done' : 'warn',
      },
    ];
    return out;
  }, [doc, placementViolations]);

  const ICON: Record<StepState, string> = { done: '✓', warn: '!', todo: '·' };
  const CLR: Record<StepState, { bg: string; fg: string; bd: string }> = {
    done: { bg: '#f0fdf4', fg: '#15803d', bd: '#bbf7d0' },
    warn: { bg: '#fffbeb', fg: '#b45309', bd: '#fde68a' },
    todo: { bg: '#f8fafc', fg: '#94a3b8', bd: '#e2e8f0' },
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 16px', background: '#fff', borderBottom: '1px solid #f1f5f9', overflowX: 'auto' }}>
      {steps.map((s, i) => {
        const c = CLR[s.state];
        return (
          <div key={s.label} data-testid={s.testId} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div title={`${tr(s.label)}：${s.note}`}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 7, background: c.bg, border: `1px solid ${c.bd}`, whiteSpace: 'nowrap' }}>
              <span style={{ width: 14, height: 14, borderRadius: 7, background: c.fg, color: '#fff', fontSize: 9, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{ICON[s.state]}</span>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: s.state === 'todo' ? '#94a3b8' : COLORS.green }}>{tr(s.label)}</span>
              <span style={{ fontSize: 10, color: c.fg }}>{s.note}</span>
            </div>
            {i < steps.length - 1 && <span style={{ color: '#cbd5e1', fontSize: 11 }}>›</span>}
          </div>
        );
      })}
    </div>
  );
}
