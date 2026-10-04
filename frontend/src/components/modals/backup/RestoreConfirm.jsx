import { useEffect, useId, useRef } from 'react';
import { RefreshCw, TriangleAlert, ShieldAlert } from 'lucide-react';
import { formatDateTime, formatMegabytes, formatNumber, formatTime } from '../../../utils/format';

const ROWS = [
  ['mangas', 'Reihen'],
  ['volumes', 'Bände'],
  ['users', 'Benutzer']
];

const SCHEMA_NEWER_FALLBACK = 'Das Backup stammt aus einer neueren Version von Manga Shelf – erst Manga Shelf aktualisieren.';

/** Step 1 result of the two-step restore: what the backup holds, what it would replace, and the warnings. */
export default function RestoreConfirm({ inspection, allowNewer, onAllowNewerChange, restoring, onConfirm, onCancel }) {
  const headingRef = useRef(null);
  const checkboxId = useId();
  const {
    source, created_at: createdAt, created_at_source: createdAtSource, app_version: appVersion,
    current_app_version: currentAppVersion, schema_version: schemaVersion, current_schema_version: currentSchemaVersion,
    schema_newer: schemaNewer, counts = {}, current_counts: currentCounts = {}, uploads_bytes: uploadsBytes,
    current_user: currentUser, relogin, expires_at: expiresAt
  } = inspection;
  const warnings = Array.isArray(inspection.warnings) ? inspection.warnings : [];

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const userLine = relogin
    ? warnings.find(w => currentUser?.username && w.includes(currentUser.username)) || 'Du wirst danach abgemeldet.'
    : null;
  const schemaLine = schemaNewer ? warnings.find(w => /neueren Version/.test(w)) || SCHEMA_NEWER_FALLBACK : null;
  const otherLines = warnings.filter(w => w !== userLine && w !== schemaLine);
  const blocked = schemaNewer && !allowNewer;
  const date = createdAt ? formatDateTime(createdAt) : '';
  const expires = expiresAt ? formatTime(expiresAt) : '';

  return (
    <section aria-labelledby={`${checkboxId}-title`} className="space-y-4 py-4">
      <div>
        <h3 id={`${checkboxId}-title`} ref={headingRef} tabIndex={-1} className="text-sm font-bold text-white outline-none">
          Wiederherstellung bestätigen
        </h3>
        <p className="text-xs text-slate-400 mt-1 break-all">
          {source?.type === 'snapshot' ? 'Snapshot' : 'Datei'} „{source?.filename || 'Backup'}“
          {Number.isFinite(source?.size) && ` (${formatMegabytes(source.size)})`}
        </p>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-slate-400">Erstellt</dt>
        <dd className="text-slate-200">
          {date || 'unbekannt'}
          {date && createdAtSource === 'filename' && <span className="text-slate-400"> (laut Dateiname)</span>}
        </dd>
        <dt className="text-slate-400">App-Version</dt>
        <dd className="text-slate-200">
          {appVersion || 'unbekannt'}
          {currentAppVersion && <span className="text-slate-400"> (aktuell {currentAppVersion})</span>}
        </dd>
        {Number.isFinite(schemaVersion) && (
          <>
            <dt className="text-slate-400">Datenbank-Schema</dt>
            <dd className={schemaNewer ? 'text-rose-300 font-semibold' : 'text-slate-200'}>
              v{schemaVersion}
              {Number.isFinite(currentSchemaVersion) && <span className="text-slate-400 font-normal"> (aktuell v{currentSchemaVersion})</span>}
            </dd>
          </>
        )}
      </dl>

      <table className="w-full text-xs border-collapse">
        <caption className="sr-only">Inhalt des Backups im Vergleich zum aktuellen Stand</caption>
        <thead>
          <tr className="text-slate-400 border-b border-slate-800">
            <th scope="col" className="text-left font-medium py-1.5"><span className="sr-only">Bereich</span></th>
            <th scope="col" className="text-right font-medium py-1.5 px-2">Backup</th>
            <th scope="col" className="text-right font-medium py-1.5 pl-2">aktuell</th>
          </tr>
        </thead>
        <tbody className="text-slate-200">
          {ROWS.map(([key, label]) => (
            <tr key={key} className="border-b border-slate-800/60">
              <th scope="row" className="text-left font-medium py-1.5">{label}</th>
              <td className="text-right font-mono py-1.5 px-2">{formatNumber(counts[key] ?? 0)}</td>
              <td className="text-right font-mono py-1.5 pl-2">{currentCounts[key] === undefined ? '–' : formatNumber(currentCounts[key])}</td>
            </tr>
          ))}
          <tr>
            <th scope="row" className="text-left font-medium py-1.5">Bilder</th>
            <td className="text-right font-mono py-1.5 px-2">
              {formatNumber(counts.uploads ?? 0)}
              {uploadsBytes > 0 && <span className="text-slate-400"> ({formatMegabytes(uploadsBytes)})</span>}
            </td>
            <td className="text-right font-mono py-1.5 pl-2 text-slate-400">–</td>
          </tr>
        </tbody>
      </table>

      {userLine && (
        <div className="bg-rose-500/15 border border-rose-500/40 text-rose-100 p-3 rounded-xl text-sm font-semibold flex gap-2">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-rose-300" aria-hidden="true" />
          <span>{userLine}</span>
        </div>
      )}

      {schemaLine && (
        <div className="bg-rose-500/10 border border-rose-500/40 text-rose-200 p-3 rounded-xl text-xs space-y-2">
          <p className="flex gap-2">
            <TriangleAlert className="w-4 h-4 shrink-0 text-rose-300" aria-hidden="true" />
            <span>{schemaLine}</span>
          </p>
          <label htmlFor={checkboxId} className="flex items-center gap-2 text-rose-100 cursor-pointer">
            <input
              id={checkboxId}
              type="checkbox"
              checked={allowNewer}
              disabled={restoring}
              onChange={(e) => onAllowNewerChange(e.target.checked)}
            />
            Trotzdem einspielen (nicht empfohlen)
          </label>
        </div>
      )}

      {otherLines.length > 0 && (
        <ul aria-label="Hinweise zur Wiederherstellung" className="space-y-1">
          {otherLines.map(line => (
            <li key={line} className="text-xs text-amber-200 flex gap-2">
              <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" aria-hidden="true" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="text-[11px] text-slate-400">
        Vor dem Einspielen legt der Server einen Sicherungs-Snapshot der aktuellen Datenbank an.
        {expires && ` Diese Prüfung gilt bis ${expires} Uhr.`}
      </p>

      <div className="flex flex-wrap justify-end gap-2">
        <button
          id="btn-cancel-restore"
          type="button"
          onClick={onCancel}
          disabled={restoring}
          className="btn-secondary text-xs px-4 py-2 disabled:opacity-50"
        >
          Abbrechen
        </button>
        <button
          id="btn-confirm-restore"
          type="button"
          onClick={onConfirm}
          disabled={restoring || blocked}
          className="btn-primary flex items-center gap-2 text-xs !bg-emerald-700 hover:!bg-emerald-800 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${restoring ? 'animate-spin' : ''}`} aria-hidden="true" />
          {restoring ? 'Wird eingespielt...' : 'Wiederherstellen'}
        </button>
      </div>
    </section>
  );
}
