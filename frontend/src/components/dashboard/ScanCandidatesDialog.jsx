import { BookOpen, Plus, X } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import { assetImgProps } from '../../utils/api';
import { langFor } from '../common/lang';

/** Barcode scan matched several similar series: the user picks one (or, as an editor, creates a new one). */
export default function ScanCandidatesDialog({ candidates, bookTitle, canEdit, onChoose, onCreateNew, onClose }) {
  const open = Boolean(candidates && candidates.length);
  const dialogRef = useDialogA11y(open);
  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="scan-candidates-title"
      tabIndex={-1}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        onClose();
      }}
      className="outline-none dialog-overlay z-50 bg-black/75 backdrop-blur-sm animate-fade-in"
    >
      <div className="dialog-box glass-panel max-w-md rounded-2xl sm:rounded-3xl p-5 sm:p-6 short:p-4 border border-slate-700/80 shadow-2xl space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="scan-candidates-title" className="text-lg font-bold text-white">Mehrere Reihen passen – bitte auswählen</h2>
            {bookTitle && <p className="text-xs text-slate-400 mt-1 truncate">Gescannt: {bookTitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            className="hit-44 text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition-colors shrink-0"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <ul className="space-y-2">
          {candidates.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onChoose(c)}
                className="w-full flex items-center gap-3 p-2 rounded-xl border border-slate-800 bg-slate-900/60 hover:border-brand-500/60 hover:bg-slate-800/60 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
              >
                <span className="w-9 h-12 rounded-md overflow-hidden bg-slate-950 border border-slate-800 shrink-0 flex items-center justify-center">
                  {c.cover_image
                    ? <img {...assetImgProps(c.cover_image)} alt="" className="w-full h-full object-cover" loading="lazy" />
                    : <BookOpen className="w-4 h-4 text-slate-500" aria-hidden="true" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-white truncate">{c.title}</span>
                  {(c.alt_title || c.publisher) && (
                    <span className="block text-xs text-slate-400 truncate">{c.alt_title && <span lang={langFor(c.alt_title)}>{c.alt_title}</span>}{c.alt_title && c.publisher ? ' · ' : ''}{c.publisher}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap justify-end gap-2 pt-3 border-t border-slate-800">
          {canEdit && onCreateNew && (
            <button type="button" onClick={onCreateNew} className="btn-secondary text-xs inline-flex items-center gap-1.5">
              <Plus className="w-4 h-4" aria-hidden="true" /> Neue Reihe anlegen
            </button>
          )}
          <button type="button" onClick={onClose} className="btn-secondary text-xs">Abbrechen</button>
        </div>
      </div>
    </div>
  );
}
