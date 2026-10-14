import { useId } from 'react';
import { Trash2, AlertTriangle } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import { t } from '../../i18n/index.js';

/**
 * Accessible confirmation dialog matching the app's glassmorphic dark design.
 * Replaces native window.confirm() for dangerous or critical actions.
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
  const titleId = useId();
  const descId = useId();
  const dialogRef = useDialogA11y(isOpen, { onClose: onCancel, history: false });

  if (!isOpen) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
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
      className="outline-none dialog-overlay z-[70] bg-black/80 backdrop-blur-md animate-fade-in flex items-center justify-center p-4"
    >
      <div className="dialog-box glass-panel max-w-md w-full rounded-2xl p-6 border border-slate-700/80 shadow-2xl animate-scale-in">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-xl bg-rose-500/20 border border-rose-500/40 flex items-center justify-center text-rose-300 shrink-0">
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
            <p id={descId} className="text-sm text-slate-300 mt-2 whitespace-pre-line leading-relaxed">
              {message}
            </p>
          </div>
        </div>

        <div className="mt-6 flex justify-end items-center gap-3">
          <button
            id="confirm-dialog-cancel"
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="btn-secondary text-xs px-4 py-2"
          >
            {cancelLabel}
          </button>
          <button
            id="confirm-dialog-confirm"
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={
              effectiveVariant === 'danger'
                ? 'btn-danger text-xs px-4 py-2 font-semibold'
                : 'btn-primary text-xs px-4 py-2 font-semibold'
            }
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
