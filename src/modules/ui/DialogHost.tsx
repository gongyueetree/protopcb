/**
 * modules/ui/DialogHost.tsx
 * 对话框与 toast 的渲染宿主：挂在 App 根部一次。
 * 对话框：Enter 提交 / Esc 取消 / 焦点困在框内 / 关闭后焦点回到触发元素 / aria-labelledby。
 */
import { useEffect, useRef, useState } from 'react';
import { useDialogStore } from './dialogStore';
import { tr } from '../../shared/i18n';
import { COLORS } from '../../shared/theme';

const TONE: Record<string, { bg: string; fg: string; bd: string }> = {
  info: { bg: '#f0f9ff', fg: '#0c4a6e', bd: '#bae6fd' },
  success: { bg: '#f0fdf4', fg: '#14532d', bd: '#bbf7d0' },
  warning: { bg: '#fffbeb', fg: '#78350f', bd: '#fde68a' },
  error: { bg: '#fef2f2', fg: '#7f1d1d', bd: '#fecaca' },
};

export function DialogHost() {
  const toasts = useDialogStore((s) => s.toasts);
  const dismiss = useDialogStore((s) => s.dismissToast);
  const dialog = useDialogStore((s) => s.dialog);
  const resolve = useDialogStore((s) => s.resolveDialog);
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!dialog) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    setValue(dialog.defaultValue ?? ''); setErr(null);
    // 下一帧聚焦：输入框优先，否则确定键
    const t = setTimeout(() => (inputRef.current ?? okRef.current)?.focus(), 0);
    return () => { clearTimeout(t); restoreRef.current?.focus?.(); };
  }, [dialog]);

  const submit = () => {
    if (!dialog) return;
    if (dialog.kind === 'prompt') {
      const v = value.trim();
      const e = dialog.validate?.(v) ?? (v ? null : tr('不能为空'));
      if (e) { setErr(e); return; }
      resolve(v);
    } else resolve(true);
  };
  const cancel = () => resolve(dialog?.kind === 'prompt' ? null : false);

  // 焦点困在对话框内
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    if (e.key === 'Enter' && dialog?.kind === 'prompt') { e.preventDefault(); submit(); }
    if (e.key === 'Tab' && boxRef.current) {
      const els = boxRef.current.querySelectorAll<HTMLElement>('input,button');
      if (!els.length) return;
      const first = els[0], last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };

  return (
    <>
      {/* toasts */}
      <div style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 1000, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 380 }} aria-live="polite">
        {toasts.map((t) => {
          const c = TONE[t.tone];
          return (
            <div key={t.id} role="status" onClick={() => dismiss(t.id)}
              style={{ padding: '10px 14px', borderRadius: 10, background: c.bg, color: c.fg, border: `1px solid ${c.bd}`, fontSize: 12.5, lineHeight: 1.55, boxShadow: '0 6px 20px rgba(0,0,0,.10)', cursor: 'pointer', whiteSpace: 'pre-wrap' }}>
              {t.message}
            </div>
          );
        })}
      </div>

      {/* modal */}
      {dialog && (
        <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) cancel(); }}
          style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(15,23,42,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div ref={boxRef} role="dialog" aria-modal="true" aria-labelledby={`dlg-title-${dialog.id}`} onKeyDown={onKeyDown}
            style={{ background: '#fff', borderRadius: 12, padding: 18, width: 420, maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,.25)' }}>
            <div id={`dlg-title-${dialog.id}`} style={{ fontSize: 14, fontWeight: 700, color: COLORS.green, marginBottom: 8 }}>
              {dialog.title ?? (dialog.kind === 'prompt' ? tr('请输入') : tr('请确认'))}
            </div>
            <div style={{ fontSize: 12.5, color: '#334155', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{dialog.message}</div>
            {dialog.kind === 'prompt' && (
              <>
                <input ref={inputRef} value={value} onChange={(e) => { setValue(e.target.value); setErr(null); }}
                  aria-invalid={!!err}
                  style={{ width: '100%', marginTop: 10, padding: '8px 10px', borderRadius: 8, border: `1px solid ${err ? '#fca5a5' : '#cbd5e1'}`, fontSize: 13, boxSizing: 'border-box' }} />
                {err && <div style={{ fontSize: 11, color: '#b91c1c', marginTop: 4 }}>{err}</div>}
              </>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button type="button" onClick={cancel}
                style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', fontSize: 12.5, cursor: 'pointer' }}>{tr('取消')}</button>
              <button ref={okRef} type="button" onClick={submit}
                style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: COLORS.green, color: '#fff', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>{tr('确定')}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
