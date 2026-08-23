/**
 * providers/digikey/index.ts — DigiKey 价格/库存（经 /api/digikey 服务端代理）
 * 需 Vercel 配置 DIGIKEY_CLIENT_ID / DIGIKEY_CLIENT_SECRET。未配置时静默隐藏。
 */
import { curLang } from '../../shared/i18n';

export interface DigikeyOffer {
  found: boolean;
  unitPrice?: number;
  currency?: string;
  stock?: number;
  productUrl?: string;
  digikeyPn?: string;
  /** DigiKey 商品实拍图（详情面板头图兜底来源） */
  photoUrl?: string;
}

let availableCache: boolean | null = null;

export async function digikeyAvailable(): Promise<boolean> {
  if (availableCache !== null) return availableCache;
  try {
    const r = await fetch('/api/digikey?path=status');
    const j = await r.json();
    availableCache = !!j.configured;
  } catch {
    availableCache = false;
  }
  return availableCache;
}

const offerCache = new Map<string, DigikeyOffer | 'loading'>();

/** 查询单个型号的价格/库存（按 mpn 会话内缓存，避免重复消耗配额） */
/** 同步读缓存：报告/CSV 与 BOM 面板复用同一价格快照（未查询过的返回 null） */
export function digikeyOfferCached(mpn: string): DigikeyOffer | null {
  const c = offerCache.get(mpn);
  return c && c !== 'loading' && c.found ? c : null;
}

export async function fetchDigikeyOffer(mpn: string): Promise<DigikeyOffer | null> {
  if (!mpn || !(await digikeyAvailable())) return null;
  const cached = offerCache.get(mpn);
  if (cached && cached !== 'loading') return cached;
  if (cached === 'loading') return null;
  offerCache.set(mpn, 'loading');
  try {
    // 按界面语言请求对应币种的**真实报价**（不是把人民币数值换个符号显示）
    const cur = curLang() === 'en' ? 'USD' : 'CNY';
    const r = await fetch(`/api/digikey?path=price&mpn=${encodeURIComponent(mpn)}&currency=${cur}`);
    if (!r.ok) { offerCache.delete(mpn); return null; }
    const j = (await r.json()) as DigikeyOffer;
    offerCache.set(mpn, j);
    return j;
  } catch {
    offerCache.delete(mpn);
    return null;
  }
}

export function formatDkPrice(o: DigikeyOffer): string {
  if (o.unitPrice == null) return '见官网';
  const sym = o.currency === 'CNY' ? '¥' : o.currency === 'USD' ? '$' : (o.currency ?? '') + ' ';
  return `${sym}${o.unitPrice < 1 ? o.unitPrice.toFixed(4) : o.unitPrice.toFixed(2)}`;
}
