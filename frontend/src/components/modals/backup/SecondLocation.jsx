import { useEffect, useId, useState } from 'react';
import { TriangleExclamationPoint } from 'lucide-react';
import { apiFetch } from '../../../utils/api';
import { formatDateTime, formatMegabytes, formatNumber } from '../../../utils/format';
import { httpErrorMessage, readJson } from './backupHelpers';
import { t, tn } from '../../../i18n/index.js';
import { payloadText } from '../../../i18n/serverText.js';

// i18n
export const SAME_DISK_HINT = 'Alle Backups liegen auf derselben Platte wie die Datenbank. Lade ab und zu ein Direkt-ZIP herunter oder richte unten einen zweiten Speicherort ein.';

/** The amber hint of GET /api/backups' copy.same_disk_hint (no second location, no ZIP downloaded in 30 days). */
export function SameDiskHint({ className = '' }) {
  return (
    <div role="note" className={`bg-amber-500/10 border border-amber-500/30 text-amber-200 p-3 rounded-xl text-xs flex gap-2 ${className}`}>
      <TriangleExclamationPoint className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
      <span>{t(SAME_DISK_HINT)}</span>
    </div>
  );
}

/**
 * "Zweiter Speicherort" in the Backups dialog: the folder every verified snapshot is copied to (PUT /api/backup/copy
 * { dir }, an empty field removes it). Locked while BACKUP_COPY_DIR sets it. Shows the last copy, the number of copies
 * and the free space, or the reason the last copy failed. `onSaved(body)` gets the answer ({ backups, copy }).
 */
export default function SecondLocation({ copy, disabled = false, onSaved }) {
  const [value, setValue] = useState(copy?.dir || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const inputId = useId();
  useEffect(() => { setValue(copy?.dir || ''); }, [copy?.dir]);
  if (!copy) return null;

  const locked = Boolean(copy.from_env);
  const unchanged = value.trim() === (copy.dir || '');
  const healthy = Boolean(copy.dir) && !copy.error;
  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch('/api/backup/copy', { method: 'PUT', body: { dir: value.trim() } });
      const data = await readJson(res);
      if (!res.ok) setError(httpErrorMessage(res.status, data, t('Speicherort konnte nicht gespeichert werden')));
      else onSaved?.(data);
    } catch (_) {
      setError(t('Netzwerkfehler beim Speichern.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2" data-second-location>
      {copy.same_disk_hint && <SameDiskHint />}
      <form
        onSubmit={save}
        className={`rounded-xl border p-3 text-xs ${healthy ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-50' : 'border-slate-800 bg-slate-900/40'}`}
      >
        <p className="font-semibold text-white mb-2">{t('Zweiter Speicherort')}</p>
        <div className="flex gap-2 items-center">
          <label htmlFor={inputId} className="sr-only">{t('Ordner für Kopien')}</label>
          <input
            id={inputId}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            readOnly={locked}
            disabled={disabled || saving}
            maxLength={1024}
            spellCheck={false}
            autoComplete="off"
            placeholder={t('z. B. E:\\Manga-Backups oder /mnt/nas/manga')}
            className="input-field bg-slate-950 font-mono text-base sm:text-xs py-2 min-w-0 flex-1"
          />
          {!locked && (
            <button type="submit" disabled={disabled || saving || unchanged} className="btn-secondary text-xs py-2 px-3 shrink-0">
              {t('Speichern')}
            </button>
          )}
        </div>
        {error && <p role="alert" className="mt-2 text-rose-300">{error}</p>}
        {locked && <p className="mt-2 text-slate-400">{t('Festgelegt über die Variable BACKUP_COPY_DIR.')}</p>}
        {!copy.dir && (
          <p className="mt-2 text-slate-400">{t('Ein Ordner auf einer anderen Platte, einem USB-Stick oder einer NAS-Freigabe, die der Server erreicht. Jedes geprüfte Backup wird dorthin kopiert, mit denselben Aufbewahrungsregeln.')}</p>
        )}
        {healthy && (
          <p className="mt-2 text-emerald-300" data-testid="copy-summary">
            {[
              copy.ok_at ? t('Letzte Kopie: {when}', { when: formatDateTime(copy.ok_at) }) : t('Noch keine Kopie'),
              copy.copies !== null ? `${tn('{n} Kopie', '{n} Kopien', copy.copies, { n: formatNumber(copy.copies) })}, ${formatMegabytes(copy.bytes || 0)}` : null,
              copy.free_bytes !== null && copy.free_bytes !== undefined ? t('{size} frei', { size: formatMegabytes(copy.free_bytes) }) : null
            ].filter(Boolean).join(' · ')}
          </p>
        )}
      </form>
      {copy.dir && copy.error && (
        <div role="alert" className="bg-amber-500/10 border border-amber-500/30 text-amber-200 p-3 rounded-xl text-xs space-y-1">
          <p className="font-semibold">{copy.error_at ? t('Kopie fehlgeschlagen ({when})', { when: formatDateTime(copy.error_at) }) : t('Kopie fehlgeschlagen')}</p>
          <p>{payloadText(copy, 'error')}</p>
          <p className="text-amber-200/80">{t('Die Backups auf dem Server bleiben davon unberührt.')}</p>
        </div>
      )}
    </div>
  );
}
