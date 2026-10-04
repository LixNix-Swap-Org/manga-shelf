import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Flame } from 'lucide-react';
import CoverImage from '../../common/CoverImage';
import api from '../../../utils/api';
import useLatestRequest from '../../../hooks/useLatestRequest';
import { countLabel, fmtNumber, monthLabel, monthShort } from '../statsFormat';
import { getVolumeDisplayTitle } from '../../../utils/volumeHelpers';
import { t, tn } from '../../../i18n/index.js';

const readSummary = (m, sep = ' · ') => `${monthLabel(m.month)}: ${countLabel(m.volumes, 'Band', 'Bände')}${sep}${countLabel(m.pages, 'Seite', 'Seiten')}`;

/** Months as bars; `value` picks the number, `color` the Tailwind class of a bar. */
function MonthBars({ months, value, label, color, activeColor, describe }) {
  const [selected, setSelected] = useState(null);
  const max = Math.max(1, ...months.map(value));
  const active = months.find(m => m.month === selected) || [...months].reverse().find(m => value(m) > 0) || months[months.length - 1];
  return (
    <>
      <div className="flex items-end gap-1 h-24" role="group" aria-label={label}>
        {months.map((m, i) => {
          const isActive = m.month === active?.month;
          return (
            <button
              key={m.month}
              type="button"
              aria-label={describe(m, ', ')}
              aria-pressed={isActive}
              title={describe(m)}
              onClick={() => setSelected(m.month)}
              onFocus={() => setSelected(m.month)}
              className="flex-1 flex flex-col items-center justify-end h-full min-w-0 rounded outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              <span aria-hidden="true" className={`block w-full rounded-t ${isActive ? activeColor : color}`} style={{ height: `${(value(m) / max) * 100}%`, minHeight: value(m) > 0 ? 3 : 0 }} />
              <span aria-hidden="true" className={`text-[8px] mt-1 ${i % 3 === 2 || isActive ? '' : 'invisible'} ${isActive ? 'text-emerald-300 font-semibold' : 'text-slate-400'}`}>
                {monthShort(m.month)}
              </span>
            </button>
          );
        })}
      </div>
      {active && <p className="text-[11px] text-slate-300 mt-2 font-mono" aria-live="polite">{describe(active)}</p>}
    </>
  );
}

/**
 * Reading over time (GET /api/stats/reading): reads per month, backlog (owned minus read), this vs last year, streaks
 * and the "Weiterlesen" list. `readers` are the users of /api/stats (user_reading_stats) for the reader select.
 */
