/**
 * modules/component-search/CompDetail.tsx
 * 右侧「当前元件」详情面板（从 App.tsx 拆出）：型号/封装/符号关联、KiCad 官方库检索、
 * 供应商报价、3D 预览、参考设计入口。
 */
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useDesignStore } from '../../state/designStore';
import { LibraryPreview } from '../../modules/component-search/LibraryPreview';
import { padFootprintFor as padFootprintForT } from '../../design-core/geometry/footprint-pads';
import { fetchDigikeyOffer, formatDkPrice, type DigikeyOffer } from '../../application/pricing';
import { fetchSupplierOffers, fmtOfferPrice, type SupplierOffer } from '../../application/pricing';
import { searchEzplmParts } from '../../application/parts';
import { loadCustomParts, deleteCustomPart, customPartToResult, type CustomPart } from '../../design-core/custom-lib';
import { parseKicadMod } from '../../design-core/geometry/kicad-file-parser';
import { TRUST_META } from '../../providers/ai-schema';
import { useAccessContext, anonymousContext } from '../../state/useAccessContext';
import { useT, useTranslated, tr } from '../../shared/i18n';
import { registerFootprintOverride, registerSymbolOverride, symbolOverrideFor, footprintOverrideFor } from '../../design-core/geometry/lib-file-registry';
import { parseKicadSym } from '../../design-core/geometry/lib-file-registry';
import type { PlacedComponent as PlacedComponentT } from '../../design-core/document/types';
import { dialogs } from '../../modules/ui/dialogStore';

import { COLORS, CATEGORY_DISPLAY } from '../../shared/theme';
import { bumpLibRegistry } from '../../design-core/geometry/lib-file-registry';
import { keyOf } from '../../shared/storage';
import { kicadLibrary } from '../../application/library';
import { linkBtn } from '../../shared/ui-styles';
import { getProviders } from '../../providers/factory';

const providers = getProviders();

