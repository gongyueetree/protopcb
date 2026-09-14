/**
 * providers/reference-design/private-cache.ts
 * 私有数据（应用项目、组织物料、参考设计的私有部分）的缓存 —— **按租户隔离**。
 *
 * 修复的问题：此前缓存键只有 componentId。用户 A 查过 U1 的应用项目后退出，
 * 用户 B 登录再查 U1，会直接命中 A 的缓存 —— 跨租户泄露。
 *
 * 规则：键必须含 tenant + user + resource；登出/切换账号时整体清空。
 */

export interface PrivateCacheKey {
  tenantId: string;
  userId: string;
  resourceId: string;
}

const store = new Map<string, { value: unknown; at: number }>();
const TTL_MS = 5 * 60 * 1000;

export const privateCacheKey = (k: PrivateCacheKey): string =>
  `${k.tenantId || '-'}|${k.userId || '-'}|${k.resourceId}`;

export function getPrivate<T>(k: PrivateCacheKey): T | undefined {
  // 没有身份就不该有私有缓存：匿名请求一律 miss，也不会写入
  if (!k.userId) return undefined;
  const hit = store.get(privateCacheKey(k));
  if (!hit) return undefined;
  if (Date.now() - hit.at > TTL_MS) { store.delete(privateCacheKey(k)); return undefined; }
  return hit.value as T;
}

export function setPrivate<T>(k: PrivateCacheKey, value: T): void {
  if (!k.userId) return;
  store.set(privateCacheKey(k), { value, at: Date.now() });
}

/** 登出 / 切换账号时调用：私有缓存整体作废 */
export function clearPrivateCaches(): void {
  store.clear();
}

/** 供测试观察 */
export const __privateCacheSize = () => store.size;
