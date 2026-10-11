import { useId, useState } from 'react';
import { Download, ExternalLink, RotateCcw, TriangleAlert } from 'lucide-react';
import { formatDateTime } from '../../utils/format';
import { t } from '../../i18n/index.js';
import UpdateInstructions from './UpdateInstructions';
import { downgradeBackupName, README_UPDATING_URL, rollbackReasonText } from './updateModel';

const redBox = 'p-3 rounded-xl border border-rose-500/40 bg-rose-500/10 text-xs text-rose-200 space-y-2';
const linkClass = 'inline-flex items-center gap-1 text-brand-300 underline';

const PANEL_ENV_KINDS = new Set(['desktop', 'pterodactyl']);

/** Date of a backup as the rollback texts show it ('–' when unknown). */
export const backupDate = (at) => (at && formatDateTime(at)) || '–';

/** Red box of a downgrade that replaces the database: what is lost, which backup comes back, what is kept; children go last. */
export function DataLossNotice({ current, version, then, now, file, at, method = 'download', children = null }) {
  const date = backupDate(at);
  return (
    <div className={redBox} data-testid="update-data-loss">
      <p className="font-semibold flex items-center gap-1.5">
        <TriangleAlert className="w-4 h-4 shrink-0" aria-hidden="true" /> {t('Änderungen seit dem Update gehen verloren')}
      </p>
      <p className="break-words">
        {t('v{current} hat die Datenbank beim Update umgebaut (Schema v{then} → v{now}); v{version} kann sie so nicht öffnen. Zurück geht es nur mit dem Backup von vor dem Update: {file} ({date}).', {
          current, then, now, version, file: file || '–', date
        })}
      </p>
      <p>{t('Alles, was seit {date} geändert wurde, fehlt danach – neue Reihen und Bände, Lesestand, Anime-Fortschritt, Einkaufsliste, Benutzer und Einstellungen. Bilder in uploads/ bleiben.', { date })}</p>
      {method === 'instructions' ? (
        <p>{t('Beim Einspielen sichert v{version} den heutigen Stand als vor-wiederherstellung-….zip; er lässt sich mit v{current} oder neuer wieder einspielen und fällt unter die Aufbewahrung BACKUP_KEEP_PRE_RESTORE – bei Bedarf herunterladen.', { version, current })}</p>
      ) : (
        <p className="break-words">
          {t('Der heutige Stand wird vorher als eigenes Backup gesichert ({file}) und lässt sich mit v{current} oder neuer wieder einspielen.', { file: downgradeBackupName(current, version), current })}
          {' '}
          {t('Auf v{version} fällt es unter die Aufbewahrung der Update-Backups (BACKUP_KEEP_PRE_UPDATE) – bei Bedarf herunterladen.', { version })}
        </p>
      )}
      {children}
    </div>
  );
}

/** "Zurück zu v…" on the system page: the version before the last update, by download or with the steps of this install. */
export default function RollbackPanel({ rollback, current: running = null, install = null, platform = '', releaseUrl = '', disabled = false, onStart }) {
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  if (!rollback?.version) return null;
  const { version } = rollback;
  const current = rollback.current || running;
  const changed = Boolean(rollback.schema?.changed);
  const method = rollback.method === 'instructions' ? 'instructions' : 'download';
  const reason = !rollback.available ? rollbackReasonText(rollback.reason) : '';
  const kind = String(install?.instructions?.kind || install?.mode || '');
  const shown = open && Boolean(rollback.available);
  return (
    <div className="space-y-2 text-xs text-slate-300" data-testid="update-rollback">
      <p>{t('Läuft v{current} nicht wie gewünscht, kannst du zur Version vor dem letzten Update zurückkehren.', { current })}</p>
      {reason && <p className="text-amber-200">{t('Zurück zu v{version} ist nicht möglich: {reason}', { version, reason })}</p>}
      <button
        type="button"
        id="btn-update-rollback"
        className="btn-secondary text-xs inline-flex items-center gap-1.5"
        disabled={!rollback.available || disabled}
        aria-expanded={shown}
        aria-controls={shown ? detailsId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> {t('Zurück zu v{version}', { version })}
      </button>
      {shown && (
        <div id={detailsId} className="space-y-2">
          {changed ? (
            <DataLossNotice
              current={current}
              version={version}
              then={rollback.schema?.then}
              now={rollback.schema?.now}
              file={rollback.backup?.file}
              at={rollback.backup?.at}
              method={method}
            />
          ) : (
            <p>{t('Die Datenbank bleibt, wie sie ist: v{current} hat sie nicht umgebaut, v{version} öffnet sie unverändert. Es geht nichts verloren.', { current, version })}</p>
          )}
          {method === 'instructions' ? (
            <>
              {changed && (
                <p className="font-semibold text-amber-200">
                  {PANEL_ENV_KINDS.has(kind)
                    ? t('einmal mit ALLOW_NEWER_SCHEMA=1 starten, sofort das Backup einspielen, vorher nichts ändern')
                    : t('nicht starten, bevor das Backup eingespielt ist')}
                </p>
              )}
              <UpdateInstructions
                install={install}
                version={version}
                latest={null}
                releaseUrl={releaseUrl}
                platform={platform}
                downgrade={{ schemaChanged: changed, backup: rollback.backup?.file || null }}
              />
              <a href={README_UPDATING_URL} target="_blank" rel="noreferrer noopener" className={linkClass}>
                {t('Weg zurück (README)')} <ExternalLink className="w-3 h-3" aria-hidden="true" />
              </a>
            </>
          ) : (
            <button
              type="button"
              id="btn-update-rollback-prepare"
              className="btn-primary text-xs inline-flex items-center gap-1.5"
              disabled={disabled}
              onClick={() => onStart?.(version)}
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" /> {t('Herunterladen und prüfen')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
