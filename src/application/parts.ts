/**
 * application/parts.ts — 器件检索的应用服务（UI 唯一入口）。
 *
 * UI 不再知道 ezPLM / DigiKey / Mouser 的接口细节：这里把具体适配器
 * （providers/ezplm/live、providers/supplier-search）封装成两个用例。
 * 依赖方向：modules → application → providers。
 */
export { searchEzplmParts, ezplmLiveAvailable, isEzplmPart } from '../providers/ezplm/live';
export { searchSupplierParts, supplierPartToResult } from '../providers/supplier-search';
