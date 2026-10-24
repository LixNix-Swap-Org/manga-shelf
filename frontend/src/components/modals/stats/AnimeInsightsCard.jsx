import { BarChart3 } from 'lucide-react';
import { barPercent } from '../../../utils/animeHub';
import { formatMonth, formatNumber } from '../../../utils/format';
import { t } from '../../../i18n/index.js';
import { watchTime } from './AnimeStatsCard';

function Bars({ title, rows, unit }) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => r.count));
  return (
    <div>
      <h4 className="text-[11px] uppercase font-bold text-slate-400 tracking-wider mb-2">{title}</h4>
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li key={row.name} className="text-xs">
            <div className="flex justify-between gap-2 text-slate-300">
              <span className="truncate">{row.name}</span>
              <span className="font-mono text-slate-400 shrink-0">{unit(row)}</span>
            </div>
            <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden" aria-hidden="true">
              <div className="h-full rounded-full bg-fuchsia-500/80" style={{ width: `${barPercent(row.count, max)}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const countUnit = (row) => (row.average ? `${row.count} · Ø ${formatNumber(row.average, 1, { fixed: true })}` : String(row.count));

/** Anime insights of the statistics: year recap, finished entries per month, score spread, genres and studios of my own list. */
export default function AnimeInsightsCard({ insights }) {
  if (!insights) return null;
  const { recap, by_month: months, scores, genres, studios } = insights;
  const maxMonth = Math.max(0, ...months.map((m) => m.completed));
  const maxScore = Math.max(0, ...scores);
  const rated = scores.reduce((a, b) => a + b, 0);
  return (
    <div id="stats-anime-insights" className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800 space-y-5">
      <h3 className="text-xs uppercase font-bold text-slate-400 tracking-wider flex items-center gap-2">
        <BarChart3 className="w-4 h-4 text-fuchsia-400" aria-hidden="true" /> {t('Mein Anime-Jahr {year}', { year: recap.year })}
      </h3>
      <dl className="grid grid-cols-2 gap-2 text-center">
        {[[t('Abgeschlossen'), formatNumber(recap.completed)], [t('Folgen'), formatNumber(recap.episodes)], [t('Schauzeit'), watchTime(recap.minutes)],
          [t('Ø Bewertung'), recap.average ? formatNumber(recap.average, 1, { fixed: true }) : '–']].map(([label, value]) => (
          <div key={label} className="rounded-xl bg-slate-900/80 border border-slate-800 py-2 px-1">
            <dt className="text-[10px] text-slate-400 uppercase tracking-wider">{label}</dt>
            <dd className="text-base font-bold text-white font-mono">{value}</dd>
          </div>
        ))}
      </dl>
      {maxMonth > 0 && (
        <div>
          <h4 className="text-[11px] uppercase font-bold text-slate-400 tracking-wider mb-2">{t('Abgeschlossen pro Monat')}</h4>
          <ol className="flex items-end gap-1 h-24" aria-label={t('Abgeschlossen pro Monat')}>
            {months.map((m) => (
              <li key={m.month} className="flex-1 min-w-0 flex flex-col items-center justify-end h-full gap-1" title={`${formatMonth(`${m.month}-01`, { style: 'long' })}: ${t('{n} abgeschlossen', { n: m.completed })}${m.average ? ` · Ø ${m.average}` : ''}`}>
                <span className="text-[10px] font-mono text-slate-400">{m.completed || ''}</span>
                <span className="w-full rounded-t bg-fuchsia-500/70" style={{ height: `${Math.max(m.completed ? 6 : 0, barPercent(m.completed, maxMonth) * 0.6)}%` }} />
                <span className="text-[9px] text-slate-400">{formatMonth(`${m.month}-01`, { style: 'short', year: false })}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {rated > 0 && (
        <div>
          <h4 className="text-[11px] uppercase font-bold text-slate-400 tracking-wider mb-2">{t('Meine Bewertungen')}</h4>
          <ol className="flex items-end gap-1 h-16" aria-label={t('Meine Bewertungen')}>
            {scores.map((count, i) => (
              <li key={i} className="flex-1 flex flex-col items-center justify-end h-full gap-1" title={`${i + 1}: ${count}`}>
                <span className="w-full rounded-t bg-sky-500/70" style={{ height: `${Math.max(count ? 6 : 0, barPercent(count, maxScore) * 0.7)}%` }} />
                <span className="text-[10px] font-mono text-slate-400">{i + 1}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="grid gap-5 sm:grid-cols-2">
        <Bars title={t('Genres')} rows={genres} unit={countUnit} />
        <Bars title={t('Studios')} rows={studios} unit={countUnit} />
      </div>
    </div>
  );
}
