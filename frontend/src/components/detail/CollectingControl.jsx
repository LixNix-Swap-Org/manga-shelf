import { useEffect, useId, useState } from 'react';
import { request } from '../../utils/api';
import { notify } from '../../utils/notify';
import { COLLECTING_OPTIONS, collectingOf } from '../../utils/seriesMeta';

const PILL = {
  aktiv: 'bg-slate-800/90 text-slate-200 border-slate-700/80',
  pausiert: 'bg-amber-500/15 text-amber-200 border-amber-500/40',
  abgebrochen: 'bg-slate-900 text-slate-400 border-slate-700 line-through decoration-slate-500'
};
const HINT = {
  pausiert: 'Fehlende Bände stehen nicht auf der Einkaufsliste.',
  abgebrochen: 'Nicht auf Einkaufsliste, Radar-Budget und Lückenhinweisen; im Kalender ausgegraut.'
};

/**
 * Collecting status of a series ("Sammelstatus", mangas.collecting), separate from the publication status. Editors
 * change it with a select that saves at once (PUT /api/mangas/:id { collecting }); everyone else sees a pill when the
 * series is paused or dropped. onSaved(value) lets the page update its copy of the series.
 */
export default function CollectingControl({ manga, canEdit = false, isOffline = false, onSaved }) {
  const id = useId();
  const stored = collectingOf(manga);
  const [value, setValue] = useState(stored);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setValue(stored); }, [manga?.id, stored]);

  const label = COLLECTING_OPTIONS.find(o => o.value === value)?.label || '';

  if (!canEdit || isOffline || !manga?.id) {
    if (value === 'aktiv') return null;
    return (
      <span id="detail-collecting-pill" className={`px-3 py-1 rounded-xl border font-semibold ${PILL[value]}`} title={HINT[value]}>
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
      await request('PUT', `/api/mangas/${manga.id}`, { collecting: next }, { fallback: 'Sammelstatus konnte nicht gespeichert werden' });
      onSaved?.(next);
      notify.success(next === 'aktiv' ? 'Reihe wird wieder gesammelt' : `Sammelstatus: ${COLLECTING_OPTIONS.find(o => o.value === next)?.label}`);
    } catch (e) {
      setValue(previous);
      notify.error(e, { fallback: 'Sammelstatus konnte nicht gespeichert werden' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <label htmlFor={`${id}-collecting`} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-xl border font-medium ${PILL[value]}`} title={HINT[value] || 'Wird die Reihe noch gesammelt?'}>
      <span className="sr-only">Sammelstatus</span>
      <select
        id={`${id}-collecting`}
        data-testid="collecting-select"
        className="filter-chip-select bg-transparent font-semibold"
        value={value}
        disabled={saving}
        onChange={(e) => change(e.target.value)}
      >
        {COLLECTING_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}
