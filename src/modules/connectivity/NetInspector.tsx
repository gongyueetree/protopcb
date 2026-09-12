/**
 * modules/connectivity/NetInspector.tsx
 * iBOM 式网络检视器 —— 在 2D 画布上点中一条走线/过孔/焊盘后，
 * 这里列出该网络上的全部器件引脚；鼠标移上去可在画布定位，点击切换选中器件。
 *
 * 数据全部来自导入的 netlist（doc.nets + 各器件 display.padNets），无任何推断。
 */
import { useMemo } from 'react';
import { useDesignStore } from '../../state/designStore';
import { tr } from '../../shared/i18n';
import { COLORS } from '../../shared/theme';

export function NetInspector() {
  const doc = useDesignStore((s) => s.doc);
  const selectedNet = useDesignStore((s) => s.selectedNet);
  const selectNet = useDesignStore((s) => s.selectNet);
  const select = useDesignStore((s) => s.select);
  const selectedId = useDesignStore((s) => s.selectedId);

  const nodes = useMemo(() => {
    if (selectedNet == null) return [];
    const out: { instanceId: string; ref: string; pad: string; mpn: string; desc?: string; side: string }[] = [];
    for (const c of doc.components) {
      for (const [pad, n] of Object.entries(c.display?.padNets ?? {})) {
        if (n === selectedNet) {
          out.push({ instanceId: c.instanceId, ref: c.reference, pad, mpn: c.mpn, desc: c.display?.description, side: c.placement.side });
        }
      }
    }
    return out.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }) || a.pad.localeCompare(b.pad, undefined, { numeric: true }));
  }, [doc.components, selectedNet]);

  if (selectedNet == null) {
    return (
      <div style={{ padding: '18px 14px', fontSize: 11.5, color: '#94a3b8', lineHeight: 1.7 }}>
        {tr('在 2D 画布上点击任意焊盘、走线或过孔，这里会列出该网络连接的全部器件引脚。')}
        <div style={{ marginTop: 6, color: '#cbd5e1' }}>{tr('（需要先导入带 netlist 的 KiCad 工程）')}</div>
      </div>
    );
  }

  const name = doc.nets?.[String(selectedNet)] ?? `Net-${selectedNet}`;
  const trackCount = (doc.tracks ?? []).filter((t) => t.net === selectedNet).length;
  const viaCount = (doc.vias ?? []).filter((v) => v.net === selectedNet).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid #f1f5f9' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: COLORS.green, fontFamily: 'monospace', wordBreak: 'break-all' }}>{name}</span>
          <button onClick={() => selectNet(null)} title={tr('取消高亮')}
            style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: '#94a3b8', fontSize: 14, fontWeight: 800, cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 3 }}>
          {tr('网络号')} {selectedNet} · {nodes.length} {tr('个引脚')} · {new Set(nodes.map((n) => n.ref)).size} {tr('个器件')}
          {trackCount ? ` · ${trackCount} ${tr('段走线')}` : ''}{viaCount ? ` · ${viaCount} ${tr('个过孔')}` : ''}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
        {!nodes.length ? (
          <div style={{ fontSize: 11, color: '#94a3b8', padding: 10, lineHeight: 1.6 }}>
            {tr('该网络在当前画布上没有对应器件引脚（可能器件已删除，或走线所属器件未被导入）。')}
          </div>
        ) : nodes.map((n) => {
          const active = n.instanceId === selectedId;
          return (
            <div key={n.instanceId + '-' + n.pad}
              onClick={() => select(n.instanceId)}
              title={n.desc}
              style={{
                padding: '7px 9px', borderRadius: 8, marginBottom: 5, cursor: 'pointer',
                background: active ? COLORS.greenBg : '#fff',
                border: `1px solid ${active ? COLORS.green : '#e8f3ee'}`,
              }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <b style={{ fontSize: 12, color: COLORS.green }}>{n.ref}</b>
                <span style={{ fontSize: 10.5, color: '#64748b' }}>{tr('引脚')} {n.pad}</span>
                <span style={{ marginLeft: 'auto', fontSize: 9, padding: '1px 5px', borderRadius: 4, fontWeight: 700, background: n.side === 'BOTTOM' ? '#e0f2fe' : '#fef3c7', color: n.side === 'BOTTOM' ? '#0369a1' : '#92400e' }}>{n.side}</span>
              </div>
              <div style={{ fontSize: 10.5, color: '#475569', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.mpn}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
