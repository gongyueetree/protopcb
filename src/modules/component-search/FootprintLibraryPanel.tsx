/**
 * modules/component-search/FootprintLibraryPanel.tsx
 * 封装库浏览 —— 按分类浏览封装并直接加到画布（生成自定义器件）。
 * 数据链：组织库 → ezPLM 云端 → 大模型联网检索（当前 demo 为 Mock，链路见 Provider 层）。
 */
import { tr } from '../../shared/i18n';
import { parseKicadMod } from '../../design-core/geometry/kicad-file-parser';
import { registerFootprintOverride } from '../../design-core/geometry/lib-file-registry';
import { useState, useEffect } from 'react';
import { useDesignStore } from '../../state/designStore';
import { COLORS } from '../../shared/theme';
import type { ComponentSearchResult } from '../../providers/types';


export function FootprintLibraryPanel() {
  const addComponent = useDesignStore((s) => s.addComponent);

  // ── KiCad 官方库（gitlab.com/kicad/libraries，按需拉取，不打包） ──
  const [klOpen, setKlOpen] = useState(true);
  const [klLibs, setKlLibs] = useState<string[]>([]);
  const [klLib, setKlLib] = useState('');
  const [klItems, setKlItems] = useState<string[]>([]);
  const [klKw, setKlKw] = useState('');
  const [klBusy, setKlBusy] = useState<'' | 'libs' | 'items' | 'add'>('');
  const [klErr, setKlErr] = useState('');

  useEffect(() => { klLoadLibs(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const klLoadLibs = async () => {
    if (klLibs.length) return;
    setKlBusy('libs'); setKlErr('');
    try {
      const j = await fetch('/api/kicadlib?path=libs').then((r) => r.json());
      if (j.libs) setKlLibs(j.libs); else setKlErr(j.error ?? '加载失败');
    } catch { setKlErr(tr('网络错误，无法访问 KiCad 官方库')); }
    setKlBusy('');
  };
  const klLoadItems = async (lib: string) => {
    setKlLib(lib); setKlItems([]); setKlKw('');
    if (!lib) return;
    setKlBusy('items'); setKlErr('');
    try {
      const j = await fetch(`/api/kicadlib?path=list&lib=${encodeURIComponent(lib)}`).then((r) => r.json());
      if (j.items) setKlItems(j.items); else setKlErr(j.error ?? '加载失败');
    } catch { setKlErr(tr('网络错误，无法访问 KiCad 官方库')); }
    setKlBusy('');
  };
  const klAdd = async (name: string) => {
    setKlBusy('add'); setKlErr('');
    try {
      const text = await fetch(`/api/kicadlib?path=mod&lib=${encodeURIComponent(klLib)}&name=${encodeURIComponent(name)}`).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text(); });
      const fp = parseKicadMod(text);
      if (!fp || !fp.pads.length) throw new Error(tr('封装解析失败'));
      registerFootprintOverride(name, fp); // 精确焊盘注册 → 2D/3D/导出全链路生效
      // (model "…/X.3dshapes/Y.wrl") 是权威 3D 引用：解析目录与文件名，.wrl 换 .step（官方每个模型两种格式都有）
      const modelRef = text.match(/\(model\s+"([^"]+)"/)?.[1];
      let lib3d = klLib, name3d = name;
      if (modelRef) {
        const mm = modelRef.match(/([^/\\]+)\.3dshapes[/\\]([^/\\]+)\.(step|stp|wrl)$/i);
        if (mm) { lib3d = mm[1]; name3d = mm[2]; }
      }
      const cat2 = /Connector|Socket|Terminal/i.test(klLib) ? 'connector'
        : /Resistor|Capacitor|Inductor|LED|Diode|Crystal|Fuse/i.test(klLib) ? 'passive'
        : /Relay|Button|Switch|Buzzer|Motor/i.test(klLib) ? 'electromech'
        : /RF|Antenna/i.test(klLib) ? 'rf' : 'ic';
      addComponent({
        componentId: `kicadlib_${name}_${Date.now()}`,
        mpn: name, manufacturer: 'KiCad库', category: cat2,
        defaultFootprintName: name, family: 'Footprint',
        description: `KiCad 官方封装 · ${klLib}`,
        pins: fp.pads.length,
        stepUrl: `/api/kicadlib?path=step&lib=${encodeURIComponent(lib3d)}&name=${encodeURIComponent(name3d)}`,
      } as ComponentSearchResult);
    } catch (e) { setKlErr(tr('添加失败：') + (e as Error).message); }
    setKlBusy('');
  };
  const klFiltered = klKw.trim() ? klItems.filter((n) => n.toLowerCase().includes(klKw.trim().toLowerCase())) : klItems;

  return (
    <div>
      {/* KiCad 官方库：一万多个封装按需拉取 */}
      <div style={{ marginBottom: 10, borderRadius: 10, border: '1px solid #e2e8f0', background: '#fff', overflow: 'hidden' }}>
        <div onClick={() => { setKlOpen(!klOpen); if (!klOpen) klLoadLibs(); }}
          style={{ padding: '8px 12px', fontSize: 12, fontWeight: 700, color: '#1a4a2e', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', background: '#f0f6f1' }}>
          <span>📚 {tr('KiCad 官方封装库')}</span><span>{klOpen ? '▾' : '▸'}</span>
        </div>
        {klOpen && (
          <div style={{ padding: 10 }}>
            <div style={{ fontSize: 9.5, color: '#94a3b8', marginBottom: 6 }}>{tr('来源 gitlab.com/kicad/libraries · 按需拉取封装与 3D，不占本地空间')}</div>
            {klBusy === 'libs' && <div style={{ fontSize: 11, color: '#94a3b8' }}>{tr('加载库列表…')}</div>}
            {klLibs.length > 0 && (
              <select value={klLib} onChange={(e) => klLoadItems(e.target.value)}
                style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 11.5, marginBottom: 6, boxSizing: 'border-box' }}>
                <option value="">{tr('选择封装库…')}（{klLibs.length}）</option>
                {klLibs.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            )}
            {klLib && (
              <input value={klKw} onChange={(e) => setKlKw(e.target.value)} placeholder={tr('在库内筛选封装名…')}
                style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 11.5, marginBottom: 6, boxSizing: 'border-box', outline: 'none' }} />
            )}
            {klBusy === 'items' && <div style={{ fontSize: 11, color: '#94a3b8' }}>{tr('加载封装列表…')}</div>}
            {klLib && !klBusy && <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 4 }}>{klFiltered.length} / {klItems.length}</div>}
            <div style={{ maxHeight: 220, overflow: 'auto' }}>
              {klFiltered.slice(0, 200).map((n) => (
                <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', marginBottom: 3, borderRadius: 6, background: '#f8fafc', fontSize: 10.5 }}>
                  <span style={{ flex: 1, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={n}>{n}</span>
                  <button disabled={klBusy === 'add'} onClick={() => klAdd(n)}
                    style={{ padding: '3px 9px', borderRadius: 5, border: 'none', background: COLORS.green, color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer', opacity: klBusy === 'add' ? 0.5 : 1 }}>＋</button>
                </div>
              ))}
              {klFiltered.length > 200 && <div style={{ fontSize: 10, color: '#94a3b8', padding: 4 }}>{tr('仅显示前 200 个，请用筛选缩小范围')}</div>}
            </div>
            {klErr && <div style={{ fontSize: 10.5, color: '#b91c1c', marginTop: 4 }}>{klErr}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
