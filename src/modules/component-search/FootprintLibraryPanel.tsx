/**
 * modules/component-search/FootprintLibraryPanel.tsx
 * 封装库浏览 —— 按分类浏览封装并直接加到画布（生成自定义器件）。
 * 数据链：组织库 → ezPLM 云端 → 大模型联网检索（当前 demo 为 Mock，链路见 Provider 层）。
 */
import { useState, useEffect } from 'react';
import { getProviders } from '../../providers/factory';
import { useDesignStore } from '../../state/designStore';
import { FOOTPRINT_CATEGORIES } from '../../providers/mock/data';
import { COLORS } from '../../shared/theme';
import type { FootprintOption, ComponentSearchResult } from '../../providers/types';

const providers = getProviders();

export function FootprintLibraryPanel() {
  const [cat, setCat] = useState<string | null>(null);
  const [list, setList] = useState<FootprintOption[]>([]);
  const addComponent = useDesignStore((s) => s.addComponent);

  useEffect(() => { providers.components.listFootprints(cat ?? undefined).then(setList); }, [cat]);

  const addFootprint = (f: FootprintOption) => {
    // 封装 → 自定义器件（无型号，仅封装占位，用于纯布板评估）
    const cat2 = f.category === 'smd_chip' ? 'passive' : f.category === 'conn' || f.category === 'tht' ? 'connector' : 'ic';
    const r: ComponentSearchResult = {
      componentId: `fp_${f.footprintId}_${Date.now()}`,
      mpn: f.name, manufacturer: '—', category: cat2 as ComponentSearchResult['category'],
      defaultFootprintName: f.name, family: 'Footprint', description: `封装占位：${f.name}（来源 ${f.source}）`,
      pins: f.geometry.padCount,
    };
    addComponent(r);
  };

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        {FOOTPRINT_CATEGORIES.map((c) => (
          <button key={c.id} onClick={() => setCat(cat === c.id ? null : c.id)}
            style={{ padding: '4px 10px', borderRadius: 16, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: `1px solid ${cat === c.id ? COLORS.green : '#dbe6dd'}`, background: cat === c.id ? COLORS.greenBg : '#fff', color: cat === c.id ? COLORS.green : '#64748b' }}>
            {c.icon} {c.name}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }}>共 {list.length} 个封装 · 点击 + 直接放到画布</div>
      {list.map((f) => (
        <div key={f.footprintId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', marginBottom: 6, borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: '#1e293b' }}>{f.name}</div>
            <div style={{ fontSize: 10, color: '#94a3b8' }}>{f.source} · {f.geometry.padCount}脚 · {f.geometry.bodyWidthMm}×{f.geometry.bodyHeightMm}mm</div>
          </div>
          <button onClick={() => addFootprint(f)} style={{ width: 26, height: 26, borderRadius: 6, border: 'none', background: COLORS.green, color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>+</button>
        </div>
      ))}
    </div>
  );
}
