/**
 * 替代料推荐引擎 —— 移植 altpart-pro 的核心决策思想（精简版）：
 *
 *  1. **AI 只生成候选**，不决定结论；
 *  2. **权威来源门槛**：候选必须经 ezPLM / 分销商验证存在，否则降级为「待核验」
 *     （altpart-pro 的教训：AI 会编造型号并进 Top3）；
 *  3. **确定性评分**：技术兼容度 × 证据可信度，按模式加权，低于阈值淘汰；
 *  4. **模式硬门槛**：pin2pin 要求封装一致、国产模式要求国产厂商 —— 程序化判定，
 *     不依赖提示词"请注意"。
 */
import { geminiComplete, extractJson, geminiAvailable } from '../../providers/gemini';
import { searchEzplmParts } from '../../providers/ezplm-live';
import { fetchSupplierOffers } from '../../providers/suppliers';

export type AltMode = 'pin2pin' | 'pkgCompat' | 'funcCompat' | 'domestic' | 'lowCost';

export interface AltModeProfile {
  label: string;
  note: string;
  requirePackageExact?: boolean;
  requirePackageCompat?: boolean;
  requireDomestic?: boolean;
  requirePriceKnown?: boolean;
}

export const ALT_MODES: Record<AltMode, AltModeProfile> = {
  pin2pin: { label: 'Pin-to-Pin', note: '封装必须完全一致；引脚未验证时仅标待核验', requirePackageExact: true },
  pkgCompat: { label: '封装兼容', note: '封装一致或同兼容族（SOIC-8 / SOP-8）', requirePackageCompat: true },
  funcCompat: { label: '功能兼容', note: '允许改板，功能参数优先' },
  domestic: { label: '国产替代', note: '仅保留国产厂商（按品牌名判断）', requireDomestic: true },
  lowCost: { label: '低成本优先', note: '必须有报价方可比较；无报价降级待核验', requirePriceKnown: true },
};

/** 国产厂商品牌（来自 altpart-pro 的 CN_HINTS，判定按品牌名） */
const CN_HINTS = [
  '兆易创新', 'gigadevice', '沁恒', 'wch', '极海', 'geehy', '国民技术', 'nations',
  '航顺', 'hk32', '灵动微', 'mindmotion', '雅特力', 'artery', '华大半导体', 'hdsc',
  '圣邦微', 'sgmicro', '思瑞浦', '3peak', '芯朋微', 'chipown', '士兰微', 'silan',
  '杰华特', 'joulwatt', '南芯', 'southchip', '矽力杰', 'silergy', '上海贝岭', 'belling',
  '复旦微', 'fudan', '紫光', 'unisoc', '全志', 'allwinner', '瑞芯微', 'rockchip',
  '中颖', 'sinowealth', '赛元', 'sinomcu', '钰泰', 'eutech', '纳芯微', 'novosense',
  '芯海', 'chipsea', '比亚迪', 'byd', '长电', '华润微', 'crmicro', '长鑫', '兆芯',
];

export function isDomesticManufacturer(mfr: string): boolean {
  const s = (mfr || '').toLowerCase();
  return CN_HINTS.some((h) => s.includes(h.toLowerCase()));
}

/** 封装兼容族（同族视为封装兼容） */
const PKG_FAMILIES: string[][] = [
  ['soic', 'sop', 'so'],
  ['ssop', 'tssop', 'msop', 'vssop'],
  ['qfn', 'dfn', 'son'],
  ['lqfp', 'tqfp', 'qfp'],
  ['sot23', 'sot-23'],
  ['0402', '1005metric'],
  ['0603', '1608metric'],
  ['0805', '2012metric'],
];

/** 提取封装族标识与管脚数：SOIC-8_3.9x4.9mm → {fam:'soic', pins:8} */
function pkgKey(name: string): { fam: string; pins: number | null } {
  const s = (name || '').toLowerCase();
  const pins = Number(s.match(/[-_](\d{1,3})(?:[-_]|$)/)?.[1] ?? s.match(/^[a-z]+-?(\d{1,3})/)?.[1] ?? '') || null;
  for (const fam of PKG_FAMILIES) {
    for (const alias of fam) if (s.includes(alias)) return { fam: fam[0], pins };
  }
  return { fam: s.split(/[-_]/)[0] ?? s, pins };
}

