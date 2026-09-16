/**
 * 确定性 API 桩。每个场景只打开需要的桩，默认匿名。
 */
import type { Page, Route } from '@playwright/test';

const json = (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers });

export const PART_POOL = [
  { partlibId: 'p1', mpn: 'CH340C', manufacturer: 'WCH', category: 'IC', footprint: 'SOP-16', description: 'USB to serial UART' },
  { partlibId: 'p2', mpn: 'CH340G', manufacturer: 'WCH', category: 'IC', footprint: 'SOP-16', description: 'USB to serial UART' },
  { partlibId: 'p3', mpn: '24LC00T-I/SN', manufacturer: 'Microchip', category: 'IC', footprint: 'SOIC-8', description: 'EEPROM' },
  { partlibId: 'p4', mpn: 'LSM6DSOPTR', manufacturer: 'ST', category: 'IC', footprint: 'LGA-14', description: 'IMU' },
  { partlibId: 'p5', mpn: 'Servo PHAT', manufacturer: 'Pimoroni', category: 'Module', footprint: '-', description: 'Raspberry Pi servo pHAT' },
];

export interface SessionStub { tier: 'anonymous' | 'registered'; credits?: number; userId?: string; backendConnected?: boolean }

export async function stubSession(page: Page, s: SessionStub) {
  await page.route('**/api/session', (r) => json(r, s.tier === 'registered'
    ? { tier: 'registered', userId: s.userId ?? 'u1', organizationId: 'org1', credits: s.credits ?? 100, creditsKnown: true, displayName: 'E2E User' }
    : { tier: 'anonymous', backendConnected: s.backendConnected ?? true, reason: s.backendConnected === false ? 'BACKEND_NOT_CONNECTED' : 'LOGIN_REQUIRED' }));
}

/** ezPLM 公开检索：按关键词过滤 fixture 池 */
export async function stubEzplm(page: Page, calls: string[] = []) {
  await page.route('**/api/ezplm**', (r) => {
    const u = new URL(r.request().url());
    calls.push(u.searchParams.get('path') ?? '');
    const path = u.searchParams.get('path');
    if (path === 'status') return json(r, { configured: true });
    if (path === 'parts') {
      const kw = (u.searchParams.get('keyword') ?? '').toUpperCase();
      return json(r, { data: PART_POOL.filter((p) => !kw || p.mpn.toUpperCase().includes(kw) || p.description.toUpperCase().includes(kw)) });
    }
    if (path === 'application-projects') return json(r, { error: 'not connected', code: 'APPLICATION_PROJECTS_NOT_CONNECTED' }, 501);
    return json(r, { data: [] });
  });
}

/** 分销商 / DigiKey：记录调用；匿名时服务端会 401，这里模拟同样语义 */
export async function stubSuppliers(page: Page, calls: string[] = [], authed = false) {
  const handler = (r: Route) => {
    const u = new URL(r.request().url());
    calls.push(u.pathname + '?' + u.searchParams.get('path'));
    if (u.searchParams.get('path') === 'status') return json(r, { configured: true });
    if (!authed) return json(r, { error: 'login required', code: 'LOGIN_REQUIRED' }, 401);
    return json(r, { items: [{ mpn: 'CH340C', vendor: 'DigiKey', price: 0.85, currency: 'USD', stock: 1200, url: 'https://example.test' }] });
  };
  await page.route('**/api/digikey**', handler);
  await page.route('**/api/suppliers**', handler);
}

/** AI：记录 operation，按固定价目扣费 */
export async function stubAi(page: Page, state: { credits: number; calls: string[] }) {
  const COST: Record<string, number> = { 'scheme.generate': 5, 'scheme.revise': 3, 'subcircuit.recommend': 2, 'advisor.analyze': 2, 'block.analyze': 2, 'part.extract': 4, 'bom.estimate': 1, 'symbol.generate': 3 };
  await page.route('**/api/gemini**', (r) => json(r, { configured: true }));
  await page.route('**/api/ai', async (r) => {
    const body = r.request().postDataJSON() as { operation: string; operationId: string };
    state.calls.push(body.operation);
    const cost = COST[body.operation];
    if (cost == null) return json(r, { error: 'unknown', code: 'UNKNOWN_OPERATION' }, 400);
    if (state.credits < cost) return json(r, { error: 'insufficient', code: 'INSUFFICIENT_CREDITS', cost }, 402);
    state.credits -= cost;
    const text = body.operation.startsWith('scheme.')
      ? JSON.stringify({ summary: 'USB 串口', components: [{ mpn: 'CH340C', footprint: 'SOP-16', category: 'ic', qty: 1, group: 'CH340C', core: true }, { mpn: '100nF', footprint: 'C_0402_1005Metric', category: 'passive', qty: 2, group: 'CH340C' }] })
      : '{}';
    return json(r, { data: { text }, usage: { operation: body.operation, charged: cost, remaining: state.credits, operationId: body.operationId } });
  });
}

export async function stubKicadLib(page: Page) {
  await page.route('**/api/kicadlib**', (r) => json(r, { libs: [], items: [], hits: [] }));
}
