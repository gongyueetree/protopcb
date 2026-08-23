/**
 * modules/component-search/CustomPartWizard.tsx
 * 定制器件构建向导：
 *   路径A（AI 提取）：上传 PDF / 输入 URL / 粘贴文本 → Gemini 提取管脚定义与物理尺寸 → 填入表单
 *   路径B（手工）：KiCad 式向导 —— 管脚表（编号/名称/电气属性/描述）+ 封装参数（族/外形/间距）
 * 表单统一可编辑；保存 → 定制库（localStorage）+ 符号覆盖注册，封装经合成 KiCad 名走既有解析器。
 */
import { tr, curLang } from '../../shared/i18n';
import { buildCustomSymbol, symbolSideSummary } from '../../design-core/custom-symbol';
import { useMemo, useState , useEffect} from 'react';
import { COLORS } from '../../shared/theme';
import { geminiAvailable, geminiComplete, extractJson } from '../../providers/gemini';
import { padFootprintFor } from '../../design-core/geometry/footprint-pads';
import {
  KICAD_PIN_TYPES, type CustomPin, type CustomPkg, type CustomPart, type PinSide,
  synthFootprintName, saveCustomPart, defaultSide, buildCustomFootprint, customFootprintName,
} from '../../design-core/custom-lib';
import type { ComponentCategory } from '../../design-core/document/types';

const FAMILIES: [CustomPkg['family'], string][] = [
  ['dual', tr('双列贴片 (SOP/TSSOP)')], ['quad', tr('四边鸥翼 (QFP)')], ['qfn', tr('四边无脚 (QFN)')], ['header', tr('单排针 (2.54)')], ['chip', tr('两端贴片 (阻容)')],
  ['sot', tr('小外形三极管 (SOT-23/SC-70，支持 3/5/6/8 脚)')],
  ['sod', tr('二极管 (SOD-123/323)')],
  ['dpak', tr('功率贴片 (TO-252/DPAK)')],
  ['to220', tr('插件功率 (TO-220/TO-247)')],
  ['bga', tr('球栅阵列 (BGA/WLCSP)')],
  ['manual', tr('异形·手动焊盘坐标（继电器/模块等）')],
];
const CATS: [ComponentCategory, string][] = [['ic', tr('集成电路')], ['mcu', tr('微控制器')], ['power', tr('电源')], ['connector', tr('连接器')], ['passive', tr('无源')], ['electromech', tr('机电(继电器/开关)')], ['sensor', tr('传感器')], ['rf', tr('射频无线')]];

