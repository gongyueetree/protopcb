/**
 * CSP 回归：blob: 必须显式出现在 connect-src 里。
 * 工程自带 3D 模型以 blob URL 挂载，而 CSP 的 `*` 不匹配 blob:/data: 这类 scheme ——
 * 少了这一项，fetch('blob:…') 会被浏览器拦成 "Failed to fetch"，本地 Node 测试完全看不到。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('vercel.json CSP', () => {
  const cfg = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  const csp: string = cfg.headers.flatMap((h: { headers: { key: string; value: string }[] }) => h.headers)
    .find((h: { key: string }) => h.key === 'Content-Security-Policy').value;
  const directive = (name: string) => csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + ' ')) ?? '';

  it('connect-src 显式允许 blob:（zip 导入的工程自带 STEP 靠它加载）', () => {
    expect(directive('connect-src')).toMatch(/\bblob:/);
  });
  it('worker-src / script-src 允许 blob:（OCCT 转换 worker 与解压 worker）', () => {
    expect(directive('worker-src')).toMatch(/\bblob:/);
    expect(directive('script-src')).toMatch(/\bblob:/);
  });
  it('frame-ancestors 保持 none（防点击劫持）', () => {
    expect(directive('frame-ancestors')).toMatch(/'none'/);
  });
});
