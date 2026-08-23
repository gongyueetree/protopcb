import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { safeUnzip, ZipSafetyError, isUnsafeEntryName, isIgnorableEntry } from './safe-unzip';

describe('ZIP 安全解压', () => {
  it('正常 KiCad 工程包可解压', async () => {
    const zip = zipSync({ 'proj/board.kicad_pcb': strToU8('(kicad_pcb)'), 'proj/x.kicad_sch': strToU8('(kicad_sch)') });
    const out = await safeUnzip(zip);
    expect(Object.keys(out).sort()).toEqual(['proj/board.kicad_pcb', 'proj/x.kicad_sch']);
  });

  it('__MACOSX / .DS_Store / ._ 资源叉被忽略', async () => {
    const zip = zipSync({
      'a.kicad_pcb': strToU8('x'),
      '__MACOSX/._a.kicad_pcb': strToU8('junk'),
      '.DS_Store': strToU8('junk'),
    });
    const out = await safeUnzip(zip);
    expect(Object.keys(out)).toEqual(['a.kicad_pcb']);
  });

  it('zip-slip 路径被拒绝', () => {
    expect(isUnsafeEntryName('../../etc/passwd')).toBe(true);
    expect(isUnsafeEntryName('/abs/path')).toBe(true);
    expect(isUnsafeEntryName('C:\\win\\x')).toBe(true);
    expect(isUnsafeEntryName('a/../../b')).toBe(true);
    expect(isUnsafeEntryName('proj/board.kicad_pcb')).toBe(false);
  });

  it('含 zip-slip 条目的包整体拒绝', async () => {
    const zip = zipSync({ '../evil.txt': strToU8('x'), 'ok.kicad_pcb': strToU8('y') });
    await expect(safeUnzip(zip)).rejects.toThrow(ZipSafetyError);
  });

  it('文件数量超限被拒', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 60; i++) files[`f${i}.txt`] = strToU8('x');
    await expect(safeUnzip(zip_(files), { maxFiles: 50 })).rejects.toThrow(/超过 50 个上限/);
  });

  it('压缩包体积超限被拒（不必真的解压）', async () => {
    const zip = zipSync({ 'a.txt': strToU8('x'.repeat(1000)) });
    await expect(safeUnzip(zip, { maxZipBytes: 100 })).rejects.toThrow(/超过.*上限/);
  });

  it('单文件解压后超限被拒', async () => {
    const zip = zipSync({ 'big.txt': strToU8('A'.repeat(200_000)) });
    await expect(safeUnzip(zip, { maxFileBytes: 50_000 })).rejects.toThrow(/超过/);
  });

  it('高压缩比（ZIP 炸弹特征）被拒', async () => {
    // 10MB 全零 → 压缩后极小，压缩比远超阈值
    const zip = zipSync({ 'bomb.bin': new Uint8Array(10 * 1024 * 1024) });
    await expect(safeUnzip(zip, { maxRatio: 50 })).rejects.toThrow(/压缩比异常/);
  });

  it('损坏的包给出可读错误', async () => {
    await expect(safeUnzip(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/解析失败|损坏/);
  });

  it('忽略判定覆盖目录项', () => {
    expect(isIgnorableEntry('proj/')).toBe(true);
    expect(isIgnorableEntry('proj/a.kicad_pcb')).toBe(false);
  });
});

function zip_(files: Record<string, Uint8Array>) { return zipSync(files); }
