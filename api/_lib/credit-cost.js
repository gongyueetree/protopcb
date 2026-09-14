/**
 * api/_lib/credit-cost.js
 * Credit 价目表 —— 必须与前端 src/design-core/entitlements 保持一致。
 * 服务端以本表为准：客户端传来的 cost 只作参考，防止篡改后少扣费。
 */
export const CREDIT_COST = {
  'scheme.generate': 5,
  'scheme.revise': 3,
  'subcircuit.recommend': 2,
  'advisor.analyze': 2,
  'block.analyze': 2,
  'part.extract': 4,
  'bom.estimate': 1,
  'symbol.generate': 3,
};
