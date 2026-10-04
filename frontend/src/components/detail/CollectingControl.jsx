import { useEffect, useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { request } from '../../utils/api';
import { notify } from '../../utils/notify';
import { COLLECTING_OPTIONS, collectingOf } from '../../utils/seriesMeta';
import { t } from '../../i18n/index.js';
import { collectingLabel } from '../../utils/enumLabels.js';

const PILL = {
  aktiv: 'bg-slate-800/90 text-slate-200 border-slate-700/80',
  pausiert: 'bg-amber-500/15 text-amber-200 border-amber-500/40',
  abgebrochen: 'bg-slate-900 text-slate-400 border-slate-700 line-through decoration-slate-500'
};
// i18n
const HINT = {
  pausiert: 'Fehlende Bände stehen nicht auf der Einkaufsliste.',
  abgebrochen: 'Nicht auf Einkaufsliste, Radar-Budget und Lückenhinweisen; im Kalender ausgegraut.'
};

/**
 * Collecting status of a series (mangas.collecting, separate from the publication status): editors get a select that
 * saves at once, everyone else a pill when paused or dropped. onSaved(value) updates the page's copy.
 */
export default function CollectingControl({ manga, canEdit = false, isOffline = false, onSaved }) {
  const id = useId();
  const stored = collectingOf(manga);
  const [value, setValue] = useState(stored);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setValue(stored); }, [manga?.id, stored]);

  const label = COLLECTING_OPTIONS.some(o => o.value === value) ? collectingLabel(value) : '';

  if (!canEdit || isOffline || !manga?.id) {
    if (value === 'aktiv') return null;
    return (
      <span id="detail-collecting-pill" className={`px-3 py-1 rounded-xl border font-semibold ${PILL[value]}`} title={HINT[value] && t(HINT[value])}>
        {label}
      </span>
    );
  }

  const change = async (next) => {
    if (next === value || saving) return;
    const previous = value;
    setValue(next);
    setSaving(true);
    try {
      await request('PUT', `/api/mangas/${manga.id}`, { collecting: next }, { fallback: t('Sammelstatus konnte nicht gespeichert werden') });
      onSaved?.(next);
      notify.success(next === 'aktiv' ? t('Reihe wird wieder gesammelt') : t('Sammelstatus: {label}', { label: collectingLabel(next) }));
    } catch (e) {
      setValue(previous);
      notify.error(e, { fallback: t('Sammelstatus konnte nicht gespeichert werden') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`relative inline-flex items-center gap-1 px-2.5 py-1 rounded-xl border font-medium cursor-pointer ${PILL[value]}`} title={HINT[value] ? t(HINT[value]) : t('Wird die Reihe noch gesammelt?')}>
      <label htmlFor={`${id}-collecting`} className="sr-only">{t('Sammelstatus')}</label>
      {/* the select lies transparent over the chip: the chip is as wide as the chosen label, not the longest option */}
      <span aria-hidden="true" data-testid="collecting-label" className="font-semibold whitespace-nowrap">{label}</span>
      <ChevronDown className="w-3 h-3 opacity-70 shrink-0 pointer-events-none" aria-hidden="true" />
      <select
        id={`${id}-collecting`}
        data-testid="collecting-select"
        className="filter-chip-select absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-wait"
        value={value}
        disabled={saving}
        onChange={(e) => change(e.target.value)}
      >
        {COLLECTING_OPTIONS.map(o => <option key={o.value} value={o.value}>{collectingLabel(o.value)}</option>)}
      </select>
    </div>
  );
}
