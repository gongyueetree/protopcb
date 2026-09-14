/**
 * modules/board-editor/PcbViewControls.tsx
 * PCB 画布的视图控制：2D / 混合 / 实物投影 + 3D 显示选项。
 *
 * 全部是**视图状态**（pcbViewStore），不写入设计文档、不进 undo/redo、不影响导出。
 */
import { useState } from 'react';
import { usePcbViewStore, type PcbVisualMode } from '../../state/pcbViewStore';
import { useDesignStore } from '../../state/designStore';
import { tr } from '../../shared/i18n';
import { COLORS, TOOLBAR_CTRL_H } from '../../shared/theme';


/**
 * 三档视图，用户只需理解"看多少东西"：
 *   2D      只看焊盘与走线（编辑时最清楚）
 *   2D+3D   焊盘上叠真实器件顶视图（既能编辑又能看实物关系）
 *   实物    只看实物外观（收起工程标注）
 * 此前旁边还有一个独立的「3D」开关，和"2D 模式"语义重叠，用户分不清 —— 已合并进这三档。
 */
const MODES: { id: PcbVisualMode; label: string; hint: string }[] = [
  { id: '2d', label: '2D', hint: '只看焊盘与走线，编辑最清楚' },
  { id: 'hybrid', label: '2D+3D', hint: '焊盘上叠加器件的真实顶视图' },
  { id: 'realistic', label: '实物', hint: '只看实物外观，收起位号与封装外框' },
];

export function PcbViewControls() {
  const mode = usePcbViewStore((s) => s.mode);
  const setMode = usePcbViewStore((s) => s.setMode);
  const showPads = usePcbViewStore((s) => s.showPads);
  const setShowPads = usePcbViewStore((s) => s.setShowPads);
  const showComponent3D = usePcbViewStore((s) => s.showComponent3D);
  const showAll3D = usePcbViewStore((s) => s.showAll3D);
  const hideAll3D = usePcbViewStore((s) => s.hideAll3D);
  const soloComponent3D = usePcbViewStore((s) => s.soloComponent3D);
  const clearSolo3D = usePcbViewStore((s) => s.clearSolo3D);
  const resetViewOptions = usePcbViewStore((s) => s.resetViewOptions);
  const solo3dId = usePcbViewStore((s) => s.solo3dId);
  const hidden = usePcbViewStore((s) => s.hidden3dIds);
  const selectedId = useDesignStore((s) => s.selectedId);
  const [open, setOpen] = useState(false);

  const hiddenCount = Object.keys(hidden).length;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative', height: CTRL_H }}>
      <div style={{ display: 'flex', height: CTRL_H, borderRadius: 6, overflow: 'hidden', border: '1px solid #E8F3EE' }}>
        {MODES.map((m) => (
          <button key={m.id} onClick={() => setMode(m.id)} title={tr(m.hint)}
            style={{
              padding: '0 12px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700,
              whiteSpace: 'nowrap', lineHeight: `${CTRL_H - 2}px`,
              background: mode === m.id ? COLORS.green : '#fff',
              color: mode === m.id ? '#fff' : '#475569',
            }}>{tr(m.label)}</button>
        ))}
      </div>

      {mode !== '2d' && (
        <button onClick={() => setOpen((v) => !v)} title={tr('显示选项')} style={chip(false)}>
          ⋯{hiddenCount || solo3dId || !showComponent3D || !showPads ? ` (${solo3dId ? tr('单件') : !showComponent3D ? tr('3D 已隐藏') : hiddenCount || (!showPads ? tr('焊盘已隐藏') : '')})` : ''}
        </button>
      )}

      {open && (
        <div onMouseLeave={() => setOpen(false)}
          style={{ position: 'absolute', top: 34, right: 0, zIndex: 20, background: '#fff', borderRadius: 10, border: '1px solid #E8F3EE', boxShadow: '0 8px 24px rgba(0,0,0,.12)', padding: 6, width: 190 }}>
          {[
            [showPads ? '隐藏焊盘' : '显示焊盘', () => setShowPads(!showPads)],
            [showComponent3D ? '隐藏全部 3D' : '显示全部 3D', () => (showComponent3D ? hideAll3D() : showAll3D())],
            [selectedId ? '仅显示选中器件' : '仅显示选中器件（未选中）', () => selectedId && soloComponent3D(selectedId)],
            ['取消单件模式', () => clearSolo3D()],
            ['恢复默认', () => resetViewOptions()],
          ].map(([label, fn]) => (
            <button key={label as string} onClick={() => { (fn as () => void)(); setOpen(false); }}
              disabled={(label as string).includes('未选中')}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '7px 9px', border: 'none',
                background: 'transparent', fontSize: 11.5, color: (label as string).includes('未选中') ? '#cbd5e1' : '#334155',
                cursor: (label as string).includes('未选中') ? 'default' : 'pointer', borderRadius: 6,
              }}>{tr(label as string)}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 与 App 工具栏共用同一高度常量，避免两处各定义后慢慢漂开 */
const CTRL_H = TOOLBAR_CTRL_H;

const chip = (on: boolean): React.CSSProperties => ({
  height: CTRL_H, padding: '0 10px', borderRadius: 6, cursor: 'pointer',
  fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap', lineHeight: `${CTRL_H - 2}px`,
  border: `1px solid ${on ? COLORS.green : '#E8F3EE'}`,
  background: on ? COLORS.greenBg : '#fff',
  color: on ? COLORS.green : '#94a3b8',
});