export function packageExact(a: string, b: string): boolean {
  return (a || '').toLowerCase() === (b || '').toLowerCase();
}

export function packageCompatible(a: string, b: string): boolean {
  if (packageExact(a, b)) return true;
  const ka = pkgKey(a), kb = pkgKey(b);
  if (ka.fam !== kb.fam) return false;
  if (ka.pins != null && kb.pins != null) return ka.pins === kb.pins; // 同族仍需管脚数一致
  return true;
}

export interface AltCandidate {
  mpn: string;
  manufacturer: string;
  description?: string;
  footprint?: string;
  /** 证据来源：ezplm=库内收录，supplier=分销商命中，ai=仅 AI 提及（待核验） */
  source: 'ezplm' | 'supplier' | 'ai';
  price?: number;
  currency?: string;
  stock?: number;
  /** 0-100 综合分 */
  score: number;
  /** 是否满足所选模式的硬门槛 */
  verified: boolean;
  /** 未通过/需注意的原因 */
  notes: string[];
  componentId?: string;
}

export interface AltResult {
  recommendations: AltCandidate[];
  pending: AltCandidate[];
  eliminated: { mpn: string; reason: string }[];
  notice?: string;
}

const SOURCE_CONFIDENCE: Record<AltCandidate['source'], number> = { ezplm: 1.0, supplier: 0.85, ai: 0.45 };

/**
 * 主流程：AI 生成候选 → ezPLM/分销商验证 → 模式硬门槛 → 评分排序
 */
