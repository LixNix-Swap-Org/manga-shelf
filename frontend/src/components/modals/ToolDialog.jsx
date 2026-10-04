import { useId } from 'react';
import { X } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';

/**
 * Shell of the collection tools: overlay above other dialogs, scrolling body (the whole dialog on short landscape
 * screens), Escape and backdrop click close it unless `busy`.
 */
export default function ToolDialog({ id, title, subtitle, Icon, onClose, busy = false, children, footer = null }) {
  const titleId = useId();
  const close = () => { if (!busy) onClose(); };
  const dialogRef = useDialogA11y(true, { onClose: close });
  return (
    <div
      id={id}
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      className="outline-none dialog-overlay z-[60] bg-black/80 backdrop-blur-md animate-fade-in"
    >
      <div className="dialog-box glass-panel max-w-3xl max-h-[90vh] supports-[height:100dvh]:max-h-[90dvh] short:max-h-none rounded-3xl p-5 sm:p-7 short:p-4 border border-slate-700/80 shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-3 pb-4 short:pb-2 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            {Icon && (
              <div className="w-10 h-10 short:hidden rounded-2xl bg-brand-500/20 border border-brand-500/40 flex items-center justify-center text-brand-300 shrink-0">
                <Icon className="w-5 h-5" aria-hidden="true" />
              </div>
            )}
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-extrabold text-white tracking-tight">{title}</h2>
              {subtitle && <p className="text-xs text-slate-400 mt-0.5 short:hidden">{subtitle}</p>}
            </div>
          </div>
          <button type="button" onClick={close} disabled={busy} className="hit-44 shrink-0 text-slate-400 hover:text-white p-1 rounded-xl hover:bg-slate-800" aria-label="Schließen" title="Schließen">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>
        <div className="overflow-y-auto short:overflow-visible custom-scrollbar flex-1 pr-1 pt-4 short:pt-3">{children}</div>
        <div className="pt-4 mt-4 short:pt-3 short:mt-3 border-t border-slate-800 flex flex-wrap items-center justify-end gap-2 shrink-0">
          {footer}
          <button type="button" onClick={close} disabled={busy} className="btn-secondary text-xs px-4 py-2">Schließen</button>
        </div>
      </div>
    </div>
  );
}