export function CompDetail({ iid, onBuild }: { iid: string; onBuild?: (mpn: string) => void }) {
  const ctx = useAccessContext() ?? anonymousContext();
  const t = useT();
  const c = useDesignStore((s) => s.doc.components.find((x) => x.instanceId === iid));
  const [alts, setAlts] = useState<{ mpn: string; manufacturer: string; note: string; channel: string; footprint?: string; description?: string }[]>([]);
  const [, setOffers] = useState<{ vendor: string; price?: { amount: number; currency: string }; stock?: number; url: string }[]>([]);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof providers.components.getComponentDetail>>>(null);
  const [dkOffer, setDkOffer] = useState<DigikeyOffer | null>(null);
  /** DigiKey 查询状态：null 表示还在飞，'done' 表示查完（无论是否命中）—— 
      此前只在命中时才赋值，查不到就永远停在"查询中…" */
  const [dkState, setDkState] = useState<'loading' | 'done' | 'unavailable'>('loading');
  const [supOffers, setSupOffers] = useState<SupplierOffer[]>([]);
  useEffect(() => {
    if (!c) return;
    setDkOffer(null); setDkState('loading');
    // 自建/占位器件的型号不是真实厂商料号，不查供应商（否则会匹配到无关器件的图片与价格）
    const isSynthetic = c.componentId?.startsWith('custom_') || c.componentId?.startsWith('fp_');
    // 分销商实时查询用的是平台 Key：未登录不发请求（服务端本来也会 401，但别白跑一趟）
    if (isSynthetic) setDkState('unavailable');
    else {
      fetchDigikeyOffer(c.mpn)
        .then((o) => { if (o?.found) setDkOffer(o); setDkState('done'); })
        .catch(() => setDkState('done'));
    }
    setSupOffers([]);
    if (!isSynthetic) fetchSupplierOffers(c.mpn).then(setSupOffers);
    providers.components.getAlternatives(c.componentId, ctx).then(setAlts);
    providers.components.getSupplierOffers(c.componentId, ctx).then(setOffers);
    providers.components.getComponentDetail(c.componentId, ctx).then(setDetail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c?.componentId, ctx?.userId]);
  if (!c) return null;
  const disp = CATEGORY_DISPLAY[c.category];
  const coreParams = detail?.coreParams ?? c.display?.attributes ?? {};
  const paramEntries = Object.entries(coreParams).slice(0, 10);
  return (
    <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid #e2e8f0' }}>
      {/* 头部：位号+型号 与 图片同行 */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{c.reference}</div>
          <div style={{ fontSize: 14, fontFamily: 'monospace', color: COLORS.green, fontWeight: 600, wordBreak: 'break-all' }}>{c.mpn}</div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{c.display?.classification ?? disp.name} · {c.manufacturer} · {c.footprint.name}</div>
          {c.display?.classification && <span style={{ display: 'inline-block', marginTop: 4, fontSize: 9.5, padding: '1px 7px', borderRadius: 4, background: '#f1f5f9', color: '#475569', fontWeight: 600 }}>{t('分类：')}<TrSpan text={c.display.classification} /></span>}
          {/* 可信等级：让"数据库事实"与"模型猜测"在界面上可区分 */}
          {(() => {
            const lv = c.trust?.level ?? 'PLACEHOLDER';
            const m = TRUST_META[lv];
            return (
              <span title={c.trust?.evidence ?? tr('来源未知，需人工核对 datasheet')}
                style={{ display: 'inline-block', marginTop: 4, marginLeft: 4, fontSize: 9.5, padding: '1px 7px', borderRadius: 4, background: m.bg, color: m.color, fontWeight: 700, cursor: 'help' }}>
                {lv === 'VERIFIED' ? '✓ ' : lv === 'CANDIDATE' ? '? ' : '⚠ '}{tr(m.label)}
              </span>
            );
          })()}
        </div>
        <ComponentImage c={c} imageUrl={detail?.imageUrl ?? c.display?.imageUrl ?? dkOffer?.photoUrl} />
      </div>

      {/* 官网 + PDF */}
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        {(detail?.productUrl ?? c.display?.officialUrl)
          ? <a href={detail?.productUrl ?? c.display?.officialUrl} target="_blank" rel="noreferrer" style={linkBtn}>{tr('🌐 官网')}</a>
          : <a href={`https://www.google.com/search?q=${encodeURIComponent(c.manufacturer + ' ' + c.mpn)}`} target="_blank" rel="noreferrer" style={linkBtn}>{tr('🌐 官网检索')}</a>}
        {(detail?.datasheetUrl ?? c.display?.datasheetUrl)
          ? <a href={detail?.datasheetUrl ?? c.display?.datasheetUrl} target="_blank" rel="noreferrer" style={{ ...linkBtn, borderColor: '#fecaca', background: '#fef2f2', color: '#dc2626' }}>{tr('📄 PDF下载')}</a>
          : <a href={`https://www.google.com/search?q=${encodeURIComponent(c.mpn + ' datasheet pdf')}`} target="_blank" rel="noreferrer" style={{ ...linkBtn, borderColor: '#fecaca', background: '#fef2f2', color: '#dc2626' }}>{tr('📄 PDF检索')}</a>}
      </div>

      {/* 核心参数 */}
      {paramEntries.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.green, marginBottom: 6 }}>⚙️ {t('核心参数')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            {paramEntries.map(([k, v]) => (
              <div key={k} style={{ padding: '4px 8px', borderRadius: 6, background: '#f8fafc', border: '1px solid #f1f5f9', fontSize: 10.5 }}>
                <span style={{ color: '#94a3b8' }}>{k}</span> <span style={{ fontWeight: 600, color: '#334155' }}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {c.display?.description && <div style={{ fontSize: 12, color: '#475569', marginTop: 10 }}><TrSpan text={c.display.description} /></div>}

      {/* 封装占位器件：补型号 + 上传自定义原理图符号 */}
      {(c.display?.family === 'Footprint'
        || !hasRealMpn(c.mpn)
        || (!c.display?.symbolFileUrl && !c.display?.symbolFromMpn && !c.customSymbolSvg)
        || (!c.display?.footprintFileUrl && !footprintOverrideFor(c.footprint.name))) && <FootprintPartEditor c={c} onBuild={onBuild} />}

      <LibraryPreview c={c} />

      {/* 参考设计智能已移到右侧「AI 顾问 → 配套电路推荐」，与 AI 推断合并在一处 */}

      {/* 采购渠道：仅当型号明确（真实 MPN）时显示并查询；分销商侧已做精确匹配 */}
      {hasRealMpn(c.mpn) && (<>
      <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: '#f0f9ff', border: '1px solid #bae6fd' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#0369a1', marginBottom: 6 }}>🛒 {t('采购渠道')}</div>
        {dkOffer?.found ? (
          <a href={dkOffer.productUrl} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', marginBottom: 4, borderRadius: 6, background: '#fff', border: '1px solid #e0f2fe', textDecoration: 'none' }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: '#be123c', width: 66 }}>DigiKey</span>
            <span style={{ fontSize: 9, padding: '0 5px', borderRadius: 3, background: '#dcfce7', color: '#166534', fontWeight: 700 }}>{tr('实时')}</span>
            <span style={{ fontSize: 11, color: '#059669', fontWeight: 600 }}>{formatDkPrice(dkOffer)}</span>
            <span style={{ fontSize: 10, color: '#64748b' }}>{tr('库存')} {dkOffer.stock?.toLocaleString() ?? '—'}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 10, color: '#94a3b8' }}>{tr('跳转 ↗')}</span>
          </a>
        ) : (
          <div style={{ fontSize: 10, color: '#94a3b8', padding: '4px 8px', marginBottom: 4 }}>
            DigiKey：{dkState === 'loading' ? tr('查询中…') : dkState === 'unavailable' ? tr('自建/占位器件不查询') : tr('未收录该型号')}
          </div>
        )}
        {/* Mouser/Arrow/element14：配置了 Key → 实时数据；未配置 → 演示数据占位 */}
        {['Mouser', 'Arrow', 'element14', 'Iceasy', 'OURIC'].map((vendor) => {
          const real = supOffers.find((o) => o.vendor === vendor);
          if (real?.configured && real.found) {
            return (
              <a key={vendor} href={real.url} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', marginBottom: 4, borderRadius: 6, background: '#fff', border: '1px solid #e0f2fe', textDecoration: 'none' }}>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: '#0369a1', width: 66 }}>{vendor}</span>
                <span style={{ fontSize: 9, padding: '0 5px', borderRadius: 3, background: '#dcfce7', color: '#166534', fontWeight: 700 }}>{tr('实时')}</span>
                <span style={{ fontSize: 11, color: '#059669', fontWeight: 600 }}>{fmtOfferPrice(real)}</span>
                <span style={{ fontSize: 10, color: '#64748b' }}>{tr('库存')} {real.stock?.toLocaleString() ?? '—'}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 10, color: '#94a3b8' }}>{tr('跳转 ↗')}</span>
              </a>
            );
          }
          if (real?.configured && !real.found) {
            return <div key={vendor} style={{ fontSize: 10, color: '#94a3b8', padding: '4px 8px', marginBottom: 4 }}>{vendor}：{real.error ? tr('查询失败') : tr('未收录该型号')}</div>;
          }
          // Iceasy / OURIC 是真实对接渠道：不编演示价。但要分清三种情况 ——
          // 未登录（根本没发请求）/ 服务端说没配凭据 / 配了但这颗料查不到。
          // 此前一律显示"未配置凭据"，把 401 误报成配置问题（实际 Key 是配好的）。
          if (vendor === 'Iceasy' || vendor === 'OURIC') {
            return (
              <div key={vendor} style={{ fontSize: 10, color: '#94a3b8', padding: '4px 8px', marginBottom: 4 }}>
                {vendor}：{real
                  ? (real.error ? tr('查询失败') : tr('未收录该型号'))
                  : `${tr('未配置凭据')}（${vendor === 'Iceasy' ? 'ICEASY_ACCOUNT + ICEASY_PASSWORD' : 'OURIC_API_KEY + OURIC_API_SECRET'}）`}
              </div>
            );
          }
          const mock = mockOffers(c.mpn, vendor);
          return (
            <a key={vendor} href={mock.url} target="_blank" rel="noreferrer" title={`配置 ${vendor === 'Mouser' ? 'MOUSER_API_KEY' : vendor === 'Arrow' ? 'ARROW_LOGIN + ARROW_API_KEY' : 'ELEMENT14_API_KEY'} 后显示实时数据`}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', marginBottom: 4, borderRadius: 6, background: '#fff', border: '1px solid #e0f2fe', textDecoration: 'none', opacity: 0.8 }}>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: '#0369a1', width: 66 }}>{vendor}</span>
              <span style={{ fontSize: 9, padding: '0 5px', borderRadius: 3, background: '#fef3c7', color: '#92400e', fontWeight: 700 }}>{tr('演示')}</span>
              <span style={{ fontSize: 11, color: '#059669', fontWeight: 600 }}>¥{mock.price.toFixed(2)}</span>
              <span style={{ fontSize: 10, color: '#64748b' }}>{tr('库存')} {mock.stock.toLocaleString()}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 10, color: '#94a3b8' }}>{tr('跳转 ↗')}</span>
            </a>
          );
        })}
      </div>
      </>)}


      {/* 替代料（本组织映射） */}
      {alts.length > 0 && (
        <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#b45309', marginBottom: 6 }}>{tr('💡 替代料（本组织映射）')}</div>
          {alts.map((a, i) => (
            <div key={i} style={{ padding: '6px 8px', marginBottom: 4, borderRadius: 6, background: '#fff', border: '1px solid #fef3c7' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontFamily: 'monospace', fontSize: 11.5, fontWeight: 700 }}>{a.mpn}</span>
                <span style={{ fontSize: 9.5, color: '#94a3b8' }}>{a.manufacturer}</span>
                {a.footprint && <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: '#f1f5f9', color: '#475569', fontWeight: 600 }}>{a.footprint}</span>}
              </div>
              {a.description && <div style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>{a.description}</div>}
              <div style={{ fontSize: 10, color: '#64748b' }}>{a.note}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


/** 定制模块库面板：已保存器件列表 + 新建入口 */
export function CustomLibPanel({ onOpenWizard, onEditPart, wizardTick }: { onOpenWizard: () => void; onEditPart: (p: CustomPart) => void; wizardTick: number }) {
  const addComponent = useDesignStore((s) => s.addComponent);
  const [, setRefresh] = useState(0);
  const parts = useMemo(() => loadCustomParts(), [wizardTick]);
  return (
    <div>
      <button onClick={onOpenWizard} style={{ width: '100%', padding: '10px 0', borderRadius: 8, border: 'none', background: COLORS.green, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', marginBottom: 10 }}>
        {tr('＋ 新建定制器件（AI 提取 / 手工向导）')}
      </button>
      {parts.length === 0 && <div style={{ textAlign: 'center', padding: 30, color: '#94a3b8', fontSize: 11.5 }}>{tr('还没有定制器件')}<br />{tr('上传 Datasheet 或手工填写管脚即可构建')}</div>}
      {parts.map((p: CustomPart) => (
        <div key={p.id} style={{ padding: '9px 10px', marginBottom: 6, borderRadius: 8, background: '#fff', border: '1px solid #eef2f0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 9, padding: '0 5px', borderRadius: 3, background: '#f5f3ff', color: '#6d28d9', fontWeight: 700 }}>{tr('自建')}</span>
            <span style={{ fontFamily: 'monospace', fontSize: 12.5, fontWeight: 700, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.mpn}</span>
            <button onClick={() => addComponent(customPartToResult(p))} title={tr('放到画布')} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: COLORS.green, color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>＋</button>
            <button onClick={() => onEditPart(p)} title={tr('编辑该定制器件')} style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ddd6fe', background: '#f5f3ff', color: '#6d28d9', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>✎</button>
            <button onClick={() => { deleteCustomPart(p.id); setRefresh((x) => x + 1); }} style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 13 }}>×</button>
          </div>
          <div style={{ fontSize: 10.5, color: '#64748b', marginTop: 2 }}>{p.pins.length} {tr('脚')} · {p.footprintName}{p.description ? ' · ' + p.description : ''}</div>
        </div>
      ))}
    </div>
  );
}

/** 演示报价：按型号+渠道稳定哈希生成（对应渠道接入真实 API 后自动切换实时数据） */
function mockOffers(mpn: string, vendor: string): { price: number; stock: number; url: string } {
  let h = 0;
  for (const ch of mpn + vendor) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const base = 0.5 + (h % 2400) / 100;
  const urls: Record<string, string> = {
    Mouser: `https://www.mouser.cn/c/?q=${encodeURIComponent(mpn)}`,
    Arrow: `https://www.arrow.com/en/products/search?q=${encodeURIComponent(mpn)}`,
    element14: `https://cn.element14.com/search?st=${encodeURIComponent(mpn)}`,
  };
  return { price: base * (0.92 + (h % 20) / 100), stock: 300 + (h % 42000), url: urls[vendor] ?? '#' };
}

/** 封装占位器件编辑：补充型号 / 上传 SVG 原理图符号 */
function FootprintPartEditor({ c, onBuild }: { c: PlacedComponentT; onBuild?: (mpn: string) => void }) {
  const setMpn = useDesignStore((s) => s.setComponentMpn);
  const setSvg = useDesignStore((s) => s.setCustomSymbol);
  const linkSymbol = useDesignStore((s) => s.linkSymbolFrom);
  const linkSymbolByMpn = useDesignStore((s) => s.linkSymbolByMpn);
  const linkFootprint = useDesignStore((s) => s.linkFootprintFrom);
  const addFull = useDesignStore((s) => s.replaceComponentWith);
  // 关联模式：full=整体替换 / symbol=仅借符号 / footprint=仅借封装
  const [mode, setMode] = useState<'full' | 'symbol' | 'footprint' | null>(null);
  const [kw, setKw] = useState('');
  const [results, setResults] = useState<Awaited<ReturnType<typeof searchEzplmParts>>['items']>([]);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const doSearch = useCallback((q: string) => {
    const n = ++seq.current;
    if (!q.trim()) { setResults([]); setBusy(false); return; }
    setBusy(true);
    setTimeout(async () => {
      if (n !== seq.current) return;
      const r = await searchEzplmParts(q.trim(), 6).catch(() => ({ items: [] as typeof results }));
      if (n !== seq.current) return;
      setResults(r.items); setBusy(false);
    }, 250);
  }, []);
  // ── KiCad 官方库跨库关键词搜索 ──
  const [ksSearchKw, setKsSearchKw] = useState('');
  const [ksHits, setKsHits] = useState<{ lib: string; name: string }[]>([]);
  const [ksSearching, setKsSearching] = useState(false);
  const [kfSearchKw, setKfSearchKw] = useState('');
  const [kfHits, setKfHits] = useState<{ lib: string; name: string }[]>([]);
  const [kfSearching, setKfSearching] = useState(false);
  const libSearch = async (kind: 'sym' | 'fp', kw: string) => {
    const q = kw.trim();
    const setBusy = kind === 'sym' ? setKsSearching : setKfSearching;
    const setHits = kind === 'sym' ? setKsHits : setKfHits;
    if (q.length < 2) { setHits([]); return; }
    setBusy(true);
    try {
      const j = await (kind === 'sym' ? kicadLibrary.searchSymbols(q) : kicadLibrary.searchFootprints(q));
      setHits(Array.isArray(j.hits) ? j.hits : []);
    } catch { setHits([]); }
    setBusy(false);
  };

  // ── KiCad 官方封装库选择 ──
  const [kfOpen, setKfOpen] = useState(false);
  const [kfLibs, setKfLibs] = useState<string[]>([]);
  const [kfLib, setKfLib] = useState('');
  const [kfItems, setKfItems] = useState<string[]>([]);
  const [kfKw, setKfKw] = useState('');
  const [kfMsg, setKfMsg] = useState('');
  const linkFootprintByMpn = useDesignStore((s2) => s2.linkFootprintByMpn);
  const kfToggle = async () => {
    setKfOpen(!kfOpen);
    if (!kfOpen && !kfLibs.length) {
      setKfMsg(tr('加载封装库列表…'));
      try {
        const j = await kicadLibrary.listFootprintLibs();
        if (Array.isArray(j.libs) && j.libs.length) { setKfLibs(j.libs); setKfMsg(''); }
        else setKfMsg(String(j.error ?? tr('空列表')));
      } catch (e) { setKfMsg(tr('网络错误，无法访问 KiCad 官方库') + '：' + (e as Error).message); }
    }
  };
  const kfPickLib = async (lib: string) => {
    setKfLib(lib); setKfItems([]); setKfKw(''); setKfMsg('');
    if (!lib) return;
    try {
      const j = await kicadLibrary.listFootprints(lib);
      setKfItems(j.items ?? []);
    } catch { setKfMsg(tr('封装列表加载失败')); }
  };
  /**
   * @param libOverride 从搜索结果点进来时显式传库名。
   * 此前写法是 `setKfLib(h.lib); kfPick(h.name)` —— setState 是异步的，
   * kfPick 里读到的还是上一次渲染的 kfLib（首次为空串），请求变成 lib= 空 → HTTP 400 bad params，
   * 再点一次才因为 state 已更新而成功。这就是"第一次总是失败、第二次才好"的原因。
   */
  const kfPick = async (name: string, libOverride?: string) => {
    const lib = libOverride ?? kfLib;
    if (!lib) { setKfMsg(tr('请先选择封装库')); return; }
    setKfMsg(tr('加载封装…'));
    try {
      const r = await kicadLibrary.fetchFootprint(lib, name);
      if (!r.ok) { let d = ''; try { d = String((await r.json())?.error ?? ''); } catch { /* */ } throw new Error(`HTTP ${r.status}${d ? ' · ' + d : ''}`); }
      const text = await r.text();
      const fp = parseKicadMod(text);
      if (!fp || !fp.pads.length) throw new Error(tr('封装解析失败（无焊盘）'));
      registerFootprintOverride(name, fp);
      bumpLibRegistry();   // 通知 2D 画布重取焊盘（否则 3D 对了 2D 还是旧的）
      const modelRef = text.match(/\(model\s+"([^"]+)"/)?.[1];
      const mm = modelRef?.match(/([^/\\]+)\.3dshapes[/\\]([^/\\]+)\.(step|stp|wrl)$/i);
      const stepUrl = mm ? `/api/kicadlib?path=step&lib=${encodeURIComponent(mm[1])}&name=${encodeURIComponent(mm[2])}` : undefined;
      linkFootprintByMpn(c.mpn, { footprintName: name, stepUrl, pins: fp.pads.length }); // 同型号全部
      setKfMsg('✓ ' + tr('已关联封装') + ' ' + name + tr('（同型号器件已一并更新）'));
    } catch (e) { setKfMsg(tr('关联失败') + '：' + (e as Error).message); }
  };
  const kfFiltered = kfKw.trim() ? kfItems.filter((n) => n.toLowerCase().includes(kfKw.trim().toLowerCase())) : kfItems;

  // ── KiCad 官方符号库选择 ──
  const [ksOpen, setKsOpen] = useState(false);
  const [ksLibs, setKsLibs] = useState<string[]>([]);
  const [ksLib, setKsLib] = useState('');
  const [ksItems, setKsItems] = useState<string[]>([]);
  const [ksKw, setKsKw] = useState('');
  const [ksMsg, setKsMsg] = useState('');
  const ksToggle = async () => {
    setKsOpen(!ksOpen);
    if (!ksOpen && !ksLibs.length) {
      setKsMsg(tr('加载符号库列表…'));
      try {
        const j = await kicadLibrary.listSymbolLibs();
        if (Array.isArray(j.libs) && j.libs.length) { setKsLibs(j.libs); setKsMsg(''); }
        else setKsMsg((j.error ? `${j.error}` : tr('空列表')) + '（' + tr('可稍后重试') + '）');
      } catch (e) { setKsMsg(tr('网络错误，无法访问 KiCad 官方库') + '：' + (e as Error).message); }
    }
  };
  const ksPickLib = async (lib: string) => {
    setKsLib(lib); setKsItems([]); setKsKw(''); setKsMsg('');
    if (!lib) return;
    try { const j = await kicadLibrary.listSymbols(lib); setKsItems(j.items ?? []); }
    catch { setKsMsg(tr('网络错误，无法访问 KiCad 官方库')); }
  };
  /** libOverride 同 kfPick：避免读到尚未提交的 setState 值（首次点击 lib 为空 → 400） */
  const ksPick = async (name: string, isRetry = false, libOverride?: string) => {
    const lib = libOverride ?? ksLib;
    if (!lib) { setKsMsg(tr('请先选择符号库')); return; }
    setKsMsg(tr('加载符号…'));
    try {
      const r = await kicadLibrary.fetchSymbol(lib, name);
      if (!r.ok) {
        let d = '';
        try { d = String((await r.json())?.error ?? ''); } catch { /* 非 JSON */ }
        throw new Error(`HTTP ${r.status}${d ? ' · ' + d : ''}`);
      }
      const text = await r.text();
      const parsed = parseKicadSym(text);
      if (!parsed || !parsed.pins.length) {
        throw new Error(tr('符号解析失败') + `（${parsed ? tr('解析成功但 0 管脚') : tr('格式无法解析')}；${tr('开头')}：${text.slice(0, 50).replace(/\s+/g, ' ')}）`);
      }
      const key = `KICADSYM:${ksLib}:${name}`;
      registerSymbolOverride(key, parsed);
      try { localStorage.setItem(keyOf.ksym(key), text); } catch { /* 空间不足忽略 */ }
      linkSymbolByMpn(c.mpn, key); // 同型号全部器件一并关联
      setKsMsg(`✓ ${tr('已关联符号')} ${name}`);
      setKsOpen(false);
    } catch (e) {
      if (!isRetry) { ksPick(name, true, lib); return; }   // 首次可能命中过期分支引用，自动换正确 ref 重试一次
 setKsMsg(tr('添加失败：') + (e as Error).message); }
  };
  const ksFiltered = ksKw.trim() ? ksItems.filter((n) => n.toLowerCase().includes(ksKw.trim().toLowerCase())) : ksItems;

  // 一键诊断：把 拉取→解析→注册→渲染 每一步实况打出来
  const [ksDiag, setKsDiag] = useState('');
  const runKsDiag = async () => {
    const key = c.display?.symbolFromMpn ?? '';
    const L: string[] = [`key=${key || tr('（未关联）')}`, `family=${c.display?.family}`];
    try {
      if (key.startsWith('KICADSYM:')) {
        const parts = key.split(':');
        const r = await kicadLibrary.fetchSymbol(parts[1], parts.slice(2).join(':'));
        const text = await r.text();
        L.push(`拉取 HTTP ${r.status}，头部：${text.slice(0, 60).replace(/\s+/g, ' ')}`);
        if (r.ok) {
          const ps = parseKicadSym(text);
          L.push(ps ? `解析 ✓ pins=${ps.pins.length}` : '解析 ✗ 返回 null');
          if (ps && ps.pins.length) registerSymbolOverride(key, ps);
        }
      }
      L.push(`override 在库=${symbolOverrideFor(key) ? '✓' : '✗'}`);
    } catch (e) { L.push(tr('异常：') + (e as Error).message); }
    setKsDiag(L.join(' | '));
  };

  const openMode = (m: 'full' | 'symbol' | 'footprint') => {
    const next = mode === m ? null : m;
    setMode(next);
    if (next) { const q = c.mpn.startsWith('fp_') ? '' : c.mpn; setKw(q); setResults([]); doSearch(q); }
  };
  const applyPick = (r: (typeof results)[number]) => {
    if (mode === 'full') addFull(c.instanceId, r);
    else if (mode === 'symbol') linkSymbol(c.instanceId, { mpn: r.mpn, symbolFileUrl: r.symbolFileUrl });
    else if (mode === 'footprint') linkFootprint(c.instanceId, { footprintName: r.defaultFootprintName, footprintFileUrl: r.footprintFileUrl, stepUrl: r.stepUrl, pins: r.pins });
    setMode(null); setKw(''); setResults([]);
  };
  const [mpnText, setMpnText] = useState(c.mpn.startsWith('fp_') || c.display?.family === 'Footprint' ? '' : c.mpn);
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    if (!text.trim().startsWith('<svg') && !text.includes('<svg')) { dialogs.toast(tr('请上传 SVG 格式文件'), 'warning'); return; }
    setSvg(c.instanceId, text);
    e.target.value = '';
  };
  return (
    <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: '#fdf4ff', border: '1px solid #f0abfc' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#a21caf', marginBottom: 6 }}>{tr('📦 封装占位器件 · 补充信息')}</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <input value={mpnText} onChange={(e) => setMpnText(e.target.value)} placeholder={tr('输入器件型号，如 GD32F103C8T6')}
          style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: '1px solid #e9d5ff', fontSize: 11, outline: 'none' }}
          onKeyDown={(e) => { if (e.key === 'Enter' && mpnText.trim()) setMpn(c.instanceId, mpnText); }} />
        <button onClick={() => mpnText.trim() && setMpn(c.instanceId, mpnText)} style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: '#a21caf', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>{tr('设为型号')}</button>
      </div>
      {/* 从 ezPLM 库关联：整体 / 仅符号 / 仅封装 */}
      <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: '#fff', border: '1px solid #f0abfc' }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#86198f', marginBottom: 5 }}>{tr('🔗 从 ezPLM 库关联')}</div>
        <div style={{ display: 'flex', gap: 5 }}>
          {([['full', tr('📦 匹配型号'), tr('型号+符号+封装全部替换')], ['symbol', tr('📐 仅符号'), tr('只借用该器件的原理图符号，型号与封装不变')], ['footprint', tr('🔲 仅封装'), tr('只借用该器件的 PCB 封装与 3D，型号与符号不变')]] as const).map(([m, label, tip]) => (
            <button key={m} onClick={() => openMode(m)} title={tip}
              style={{ flex: 1, padding: '5px 4px', borderRadius: 5, fontSize: 10, fontWeight: 700, cursor: 'pointer',
                border: `1px solid ${mode === m ? '#a21caf' : '#e9d5ff'}`, background: mode === m ? '#fae8ff' : '#fff', color: mode === m ? '#86198f' : '#a855f7' }}>{label}</button>
          ))}
        </div>
        {mode && (
          <div style={{ marginTop: 6 }}>
            <input autoFocus value={kw} onChange={(e) => { setKw(e.target.value); doSearch(e.target.value); }}
              placeholder={mode === 'symbol' ? tr('搜索型号，借用其原理图符号…') : mode === 'footprint' ? tr('搜索型号，借用其封装…') : tr('搜索 ezPLM 型号…')}
              style={{ width: '100%', padding: '5px 8px', borderRadius: 5, border: '1px solid #e9d5ff', fontSize: 11, outline: 'none', boxSizing: 'border-box' }} />
            {busy && <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>{tr('搜索中…')}</div>}
            {!busy && kw.trim() && !results.length && <div style={{ fontSize: 10, color: '#b45309', marginTop: 4 }}>{tr('无匹配结果')}</div>}
            {results.map((r) => (
              <div key={r.componentId} onClick={() => applyPick(r)}
                style={{ padding: '5px 8px', marginTop: 4, borderRadius: 5, background: '#fdf4ff', border: '1px solid #f0abfc', cursor: 'pointer', fontSize: 10.5 }}>
                <b style={{ fontFamily: 'monospace' }}>{r.mpn}</b>
                <span style={{ color: '#94a3b8' }}> · {r.manufacturer}</span>
                <div style={{ color: '#a855f7', fontSize: 9.5, marginTop: 1 }}>
                  {mode === 'symbol' ? `借用符号${r.symbolFileUrl ? '（含 KiCad 符号文件）' : tr('（按引脚数生成）')}` : mode === 'footprint' ? `借用封装 ${r.defaultFootprintName}` : `${r.defaultFootprintName}`}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* KiCad 官方符号库：为占位器件挑一个真实原理图符号 */}
      <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: '#fff', border: '1px solid #bae6fd' }}>
        <div onClick={ksToggle} style={{ fontSize: 10, fontWeight: 700, color: '#0369a1', cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}>
          <span>📐 {tr('KiCad 官方符号库')}</span><span>{ksOpen ? '▾' : '▸'}</span>
        </div>
        {ksOpen && (
          <div style={{ marginTop: 6 }}>
            <div style={{ display: 'flex', gap: 4, marginBottom: 5 }}>
              <input value={ksSearchKw} onChange={(e) => setKsSearchKw(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') libSearch('sym', ksSearchKw); }}
                placeholder={tr('跨库搜索符号，如 STM32F103 / LED')}
                style={{ flex: 1, padding: '5px 8px', borderRadius: 5, border: '1px solid #7dd3fc', fontSize: 11, boxSizing: 'border-box', outline: 'none' }} />
              <button onClick={() => libSearch('sym', ksSearchKw)} disabled={ksSearching || ksSearchKw.trim().length < 2}
                style={{ padding: '5px 10px', borderRadius: 5, border: 'none', background: '#0369a1', color: '#fff', fontSize: 10.5, fontWeight: 700, cursor: ksSearching ? 'wait' : 'pointer', opacity: ksSearchKw.trim().length < 2 ? 0.5 : 1 }}>
                {ksSearching ? '⟳' : '🔍'}
              </button>
            </div>
            {ksHits.length > 0 && (
              <div style={{ maxHeight: 160, overflow: 'auto', marginBottom: 5, border: '1px solid #e0f2fe', borderRadius: 5, padding: 4 }}>
                <div style={{ fontSize: 9.5, color: '#0369a1', fontWeight: 700, marginBottom: 3 }}>{tr('搜索结果')}（{ksHits.length}）</div>
                {ksHits.map((h) => (
                  <div key={h.lib + '/' + h.name} onClick={() => { setKsLib(h.lib); ksPick(h.name, false, h.lib); }}
                    style={{ padding: '4px 8px', marginBottom: 3, borderRadius: 5, background: '#f0f9ff', fontSize: 10.5, fontFamily: 'monospace', cursor: 'pointer' }} title={h.lib + ' / ' + h.name}>
                    <span style={{ color: '#0891b2' }}>{h.lib}</span> / {h.name}
                  </div>
                ))}
              </div>
            )}
            {!ksSearching && ksSearchKw.trim().length >= 2 && !ksHits.length && (
              <div style={{ fontSize: 10, color: '#b45309', marginBottom: 5 }}>{tr('未搜到，可换关键词或按库浏览')}</div>
            )}
            {ksLibs.length > 0 && (
              <select value={ksLib} onChange={(e) => ksPickLib(e.target.value)} style={{ width: '100%', padding: '5px 8px', borderRadius: 5, border: '1px solid #e0f2fe', fontSize: 11, marginBottom: 5, boxSizing: 'border-box' }}>
                <option value="">{tr('选择符号库…')}（{ksLibs.length}）</option>
                {ksLibs.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            )}
            {ksLib && <input value={ksKw} onChange={(e) => setKsKw(e.target.value)} placeholder={tr('筛选符号名…')}
              style={{ width: '100%', padding: '5px 8px', borderRadius: 5, border: '1px solid #e0f2fe', fontSize: 11, marginBottom: 5, boxSizing: 'border-box', outline: 'none' }} />}
            <div style={{ maxHeight: 150, overflow: 'auto' }}>
              {ksFiltered.slice(0, 100).map((n) => (
                <div key={n} onClick={() => ksPick(n)}
                  style={{ padding: '4px 8px', marginBottom: 3, borderRadius: 5, background: '#f0f9ff', fontSize: 10.5, fontFamily: 'monospace', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={n}>{n}</div>
              ))}
            </div>
            {ksMsg && <div style={{ fontSize: 10, color: ksMsg.startsWith('✓') ? '#16a34a' : '#b91c1c', marginTop: 4 }}>{ksMsg}</div>}
            <button onClick={runKsDiag} style={{ marginTop: 6, padding: '3px 10px', borderRadius: 5, border: '1px solid #cbd5e1', background: '#f8fafc', color: '#475569', fontSize: 10, cursor: 'pointer' }}>🔍 {tr('诊断符号链路')}</button>
            {ksDiag && <div style={{ fontSize: 9.5, color: '#334155', marginTop: 4, wordBreak: 'break-all', background: '#f8fafc', padding: 6, borderRadius: 5, fontFamily: 'monospace' }}>{ksDiag}</div>}
          </div>
        )}
      </div>

      <div style={{ marginTop: 8, padding: 8, borderRadius: 8, border: '1px solid #fde68a', background: '#fffbeb' }}>
        <div onClick={kfToggle} style={{ fontSize: 10, fontWeight: 700, color: '#92400e', cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}>
          <span>📦 {tr('KiCad 官方封装库')}</span><span>{kfOpen ? '▾' : '▸'}</span>
        </div>
        {kfOpen && (
          <div style={{ marginTop: 6 }}>
            <div style={{ display: 'flex', gap: 4, marginBottom: 5 }}>
              <input value={kfSearchKw} onChange={(e) => setKfSearchKw(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') libSearch('fp', kfSearchKw); }}
                placeholder={tr('跨库搜索封装，如 0402 / SOIC-8 / USB_C')}
                style={{ flex: 1, padding: '5px 8px', borderRadius: 5, border: '1px solid #fcd34d', fontSize: 11, boxSizing: 'border-box', outline: 'none' }} />
              <button onClick={() => libSearch('fp', kfSearchKw)} disabled={kfSearching || kfSearchKw.trim().length < 2}
                style={{ padding: '5px 10px', borderRadius: 5, border: 'none', background: '#b45309', color: '#fff', fontSize: 10.5, fontWeight: 700, cursor: kfSearching ? 'wait' : 'pointer', opacity: kfSearchKw.trim().length < 2 ? 0.5 : 1 }}>
                {kfSearching ? '⟳' : '🔍'}
              </button>
            </div>
            {kfHits.length > 0 && (
              <div style={{ maxHeight: 160, overflow: 'auto', marginBottom: 5, border: '1px solid #fde68a', borderRadius: 5, padding: 4 }}>
                <div style={{ fontSize: 9.5, color: '#92400e', fontWeight: 700, marginBottom: 3 }}>{tr('搜索结果')}（{kfHits.length}）</div>
                {kfHits.map((h) => (
                  <div key={h.lib + '/' + h.name} onClick={() => { setKfLib(h.lib); kfPick(h.name, h.lib); }}
                    style={{ padding: '4px 8px', marginBottom: 3, borderRadius: 5, background: '#fffdf5', fontSize: 10.5, fontFamily: 'monospace', cursor: 'pointer' }} title={h.lib + ' / ' + h.name}>
                    <span style={{ color: '#b45309' }}>{h.lib}</span> / {h.name}
                  </div>
                ))}
              </div>
            )}
            {!kfSearching && kfSearchKw.trim().length >= 2 && !kfHits.length && (
              <div style={{ fontSize: 10, color: '#b45309', marginBottom: 5 }}>{tr('未搜到，可换关键词或按库浏览')}</div>
            )}
            {kfLibs.length > 0 && (
              <select value={kfLib} onChange={(e) => kfPickLib(e.target.value)} style={{ width: '100%', padding: '5px 8px', borderRadius: 5, border: '1px solid #fde68a', fontSize: 11, marginBottom: 5, boxSizing: 'border-box' }}>
                <option value="">{tr('选择封装库…')}（{kfLibs.length}）</option>
                {kfLibs.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            )}
            {kfLib && <input value={kfKw} onChange={(e) => setKfKw(e.target.value)} placeholder={tr('筛选封装名…')}
              style={{ width: '100%', padding: '5px 8px', borderRadius: 5, border: '1px solid #fde68a', fontSize: 11, marginBottom: 5, boxSizing: 'border-box', outline: 'none' }} />}
            <div style={{ maxHeight: 150, overflow: 'auto' }}>
              {kfFiltered.slice(0, 100).map((n) => (
                <div key={n} onClick={() => kfPick(n)}
                  style={{ padding: '4px 8px', marginBottom: 3, borderRadius: 5, background: '#fffdf5', border: '1px solid #fef3c7', fontSize: 10.5, fontFamily: 'monospace', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={n}>{n}</div>
              ))}
            </div>
            {kfMsg && <div style={{ fontSize: 10, color: kfMsg.startsWith('✓') ? '#16a34a' : '#b91c1c', marginTop: 4 }}>{kfMsg}</div>}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
        <button onClick={() => onBuild?.(mpnText.trim() || c.mpn)} title={tr('打开构建向导：上传 PDF / 输入 URL 由 AI 提取管脚与封装，或手工填写')}
          style={{ padding: '5px 10px', borderRadius: 6, border: 'none', background: '#6d28d9', color: '#fff', fontSize: 10.5, fontWeight: 700, cursor: 'pointer' }}>{tr('🤖 从 URL / PDF 提取生成')}</button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: '#86198f', cursor: 'pointer' }}>
          <span style={{ padding: '5px 10px', borderRadius: 6, border: '1px dashed #d8b4fe', background: '#fff', fontWeight: 700 }}>{tr('⬆ 上传符号 (SVG)')}</span>
          {c.customSymbolSvg && <span style={{ color: '#16a34a', fontWeight: 700 }}>{tr('✓ 已上传')}</span>}
          <input type="file" accept=".svg,image/svg+xml" onChange={onFile} style={{ display: 'none' }} />
        </label>
      </div>
      {(c.display?.symbolFromMpn || (c.display?.footprintFileUrl && c.display?.family === 'Footprint')) && (
        <div style={{ marginTop: 6, fontSize: 9.5, color: '#16a34a', fontWeight: 700 }}>
          {c.display?.symbolFromMpn && <div>✓ 符号已关联自 {c.display.symbolFromMpn}</div>}
        </div>
      )}
    </div>
  );
}

/** 动态文本（ezPLM 中文数据）：英文模式下自动翻译并缓存 */
function TrSpan({ text }: { text: string }) {
  const tr = useTranslated(text);
  return <>{tr}</>;
}

/** 器件图片：ezPLM 提供 imageUrl 时显示实拍图，否则用封装缩略图兜底 */
function ComponentImage({ c, imageUrl }: { c: PlacedComponentT; imageUrl?: string }) {
  if (imageUrl) return <img src={imageUrl} alt={c.mpn} style={{ width: 64, height: 64, objectFit: 'contain', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff' }} />;
  const pads = padFootprintForT(c.footprint.name);
  if (!pads) return <div style={{ width: 64, height: 64, borderRadius: 8, border: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, background: '#f8fafc' }}>{CATEGORY_DISPLAY[c.category].icon}</div>;
  const hw = Math.max(...pads.pads.map((p) => Math.abs(p.x) + p.w / 2), pads.bodyW / 2) + 1;
  const hh = Math.max(...pads.pads.map((p) => Math.abs(p.y) + p.h / 2), pads.bodyH / 2) + 1;
  return (
    <svg width={64} height={64} viewBox={`${-hw} ${-hh} ${hw * 2} ${hh * 2}`} style={{ borderRadius: 8, border: '1px solid #e2e8f0', background: '#f0f9f4' }}>
      <rect x={-pads.bodyW / 2} y={-pads.bodyH / 2} width={pads.bodyW} height={pads.bodyH} rx={0.5} fill="none" stroke="#1a6b3c" strokeWidth={hw / 40} />
      {pads.pads.map((p, i) => <rect key={i} x={p.x - p.w / 2} y={p.y - p.h / 2} width={p.w} height={p.h} rx={p.round ? p.w / 2 : 0.15} fill="#c08a2d" />)}
    </svg>
  );
}

export function NumInput({ value, onChange, label }: { value: number; onChange: (v: number) => void; label?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#f8fafc', borderRadius: 6, padding: '3px 6px', border: '1px solid #E8F3EE' }}>
      <input aria-label={label} title={label} type="number" value={value} min={20} max={500} step={5} onChange={(e) => onChange(Math.max(20, Math.min(500, Number(e.target.value) || 20)))}
        style={{ width: 44, border: 'none', background: 'transparent', fontSize: 12, fontWeight: 600, color: COLORS.green, outline: 'none', textAlign: 'center', fontFamily: 'monospace' }} />
      <span style={{ color: '#94a3b8', fontSize: 10 }}>mm</span>
    </div>
  );
}



/** 是否是可用于分销商查询的真实型号（排除占位/自建/子电路通用值/中文值） */
function hasRealMpn(mpn: string): boolean {
  if (!mpn || mpn.length < 4) return false;
  if (/^(fp_|CUSTOM_|sub_)/i.test(mpn)) return false;
  if (/[\u4e00-\u9fff]/.test(mpn)) return false;
  if (/^\d+(\.\d+)?(pF|nF|uF|k?Ω|ohm|uH|nH|MHz|kHz)$/i.test(mpn)) return false;
  return /[A-Za-z]/.test(mpn) && /\d/.test(mpn);
}
