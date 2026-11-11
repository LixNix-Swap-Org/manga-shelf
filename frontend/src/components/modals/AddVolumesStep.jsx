import { useRef, useState } from 'react';
import { MAX_PICKED_VOLUMES, pickRange, volumeRuns } from '../../utils/volumePicker';
import { t, tn } from '../../i18n/index.js';

const LABEL = 'block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5';

/**
 * Step "Bände" of "Neuer Manga": which volumes the person already has. A tap marks a volume as owned, Shift-click marks
 * the range since the last tap; the other volumes up to the count become "Fehlt" when the switch is on. Without a pick
 * no volumes are created, as before.
 */
export default function AddVolumesStep({ ids, count, typedCount, onTypedCount, owned, onOwned, missingRest, onMissingRest, skip = null, disabled = false }) {
  const [upTo, setUpTo] = useState('');
  const lastRef = useRef(null);
  const numbers = Array.from({ length: count }, (_, i) => i + 1);
  const pickedCount = numbers.filter((n) => owned.has(n)).length;
  const runs = volumeRuns({ count, owned, missingRest, skip });
  const missingCount = runs.filter((r) => r.status === 'Fehlt').reduce((sum, r) => sum + r.to - r.from + 1, 0);

  const toggle = (e, n) => {
    if (e.shiftKey && lastRef.current !== null) {
      onOwned(pickRange(owned, lastRef.current, n));
    } else {
      const next = new Set(owned);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      onOwned(next);
    }
    lastRef.current = n;
  };
  const takeUpTo = () => {
    const n = Math.min(Math.floor(Number(upTo)) || 0, count);
    if (n >= 1) onOwned(pickRange(owned, 1, n));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={`${ids}-volume-count`} className={LABEL}>{t('Erschienene Bände')}</label>
          <input
            id={`${ids}-volume-count`}
            type="number"
            inputMode="numeric"
            min="0"
            max={MAX_PICKED_VOLUMES}
            step="1"
            className="input-field" style={{ width: '7rem' }}
            disabled={disabled}
            placeholder={count ? String(count) : t('z.B. 12')}
            value={typedCount}
            onChange={(e) => onTypedCount(e.target.value)}
          />
        </div>
        {count > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" id="btn-add-volumes-all" className="btn-secondary text-xs py-2 px-3" disabled={disabled} onClick={() => onOwned(new Set(numbers))}>{t('Alle')}</button>
            <button type="button" id="btn-add-volumes-none" className="btn-secondary text-xs py-2 px-3" disabled={disabled} onClick={() => onOwned(new Set())}>{t('Keine')}</button>
            <span className="flex items-center gap-1.5 text-xs text-slate-300">
              <label htmlFor={`${ids}-volume-upto`} className="whitespace-nowrap">{t('Band 1 bis')}</label>
              <input id={`${ids}-volume-upto`} type="number" inputMode="numeric" min="1" max={count} className="input-field py-1.5" style={{ width: '5rem' }} disabled={disabled} value={upTo} onChange={(e) => setUpTo(e.target.value)} />
              <button type="button" id="btn-add-volumes-upto" className="btn-secondary text-xs py-2 px-3" disabled={disabled || !upTo} onClick={takeUpTo}>{t('übernehmen')}</button>
            </span>
          </div>
        )}
      </div>

      {count > 0 ? (
        <>
          <p className="text-[11px] text-slate-400">{t('Tippe die Bände an, die du hast. Mit gedrückter Umschalttaste markiert ein Klick alle Bände seit dem letzten.')}</p>
          <div role="group" aria-label={t('Vorhandene Bände')} className="grid grid-cols-6 sm:grid-cols-10 gap-1.5 max-h-56 overflow-y-auto custom-scrollbar pr-1">
            {numbers.map((n) => {
              const on = owned.has(n);
              return (
                <button
                  key={n}
                  type="button"
                  aria-pressed={on}
                  aria-label={t('Band {n}', { n })}
                  disabled={disabled}
                  onClick={(e) => toggle(e, n)}
                  className={`h-10 rounded-lg text-xs font-bold border font-mono ${on ? 'bg-emerald-500/25 text-emerald-200 border-emerald-500/60' : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-white hover:border-slate-600'}`}
                >
                  {n}
                </button>
              );
            })}
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
            <input id={`${ids}-missing-rest`} type="checkbox" className="w-4 h-4" disabled={disabled} checked={missingRest} onChange={(e) => onMissingRest(e.target.checked)} />
            {t('Übrige Bände als „Fehlt“ anlegen')}
          </label>
          <p id={`${ids}-volume-summary`} role="status" className="text-xs text-slate-300">
            {pickedCount === 0
              ? t('Ohne Auswahl werden keine Bände angelegt.')
              : `${tn('{n} Band vorhanden', '{n} Bände vorhanden', pickedCount)}${missingCount > 0 ? ` · ${tn('{n} Band als „Fehlt“', '{n} Bände als „Fehlt“', missingCount)}` : ''}`}
          </p>
        </>
      ) : (
        <p className="text-xs text-slate-400">{t('Trage ein, wie viele Bände erschienen sind, um die vorhandenen anzutippen. Ohne Angabe wird die Reihe ohne Bände angelegt.')}</p>
      )}
    </div>
  );
}
