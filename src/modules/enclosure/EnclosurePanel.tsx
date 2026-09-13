/**
 * modules/enclosure/EnclosurePanel.tsx
 * 3D 结构页 —— 外壳参数、确定性干涉检查、包络尺寸、STL 导出。
 * 所有数字来自 design-core/enclosure 的纯几何计算，无 AI 推断。
 */
import { useMemo } from 'react';
import { useDesignStore } from '../../state/designStore';
import { useLibFileStore } from '../../design-core/geometry/lib-file-registry';
import { tr } from '../../shared/i18n';
import { COLORS } from '../../shared/theme';
import {
  DEFAULT_ENCLOSURE, PCB_THICKNESS_MM, heightEnvelope, computeEnclosureDims, checkEnclosure, buildEnclosureStl,
} from '../../design-core/enclosure';
import { deriveOpenings, deriveMounting } from '../../design-core/enclosure/openings';
import { buildCadQueryScript } from '../../design-core/enclosure/cadquery';

const box: React.CSSProperties = { background: '#fff', borderRadius: 10, border: '1px solid #E8F3EE', padding: 12, marginBottom: 10 };
const title: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: COLORS.green, marginBottom: 8 };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11.5, color: '#475569', padding: '3px 0' };
const num: React.CSSProperties = { width: 62, padding: '3px 6px', borderRadius: 5, border: '1px solid #dbe6dd', fontSize: 11.5, textAlign: 'right' };

