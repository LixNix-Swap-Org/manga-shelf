import { useState } from 'react';
import { Download, FileSpreadsheet, X } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import { apiUrl } from '../../utils/api';
import CsvImportPanel from '../modals/backup/CsvImportPanel';

/**
 * CSV export for every logged-in user and import for editors (POST /api/import/csv: dry run first, then the
 * previewed text). Admins also reach the same functions in the backup dialog.
 */
export default function CsvExchangeModal({ isOpen, onClose, canEdit, onImported }) {
  const dialogRef = useDialogA11y(isOpen);
  const [importing, setImporting] = useState(false);

  if (!isOpen) return null;

  const requestClose = () => {
    if (!importing) onClose();
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="csv-exchange-title"
      data-busy={importing ? 'true' : undefined}
      tabIndex={-1}
      onClick={(e) => { if (e.target === e.currentTarget) requestClose(); }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        requestClose();
      }}
      className="outline-none fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto animate-fade-in"
    >
      <div className="glass-panel w-full max-w-lg rounded-2xl sm:rounded-3xl p-5 sm:p-7 border border-slate-700/80 shadow-2xl my-3 sm:my-8 space-y-4">
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 flex items-center justify-center">
              <FileSpreadsheet className="w-5 h-5" aria-hidden="true" />
            </div>
            <h2 id="csv-exchange-title" className="text-xl font-bold text-white">CSV-Export{canEdit ? ' & Import' : ''}</h2>
          </div>
          <button
            type="button"
            onClick={requestClose}
            disabled={importing}
            aria-label="Schließen"
            className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-40"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div className="p-4 rounded-2xl bg-slate-900/40 border border-slate-800 space-y-2">
          <div className="text-sm font-semibold text-slate-200">Sammlung exportieren</div>
          <p className="text-xs text-slate-400">Alle Bände als CSV (Semikolon, UTF-8). Öffnet sich direkt in Excel oder LibreOffice.</p>
          <a id="btn-export-csv" href={apiUrl('/api/export/csv')} download className="btn-primary inline-flex items-center gap-2 text-xs !bg-emerald-700 hover:!bg-emerald-800">
            <Download className="w-4 h-4" aria-hidden="true" /> CSV herunterladen
          </a>
        </div>

        {canEdit && <CsvImportPanel onImported={onImported} onImportingChange={setImporting} />}

        <div className="pt-3 border-t border-slate-800 flex justify-end">
          <button type="button" onClick={requestClose} disabled={importing} className="btn-secondary text-sm disabled:opacity-50">
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
}
