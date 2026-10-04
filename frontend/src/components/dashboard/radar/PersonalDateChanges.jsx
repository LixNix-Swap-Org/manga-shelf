import { CalendarClock, Check } from 'lucide-react';
import { getVolumeDisplayTitle } from '../../../utils/volumeHelpers';
import { formatReleaseDate } from '../../../utils/radarHelpers';
import { t } from '../../../i18n/index.js';

/** Notice of preorders whose date in the Manga Passion calendar has changed since; with one-click adoption. */
export default function PersonalDateChanges({ changes, canEdit, onApply, applyingIds }) {
  if (!changes || changes.length === 0) return null;
  return (
    <div id="radar-date-changes" className="bg-amber-500/10 border border-amber-500/30 text-amber-200 p-4 rounded-2xl text-xs space-y-2.5">
      <h3 className="font-bold text-sm text-amber-300 flex items-center gap-2">
        <CalendarClock className="w-4 h-4" /> {t('Neue Termine bei Manga Passion ({count})', { count: changes.length })}
      </h3>
      <ul className="space-y-2">
        {changes.map(c => (
          <li key={c.volume_id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <span>
              <strong>{c.manga_title} – {getVolumeDisplayTitle(c)}</strong>: {formatReleaseDate(c.stored_date)} <span aria-hidden="true">→</span><span className="sr-only">{t('neu:')}</span> <strong>{formatReleaseDate(c.new_date)}</strong>
            </span>
            {canEdit && (
              <button
                type="button"
                onClick={() => onApply(c)}
                disabled={Boolean(applyingIds?.has(c.volume_id))}
                aria-label={t('Termin übernehmen: {title} – {volume}', { title: c.manga_title, volume: getVolumeDisplayTitle(c) })}
                className="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5 self-start sm:self-auto disabled:opacity-50"
              >
                <Check className="w-3.5 h-3.5" /> {t('Termin übernehmen')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
