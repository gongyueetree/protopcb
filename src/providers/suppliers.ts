/**
 * providers/suppliers.ts — Mouser/Arrow/element14 聚合报价（经 /api/suppliers 服务端代理）
 */
export interface SupplierOffer {
  vendor: string;
  configured: boolean;
  found: boolean;
  price?: number;
  /** 币种；undefined = 上游文档未明确币种（如 OURIC），UI 显示裸数值并附 note */
  currency?: string;
  /** 该渠道查询失败时的原因（后端已截断，仅用于提示） */
  error?: string;
  stock?: number;
  url?: string;
  /** 阶梯价（qty 升序），Iceasy/OURIC 等提供 */
  priceBreaks?: { qty: number; price: number }[];
  /** 口径备注：币种待确认 / 虚拟库存 / MOQ 等 */
  note?: string;
  warehouse?: string;
  deliveryTime?: string;
}

const cache = new Map<string, SupplierOffer[]>();

export async function fetchSupplierOffers(mpn: string): Promise<SupplierOffer[]> {
  if (!mpn) return [];
  const hit = cache.get(mpn);
  if (hit) return hit;
  try {
    const r = await fetch(`/api/suppliers?mpn=${encodeURIComponent(mpn)}`);
    if (!r.ok) return [];
    const j = await r.json();
    const offers: SupplierOffer[] = Array.isArray(j.offers) ? j.offers : [];
    cache.set(mpn, offers);
    return offers;
  } catch {
    return [];
  }
}

export function fmtOfferPrice(o: SupplierOffer): string {
  if (o.price == null) return '见官网';
  // currency 未确认（如 OURIC 文档未标币种）时显示裸数值，不冒充某种货币
  const sym = o.currency === 'CNY' ? '¥' : o.currency === 'USD' ? '$' : o.currency ? o.currency + ' ' : '';
  return `${sym}${o.price < 1 ? o.price.toFixed(4) : o.price.toFixed(2)}`;
}
