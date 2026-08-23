import { describe, it, expect } from 'vitest';
import { isBlockedAddress, assertSafeUrl } from '../_lib/safe-fetch.js';

describe('SSRF 防护', () => {
  it('内网 / 环回 / 元数据地址一律拦截', () => {
    for (const ip of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('公网地址放行', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700::1111']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it('非 https 协议被拒（默认）', async () => {
    await expect(assertSafeUrl('http://example.com/a.pdf')).rejects.toThrow(/https/);
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(assertSafeUrl('gopher://x')).rejects.toThrow();
  });

  it('localhost / .local / .internal 主机名被拒', async () => {
    await expect(assertSafeUrl('https://localhost/x')).rejects.toThrow(/本机|内网/);
    await expect(assertSafeUrl('https://foo.local/x')).rejects.toThrow(/本机|内网/);
    await expect(assertSafeUrl('https://svc.internal/x')).rejects.toThrow(/本机|内网/);
  });

  it('字面量私网 IP 的 URL 被拒', async () => {
    await expect(assertSafeUrl('https://127.0.0.1:8080/x')).rejects.toThrow(/内网|保留/);
    await expect(assertSafeUrl('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(/内网|保留/);
    await expect(assertSafeUrl('https://[::1]/x')).rejects.toThrow(/内网|保留/);
  });

  it('URL 格式错误给出明确报错', async () => {
    await expect(assertSafeUrl('not a url')).rejects.toThrow(/格式无效/);
  });
});
