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

  if (selectedNet == null) return <ConnectedComponents />;

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

/**
 * 未选中网络时：列出与**当前选中器件**直接相连的所有其它器件，按网络分组。
 * 关系由 padNets 逐引脚求交得出（确定性），点击可切换到对方器件继续追。
 */
function ConnectedComponents() {
  const doc = useDesignStore((s) => s.doc);
  const selectedId = useDesignStore((s) => s.selectedId);
  const select = useDesignStore((s) => s.select);
  const selectNet = useDesignStore((s) => s.selectNet);

  const me = doc.components.find((c) => c.instanceId === selectedId);

  const groups = useMemo(() => {
    if (!me) return [];
    const myNets = new Map<number, string[]>();        // 网络号 → 我方引脚
    for (const [pad, n] of Object.entries(me.display?.padNets ?? {})) {
      if (!n) continue;
      myNets.set(n, [...(myNets.get(n) ?? []), pad]);
    }
    const out: { net: number; name: string; myPads: string[]; peers: { instanceId: string; ref: string; pad: string; mpn: string }[] }[] = [];
    for (const [net, myPads] of myNets) {
      const peers: { instanceId: string; ref: string; pad: string; mpn: string }[] = [];
      for (const c of doc.components) {
        if (c.instanceId === me.instanceId) continue;
        for (const [pad, n] of Object.entries(c.display?.padNets ?? {})) {
          if (n === net) peers.push({ instanceId: c.instanceId, ref: c.reference, pad, mpn: c.mpn });
        }
      }
      out.push({ net, name: doc.nets?.[String(net)] ?? `Net-${net}`, myPads: myPads.sort(), peers });
    }
    // 连接点少的网络排前面（信号网络通常比 GND/电源更有信息量）
    return out.sort((a, b) => a.peers.length - b.peers.length || a.name.localeCompare(b.name));
  }, [doc.components, doc.nets, me]);

  if (!me) {
    return (
      <div style={{ padding: '18px 14px', fontSize: 11.5, color: '#94a3b8', lineHeight: 1.7 }}>
        {tr('在 2D 画布上点击一个器件，这里会列出与它相连的所有其它器件；')}
        {tr('点击焊盘、走线或过孔则高亮整条网络。')}
        <div style={{ marginTop: 6, color: '#cbd5e1' }}>{tr('（需要先导入带 netlist 的 KiCad 工程）')}</div>
      </div>
    );
  }

  const totalPeers = new Set(groups.flatMap((g) => g.peers.map((p) => p.ref))).size;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid #f1f5f9' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.green }}>{me.reference} <span style={{ fontFamily: 'monospace', fontSize: 11.5, color: '#475569' }}>{me.mpn}</span></div>
        <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 3 }}>
          {groups.length ? `${tr('连接')} ${groups.length} ${tr('个网络')} · ${totalPeers} ${tr('个器件')}` : tr('该器件没有网络连接数据')}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
        {!groups.length && (
          <div style={{ fontSize: 11, color: '#94a3b8', padding: 10, lineHeight: 1.6 }}>
            {tr('手工摆放的器件尚未建立电气连接。导入 KiCad 工程后这里会显示真实连接关系。')}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.net} style={{ marginBottom: 10 }}>
            <div onClick={() => selectNet(g.net)} title={tr('点击在画布上高亮该网络')}
              style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '4px 6px', borderRadius: 6, cursor: 'pointer', background: '#f8fafc' }}>
              <b style={{ fontSize: 11, fontFamily: 'monospace', color: COLORS.green }}>{g.name}</b>
              <span style={{ fontSize: 9.5, color: '#94a3b8' }}>{tr('本器件引脚')} {g.myPads.join('/')}</span>
              <span style={{ marginLeft: 'auto', fontSize: 9.5, color: '#94a3b8' }}>{g.peers.length} {tr('个对端')}</span>
            </div>
            {g.peers.map((p) => (
              <div key={p.instanceId + '-' + p.pad} onClick={() => select(p.instanceId)}
                style={{ padding: '5px 9px', marginTop: 4, marginLeft: 8, borderRadius: 7, cursor: 'pointer', border: '1px solid #e8f3ee', background: '#fff' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <b style={{ fontSize: 11.5, color: COLORS.green }}>{p.ref}</b>
                  <span style={{ fontSize: 10, color: '#64748b' }}>{tr('引脚')} {p.pad}</span>
                </div>
                <div style={{ fontSize: 10, color: '#475569', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.mpn}</div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
