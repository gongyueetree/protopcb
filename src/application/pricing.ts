/**
 * application/pricing.ts — 报价/库存的应用服务（UI 唯一入口）。
 * 封装 DigiKey 单品报价与多分销商报价两个适配器；未登录时的门禁在服务端，
 * UI 侧通过 entitlementStore 决定要不要发起。
 */
export { fetchDigikeyOffer, digikeyOfferCached, formatDkPrice, searchDigikeyFuzzy, type DigikeyOffer } from '../providers/digikey';
export { fetchSupplierOffers, fmtOfferPrice, searchSupplierFuzzy, type SupplierOffer } from '../providers/suppliers';