export function EnclosurePanel() {
  const doc = useDesignStore((s) => s.doc);
  const setEnclosure = useDesignStore((s) => s.setEnclosure);
  const spec = { ...DEFAULT_ENCLOSURE, ...(doc.enclosure ?? {}) };
  // 工程导入后封装是**异步**匹配上的（KiCad 官方库/内嵌定义注册进来会 bump libVersion）。
  // 开孔位置、器件高度、内腔尺寸全都依赖真实封装，所以必须跟着 libVersion 重算，
  // 否则一直停在导入瞬间用名字猜出来的那套几何上（开孔对不上连接器的根因）。
  const libVersion = useLibFileStore((s) => s.version);

  const { env, dims, issues, openings, mounting } = useMemo(() => {
    const e = heightEnvelope(doc.components);
    return {
      env: e, dims: computeEnclosureDims(doc.board, e, spec), issues: checkEnclosure(doc, spec),
      openings: deriveOpenings(doc), mounting: deriveMounting(doc.board),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, libVersion, spec.wallMm, spec.sideClearanceMm, spec.standoffMm, spec.topClearanceMm, spec.bottomClearanceMm, spec.lidMm]);

  const field = (label: string, key: keyof typeof spec, hint: string, step = 0.1) => (
    <div style={row} title={hint}>
      <span>{tr(label)}</span>
      <span>
        <input type="number" step={step} value={spec[key] as number}
          onChange={(e) => setEnclosure({ [key]: Number(e.target.value) } as Partial<typeof spec>)} style={num} /> mm
      </span>
    </div>
  );

  const exportCadQuery = () => {
    const name = (doc.name || 'enclosure').replace(/\s+/g, '_');
    const py = buildCadQueryScript({ name, spec, dims, openings, mounting, board: doc.board, pcbThicknessMm: PCB_THICKNESS_MM });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([py], { type: 'text/x-python' }));
    a.download = `${name}-enclosure.py`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const exportStl = () => {
    const stl = buildEnclosureStl(doc.board, env, spec, (doc.name || 'enclosure').replace(/\s+/g, '_'));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([stl], { type: 'model/stl' }));
    a.download = `${doc.name || 'design'}-enclosure.stl`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const errCount = issues.filter((i) => i.level === 'error').length;
  const warnCount = issues.filter((i) => i.level === 'warn').length;

  return (
    <div style={{ padding: 12, overflow: 'auto', height: '100%', background: '#f8fafc' }}>
      <div style={box}>
        <div style={title}>🧰 {tr('外壳协同')}</div>
        <label style={{ ...row, cursor: 'pointer' }}>
          <span style={{ fontWeight: 600 }}>{tr('在 3D 视图中显示外壳')}</span>
          <input type="checkbox" checked={spec.enabled} onChange={(e) => setEnclosure({ enabled: e.target.checked })} />
        </label>
        <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4, lineHeight: 1.5 }}>
          {tr('由 PCB 外形与器件高度包络推出的参数化外壳。不含卡扣、加强筋、拔模与螺纹孔，适合原型阶段尺寸协同与 3D 打印初版。')}
        </div>
      </div>

      <div style={box}>
        <div style={title}>📐 {tr('结构参数')}</div>
        {field('壁厚', 'wallMm', tr('外壳侧壁与底板厚度；FDM 打印建议 ≥1.2mm'))}
        {field('侧向间隙', 'sideClearanceMm', tr('PCB 边缘到内壁的单边间隙，需覆盖制板公差'))}
        {field('支柱高度', 'standoffMm', tr('PCB 底面到内腔底面的距离，必须容纳底面器件'))}
        {field('顶部净空', 'topClearanceMm', tr('顶面最高器件到内顶面的净空'))}
        {field('底面净空', 'bottomClearanceMm', tr('底面器件到内腔底面的净空'))}
        {field('顶盖厚度', 'lidMm', tr('顶盖板厚'))}
      </div>

      <div style={box}>
        <div style={title}>📦 {tr('包络尺寸')}</div>
        <div style={row}><span>{tr('外形 长×宽×高')}</span><b style={{ fontFamily: 'monospace' }}>{dims.outerW.toFixed(1)} × {dims.outerH.toFixed(1)} × {dims.outerHeight.toFixed(1)}</b></div>
        <div style={row}><span>{tr('内腔 长×宽×深')}</span><span style={{ fontFamily: 'monospace' }}>{dims.innerW.toFixed(1)} × {dims.innerH.toFixed(1)} × {dims.innerDepth.toFixed(1)}</span></div>
        <div style={row}><span>{tr('顶面最高器件')}</span><span>{env.topTallest ? `${env.topTallest.reference} ${env.topMaxMm.toFixed(1)}mm` : '—'}</span></div>
        <div style={row}><span>{tr('底面最高器件')}</span><span>{env.bottomTallest ? `${env.bottomTallest.reference} ${env.bottomMaxMm.toFixed(1)}mm` : '—'}</span></div>
        <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>
          {env.estimatedCount > 0
            ? `⚠ ${env.estimatedCount} ${tr('个器件高度为估算值（非 datasheet 实测）')}`
            : tr('全部器件高度来自 datasheet 机械图')}
        </div>
      </div>

      <div style={box}>
        <div style={title}>🕳 {tr('开孔与固定')}<span style={{ marginLeft: 8, fontWeight: 600, color: '#64748b' }}>{openings.length} {tr('处开孔')}</span></div>
        {openings.length === 0 ? (
          <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.6 }}>
            {tr('未识别到需要开孔的器件。连接器需靠近板边、显示屏/按键/LED 需在顶面才会自动开孔。')}
          </div>
        ) : openings.map((o, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', fontSize: 11, borderTop: i ? '1px solid #f8fafc' : 'none' }}>
            <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, fontWeight: 700, background: o.face === 'top' ? '#fef3c7' : '#e0f2fe', color: o.face === 'top' ? '#92400e' : '#0369a1' }}>
              {tr(o.face === 'top' ? '顶盖' : '侧壁')}
            </span>
            <b style={{ color: COLORS.green }}>{o.reference}</b>
            <span style={{ fontFamily: 'monospace', color: '#475569' }}>
              {o.shape === 'circle' ? `Ø${o.w.toFixed(1)}` : `${o.w.toFixed(1)}×${o.h.toFixed(1)}`} mm
            </span>
            <span style={{ flex: 1 }} />
            <span title={o.reason} style={{ fontSize: 9.5, color: '#94a3b8', cursor: 'help', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>{tr(o.reason)}</span>
          </div>
        ))}
        <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px dashed #e2e8f0', fontSize: 11, color: '#475569' }}>
          <b style={{ color: COLORS.green }}>{tr(mounting.kind === 'screw-post' ? '螺柱固定' : '卡扣固定')}</b>
          <span style={{ marginLeft: 6, color: '#64748b' }}>{tr(mounting.detail)}</span>
        </div>
      </div>

      <div style={box}>
        <div style={title}>
          🔍 {tr('干涉检查')}
          <span style={{ marginLeft: 8, fontWeight: 600, color: errCount ? '#b91c1c' : warnCount ? '#a16207' : '#15803d' }}>
            {errCount ? `${errCount} ${tr('项冲突')}` : warnCount ? `${warnCount} ${tr('项提醒')}` : tr('未发现冲突')}
          </span>
        </div>
        {issues.length === 0 ? (
          <div style={{ fontSize: 11, color: '#15803d' }}>✓ {tr('当前参数下 PCB 与外壳无几何冲突')}</div>
        ) : issues.map((i, k) => (
          <div key={k} style={{
            fontSize: 11, lineHeight: 1.55, padding: '7px 9px', borderRadius: 7, marginBottom: 6,
            background: i.level === 'error' ? '#fef2f2' : i.level === 'warn' ? '#fffbeb' : '#f8fafc',
            border: `1px solid ${i.level === 'error' ? '#fecaca' : i.level === 'warn' ? '#fde68a' : '#e2e8f0'}`,
            color: i.level === 'error' ? '#b91c1c' : i.level === 'warn' ? '#92400e' : '#475569',
          }}>
            {i.level === 'error' ? '🔴 ' : i.level === 'warn' ? '🟡 ' : 'ℹ️ '}{tr(i.message)}
          </div>
        ))}
        <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
          {tr('以上均为几何计算结论，可逐条复算；不含强度、散热、EMC 等分析。')}
        </div>
      </div>

      <button onClick={exportCadQuery} style={{ width: '100%', padding: '9px 0', marginBottom: 8, borderRadius: 8, border: '1px solid #c7d2fe', background: '#eef2ff', color: '#4338ca', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
        🐍 {tr('导出 CadQuery 脚本（可生成真实 STEP）')}
      </button>
      <button onClick={exportStl} style={{ width: '100%', padding: '9px 0', borderRadius: 8, border: 'none', background: `linear-gradient(135deg,#245b3a,${COLORS.green})`, color: '#fff', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
        ⬇ {tr('导出外壳 STL（底壳）')}
      </button>
      <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 6, lineHeight: 1.5 }}>
        {tr('STL 是三角网格（可直接 3D 打印），不含开孔；CadQuery 脚本包含全部开孔与螺柱/卡扣位，在 CadQuery 或 FreeCAD 中运行即可得到真实 STEP —— 浏览器里做不了 B-rep 布尔运算，所以我们出脚本而不是假装出 STEP。')}
      </div>
    </div>
  );
}
