import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, AlertTriangle } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import { t } from '../../i18n/index.js';

// the confirmation on screen; a second one opened meanwhile is cancelled at once (never two stacked questions)
let shownConfirm = null;

/**
 * Accessible confirmation dialog matching the app's glassmorphic dark design, in place of native window.confirm().
 * One at a time; it owns a history entry like every dialog (Back cancels). The root carries `data-confirm`, the buttons
 * `data-confirm-action="cancel"` / `"confirm"`. Focus goes back to the opener, or to the dialog the opener was in when
 * the opener is gone (a removed list row).
 */
export default function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel = t('Löschen'),
  cancelLabel = t('Abbrechen'),
  variant = 'danger',
  isDanger,
  busy = false,
  onConfirm,
  onCancel
}) {
  const effectiveVariant = isDanger !== undefined ? (isDanger ? 'danger' : 'primary') : variant;
  const ids = useId();
  const titleId = `${ids}-title`;
  const descId = `${ids}-desc`;
  const latest = useRef(null);
  latest.current = { onCancel, busy };
  const [claimed, setClaimed] = useState(false);
  useLayoutEffect(() => {
    if (!isOpen) return undefined;
    if (shownConfirm) {
      latest.current.onCancel?.();
      return undefined;
    }
    const token = {};
    shownConfirm = token;
    setClaimed(true);
    return () => {
      if (shownConfirm === token) shownConfirm = null;
      setClaimed(false);
    };
  }, [isOpen]);
  const shown = Boolean(isOpen && claimed);

  // read while rendering, like the opener in useDialogA11y: the dialog the opener sits in
  const parentDialogRef = useRef(null);
  const wasShown = useRef(false);
  if (shown && !wasShown.current) {
    const opener = typeof document === 'undefined' ? null : document.activeElement;
    parentDialogRef.current = typeof opener?.closest === 'function' ? opener.closest('[role="dialog"]') : null;
  }
  wasShown.current = shown;
  const dialogRef = useDialogA11y(shown, {
    onClose: () => { if (!latest.current.busy) latest.current.onCancel?.(); },
    returnFocusRef: parentDialogRef
  });

  if (!shown) return null;

  // portal: inside a glass-panel (backdrop-filter) or a scrolling dialog a fixed overlay only covers that ancestor
  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={message ? descId : undefined}
      data-confirm=""
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) {
          e.stopPropagation();
          onCancel();
        }
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
      className="outline-none dialog-overlay z-[68] bg-black/80 backdrop-blur-md animate-fade-in"
    >
      <div className="dialog-box glass-panel max-w-md rounded-2xl p-6 border border-slate-700/80 shadow-2xl animate-scale-in">
        <div className="flex items-start gap-4">
          <div className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${effectiveVariant === 'danger'
            ? 'bg-rose-500/20 border-rose-500/40 text-rose-300'
            : 'bg-brand-500/20 border-brand-500/40 text-brand-300'}`}>
            {effectiveVariant === 'danger' ? (
              <Trash2 className="w-5 h-5" aria-hidden="true" />
            ) : (
              <AlertTriangle className="w-5 h-5" aria-hidden="true" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h3 id={titleId} className="text-base font-bold text-white tracking-tight">
              {title}
            </h3>
            {message && (
              <p id={descId} className="text-sm text-slate-300 mt-2 whitespace-pre-line leading-relaxed">
                {message}
              </p>
            )}
          </div>
        </div>

        <div className="mt-6 flex justify-end items-center gap-3">
          <button
            id={`${ids}-cancel`}
            type="button"
            onClick={onCancel}
            disabled={busy}
            data-confirm-action="cancel"
            data-autofocus
            className="btn-secondary text-xs px-4 py-2"
          >
            {cancelLabel}
          </button>
          <button
            id={`${ids}-confirm`}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            data-confirm-action="confirm"
            className={
              effectiveVariant === 'danger'
                ? 'btn-danger text-xs px-4 py-2 font-semibold'
                : 'btn-primary text-xs px-4 py-2 font-semibold'
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