export function CustomPartWizard({ initialMpn, editPart, onSaved, onClose }: { initialMpn?: string; editPart?: CustomPart; onSaved: (p: CustomPart) => void; onClose: () => void }) {
  // editPart 存在 = 编辑既有自建器件（保留 id/createdAt，保存即覆盖）
  const [mpn, setMpn] = useState(editPart?.mpn ?? initialMpn ?? '');
  const [desc, setDesc] = useState(editPart?.description ?? '');
  const [cat, setCat] = useState<ComponentCategory>(editPart?.category ?? 'ic');
  const [pins, setPins] = useState<CustomPin[]>(editPart?.pins ?? [{ num: '1', name: 'VCC', type: 'power_in' }, { num: '2', name: 'GND', type: 'power_in' }]);
  const [pkg, setPkg] = useState<CustomPkg>(editPart?.pkg ?? { family: 'dual', bodyW: 4.9, bodyH: 3.9, pitch: 1.27 });
  const [aiUrl, setAiUrl] = useState('');
  const [aiText, setAiText] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState('');

  const fpName = customFootprintName({ mpn: mpn || 'X', pkg, pins });
  const fp = useMemo(() => buildCustomFootprint(pkg, pins.length), [pkg, pkg.manualPads, pins.length]);
  // 手动焊盘模式：焊盘行数自动跟随管脚数（不足补行、超出截断，已填内容保留）
  useEffect(() => {
    if (pkg.family !== 'manual') return;
    const cur = pkg.manualPads ?? [];
    if (cur.length === pins.length) return;
    const next = pins.map((pn, i) => cur[i] ?? { num: pn.num || String(i + 1), x: +(i * 1.27).toFixed(2), y: 0, w: 0.6, h: 1.2, round: false });
    setPkg((prev) => ({ ...prev, manualPads: next }));
  }, [pins.length, pkg.family]);

  const EXTRACT_PROMPT_BASE = `请从以上器件资料中提取信息，严格输出 JSON（勿输出其它文字）：
{"mpn":"型号","description":"30字内功能描述","category":"ic|mcu|power|connector|passive",
"pins":[{"num":"1","name":"VCC","type":"power_in","desc":"电源","side":"top|bottom|left|right"}],
"package":{"family":"dual|quad|qfn|header|chip","bodyW":本体宽mm,"bodyH":本体长mm,"pitch":引脚间距mm,"outlineW":模块整体轮廓宽mm(若焊盘只占模块一部分则填写否则省略),"outlineH":模块整体轮廓高mm}}
side 规则：电源脚 top，地脚 bottom，输入类 left，输出类 right
pin type 取值：${KICAD_PIN_TYPES.join('|')}`;
  // 英文界面：要求模型用英文回填描述类字段（管脚名/方向说明等）
  const EXTRACT_PROMPT = (curLang() === 'en'
    ? 'Answer in English: description and any free-text fields must be in English.\n'
    : '') + EXTRACT_PROMPT_BASE;

  /** 图片提取：引脚图/封装图截图 → Gemini 视觉 → 填表 */
  const onImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) { setAiMsg('图片超过 4MB，请压缩后重试'); return; }
    setAiBusy(true); setAiMsg(tr('视觉识别中…'));
    try {
      const b64 = await new Promise<string>((res, rej) => {
        const rd = new FileReader();
        rd.onload = () => res(String(rd.result).split(',')[1] ?? '');
        rd.onerror = () => rej(new Error(tr('读取失败')));
        rd.readAsDataURL(f);
      });
      const r = await fetch('/api/gemini', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: EXTRACT_PROMPT + '\n补充：这是一张图片。请先判断它是「引脚定义图」还是「封装尺寸图」：引脚图 → 重点提取 pins（脚号+名称+类型）；封装尺寸图 → 重点提取 package（bodyW/bodyH/pitch，单位 mm，并按脚号数量推断 family）。两类信息都可见时都提取。', imageBase64: b64, imageMime: f.type || 'image/png' }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = String((await r.json()).text ?? '');
      applyExtract(extractJson(text));
      setAiMsg('✓ ' + tr('已从图片提取，请核对下方表单（视觉识别务必人工复核管脚号）'));
    } catch (err) {
      setAiMsg(tr('图片提取失败') + '：' + (err as Error).message);
    }
    setAiBusy(false);
  };

  const applyExtract = (j: { mpn?: string; description?: string; category?: string; pins?: CustomPin[]; package?: Partial<CustomPkg> }) => {
    if (j.mpn) setMpn(j.mpn);
    if (j.description) setDesc(j.description);
    if (j.category && CATS.some(([c]) => c === j.category)) setCat(j.category as ComponentCategory);
    if (Array.isArray(j.pins) && j.pins.length) {
      setPins(j.pins.slice(0, 100).map((p, i) => ({
        num: String(p.num ?? i + 1), name: String(p.name ?? `P${i + 1}`),
        type: KICAD_PIN_TYPES.includes(p.type) ? p.type : 'passive', desc: p.desc,
        side: (['left', 'right', 'top', 'bottom'] as const).includes(p.side as PinSide) ? p.side as PinSide : undefined,
      })));
    }
    const pk = j.package;
    if (pk) {
      setPkg((prev) => ({
        family: FAMILIES.some(([f]) => f === pk.family) ? pk.family as CustomPkg['family'] : prev.family,
        bodyW: Number(pk.bodyW) || prev.bodyW,
        bodyH: Number(pk.bodyH) || prev.bodyH,
        pitch: Number(pk.pitch) || prev.pitch,
        outlineW: Number(pk.outlineW) || prev.outlineW,
        outlineH: Number(pk.outlineH) || prev.outlineH,
        padsOffsetX: prev.padsOffsetX, padsOffsetY: prev.padsOffsetY,
      }));
    }
  };

  /** ds2kicad 封装类型 → 向导封装族 */
  const mapDsFamily = (type: string): CustomPkg['family'] => {
    const t = (type ?? '').toUpperCase();
    if (/QFN|DFN|WQFN|VQFN|SON/.test(t)) return 'qfn';
    if (/SOT-?23|SOT-?353|SOT-?363|SC-?70|SOT-?89|SOT-?223/.test(t)) return 'sot';
    if (/SOD-?\d|SMA|SMB/.test(t)) return 'sod';
    if (/TO-?252|TO-?263|DPAK/.test(t)) return 'dpak';
    if (/TO-?220|TO-?247/.test(t)) return 'to220';
    if (/BGA|WLCSP|CSP/.test(t)) return 'bga';
    if (/QFP|LQFP|TQFP/.test(t)) return 'quad';
    if (/DIP|HEADER/.test(t)) return 'header';
    return 'dual'; // SOIC/SOP/TSSOP/MSOP/SSOP/SOT…
  };

  /** ds2kicad /api/extract 响应 → 填表（确定性解析器 + 置信度，管脚类型已是 KiCad 电气属性） */
  const applyDs2kicad = (j: {
    mock?: boolean;
    part?: { mpn?: string; name?: string; title?: string; description_zh?: string; description?: string };
    pins?: { number: string; name: string; type?: string; description?: string }[];
    pinsets?: { id: string; label?: string; pins: { number: string; name: string; type?: string; description?: string }[] }[];
    packages?: { type?: string; pitch?: number; bodyLength?: number; bodyWidth?: number }[];
    recommendedPackageIndex?: number;
  }) => {
    if (j.part?.mpn || j.part?.name) setMpn(j.part.mpn ?? j.part.name ?? '');
    const dsDesc = j.part?.description_zh || j.part?.title || j.part?.description;
    if (dsDesc) setDesc(dsDesc.slice(0, 120));
    // v0.3 起管脚在 pinsets（多封装管脚定义集）；顶层 pins 为默认集，两者取其有
    const dsPins = (Array.isArray(j.pins) && j.pins.length) ? j.pins : j.pinsets?.[0]?.pins;
    if (Array.isArray(dsPins) && dsPins.length) {
      setPins(dsPins.slice(0, 200).map((p) => ({
        num: String(p.number), name: p.name || 'NC',
        type: KICAD_PIN_TYPES.includes(p.type as never) ? (p.type as CustomPin['type']) : 'passive',
        desc: p.description,
      })));
    }
    const pk = j.packages?.[j.recommendedPackageIndex ?? 0];
    if (pk) {
      setPkg((prev) => ({
        ...prev,
        family: mapDsFamily(pk.type ?? ''),
        bodyW: Number(pk.bodyWidth) || prev.bodyW,
        bodyH: Number(pk.bodyLength) || prev.bodyH,
        pitch: Number(pk.pitch) || prev.pitch,
      }));
    }
    setAiMsg(j.mock ? '⚠ ds2kicad 处于演示模式（其 GEMINI_API_KEY 未配置），已填入示例数据' : '✓ ds2kicad 提取完成（确定性解析+AI），请核对后保存');
  };

  const runAi = async (payload: { fileBase64?: string; mimeType?: string; url?: string; text?: string }) => {
    setAiBusy(true); setAiMsg('');
    try {
      // 优先 ds2kicad 引擎（确定性 PDF 解析 + 按需 AI）：适用于 PDF 上传与 PDF 链接
      let usedEngine = tr('内置 Gemini');
      if (payload.fileBase64 || payload.url) {
        const st = await fetch('/api/ds2kicad').then((r) => r.json()).catch(() => ({ configured: false }));
        if (!st.configured) {
          setAiMsg(tr('⚠ 未配置 DS2KICAD_URL（提取引擎），本次使用内置 Gemini——PDF 提取精度建议配置 ds2kicad'));
        }
        if (st.configured) {
          usedEngine = 'ds2kicad';
          const body = payload.fileBase64
            ? { pdfBase64: payload.fileBase64, fileName: `${mpn || 'part'}.pdf` }
            : { pdfUrl: payload.url };
          const r = await fetch('/api/ds2kicad', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          if (r.ok) { applyDs2kicad(await r.json()); setAiBusy(false); return; }
          const err = await r.json().catch(() => ({}));
          setAiMsg(`ds2kicad 提取失败（${(err as { error?: string }).error ?? r.status}），回退内置 Gemini…`);
        }
      }
      if (!(await geminiAvailable())) { setAiMsg(tr('未配置 GEMINI_API_KEY（或配置 DS2KICAD_URL 使用提取引擎）')); setAiBusy(false); return; }
      let text: string;
      if (payload.text) {
        text = await geminiComplete(`以下是器件资料文本：\n${payload.text.slice(0, 60000)}\n\n${EXTRACT_PROMPT}`);
      } else {
        const r = await fetch('/api/gemini', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: EXTRACT_PROMPT, ...payload }),
        });
        if (!r.ok) throw new Error(`提取失败 HTTP ${r.status}`);
        text = String((await r.json()).text ?? '');
      }
      applyExtract(extractJson(text));
      setAiMsg(`✓ 已提取（${usedEngine}），请核对下方表单后保存`);
    } catch (e) {
      setAiMsg(tr('提取失败：') + (e as Error).message);
    }
    setAiBusy(false);
  };

  const onPdf = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 3 * 1024 * 1024) { setAiMsg(tr('PDF 超过 3MB，请压缩或改用 URL 方式')); return; }
    setAiBusy(true); setAiMsg(tr('解析 PDF 中…'));
    try {
      const b64 = await new Promise<string>((res, rej) => {
        const rd = new FileReader();
        rd.onload = () => res(String(rd.result).split(',')[1] ?? '');
        rd.onerror = () => rej(new Error(tr('读取失败')));
        rd.readAsDataURL(f);
      });
      let text = '';
      let engine = '';
      // 首选 ds2kicad（确定性解析 + 溯源）；不可用/失败则自动回落 Gemini 直读
      try {
        const r = await fetch('/api/ds2kicad', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pdfBase64: b64, fileName: f.name }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(String(j?.error ?? `HTTP ${r.status}`));
        applyDs2kicad(j);
        setAiMsg('✓ ' + tr('已提取（DS2KiCad），请核对下方表单后保存'));
        setAiBusy(false);
        return;
      } catch (dsErr) {
        engine = `ds2kicad 不可用（${(dsErr as Error).message.slice(0, 80)}），已回落 Gemini`;
      }
      const r2 = await fetch('/api/gemini', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: EXTRACT_PROMPT, pdfBase64: b64 }),
      });
      const j2 = await r2.json().catch(() => ({}));
      if (!r2.ok) throw new Error(String((j2 as { error?: string })?.error ?? `HTTP ${r2.status}`));
      text = String((j2 as { text?: string }).text ?? '');
      applyExtract(extractJson(text));
      setAiMsg('✓ ' + tr('已提取（Gemini 直读）') + (engine ? ' · ' + engine : ''));
    } catch (err) {
      setAiMsg(tr('提取失败') + '：' + (err as Error).message);
    }
    setAiBusy(false);
  };

  const save = () => {
    if (!mpn.trim() || !pins.length) { setAiMsg(tr('型号与管脚不能为空')); return; }
    const part: CustomPart = {
      // 编辑模式保留原 id/创建时间（保存即覆盖同一条，不产生重复器件）
      id: editPart?.id ?? Math.random().toString(36).slice(2, 10), mpn: mpn.trim(), description: desc.trim() || undefined,
      category: cat, pins, pkg, footprintName: fpName, createdAt: editPart?.createdAt ?? Date.now(),
    };
    saveCustomPart(part);
    onSaved(part);
  };

  const inp = { padding: '5px 8px', borderRadius: 5, border: '1px solid #e2e8f0', fontSize: 11.5, outline: 'none' } as const;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={onClose}>
      <div style={{ width: '100%', maxWidth: 760, maxHeight: '92vh', overflow: 'auto', background: '#fff', borderRadius: 14, padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 800, color: '#1a4a2e', marginBottom: 12 }}>🛠 {tr('定制器件构建向导')}</div>

        {/* 路径A：AI 提取 */}
        <div style={{ padding: 12, borderRadius: 10, background: '#f5f3ff', border: '1px solid #ddd6fe', marginBottom: 14 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: '#6d28d9', marginBottom: 8 }}>{tr('🤖 AI 提取（Datasheet PDF / 网页链接 / 粘贴文本）→ 自动填表')}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ padding: '6px 12px', borderRadius: 6, border: '1px dashed #c4b5fd', background: '#fff', fontSize: 11, fontWeight: 700, color: '#6d28d9', cursor: 'pointer' }}>
              {tr('📄 上传 PDF')}<input type="file" accept="application/pdf" onChange={onPdf} style={{ display: 'none' }} />
            </label>
            <label style={{ padding: '6px 12px', borderRadius: 6, border: '1px dashed #c4b5fd', background: '#fff', fontSize: 11, fontWeight: 700, color: '#6d28d9', cursor: 'pointer' }}
              title={tr('上传引脚图/封装图截图，AI 视觉识别管脚与封装参数')}>
              {tr('🖼 上传图片')}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={onImage} style={{ display: 'none' }} />
            </label>
            <input value={aiUrl} onChange={(e) => setAiUrl(e.target.value)} placeholder={tr('或粘贴器件页面 URL…')} style={{ ...inp, flex: 1, minWidth: 200 }} />
            <button disabled={aiBusy || !aiUrl.trim()} onClick={() => runAi({ url: aiUrl.trim() })} style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: '#6d28d9', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer', opacity: aiBusy || !aiUrl.trim() ? 0.5 : 1 }}>{tr('提取')}</button>
          </div>
          <textarea value={aiText} onChange={(e) => setAiText(e.target.value)} placeholder={tr('或直接粘贴 datasheet 关键文本（管脚表/封装尺寸）…')} rows={2}
            style={{ ...inp, width: '100%', marginTop: 8, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }} />
          {aiText.trim() && <button disabled={aiBusy} onClick={() => runAi({ text: aiText })} style={{ marginTop: 6, padding: '5px 12px', borderRadius: 6, border: 'none', background: '#6d28d9', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>{aiBusy ? tr('提取中…') : tr('从文本提取')}</button>}
          {aiMsg && <div style={{ marginTop: 6, fontSize: 10.5, color: aiMsg.startsWith('✓') ? '#16a34a' : '#b91c1c' }}>{aiMsg}</div>}
        </div>

        {/* 基本信息 */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <input value={mpn} onChange={(e) => setMpn(e.target.value)} placeholder={tr('型号 *')} style={{ ...inp, flex: 1, fontFamily: 'monospace', fontWeight: 700 }} />
          <select value={cat} onChange={(e) => setCat(e.target.value as ComponentCategory)} style={inp}>
            {CATS.map(([v, l]) => <option key={v} value={v}>{tr(l)}</option>)}
          </select>
        </div>
        <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={tr('功能描述')} style={{ ...inp, width: '100%', boxSizing: 'border-box', marginBottom: 12 }} />

        {/* 管脚表 */}
        <div style={{ fontSize: 11.5, fontWeight: 700, color: '#334155', marginBottom: 6 }}>{tr('管脚定义')}（{pins.length}）</div>
        <div style={{ maxHeight: 200, overflow: 'auto', border: '1px solid #f1f5f9', borderRadius: 8, marginBottom: 8 }}>
          {pins.map((p, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, padding: '4px 8px', borderBottom: '1px solid #f8fafc', alignItems: 'center' }}>
              <input value={p.num} onChange={(e) => setPins(pins.map((x, k) => k === i ? { ...x, num: e.target.value } : x))} style={{ ...inp, width: 40, textAlign: 'center' }} />
              <input value={p.name} onChange={(e) => setPins(pins.map((x, k) => k === i ? { ...x, name: e.target.value } : x))} placeholder={tr('名称')} style={{ ...inp, width: 90, fontFamily: 'monospace' }} />
              <select value={p.type} onChange={(e) => setPins(pins.map((x, k) => k === i ? { ...x, type: e.target.value as CustomPin['type'] } : x))} style={{ ...inp, width: 104 }}>
                {KICAD_PIN_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <select value={p.side ?? defaultSide(p)} onChange={(e) => setPins(pins.map((x, k) => k === i ? { ...x, side: e.target.value as PinSide } : x))}
                title={tr('管脚在原理图符号的哪一边（默认：电源上/地下/输入左/输出右）')} style={{ ...inp, width: 62 }}>
                <option value="left">{tr('◀ 左')}</option><option value="right">{tr('右 ▶')}</option><option value="top">{tr('▲ 上')}</option><option value="bottom">{tr('▼ 下')}</option>
              </select>
              <input value={p.desc ?? ''} onChange={(e) => setPins(pins.map((x, k) => k === i ? { ...x, desc: e.target.value } : x))} placeholder={tr('描述')} style={{ ...inp, flex: 1 }} />
              <button onClick={() => setPins(pins.filter((_, k) => k !== i))} style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 13 }}>×</button>
            </div>
          ))}
        </div>
        <button onClick={() => setPins([...pins, { num: String(pins.length + 1), name: `P${pins.length + 1}`, type: 'passive' }])}
          style={{ padding: '5px 12px', borderRadius: 6, border: '1px dashed #cbd5e1', background: '#fff', fontSize: 11, color: '#475569', cursor: 'pointer', marginBottom: 14 }}>＋ {tr('添加管脚')}</button>

        {/* 封装参数 + 预览 */}
        <div style={{ display: 'flex', gap: 14 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: '#334155', marginBottom: 6 }}>{tr('封装参数')}</div>
            <select value={pkg.family} onChange={(e) => setPkg({ ...pkg, family: e.target.value as CustomPkg['family'] })} style={{ ...inp, width: '100%', boxSizing: 'border-box', marginBottom: 6 }}>
              {FAMILIES.map(([v, l]) => <option key={v} value={v}>{tr(l)}</option>)}
            </select>
            {pkg.family === 'manual' ? (
              <div>
                <div style={{ fontSize: 9.5, color: '#94a3b8', marginBottom: 5 }}>{tr('逐焊盘坐标（相对封装中心，mm）·适合继电器等不规则孔位')}</div>
                <div style={{ maxHeight: 150, overflow: 'auto', border: '1px solid #f1f5f9', borderRadius: 6, marginBottom: 5 }}>
                  {(pkg.manualPads ?? []).map((mp, i) => (
                    <div key={i} style={{ display: 'flex', gap: 4, padding: '3px 5px', alignItems: 'center', borderBottom: '1px solid #f8fafc', fontSize: 10 }}>
                      <input value={mp.num} onChange={(e) => setPkg({ ...pkg, manualPads: pkg.manualPads!.map((x, k) => k === i ? { ...x, num: e.target.value } : x) })} style={{ ...inp, width: 30, textAlign: 'center', padding: '3px 4px' }} />
                      X<input type="number" step={0.1} value={mp.x} onChange={(e) => setPkg({ ...pkg, manualPads: pkg.manualPads!.map((x, k) => k === i ? { ...x, x: Number(e.target.value) } : x) })} style={{ ...inp, width: 50, padding: '3px 4px' }} />
                      Y<input type="number" step={0.1} value={mp.y} onChange={(e) => setPkg({ ...pkg, manualPads: pkg.manualPads!.map((x, k) => k === i ? { ...x, y: Number(e.target.value) } : x) })} style={{ ...inp, width: 50, padding: '3px 4px' }} />
                      <input type="number" step={0.1} value={mp.w} title={tr('宽/直径')} onChange={(e) => setPkg({ ...pkg, manualPads: pkg.manualPads!.map((x, k) => k === i ? { ...x, w: Number(e.target.value), h: x.round ? Number(e.target.value) : x.h } : x) })} style={{ ...inp, width: 44, padding: '3px 4px' }} />
                      <label style={{ display: 'flex', alignItems: 'center', gap: 2, cursor: 'pointer' }}>
                        <input type="checkbox" checked={!!mp.round} onChange={(e) => setPkg({ ...pkg, manualPads: pkg.manualPads!.map((x, k) => k === i ? { ...x, round: e.target.checked, h: e.target.checked ? x.w : x.h } : x) })} />{tr('圆')}
                      </label>
                      <button onClick={() => setPkg({ ...pkg, manualPads: pkg.manualPads!.filter((_, k) => k !== i) })} style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer' }}>×</button>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => setPkg({ ...pkg, manualPads: [...(pkg.manualPads ?? []), { num: String((pkg.manualPads?.length ?? 0) + 1), x: 0, y: 0, w: 1.8, h: 1.8, round: true }] })}
                    style={{ padding: '4px 10px', borderRadius: 5, border: '1px dashed #cbd5e1', background: '#fff', fontSize: 10, cursor: 'pointer' }}>{tr('＋焊盘')}</button>
                  <button onClick={() => setPkg({ ...pkg, manualPads: pins.map((p, i) => pkg.manualPads?.[i] ?? ({ num: p.num, x: 0, y: i * 2.54, w: 1.8, h: 1.8, round: true })) })}
                    title={tr('按管脚表生成同数量的焊盘行')} style={{ padding: '4px 10px', borderRadius: 5, border: '1px dashed #cbd5e1', background: '#fff', fontSize: 10, cursor: 'pointer' }}>{tr('按管脚生成')} {pins.length} {tr('行')}</button>
                </div>
              </div>
            ) : (
              <>
                {pkg.family !== 'chip' && pkg.family !== 'header' && (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: '#64748b', marginBottom: 6 }}>
                    {tr('本体')} <input type="number" step={0.1} value={pkg.bodyW} onChange={(e) => setPkg({ ...pkg, bodyW: Number(e.target.value) })} style={{ ...inp, width: 58 }} />
                    × <input type="number" step={0.1} value={pkg.bodyH} onChange={(e) => setPkg({ ...pkg, bodyH: Number(e.target.value) })} style={{ ...inp, width: 58 }} /> mm
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: '#64748b' }}>
                  {tr('间距')} <input type="number" step={0.05} value={pkg.pitch} onChange={(e) => setPkg({ ...pkg, pitch: Number(e.target.value) })} style={{ ...inp, width: 58 }} /> mm
                </div>
              </>
            )}
            <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed #e2e8f0' }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: '#475569', marginBottom: 4 }}>{tr('模块轮廓（可选）')}</div>
              <div style={{ fontSize: 9.5, color: '#94a3b8', marginBottom: 5 }}>{tr('焊盘可能只占模块的一部分（如排针在模组边缘），此处指定整体外形')}</div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: '#64748b', marginBottom: 5 }}>
                {tr('轮廓')} <input type="number" step={0.5} placeholder={tr('宽')} value={pkg.outlineW ?? ''} onChange={(e) => setPkg({ ...pkg, outlineW: e.target.value ? Number(e.target.value) : undefined })} style={{ ...inp, width: 54 }} />
                × <input type="number" step={0.5} placeholder={tr('高')} value={pkg.outlineH ?? ''} onChange={(e) => setPkg({ ...pkg, outlineH: e.target.value ? Number(e.target.value) : undefined })} style={{ ...inp, width: 54 }} /> mm
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: '#64748b' }}>
                {tr('焊盘偏移')} <input type="number" step={0.5} value={pkg.padsOffsetX ?? 0} onChange={(e) => setPkg({ ...pkg, padsOffsetX: Number(e.target.value) })} style={{ ...inp, width: 50 }} />
                , <input type="number" step={0.5} value={pkg.padsOffsetY ?? 0} onChange={(e) => setPkg({ ...pkg, padsOffsetY: Number(e.target.value) })} style={{ ...inp, width: 50 }} /> mm
              </div>
            </div>
            <div style={{ marginTop: 8, fontSize: 10, color: '#94a3b8', fontFamily: 'monospace' }}>{fpName}</div>
          </div>
          <div style={{ width: 200 }}>
            {/* 原理图符号预览：保存前让用户核对管脚被分到了哪一边 */}
            <div style={{ fontSize: 11.5, fontWeight: 700, color: '#334155', marginBottom: 6 }}>{tr('原理图符号')}</div>
            {(() => {
              const sym = buildCustomSymbol(pins);
              if (!sym) return <div style={{ fontSize: 10.5, color: '#94a3b8', marginBottom: 10 }}>{tr('填写管脚后自动生成')}</div>;
              const side = symbolSideSummary(pins);
              return (
                <div style={{ marginBottom: 10 }}>
                  <svg viewBox={`0 0 ${sym.w} ${sym.h}`} style={{ width: '100%', maxHeight: 190, background: '#fffdf5', borderRadius: 6, border: '1px solid #e2e8f0' }}>
                    {sym.rects.map((r, i) => (
                      <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} rx={0.6} fill="#fffbd6" stroke="#8a1c1c" strokeWidth={0.35} />
                    ))}
                    {sym.pins.map((pn, i) => (
                      <g key={i}>
                        <line x1={pn.tipX} y1={pn.tipY} x2={pn.endX} y2={pn.endY} stroke="#8a1c1c" strokeWidth={0.3} />
                        <text x={pn.nameX} y={pn.nameY} fontSize={1.7} fill="#334155" fontFamily="monospace"
                          textAnchor={pn.nameX > pn.endX ? 'start' : pn.nameX < pn.endX ? 'end' : 'middle'}>{pn.name}</text>
                        <text x={pn.numX} y={pn.numY} fontSize={1.4} fill="#7c2d12" textAnchor="middle">{pn.number}</text>
                      </g>
                    ))}
                  </svg>
                  <div style={{ fontSize: 9.5, color: '#64748b', marginTop: 3 }}>
                    {tr('左')} {side.left} · {tr('右')} {side.right} · {tr('上')} {side.top} · {tr('下')} {side.bottom}
                    <span style={{ marginLeft: 6, color: '#94a3b8' }}>{tr('（可在管脚表中改「方向」调整）')}</span>
                  </div>
                </div>
              );
            })()}
            <div style={{ fontSize: 11.5, fontWeight: 700, color: '#334155', marginBottom: 6 }}>{tr('封装预览')}（{fp?.pads.length ?? 0}）</div>
            <div style={{ height: 130, background: '#f0f6f1', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {fp && fp.pads.length ? (() => {
                const padExt = Math.max(...fp.pads.map((pd) => Math.max(Math.abs(pd.x) + pd.w / 2, Math.abs(pd.y) + pd.h / 2)));
                const ext = Math.max(padExt, fp.bodyW / 2, fp.bodyH / 2) * 2 + 1;
                return (
                  <svg viewBox={`${-ext / 2} ${-ext / 2} ${ext} ${ext}`} style={{ width: '90%', height: '90%' }} preserveAspectRatio="xMidYMid meet">
                    <rect x={-fp.bodyW / 2} y={-fp.bodyH / 2} width={fp.bodyW} height={fp.bodyH} fill="none" stroke="#1f5c3b" strokeWidth={ext * 0.008}  />
                    {fp.pads.map((pd, i) => pd.round
                      ? <circle key={i} cx={pd.x} cy={pd.y} r={pd.w / 2} fill="#c08a2d" />
                      : <rect key={i} x={pd.x - pd.w / 2} y={pd.y - pd.h / 2} width={pd.w} height={pd.h} rx={Math.min(pd.w, pd.h) * 0.2} fill="#c08a2d" />)}
                  </svg>
                );
              })() : <span style={{ fontSize: 10, color: '#94a3b8' }}>{tr('参数不足')}</span>}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', fontSize: 13, cursor: 'pointer' }}>{tr('取消')}</button>
          <button onClick={save} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: COLORS.green, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>{tr('保存到定制库')}</button>
        </div>
      </div>
    </div>
  );
}
