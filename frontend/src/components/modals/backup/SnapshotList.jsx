import { FileArchive, RefreshCw, Download, Trash } from 'lucide-react';
import { apiUrl } from '../../../utils/api';
import { formatDateTime, formatMegabytes } from '../../../utils/format';
import { CATEGORY_LABELS, manifestSummary, versionSummary } from './backupHelpers';

const CATEGORY_STYLES = {
  daily: 'bg-sky-500/20 text-sky-300',
  manual: 'bg-purple-500/20 text-purple-300',
  'pre-restore': 'bg-amber-500/20 text-amber-200',
  'pre-update': 'bg-slate-700/60 text-slate-200'
};

function VerifiedBadge({ verified, error }) {
  if (verified === true) {
    return <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-emerald-500/20 text-emerald-300">geprüft ✓</span>;
  }
  if (verified === false) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-rose-500/20 text-rose-300" title={error || undefined}>
        beschädigt
      </span>
    );
  }
  return <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-slate-800 text-slate-400">ungeprüft</span>;
}

export default function SnapshotList({ snapshots, disabled, onRestore, onDelete }) {
  return (
    <ul className="space-y-2" aria-label="Server-Snapshots">
      {snapshots.map(b => {
        const label = CATEGORY_LABELS[b.category];
        const summary = manifestSummary(b.manifest);
        const versions = versionSummary(b.manifest);
        return (
          <li
            key={b.filename}
            className="glass-card rounded-2xl p-3 border border-slate-800 bg-slate-900/60 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 hover:border-slate-700 transition-all"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                b.category === 'daily' ? 'bg-sky-500/15 text-sky-400 border border-sky-500/30' : 'bg-purple-500/15 text-purple-400 border border-purple-500/30'
              }`}>
                <FileArchive className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-bold text-white truncate max-w-xs font-mono" title={b.filename}>
                    {b.filename}
                  </span>
                  {label && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${CATEGORY_STYLES[b.category]}`}>{label}</span>
                  )}
                  <VerifiedBadge verified={b.verified} error={b.verify_error} />
                </div>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  {formatDateTime(b.created_at)} • <strong className="font-mono text-slate-300">{formatMegabytes(b.size)}</strong>
                  {versions && <> • {versions}</>}
                </p>
                {summary && <p className="text-[11px] text-slate-400">{summary}</p>}
              </div>
            </div>

            <div className="flex items-center gap-1.5 w-full sm:w-auto justify-end shrink-0">
              <button
                type="button"
                onClick={() => onRestore(b.filename)}
                disabled={disabled}
                className="btn-secondary text-[11px] py-1 px-2.5 flex items-center gap-1 text-emerald-300 hover:text-white border-emerald-500/30 hover:bg-emerald-700 transition-all"
                title="Diesen Snapshot prüfen und wiederherstellen"
                aria-label={`Snapshot ${b.filename} wiederherstellen`}
              >
                <RefreshCw className="w-3 h-3" aria-hidden="true" />
                <span>Wiederherstellen</span>
              </button>
              <a
                href={apiUrl(`/api/backups/${encodeURIComponent(b.filename)}/download`)}
                className="btn-secondary text-[11px] py-1 px-2 flex items-center gap-1 text-sky-300 hover:text-white border-slate-700"
                title="Herunterladen"
                aria-label={`Snapshot ${b.filename} herunterladen`}
              >
                <Download className="w-3 h-3" aria-hidden="true" />
              </a>
              <button
                type="button"
                onClick={() => onDelete(b.filename)}
                disabled={disabled}
                className="btn-secondary text-[11px] py-1 px-2 text-rose-400 hover:text-white hover:bg-rose-600/50 border-slate-700"
                title="Löschen"
                aria-label={`Snapshot ${b.filename} löschen`}
              >
                <Trash className="w-3 h-3" aria-hidden="true" />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
