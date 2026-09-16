/**
 * providers/kicad-library.ts — KiCad 官方库的基础设施适配器（唯一知道 /api/kicadlib 路径的地方）。
 * UI 通过 application/library 使用；不得再手拼 URL。
 */

export interface LibHit { lib: string; name: string; score?: number }

async function getJson<T>(url: string): Promise<T> {
  // 不按 ok 抛：服务端的错误也是 JSON（{error}），调用方要拿到它显示给用户
  return (await fetch(url)).json() as Promise<T>;
}

const q = (o: Record<string, string | number | undefined>) =>
  Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');

export const kicadLibrary = {
  /** 封装名检索 */
  searchFootprints: (query: string) => getJson<{ hits?: LibHit[]; items?: LibHit[]; error?: string }>(`/api/kicadlib?${q({ path: 'fpsearch', q: query })}`),
  /** 符号名检索 */
  searchSymbols: (query: string, limit?: number) => getJson<{ hits?: LibHit[]; items?: LibHit[]; error?: string }>(`/api/kicadlib?${q({ path: 'symsearch', q: query, limit })}`),
  /** 封装库列表 / 符号库列表 */
  listFootprintLibs: () => getJson<{ libs?: string[]; error?: string }>('/api/kicadlib?path=libs'),
  listSymbolLibs: () => getJson<{ libs?: string[]; error?: string }>('/api/kicadlib?path=symlibs'),
  /** 某库内的封装/符号名 */
  listFootprints: (lib: string) => getJson<{ items?: string[]; error?: string }>(`/api/kicadlib?${q({ path: 'list', lib })}`),
  listSymbols: (lib: string) => getJson<{ items?: string[]; error?: string }>(`/api/kicadlib?${q({ path: 'symlist', lib })}`),
  /** 取 .kicad_mod / .kicad_sym 原文（返回 Response：调用方需要区分 ok/错误 JSON/原文） */
  fetchFootprint: (lib: string, name: string) => fetch(`/api/kicadlib?${q({ path: 'mod', lib, name })}`),
  fetchSymbol: (lib: string, name: string) => fetch(`/api/kicadlib?${q({ path: 'sym', lib, name })}`),
  /** 官方 3D 模型 URL（只生成地址，加载由 step-loader 完成） */
  stepUrl: (lib3d: string, name3d: string) => `/api/kicadlib?${q({ path: 'step', lib: lib3d, name: name3d })}`,
};

/** DS2KiCad 提取引擎（服务端已要求登录） */
export const ds2kicad = {
  status: () => fetch('/api/ds2kicad').then((r) => r.json()).catch(() => ({ configured: false })) as Promise<{ configured: boolean }>,
  extract: (body: Record<string, unknown>) => fetch('/api/ds2kicad', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }),
};
