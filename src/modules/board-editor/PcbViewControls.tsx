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
import { COLORS } from '../../shared/theme';

const MODES: { id: PcbVisualMode; label: string; hint: string }[] = [
  { id: '2d', label: '2D', hint: '纯 2D 编辑视图（不挂载 3D 图层，性能与原来一致）' },
  { id: 'hybrid', label: '混合', hint: '焊盘/走线 + 器件 3D 顶视投影' },
  { id: 'realistic', label: '实物投影', hint: '弱化工程标注，接近实物外观' },
];

export function PcbViewControls() {
  const mode = usePcbViewStore((s) => s.mode);
  const setMode = usePcbViewStore((s) => s.setMode);
  const showPads = usePcbViewStore((s) => s.showPads);
  const setShowPads = usePcbViewStore((s) => s.setShowPads);
  const showComponent3D = usePcbViewStore((s) => s.showComponent3D);
  const setShowComponent3D = usePcbViewStore((s) => s.setShowComponent3D);
  const showAll3D = usePcbViewStore((s) => s.showAll3D);
  const hideAll3D = usePcbViewStore((s) => s.hideAll3D);
  const soloComponent3D = usePcbViewStore((s) => s.soloComponent3D);
  const clearSolo3D = usePcbViewStore((s) => s.clearSolo3D);
  const resetViewOptions = usePcbViewStore((s) => s.resetViewOptions);
  const solo3dId = usePcbViewStore((s) => s.solo3dId);
  const hidden = usePcbViewStore((s) => s.hidden3dIds);
  const comps = useDesignStore((s) => s.doc.components);
  const selectedId = useDesignStore((s) => s.selectedId);
  const [open, setOpen] = useState(false);

  const hiddenCount = Object.keys(hidden).length;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }}>
      <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #E8F3EE' }}>
        {MODES.map((m) => (
          <button key={m.id} onClick={() => setMode(m.id)} title={tr(m.hint)}
            style={{
              padding: '7px 12px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700,
              background: mode === m.id ? COLORS.green : '#fff',
              color: mode === m.id ? '#fff' : '#475569',
            }}>{tr(m.label)}</button>
        ))}
      </div>

      {mode !== '2d' && (
        <>
          <button onClick={() => setShowComponent3D(!showComponent3D)}
            title={tr('器件 3D 总开关')}
            style={chip(showComponent3D)}>🧊 3D</button>
          <button onClick={() => setShowPads(!showPads)} title={tr('焊盘显示')} style={chip(showPads)}>⬚ {tr('焊盘')}</button>
          <button onClick={() => setOpen((v) => !v)} title={tr('显示选项')} style={chip(false)}>
            ⋯{hiddenCount || solo3dId ? ` (${solo3dId ? tr('单件') : hiddenCount})` : ''}
          </button>
        </>
      )}

      {open && (
        <div onMouseLeave={() => setOpen(false)}
          style={{ position: 'absolute', top: 34, right: 0, zIndex: 20, background: '#fff', borderRadius: 10, border: '1px solid #E8F3EE', boxShadow: '0 8px 24px rgba(0,0,0,.12)', padding: 6, width: 190 }}>
          {[
            ['显示全部 3D', () => showAll3D()],
            ['隐藏全部 3D', () => hideAll3D(comps.map((c) => c.instanceId))],
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

const chip = (on: boolean): React.CSSProperties => ({
  padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 11.5, fontWeight: 700,
  border: `1px solid ${on ? COLORS.green : '#E8F3EE'}`,
  background: on ? COLORS.greenBg : '#fff',
  color: on ? COLORS.green : '#94a3b8',
});
