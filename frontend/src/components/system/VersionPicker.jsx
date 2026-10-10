import { useId } from 'react';
import { ExternalLink } from 'lucide-react';
import { t } from '../../i18n/index.js';
import { compareVersions, isSelectable, README_UPDATING_URL, releaseLabel, releaseUrl, sortReleases } from './updateModel.js';

const linkClass = 'inline-flex items-center gap-1 text-brand-300 underline';

/** Every published release (newest first), the ones that cannot be chosen disabled with the reason in the text. */
export default function VersionPicker({ releases, current, canInstall = true, selected, onSelect, disabled = false, action = null }) {
  const id = useId();
  const sorted = sortReleases(releases);
  const chosen = sorted.find((r) => r.version === selected) || null;
  const skipped = chosen ? sorted.filter((r) => compareVersions(r.version, current) > 0 && compareVersions(r.version, chosen.version) < 0) : [];
  return (
    <div className="space-y-2 text-xs">
      <label htmlFor={id} className="block font-semibold text-slate-300">{t('Andere Version wählen')}</label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id={id}
          className="input-field !w-auto max-w-full text-base sm:text-sm py-1.5"
          value={chosen ? chosen.version : ''}
          disabled={disabled}
          onChange={(e) => onSelect(e.target.value)}
        >
          {!chosen && <option value="" disabled>{t('Keine installierbare Version')}</option>}
          {sorted.map((r) => {
            const selectable = isSelectable(r, { current, canInstall });
            return <option key={r.version} value={r.version} disabled={!selectable}>{releaseLabel(r, selectable)}</option>;
          })}
        </select>
        {action}
      </div>
      {releaseUrl(chosen) && (
        <a href={releaseUrl(chosen)} target="_blank" rel="noreferrer noopener" className={linkClass}>
          {t('Versionshinweise')} (v{chosen.version}) <ExternalLink className="w-3 h-3" aria-hidden="true" />
        </a>
      )}
      {skipped.length > 0 && (
        <p className="text-slate-300 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>{t('Dazwischen liegen:')}</span>
          {skipped.map((r) => (releaseUrl(r)
            ? <a key={r.version} href={releaseUrl(r)} target="_blank" rel="noreferrer noopener" className={linkClass}>v{r.version}</a>
            : <span key={r.version}>v{r.version}</span>))}
        </p>
      )}
      <p className="text-[11px] text-slate-400">
        {t('Ältere Versionen lassen sich nicht per Klick installieren: Die Datenbank wird nur vorwärts migriert.')}{' '}
        <a href={README_UPDATING_URL} target="_blank" rel="noreferrer noopener" className={linkClass}>{t('Weg zurück (README)')}</a>
      </p>
    </div>
  );
}
