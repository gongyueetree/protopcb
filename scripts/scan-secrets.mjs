/**
 * 密钥泄漏扫描：任何 VITE_ 前缀的变量都会被打进前端 bundle，
 * 因此 VITE_*KEY / *SECRET / *TOKEN 一律视为泄漏，CI 直接失败。
 *
 * 用法：node scripts/scan-secrets.mjs
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOTS = ['src', 'api', 'server', 'scripts'];
const FILES = ['.env.example', 'vite.config.ts', 'vercel.json', 'README.md', 'ARCHITECTURE.md'];
const EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.html']);

/** 危险模式：VITE_ 前缀 + 密钥类名字 */
const DANGEROUS = /\bVITE_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)\b/;
/** 疑似硬编码的真实密钥（Google API Key 形态、长 hex/base64 赋值给 key 字段） */
const HARDCODED = [
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{28,}['"]/i,
];

const hits = [];
function scanFile(p) {
  if (!EXT.has(extname(p))) return;
  const text = readFileSync(p, 'utf8');
  text.split('\n').forEach((line, i) => {
    if (p.endsWith('scan-secrets.mjs')) return;      // 本文件自身含模式定义
    if (DANGEROUS.test(line)) hits.push(`${p}:${i + 1}  VITE_ 前缀密钥：${line.trim().slice(0, 90)}`);
    for (const re of HARDCODED) {
      if (re.test(line) && !/process\.env|import\.meta\.env|example|xxx|your[_-]?key/i.test(line)) {
        hits.push(`${p}:${i + 1}  疑似硬编码密钥：${line.trim().slice(0, 90)}`);
      }
    }
  });
}
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p); else scanFile(p);
  }
}

ROOTS.forEach(walk);
FILES.filter(existsSync).forEach(scanFile);

if (hits.length) {
  console.error('✗ 发现潜在密钥泄漏：\n' + hits.map((h) => '  ' + h).join('\n'));
  console.error('\n密钥必须使用不带 VITE_ 前缀的服务端环境变量（如 GEMINI_API_KEY），并只在 api/ 中读取。');
  process.exit(1);
}
console.log('✓ 未发现 VITE_ 前缀密钥或硬编码密钥');
