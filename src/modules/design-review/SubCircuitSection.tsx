/**
 * modules/design-review/SubCircuitSection.tsx
 * 子电路推荐 —— 从"当前元件"页移到 AI 顾问页。
 *
 * 顺序遵循 Reuse > Modify > Generate：
 *   参考设计 / 组织内项目（ReferenceDesignSection）在器件详情里先呈现；
 *   这里是"都没有参考时"由模型给出的典型应用电路，明确标注来源，需用户确认后才上画布。
 */
import { useState } from 'react';
import { useDesignStore } from '../../state/designStore';
import { tr } from '../../shared/i18n';

import { recommendSubCircuit, type SubCircuitItem } from '../component-search/sub-circuit';
import { ReferenceDesignSection } from '../component-search/ReferenceDesignSection';
import { autoKicadFootprint } from '../../design-core/geometry/auto-kicad-footprint';
import { ensureKicadSymbolByMpn } from '../../design-core/geometry/lib-file-registry';

export function SubCircuitSection() {
  const doc = useDesignStore((s) => s.doc);
  const selectedId = useDesignStore((s) => s.selectedId);
  const placeSubCircuit = useDesignStore((s) => s.placeSubCircuit);
  const reoptimizeGroup = useDesignStore((s) => s.reoptimizeGroup);
  const [items, setItems] = useState<SubCircuitItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const c = doc.components.find((x) => x.instanceId === selectedId);
  const isSatellite = !!c?.display?.anchorRef;
  const satCount = c ? doc.components.filter((x) => x.display?.anchorRef === c.reference).length : 0;

  const run = async () => {
    if (!c || busy) return;
    setBusy(true); setMsg(''); setItems(null);
    try {
      setItems(await recommendSubCircuit({ mpn: c.mpn, manufacturer: c.manufacturer, description: c.display?.description }));
    } catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  };

  const load = () => {
    if (!c || !items?.length) return;
    const n = placeSubCircuit(c.instanceId, items);
    setMsg(`✓ ${tr('已上画布')} ${n} ${tr('个器件（围绕')} ${c.reference}${tr('），正在关联 KiCad 官方封装与符号…')}`);
    const fps = [...new Set(items.map((x) => x.footprint).filter(Boolean))];
    Promise.allSettled(fps.map(async (fp) => {
      const stepUrl = await autoKicadFootprint(fp);
      if (stepUrl) useDesignStore.getState().setStepUrlByFootprint(fp, stepUrl);
    })).then(() => setMsg(`✓ ${tr('已上画布')} ${n} ${tr('个器件，封装/3D 已按 KiCad 官方库关联')}`));
    for (const it of items) ensureKicadSymbolByMpn(it.mpn ?? it.value);
    setItems(null);
  };

  if (!c) {
    return (
      <div style={{ padding: '14px 12px', fontSize: 11, color: '#94a3b8', lineHeight: 1.7 }}>
        {tr('在画布上选中一个核心器件，这里会推荐它的典型应用电路（去耦、上拉、晶振、接口保护等）。')}
      </div>
    );
  }

  return (
    <div style={{ padding: 10, borderRadius: 8, background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: '#15803d' }}>🧩 {c.reference} {c.mpn}</span>
        <span style={{ flex: 1 }} />
        {satCount > 0 && (
          <button onClick={() => { const r = reoptimizeGroup(c.instanceId); setMsg(`✓ ${tr('已重排')} ${r.moved} ${tr('个附属器件')}${r.violations ? `（${r.violations} ${tr('个仍有冲突')}）` : ''}`); }}
            title={tr('保持围绕核心的相对关系重新摆放，避开定位孔与其它器件')}
            style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #bbf7d0', background: '#fff', color: '#15803d', fontSize: 10.5, fontWeight: 700, cursor: 'pointer' }}>
            ↻ {tr('重排附属器件')}（{satCount}）
          </button>
        )}
        {!isSatellite && (
          <button onClick={run} disabled={busy}
            style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: busy ? '#d6d3d1' : '#15803d', color: '#fff', fontSize: 10.5, fontWeight: 700, cursor: busy ? 'default' : 'pointer' }}>
            {busy ? '⟳ ' + tr('分析中…') : '🤖 ' + tr('推荐')}
          </button>
        )}
      </div>
      <div style={{ fontSize: 9.5, color: '#4d7c0f', marginBottom: 6 }}>
        {isSatellite ? tr('该器件是子电路的一部分') : tr('优先用参考设计，无参考才由 AI 推断')}
      </div>

      {/* ① 参考设计 / 组织内用过该器件的项目（从器件详情页整块移来，
             与下面的 AI 推断是同一个问题的两个阶段：先复用，找不到才生成） */}
      {!isSatellite && <div style={{ marginBottom: 8 }}><ReferenceDesignSection c={c} /></div>}
      {msg && <div style={{ fontSize: 10, color: msg.startsWith('✓') ? '#15803d' : '#b45309', marginBottom: 4 }}>{msg}</div>}
      {!!items?.length && (
        <>
          <div style={{ maxHeight: 280, overflowY: 'auto', paddingRight: 2 }}>
            {items.map((it, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '4px 8px', marginBottom: 3, borderRadius: 5, background: '#fff', border: '1px solid #dcfce7', fontSize: 10.5 }}>
                <span style={{ fontWeight: 700, color: '#166534', minWidth: 72 }}>{tr(it.role)}</span>
                <span style={{ fontFamily: 'monospace' }}>{it.value}{it.qty > 1 ? ` ×${it.qty}` : ''}</span>
                <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: '#f1f5f9', color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{it.footprint}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 9.5, color: '#64748b', whiteSpace: 'nowrap' }}>→ {it.connectsTo}</span>
              </div>
            ))}
          </div>
          <button onClick={load} style={{ width: '100%', marginTop: 4, padding: '6px 0', borderRadius: 6, border: 'none', background: '#16a34a', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
            ⬇ {tr('一键上画布')}（{items.reduce((a, b) => a + b.qty, 0)} {tr('个器件，围绕')} {c.reference}）
          </button>
        </>
      )}
    </div>
  );
}