export async function findAlternatives(opts: {
  mpn: string;
  manufacturer?: string;
  description?: string;
  footprint?: string;
  mode: AltMode;
  onProgress?: (msg: string) => void;
}): Promise<AltResult> {
  const { mpn, manufacturer = '', description = '', footprint = '', mode, onProgress } = opts;
  const profile = ALT_MODES[mode];
  const eliminated: { mpn: string; reason: string }[] = [];

  if (!(await geminiAvailable())) {
    throw new Error('未配置 Gemini（Vercel 环境变量 GEMINI_API_KEY）');
  }

  // ── 1. AI 生成候选（多要，后筛选） ──
  onProgress?.('AI 生成候选型号…');
  const modeHint =
    mode === 'pin2pin' ? '必须与原型号封装完全相同、引脚定义一致'
    : mode === 'pkgCompat' ? '封装需一致或同兼容族'
    : mode === 'domestic' ? '仅限中国大陆厂商（兆易创新/沁恒/圣邦微/思瑞浦/南芯/矽力杰等）'
    : mode === 'lowCost' ? '优先量产常见、成本更低的型号'
    : '功能等效即可，允许改板';

  const raw = await geminiComplete(
    `原器件：${mpn}（厂商 ${manufacturer || '未知'}，${description || '无描述'}，封装 ${footprint || '未知'}）。\n` +
    `请给出 10 个真实存在的替代器件型号，要求：${modeHint}。\n` +
    `只列真实量产型号，不要编造。严格输出 JSON 数组，不要其它文字：\n` +
    `[{"mpn":"型号","manufacturer":"厂商","reason":"一句话替代理由"}]`,
  );
  let cands: { mpn: string; manufacturer?: string; reason?: string }[] = [];
  try {
    cands = extractJson<typeof cands>(raw).filter((x) => x && typeof x.mpn === 'string' && x.mpn.trim());
  } catch {
    throw new Error('AI 返回格式无法解析，请重试');
  }
  cands = cands.filter((x) => x.mpn.trim().toUpperCase() !== mpn.toUpperCase()).slice(0, 10);
  if (!cands.length) throw new Error('AI 未给出候选型号');

  // ── 2. 逐个验证存在性（ezPLM 优先，其次分销商） ──
  const out: AltCandidate[] = [];
  for (const cand of cands) {
    const q = cand.mpn.trim();
    onProgress?.(`验证 ${q}…`);
    let item: AltCandidate | null = null;

    // ezPLM
    const live = await searchEzplmParts(q, 3).catch(() => ({ available: false, items: [] as { mpn: string; manufacturer: string; description?: string; defaultFootprintName: string; componentId: string }[] }));
    const hit = live.items.find((i) => i.mpn.toUpperCase() === q.toUpperCase())
      ?? live.items.find((i) => i.mpn.toUpperCase().startsWith(q.toUpperCase()));
    if (hit) {
      item = {
        mpn: hit.mpn, manufacturer: hit.manufacturer, description: hit.description,
        footprint: hit.defaultFootprintName, source: 'ezplm', score: 0, verified: false, notes: [],
        componentId: hit.componentId,
      };
    } else {
      // 分销商（真实存在性的第二来源）
      const offers = await fetchSupplierOffers(q).catch(() => []);
      const best = offers.filter((o) => o.found && o.price != null).sort((a, b) => (a.price ?? 0) - (b.price ?? 0))[0];
      if (best) {
        item = {
          mpn: q, manufacturer: cand.manufacturer ?? '—', description: cand.reason,
          footprint: undefined, source: 'supplier', price: best.price, currency: best.currency,
          stock: best.stock, score: 0, verified: false, notes: [`${best.vendor} 收录`],
        };
      }
    }

    if (!item) {
      // 无权威来源 → 待核验（不淘汰，但明确标注）
      out.push({
        mpn: q, manufacturer: cand.manufacturer ?? '—', description: cand.reason,
        source: 'ai', score: 0, verified: false, notes: ['无权威来源验证，需人工核对 datasheet'],
      });
      continue;
    }
    out.push(item);
  }

  // ── 3. 模式硬门槛 + 评分 ──
  const scored: AltCandidate[] = [];
  for (const cnd of out) {
    const notes = [...cnd.notes];
    let technical = 70; // 基线：AI 认为功能等效

    // 封装门槛
    if (profile.requirePackageExact || profile.requirePackageCompat) {
      if (!cnd.footprint) {
        notes.push('封装未知，无法确认封装一致性');
        technical -= 25;
      } else if (profile.requirePackageExact && !packageExact(cnd.footprint, footprint)) {
        eliminated.push({ mpn: cnd.mpn, reason: `封装不一致（${cnd.footprint} ≠ ${footprint}）` });
        continue;
      } else if (profile.requirePackageCompat && !packageCompatible(cnd.footprint, footprint)) {
        eliminated.push({ mpn: cnd.mpn, reason: `封装不兼容（${cnd.footprint} vs ${footprint}）` });
        continue;
      } else {
        technical += 15;
        notes.push(packageExact(cnd.footprint, footprint) ? '封装完全一致' : '封装同兼容族');
      }
    }

    // 国产门槛
    if (profile.requireDomestic && !isDomesticManufacturer(cnd.manufacturer)) {
      eliminated.push({ mpn: cnd.mpn, reason: `非国产厂商（${cnd.manufacturer}）` });
      continue;
    }
    if (isDomesticManufacturer(cnd.manufacturer)) notes.push('国产厂商');

    // 价格门槛
    if (profile.requirePriceKnown && cnd.price == null) {
      notes.push('无报价数据，降级为待核验');
      technical -= 20;
    }

    const confidence = SOURCE_CONFIDENCE[cnd.source];
    const score = Math.round(Math.max(0, Math.min(100, technical)) * confidence);
    // 权威来源 + 达标分 = 正式推荐；否则待核验
    const verified = cnd.source !== 'ai' && score >= 40;
    scored.push({ ...cnd, score, verified, notes });
  }

  scored.sort((a, b) => b.score - a.score);
  const recommendations = scored.filter((x) => x.verified).slice(0, 5);
  const pending = scored.filter((x) => !x.verified).slice(0, 5);

  return {
    recommendations,
    pending,
    eliminated,
    notice: !recommendations.length && pending.length
      ? `未找到有权威来源支撑的候选；以下 ${pending.length} 个需人工核对 datasheet`
      : undefined,
  };
}
