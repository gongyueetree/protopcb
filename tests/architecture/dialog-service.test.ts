/**
 * Phase 19：非阻塞对话框服务（替代 window.alert/confirm/prompt）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { useDialogStore } from '../../src/modules/ui/dialogStore';

describe('dialogStore 语义', () => {
  it('confirm：resolve(true) → true，取消 → false', async () => {
    const p = useDialogStore.getState().confirm('清空？');
    expect(useDialogStore.getState().dialog?.kind).toBe('confirm');
    useDialogStore.getState().resolveDialog(true);
    expect(await p).toBe(true);
    const p2 = useDialogStore.getState().confirm('再问');
    useDialogStore.getState().resolveDialog(false);
    expect(await p2).toBe(false);
    expect(useDialogStore.getState().dialog).toBeNull();
  });
  it('prompt：提交字符串 → 该字符串，取消 → null', async () => {
    const p = useDialogStore.getState().prompt('名字', '默认');
    expect(useDialogStore.getState().dialog?.defaultValue).toBe('默认');
    useDialogStore.getState().resolveDialog('我的板');
    expect(await p).toBe('我的板');
    const p2 = useDialogStore.getState().prompt('名字');
    useDialogStore.getState().resolveDialog(null);
    expect(await p2).toBeNull();
  });
  it('toast 追加并可关闭', () => {
    useDialogStore.getState().toast('ok', 'success', 100000);
    expect(useDialogStore.getState().toasts.at(-1)?.tone).toBe('success');
    const id = useDialogStore.getState().toasts.at(-1)!.id;
    useDialogStore.getState().dismissToast(id);
    expect(useDialogStore.getState().toasts.some((t) => t.id === id)).toBe(false);
  });
});

describe('生产代码不再使用阻塞式浏览器弹窗', () => {
  const SRC = new URL('../../src', import.meta.url).pathname;
  const walk = (d: string, out: string[] = []): string[] => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p, out); else if (/\.tsx?$/.test(p) && !/\.test\./.test(p) && !p.includes('__tests__')) out.push(p); } return out; };
  it('window.prompt / alert( / window.confirm 为 0', () => {
    const offenders = walk(SRC).filter((p) => /window\.prompt\(|(^|[^.\w])alert\(|window\.confirm\(/m.test(readFileSync(p, 'utf8').replace(/\/\/[^\n]*/g, ''))).map((p) => p.split('/src/')[1]);
    expect(offenders).toEqual([]);
  });
});
