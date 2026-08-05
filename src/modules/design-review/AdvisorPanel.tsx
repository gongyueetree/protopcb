/**
 * modules/design-review/AdvisorPanel.tsx
 * AI 顾问 —— 实时展示设计审查、子电路推荐、PCB规格。数据来自 store + ReferenceDesignProvider。
 */
import { useEffect, useState } from 'react';
import { useDesignStore } from '../../state/designStore';
import { getProviders } from '../../providers/factory';
import { geminiComplete, getGeminiKey } from '../../providers/gemini';
import { recommendLayers } from '../../design-core/document/services';
import { CATEGORY_DISPLAY, COLORS } from '../../shared/theme';
import type { PeripheralCircuitRecommendation } from '../../providers/types';
import type { ComponentCategory, ReviewLevel } from '../../design-core/document/types';

const providers = getProviders();
const ctx = { userId: 'demo-user', organizationId: 'org-demo' };

const LEVEL: Record<ReviewLevel, { bg: string; color: string; label: string }> = {
  high: { bg: '#fef2f2', color: '#dc2626', label: '高' },
  mid: { bg: '#fffbeb', color: '#b45309', label: '中' },
  low: { bg: '#f0fdf4', color: '#16a34a', label: '低' },
  info: { bg: '#f1f5f9', color: '#64748b', label: 'ℹ' },
};


/** 基于画布器件的规则引擎建议（无 Gemini 时的动态兜底，逐条对应画布实际构成） */
function ruleSuggestions(comps: { mpn: string; category: string; family?: string }[]): { name: string; reason: string; addId?: string }[] {
  const out: { name: string; reason: string; addId?: string }[] = [];
  const has = (pred: (c: typeof comps[0]) => boolean) => comps.some(pred);
  const fam = (f: string) => has((c) => (c.family ?? '').includes(f));
  const icCount = comps.filter((c) => c.category === 'mcu' || c.category === 'ic').length;
  const capCount = comps.filter((c) => c.mpn.toUpperCase().includes('CL10') || (c.family ?? '').includes('MLCC')).length;

  if (icCount > 0 && !has((c) => c.category === 'power')) out.push({ name: '3.3V 稳压电路（LDO/DCDC）', reason: '画布上有 IC 但没有电源管理器件，系统无法供电', addId: 'lm1117' });
  if (fam('STM32') || fam('GD32')) {
    out.push({ name: '8MHz 晶振 + 2×20pF 负载电容', reason: 'STM32/GD32 外部主时钟（也可用内部 HSI，但精度受限）' });
    out.push({ name: '复位电路（10KΩ 上拉 + 100nF）', reason: 'NRST 引脚复位可靠性', addId: 'res10k' });
    out.push({ name: 'SWD 调试接口（2×5 排针）', reason: '烧录与在线调试必需', addId: 'header2x5' });
    out.push({ name: 'BOOT0 下拉 10KΩ', reason: '确保从主 Flash 启动', addId: 'res10k' });
  }
  if (fam('ESP32')) {
    out.push({ name: '3.3V ≥500mA 供电', reason: 'ESP32 Wi-Fi 发射瞬时电流大，LDO 需选大电流型号' });
    out.push({ name: '天线净空区', reason: '模组天线下方及周边禁止铺铜走线' });
    out.push({ name: 'EN 引脚 RC 延时（10K+1μF）', reason: '保证上电时序' });
  }
  if (fam('USB')) {
    out.push({ name: 'USB ESD 保护（TVS 阵列）', reason: 'USB 接口静电防护' });
    out.push({ name: 'CC1/CC2 5.1KΩ 下拉', reason: 'Type-C 从机模式识别必需', addId: 'res10k' });
  }
  if (fam('USB-UART') || has((c) => c.mpn.startsWith('CH340'))) out.push({ name: '12MHz 晶振', reason: 'CH340G 需外部晶振（CH340C 内置可省）' });
  if (fam('Flash')) out.push({ name: 'CS 上拉 10KΩ', reason: 'SPI Flash 片选默认无效电平', addId: 'res10k' });
  if (fam('CAN')) out.push({ name: '120Ω 终端电阻', reason: 'CAN 总线末端匹配' });
  if (icCount > capCount) out.push({ name: `去耦电容 100nF ×${icCount - capCount}`, reason: `每个 IC 电源脚就近去耦（当前 ${icCount} 个 IC / ${capCount} 个电容）`, addId: 'cap100nf' });
  if (icCount > 0 && !has((c) => c.category === 'connector')) out.push({ name: '供电/调试接口', reason: '板卡缺少对外接口', addId: 'usbc' });
  return out;
}


