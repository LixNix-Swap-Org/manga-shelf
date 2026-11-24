import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, CalendarRange } from 'lucide-react';
import CoverImage from '../../common/CoverImage';
import api from '../../../utils/api';
import useLatestRequest from '../../../hooks/useLatestRequest';
import { shelfQuery } from '../../../utils/shelfScope';
import { formatEuro, formatMonth, formatNumber } from '../../../utils/format';
import { countLabel } from '../statsFormat';
import { t, tn } from '../../../i18n/index.js';

/** "+12 zu 2025", "−3 zu 2025", "wie 2025" (null without reads in either year). */
export function yearDelta(current, previous, year) {
  if (!current && !previous) return null;
  const diff = current - previous;
  if (diff === 0) return t('wie {year}', { year: year - 1 });
  return t('{diff} zu {year}', { diff: `${diff > 0 ? '+' : '−'}${formatNumber(Math.abs(diff))}`, year: year - 1 });
}

/**
 * "Mein Manga-Jahr" on top of the reading tab (GET /api/stats/year): read volumes and pages against the year before,
 * series started, own copies bought with their list price, the most read series and the strongest month. The year can
 * be picked among the years with a dated read or purchase; the reader is the one chosen for the reading tab.
 */
export default function YearReviewCard({ userId, shelfId = null, onNavigate }) {
  // the picked year belongs to one reader and shelf: another one starts at the current year again (an old pick could
  // lie outside the new reader's years and leave the card on zeros)
  const scope = `${userId ?? ''}|${shelfId ?? ''}`;
  const [choice, setChoice] = useState({ scope, year: null });
  const year = choice.scope === scope ? choice.year : null;
  const setYear = (value) => setChoice({ scope, year: value });
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const begin = useLatestRequest();
  const selectId = useId();

  useEffect(() => {
    const { signal, isCurrent } = begin();
    setError(null);
    const params = [userId ? `user_id=${encodeURIComponent(userId)}` : null, year ? `year=${year}` : null].filter(Boolean).join('&');
    const query = params ? `?${params}${shelfQuery(shelfId, '&')}` : shelfQuery(shelfId);
    api.get(`/api/stats/year${query}`, { signal })
      .then((body) => { if (isCurrent()) setData(body); })
      .catch((e) => {
        if (!isCurrent() || e?.name === 'AbortError') return;
        // an older server without the route (or a reader no longer visible): no card instead of an error in the tab
        if (e?.status === 404 || e?.status === 405) { setData(null); return; }
        setError(e?.message || t('Jahresrückblick konnte nicht geladen werden.'));
      });
  }, [userId, year, shelfId, begin]);

  if (error) return <p role="alert" className="text-xs text-rose-300">{error}</p>;
  if (!data?.read || !data?.bought) return null;

  const { read, bought } = data;
  const delta = yearDelta(read.volumes, read.previous_year, data.year);
  const tiles = [
    { label: t('Gelesen'), value: countLabel(read.volumes, 'Band', 'Bände'), hint: delta },
    { label: t('Seiten'), value: formatNumber(read.pages) },
    {
      label: t('Gekauft'),
      value: countLabel(bought.volumes, 'Band', 'Bände'),
      hint: bought.volumes > 0 ? formatEuro(bought.total) : null,
      money: true
    },
    { label: t('Neu angefangen'), value: tn('{n} Reihe', '{n} Reihen', read.started) }
  ];

  return (
    <section id="stats-year-review" aria-labelledby={`${selectId}-title`} className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${selectId}-title`} className="text-xs uppercase font-bold text-slate-400 tracking-wider flex items-center gap-2">
          <CalendarRange className="w-4 h-4 text-emerald-400" aria-hidden="true" /> {t('Mein Manga-Jahr {year}', { year: data.year })}
        </h3>
        {(data.years || []).length > 1 && (
          <label htmlFor={selectId} className="ml-auto flex items-center gap-2 text-xs text-slate-300">
            <span className="sr-only">{t('Jahr')}</span>
            <select id={selectId} className="input-field bg-slate-950 py-1.5 w-auto text-base sm:text-xs" value={data.year} onChange={(e) => setYear(Number(e.target.value))}>
              {data.years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
        )}
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-xl bg-slate-900/80 border border-slate-800 p-3">
            <dt className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">{tile.label}{/* i18n-ignore: translated in tiles */}</dt>
            <dd className="text-lg font-extrabold text-white">{tile.value}</dd>
            {tile.hint && <dd className={`text-[11px] ${tile.money ? 'font-mono text-emerald-400' : 'text-slate-400'}`}>{tile.hint}{/* i18n-ignore: translated in tiles */}</dd>}
          </div>
        ))}
      </dl>
      {bought.other_currency > 0 && (
        <p className="text-[11px] text-slate-400">{tn('Ohne {n} Band in anderer Währung.', 'Ohne {n} Bände in anderer Währung.', bought.other_currency)}</p>
      )}

      {(data.top_series || data.best_month) && (
        <div className="grid gap-2.5 sm:grid-cols-2">
          {data.top_series && (
            <Link to={`/manga/${data.top_series.manga_id}`} onClick={onNavigate} className="flex items-center gap-3 p-2.5 rounded-xl border border-slate-800 hover:border-emerald-500/50 bg-slate-900/60 min-w-0">
              <CoverImage
                src={data.top_series.cover_image}
                className="w-9 h-12 rounded object-cover shrink-0"
                fallback={<div className="w-9 h-12 rounded bg-slate-800 flex items-center justify-center text-slate-400 shrink-0"><BookOpen className="w-4 h-4" aria-hidden="true" /></div>}
              />
              <span className="min-w-0">
                <span className="block text-[10px] uppercase font-bold text-slate-400 tracking-wider">{t('Am meisten gelesen')}</span>
                <span className="block text-sm font-semibold text-white truncate">{data.top_series.title}</span>
                <span className="block text-[11px] text-emerald-300">{countLabel(data.top_series.volumes, 'Band', 'Bände')}</span>
              </span>
            </Link>
          )}
          {data.best_month && (
            <div className="p-2.5 rounded-xl border border-slate-800 bg-slate-900/60">
              <span className="block text-[10px] uppercase font-bold text-slate-400 tracking-wider">{t('Stärkster Monat')}</span>
              <span className="block text-sm font-semibold text-white">{formatMonth(`${data.best_month.month}-01`, { style: 'long', year: false })}</span>
              <span className="block text-[11px] text-emerald-300">{countLabel(data.best_month.volumes, 'Band', 'Bände')}</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