export default function ReadingOverTime({ readers = [], user, onNavigate }) {
  const [userId, setUserId] = useState(user?.id ?? null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const begin = useLatestRequest();
  const selectId = useId();

  useEffect(() => {
    const { signal, isCurrent } = begin();
    setError(null);
    const query = userId ? `?user_id=${encodeURIComponent(userId)}` : '';
    api.get(`/api/stats/reading${query}`, { signal })
      .then((body) => { if (isCurrent()) setData(body); })
      .catch((e) => { if (isCurrent() && e?.name !== 'AbortError') setError(e?.message || t('Leseverlauf konnte nicht geladen werden.')); });
  }, [userId, begin]);

  if (error) return <p role="alert" className="text-sm text-rose-300 py-8 text-center">{error}</p>;
  if (!data) return <p role="status" className="text-sm text-slate-400 py-8 text-center">{t('Leseverlauf wird geladen…')}</p>;

  const months = data.by_month || [];
  const backlog = data.backlog_by_month || [];
  const totalRead = months.reduce((n, m) => n + m.volumes, 0);
  const lastBacklog = backlog[backlog.length - 1];
  const range = months.length ? `${monthLabel(months[0].month)} – ${monthLabel(months[months.length - 1].month)}` : '';

  return (
    <div id="stats-reading-over-time" className="space-y-5 animate-fade-in">
      {readers.length > 1 && (
        <label htmlFor={selectId} className="flex items-center gap-2 text-xs text-slate-300">
          {t('Leser')}
          <select id={selectId} className="input-field bg-slate-950 py-1.5 w-auto text-base sm:text-xs" value={userId ?? ''} onChange={(e) => setUserId(Number(e.target.value))}>
            {readers.map(r => <option key={r.user_id} value={r.user_id}>{r.username}</option>)}
          </select>
        </label>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="p-3 rounded-2xl bg-slate-950/70 border border-slate-800">
          <p className="text-[10px] uppercase font-bold text-slate-400">{data.this_year.year}</p>
          <p className="text-lg font-extrabold text-white">{countLabel(data.this_year.volumes, 'Band', 'Bände')}</p>
          <p className="text-[11px] text-slate-400">{t('Vorjahr: {count}', { count: countLabel(data.last_year.volumes, 'Band', 'Bände') })}</p>
        </div>
        <div className="p-3 rounded-2xl bg-slate-950/70 border border-slate-800">
          <p className="text-[10px] uppercase font-bold text-slate-400">{t('Seiten {year}', { year: data.this_year.year })}</p>
          <p className="text-lg font-extrabold text-white">{fmtNumber(data.this_year.pages)}</p>
          <p className="text-[11px] text-slate-400">{t('Vorjahr: {number}', { number: fmtNumber(data.last_year.pages) })}</p>
        </div>
        <div className="p-3 rounded-2xl bg-slate-950/70 border border-slate-800">
          <p className="text-[10px] uppercase font-bold text-slate-400 flex items-center gap-1"><Flame className="w-3 h-3 text-amber-400" aria-hidden="true" /> {t('Lesesträhne')}</p>
          <p className="text-lg font-extrabold text-white">{countLabel(data.streak.current, 'Monat', 'Monate')}</p>
          <p className="text-[11px] text-slate-400">{t('Rekord: {count}', { count: countLabel(data.streak.longest, 'Monat', 'Monate') })}</p>
        </div>
        <div className="p-3 rounded-2xl bg-slate-950/70 border border-slate-800">
          <p className="text-[10px] uppercase font-bold text-slate-400">{t('Stapel ungelesen')}</p>
          <p className="text-lg font-extrabold text-white">{countLabel(lastBacklog?.backlog || 0, 'Band', 'Bände')}</p>
          <p className="text-[11px] text-slate-400">{t('vorhanden minus gelesen')}</p>
        </div>
      </div>

      <div className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
        <h3 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-1">{t('Gelesene Bände je Monat')}</h3>
        <p className="text-[11px] text-slate-400 mb-3">{range ? t('Letzte 24 Monate ({range})', { range }) : t('Letzte 24 Monate')}</p>
        {totalRead === 0 ? (
          <p className="text-xs text-slate-400">{t('In diesem Zeitraum wurde nichts mit Datum als gelesen markiert.')}</p>
        ) : (
          <MonthBars months={months} value={m => m.volumes} label={t('Gelesene Bände je Monat, {range}', { range })} color="bg-emerald-500/70" activeColor="bg-emerald-400" describe={readSummary} />
        )}
        {data.unknown_date > 0 && (
          <p className="text-[11px] text-slate-400 mt-3">
            {tn(
              '{volumes} ohne Lesedatum zählt als gelesen, aber in keinem Monat.',
              '{volumes} ohne Lesedatum zählen als gelesen, aber in keinem Monat.',
              data.unknown_date,
              { volumes: countLabel(data.unknown_date, 'Band', 'Bände') }
            )}
          </p>
        )}
      </div>

      <div className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
        <h3 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-3">{t('Ungelesener Stapel am Monatsende')}</h3>
        <MonthBars
          months={backlog}
          value={m => m.backlog}
          label={t('Ungelesene vorhandene Bände am Monatsende, {range}', { range })}
          color="bg-amber-500/60"
          activeColor="bg-amber-400"
          describe={(m, sep = ' · ') => t('{month}: {backlog} ungelesen{sep}{owned} vorhanden', {
            month: monthLabel(m.month), backlog: countLabel(m.backlog, 'Band', 'Bände'), sep, owned: countLabel(m.owned, 'Band', 'Bände')
          })}
        />
      </div>

      <div className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
        <h3 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-3">{t('Weiterlesen')}</h3>
        {data.continue_reading.length === 0 ? (
          <p className="text-xs text-slate-400">{t('Keine angefangene Reihe mit einem ungelesenen nächsten Band im Regal.')}</p>
        ) : (
          <ul id="continue-reading" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {data.continue_reading.map(c => (
              <li key={c.manga_id}>
                <Link to={`/manga/${c.manga_id}`} onClick={onNavigate} className="flex items-center gap-3 p-2 rounded-xl border border-slate-800 hover:border-emerald-500/50 bg-slate-900/60">
                  <CoverImage
                    src={[c.next_volume?.cover_image, c.cover_image]}
                    className="w-9 h-12 rounded object-cover shrink-0"
                    fallback={<div className="w-9 h-12 rounded bg-slate-800 flex items-center justify-center text-slate-400 shrink-0"><BookOpen className="w-4 h-4" aria-hidden="true" /></div>}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-white truncate">{c.title}</span>
                    <span className="block text-[11px] text-emerald-300">{t('Weiter mit {volume}', { volume: getVolumeDisplayTitle({ volume_number: c.next_volume?.volume_number, type: 'volume' }) })}</span>
                    {c.unread_after > 1 && <span className="block text-[11px] text-slate-400">{t('{count} ungelesen im Regal', { count: countLabel(c.unread_after, 'Band', 'Bände') })}</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
