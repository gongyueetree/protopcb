/**
 * Phase 20：cc_* / cc:* → protopcb:* 一次性迁移，老用户存档与自建器件不丢
 */
import { describe, it, expect } from 'vitest';
import { migrateLegacyStorage, KEYS, keyOf } from '../../src/shared/storage';

function memStorage(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init));
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  } as Storage;
}

describe('迁移', () => {
  it('固定键与带参数键都迁到新前缀，旧键删除', () => {
    const st = memStorage({
      'cc_doc_autosave': '{"doc":1}', 'cc_custom_parts': '[1]', 'cc_lang': 'en',
      'cc_manual_price_docA': '{"R1":0.1}', 'cc_ksym_Device:R': '(sym)', 'cc_ksym_mpn_STM32': '(sym2)',
    });
    const r = migrateLegacyStorage(st);
    expect(r.failed).toEqual([]);
    expect(st.getItem(KEYS.docAutosave)).toBe('{"doc":1}');
    expect(st.getItem(KEYS.customParts)).toBe('[1]');
    expect(st.getItem(KEYS.lang)).toBe('en');
    expect(st.getItem(keyOf.manualPrice('docA'))).toBe('{"R1":0.1}');
    expect(st.getItem(keyOf.ksym('Device:R'))).toBe('(sym)');
    expect(st.getItem(keyOf.ksymMpn('STM32'))).toBe('(sym2)');
    for (const old of ['cc_doc_autosave', 'cc_custom_parts', 'cc_lang', 'cc_manual_price_docA', 'cc_ksym_Device:R', 'cc_ksym_mpn_STM32']) expect(st.getItem(old)).toBeNull();
  });

  it('新键已存在时不覆盖（只删旧键）', () => {
    const st = memStorage({ 'cc_doc_autosave': 'OLD', [KEYS.docAutosave]: 'NEW' });
    migrateLegacyStorage(st);
    expect(st.getItem(KEYS.docAutosave)).toBe('NEW');
    expect(st.getItem('cc_doc_autosave')).toBeNull();
  });

  it('幂等：第二次调用不再动任何键', () => {
    const st = memStorage({ 'cc_lang': 'zh' });
    migrateLegacyStorage(st);
    st.setItem('cc_lang', 'again');   // 模拟旧代码又写了一个旧键
    const r2 = migrateLegacyStorage(st);
    expect(r2.migrated).toEqual([]);
  });

  it('更老的 cc:autosave 也能迁到同一个新键', () => {
    const st = memStorage({ 'cc:autosave': '{"legacy":true}' });
    migrateLegacyStorage(st);
    expect(st.getItem(KEYS.docAutosave)).toBe('{"legacy":true}');
  });
});