export function AdvisorPanel() {
  const doc = useDesignStore((s) => s.doc);
  const addComponent = useDesignStore((s) => s.addComponent);
  const [subs, setSubs] = useState<Record<string, PeripheralCircuitRecommendation[]>>({});
  const [sysSugs, setSysSugs] = useState<{ name: string; reason: string; addId?: string }[]>([]);
  const [sysSource, setSysSource] = useState<'gemini' | 'rules' | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const coreList = doc.components.filter((c) => c.category !== 'passive').map((c) => ({ mpn: c.mpn, category: c.category, family: c.display?.family }));
  const coreSig = coreList.map((c) => c.mpn).sort().join(',');

  const analyze = async () => {
    if (!doc.components.length) { setSysSugs([]); setSysSource(null); return; }
    setAnalyzing(true);
    const all = doc.components.map((c) => ({ mpn: c.mpn, category: c.category, family: c.display?.family }));
    if (getGeminiKey()) {
      try {
        const prompt = `你是资深硬件工程师。当前 PCB 画布上已有器件：\n${all.map((c) => `- ${c.mpn}（${c.category}${c.family ? '/' + c.family : ''}）`).join('\n')}\n\n请分析构成完整可工作系统还缺哪些功能器件/子电路（晶振、复位、去耦、ESD、接口、供电等），按重要性给出至多8条。严格输出 JSON 数组，勿输出其它文字：\n[{"name":"器件/子电路名","reason":"必要性(30字内)"}]`;
        const text = await geminiComplete(prompt);
        const parsed = JSON.parse(text.replace(/\`\`\`json|\`\`\`/g, '').trim());
        setSysSugs(parsed.slice(0, 8));
        setSysSource('gemini');
      } catch (e) {
        console.warn('[Advisor] Gemini 失败，回退规则引擎', e);
        setSysSugs(ruleSuggestions(all));
        setSysSource('rules');
      }
    } else {
      setSysSugs(ruleSuggestions(all));
      setSysSource('rules');
    }
    setAnalyzing(false);
  };

  useEffect(() => { analyze(); }, [coreSig]);

  const cats = Array.from(new Set(doc.components.map((c) => c.category)));

  useEffect(() => {
    (async () => {
      const out: Record<string, PeripheralCircuitRecommendation[]> = {};
      for (const cat of cats) out[cat] = await providers.referenceDesigns.getRecommendedPeripheralCircuits(cat as ComponentCategory, ctx);
      setSubs(out);
    })();
  }, [cats.join(',')]);

  const quickAdd = async (componentId: string) => {
    const detail = await providers.components.getComponentDetail(componentId, ctx);
    if (detail) addComponent(detail);
  };

  const layers = recommendLayers(doc);
  const highCount = doc.reviewResults.filter((r) => r.level === 'high').length;

  return (
    <div>
      {/* 系统补全建议（基于画布实际器件） */}
      <Section title="🧠 系统补全建议" badge={sysSugs.length || undefined}>
        {doc.components.length === 0 ? <Empty text="添加器件后，AI 分析系统还缺什么" /> : analyzing ? <Empty text="分析中..." /> : (
          <>
            <div style={{ fontSize: 9.5, color: '#94a3b8', marginBottom: 6 }}>{sysSource === 'gemini' ? '由 Gemini 基于画布器件实时生成' : '规则引擎基于画布器件动态生成（在 Vercel 配置 VITE_GEMINI_API_KEY 后由 Gemini 生成）'}</div>
            {sysSugs.length === 0 ? <Empty text="当前构成已较完整 ✓" /> : sysSugs.map((g, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '7px 9px', marginBottom: 5, borderRadius: 7, background: '#fff', border: '1px solid #f1f5f9' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: '#334155' }}>{g.name}</div>
                  <div style={{ fontSize: 10, color: '#64748b' }}>{g.reason}</div>
                </div>
                {g.addId && <button onClick={() => quickAdd(g.addId!)} style={{ flexShrink: 0, padding: '3px 9px', borderRadius: 5, border: 'none', background: COLORS.green, color: '#fff', fontSize: 10.5, fontWeight: 700, cursor: 'pointer' }}>+ 添加</button>}
              </div>
            ))}
          </>
        )}
      </Section>

      {/* 子电路推荐 */}
      <Section title="🧩 子电路推荐" badge={cats.length || undefined}>
        {doc.components.length === 0 ? <Empty text="添加器件后推荐配套子电路" /> :
          cats.map((cat) => (
            <div key={cat} style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.green, marginBottom: 4 }}>{CATEGORY_DISPLAY[cat as ComponentCategory].name}</div>
              {(subs[cat] ?? []).map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '5px 8px', marginBottom: 3, borderRadius: 6, background: '#f8fafc' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: '#334155' }}>{r.name}</div>
                    <div style={{ fontSize: 9.5, color: '#64748b' }}>{r.parts}</div>
                  </div>
                  {r.quickAddComponentId && <button onClick={() => quickAdd(r.quickAddComponentId!)} style={miniBtn}>+ 上板</button>}
                </div>
              ))}
            </div>
          ))}
      </Section>

      {/* PCB规格 */}
      <Section title="📋 PCB设计规格">
        <table style={{ width: '100%', fontSize: 10, borderCollapse: 'collapse', marginTop: 6 }}>
          <tbody>
            {[
              ['层数', `${layers}层`, layers === 4 ? '密度高,建议4层' : '2层可满足'],
              ['板厚', '1.6mm', '标准'],
              ['铜厚', '1oz', '大电流局部2oz'],
              ['线宽/距', '6/6mil', '标准工艺'],
              ['板框', `${doc.board.widthMm}×${doc.board.heightMm}mm`, doc.board.shape === 'lshape' ? '异形(费用+)' : '常规'],
            ].map(([k, v, n]) => (
              <tr key={k} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <td style={{ padding: '4px 6px', color: '#94a3b8' }}>{k}</td>
                <td style={{ padding: '4px 6px', fontWeight: 700, color: COLORS.green }}>{v}</td>
                <td style={{ padding: '4px 6px', color: '#64748b' }}>{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ fontSize: 9.5, color: '#64748b', marginTop: 6, lineHeight: 1.6 }}>
          <b>布局要点</b>：晶振贴MCU包地 · 去耦电容贴引脚 · USB差分等长(90Ω) · 电源回路最小化 · 连接器靠板边
        </div>
      </Section>

      {/* 风险 */}
      <Section title="⚠️ 设计风险" badge={highCount ? `${highCount}高` : undefined} badgeColor="#dc2626">
        {doc.reviewResults.map((r) => {
          const st = LEVEL[r.level];
          return (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', marginBottom: 3, borderRadius: 5, background: st.bg }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: st.color, width: 14, textAlign: 'center' }}>{st.label}</span>
              <span style={{ fontSize: 10.5, color: '#334155' }}>{r.title}{r.detail ? ` — ${r.detail}` : ''}</span>
            </div>
          );
        })}
      </Section>
    </div>
  );
}

function Section({ title, badge, badgeColor, children }: { title: string; badge?: string | number; badgeColor?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ marginBottom: 8, borderRadius: 10, border: '1px solid #e2e8f0', background: '#fff', overflow: 'hidden' }}>
      <div onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', cursor: 'pointer', background: open ? '#f7fcf9' : '#fff' }}>
        <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: '#1e293b' }}>{title}</span>
        {badge != null && <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 8, background: badgeColor ?? COLORS.green, color: '#fff', fontWeight: 700 }}>{badge}</span>}
        <span style={{ fontSize: 9, color: '#94a3b8' }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && <div style={{ padding: '4px 12px 12px', borderTop: '1px solid #f1f5f9' }}>{children}</div>}
    </div>
  );
}
const Empty = ({ text }: { text: string }) => <div style={{ fontSize: 11, color: '#94a3b8', paddingTop: 6 }}>{text}</div>;
const miniBtn: React.CSSProperties = { fontSize: 9, padding: '2px 7px', borderRadius: 4, border: '1px solid #c6e2d0', background: '#fff', color: COLORS.green, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' };
