/**
 * modules/connectivity/ConnectivityPanel.tsx
 * 连接关系视图 —— 网络表与引脚级联动。
 *
 * 数据来源全部是确定性的：doc.nets（KiCad 导入的网络号→网络名）与
 * 各器件 display.padNets（焊盘号→网络号）。没有导入 netlist 时如实显示"无数据"，
 * 不用 AI 猜连接关系。
 */
import { useMemo, useState } from 'react';
import { useDesignStore } from '../../state/designStore';
import { tr } from '../../shared/i18n';
import { COLORS } from '../../shared/theme';

interface NetNode { ref: string; pad: string; mpn: string }

export function ConnectivityPanel() {
  const doc = useDesignStore((s) => s.doc);
  const selectComponent = useDesignStore((s) => s.select);
  const [sel, setSel] = useState<number | null>(null);
  const [q, setQ] = useState('');

  const nets = useMemo(() => {
    const map = new Map<number, NetNode[]>();
    for (const c of doc.components) {
      for (const [pad, netId] of Object.entries(c.display?.padNets ?? {})) {
        if (!netId) continue;   // net 0 = 未连接
        const arr = map.get(netId) ?? [];
        arr.push({ ref: c.reference, pad, mpn: c.mpn });
        map.set(netId, arr);
      }
    }
    return [...map.entries()]
      .map(([id, nodes]) => ({ id, name: doc.nets?.[String(id)] ?? `Net-${id}`, nodes }))
      .sort((a, b) => b.nodes.length - a.nodes.length || a.name.localeCompare(b.name));
  }, [doc.components, doc.nets]);

  const shown = nets.filter((n) => !q.trim() || n.name.toLowerCase().includes(q.toLowerCase()) || n.nodes.some((x) => x.ref.toLowerCase().includes(q.toLowerCase())));
  const selNet = nets.find((n) => n.id === sel);
  // 电源/地网络按常见命名归类（仅用于显示分组，不参与任何工程结论）
  const kind = (name: string) => (/^(GND|AGND|DGND|VSS|PGND)/i.test(name) ? 'GROUND' : /^(\+?\d|VCC|VDD|VBUS|VBAT|VIN|V\d)/i.test(name) ? 'POWER' : 'SIGNAL');

  if (!nets.length) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#7F8C8D', fontSize: 12.5, lineHeight: 1.7 }}>
        {tr('当前设计没有网络连接数据。')}<br />
        {tr('导入 KiCad 工程（.kicad_pcb / 工程 ZIP）后，这里会显示真实网络表与引脚归属。')}<br />
        <span style={{ fontSize: 11, color: '#94a3b8' }}>{tr('在画布上手工摆放的器件尚未建立电气连接，本页不会凭猜测生成网络。')}</span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, background: '#f8fafc' }}>
      <div style={{ width: 300, flexShrink: 0, borderRight: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', background: '#fff' }}>
        <div style={{ padding: 10, borderBottom: '1px solid #f1f5f9' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.green, marginBottom: 6 }}>🔗 {tr('网络列表')}（{nets.length}）</div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('搜索网络名 / 位号…')}
            style={{ width: '100%', padding: '6px 9px', borderRadius: 7, border: '1px solid #dbe6dd', fontSize: 11.5, outline: 'none', boxSizing: 'border-box' }} />
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {shown.map((n) => {
            const k = kind(n.name);
            return (
              <div key={n.id} onClick={() => setSel(n.id)} style={{
                padding: '7px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
                background: sel === n.id ? COLORS.greenBg : 'transparent', borderLeft: `3px solid ${sel === n.id ? COLORS.green : 'transparent'}`,
              }}>
                <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: k === 'GROUND' ? '#e2e8f0' : k === 'POWER' ? '#fee2e2' : '#e0f2fe', color: k === 'GROUND' ? '#475569' : k === 'POWER' ? '#b91c1c' : '#0369a1' }}>{k}</span>
                <span style={{ flex: 1, fontSize: 11.5, fontWeight: 600, fontFamily: 'monospace', color: '#2C3E50', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.name}</span>
                <span style={{ fontSize: 10.5, color: '#94a3b8' }}>{n.nodes.length} {tr('点')}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {!selNet ? (
          <div style={{ textAlign: 'center', padding: 60, color: '#7F8C8D', fontSize: 12 }}>{tr('选择左侧网络查看引脚连接')}</div>
        ) : (
          <>
            <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.green, fontFamily: 'monospace' }}>{selNet.name}</div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 12 }}>
              {tr('网络号')} {selNet.id} · {selNet.nodes.length} {tr('个连接点')} · {new Set(selNet.nodes.map((n) => n.ref)).size} {tr('个器件')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))', gap: 8 }}>
              {selNet.nodes.map((n, i) => (
                <div key={i} onClick={() => { const c = doc.components.find((x) => x.reference === n.ref); if (c) selectComponent(c.instanceId); }}
                  style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #E8F3EE', background: '#fff', cursor: 'pointer' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.green }}>{n.ref} <span style={{ color: '#94a3b8', fontWeight: 500 }}>{tr('引脚')} {n.pad}</span></div>
                  <div style={{ fontSize: 10.5, color: '#64748b', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.mpn}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
