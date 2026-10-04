import { useMemo, useState } from 'react';
import { BuildingComplex } from 'lucide-react';
import {
  fmtNumber, fmtEuro, fmtPct, countLabel, cssPct, publisherColor, publisherSegments, OTHER_PUBLISHERS_COLOR, PUBLISHER_COLORS
} from '../statsFormat';

export const PUBLISHER_SORTS = [
  { id: 'volumes', label: 'Bände' },
  { id: 'value', label: 'Wert' },
  { id: 'avg', label: 'Ø' }
];

const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);
const SORT_KEYS = {
  volumes: (p) => num(p.volume_count),
  value: (p) => num(p.total_value),
  avg: (p) => (p.avg_price === null || p.avg_price === undefined ? -1 : num(p.avg_price))
};

/** Publishers sorted by volumes, value or average price (largest first, ties keep the server order); never sorts in place. */
export function sortPublishers(list, sortBy = 'volumes') {
  const key = SORT_KEYS[sortBy] || SORT_KEYS.volumes;
  return [...(Array.isArray(list) ? list : [])].sort((a, b) => key(b) - key(a));
}

/** Segments of the stacked bar by value share: the first eight publishers and one grey 'Sonstige' segment. */
export function valueSegments(list, topN = PUBLISHER_COLORS.length) {
  const pubs = Array.isArray(list) ? list : [];
  const total = pubs.reduce((sum, p) => sum + num(p.total_value), 0);
  const share = (value) => (total > 0 ? (value / total) * 100 : 0);
  const segments = pubs.slice(0, topN).map((p, idx) => ({
    key: p.publisher, label: p.publisher, value: num(p.total_value), width: share(num(p.total_value)), color: publisherColor(idx)
  }));
  const rest = pubs.slice(topN);
  if (rest.length > 0) {
    const value = rest.reduce((sum, p) => sum + num(p.total_value), 0);
    segments.push({ key: '__other__', label: `Sonstige (${countLabel(rest.length, 'Verlag', 'Verlage')})`, value, width: share(value), color: OTHER_PUBLISHERS_COLOR });
  }
  return segments;
}

function Figure({ value, label, className = 'text-white' }) {
  return (
    <div className="min-w-[64px]">
      <span className={`font-mono font-bold text-sm ${className}`}>{value}</span>
      <span className="text-[11px] text-slate-400 block">{label}</span>
    </div>
  );
}

/** Publisher tab: stacked share bar (volumes or value) and one row per publisher with volumes, series, value, Ø price, missing. */
export default function PublisherTab({ publishers }) {
  const [sortBy, setSortBy] = useState('volumes');
  const list = useMemo(() => sortPublishers(publishers, sortBy), [publishers, sortBy]);
  const byValue = sortBy === 'value';
  const segments = byValue ? valueSegments(list) : publisherSegments(list);

  return (
    <div className="space-y-6 animate-fade-in">
      <div id="stats-publishers" className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-4">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <BuildingComplex className="w-4 h-4 text-sky-400" aria-hidden="true" />
              Verlagsverteilung & Sammlungsanteile
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              {byValue ? 'Anteil jedes Verlags am Wert aller vorhandenen Bände' : 'Prozentualer Anteil jedes Verlags an allen vorhandenen Bänden'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div role="group" aria-label="Verlage sortieren nach" className="flex items-center bg-slate-900 border border-slate-800 rounded-xl p-0.5 text-xs">
              {PUBLISHER_SORTS.map(s => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={sortBy === s.id}
                  onClick={() => setSortBy(s.id)}
                  title={s.id === 'avg' ? 'Durchschnittspreis' : undefined}
                  className={`px-2.5 py-1 rounded-lg font-semibold transition-colors ${sortBy === s.id ? 'bg-sky-700 text-white' : 'text-slate-400 hover:text-white'}`}
                >
                  {s.id === 'avg' ? <><span aria-hidden="true">Ø</span><span className="sr-only">Durchschnittspreis</span></> : s.label}
                </button>
              ))}
            </div>
            <span className="text-xs font-mono font-semibold text-slate-300 bg-slate-900 px-3 py-1 rounded-xl border border-slate-800">
              {countLabel(list.length, 'Verlag', 'Verlage')}
            </span>
          </div>
        </div>

        {/* the list below carries every value, so the bar is hidden from screen readers */}
        <div className="mb-6 space-y-2">
          <div aria-hidden="true" className="w-full h-5 rounded-xl overflow-hidden flex bg-slate-900 border border-slate-800">
            {segments.map(seg => (
              <div
                key={seg.key}
                className={`${seg.color} hover:opacity-90 transition-opacity`}
                style={{ width: `${cssPct(seg.width)}%` }}
                title={byValue ? `${seg.label}: ${fmtPct(seg.width)} (${fmtEuro(seg.value)})` : `${seg.label}: ${fmtPct(seg.width)} (${countLabel(seg.volumes, 'Band', 'Bände')})`}
              />
            ))}
          </div>
          <p className="text-[11px] text-slate-400 text-center">
            Farben wie in der Liste unten{list.length > 8 ? '; ab Platz 9 grau als „Sonstige“' : ''}.
          </p>
        </div>

        <div className="space-y-2.5">
          {list.map((pub, idx) => {
            const dotColor = publisherColor(idx);
            const pct = byValue ? pub.value_percentage : pub.percentage;
            return (
              <div
                key={pub.publisher}
                className="p-3 rounded-xl bg-slate-900/60 border border-slate-800/80 hover:border-slate-700 transition-colors flex flex-col lg:flex-row items-start lg:items-center justify-between gap-3 text-xs"
              >
                <div className="flex items-center gap-2.5 min-w-[180px]">
                  <span aria-hidden="true" className={`w-3 h-3 rounded-full ${dotColor} shrink-0`}></span>
                  <span className="font-bold text-white text-sm">{pub.publisher}</span>
                </div>

                <div className="flex-1 w-full lg:w-auto lg:max-w-[180px]">
                  <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                    <span>{byValue ? 'Wertanteil:' : 'Anteil:'}</span>
                    <strong className="text-white font-mono">{fmtPct(pct ?? 0)}</strong>
                  </div>
                  <div aria-hidden="true" className="w-full h-2 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                    <div className={`h-full ${dotColor} rounded-full`} style={{ width: `${cssPct(pct)}%` }} />
                  </div>
                </div>

                <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 text-right w-full lg:w-auto">
                  <Figure value={fmtNumber(pub.volume_count)} label={pub.volume_count === 1 ? 'Band' : 'Bände'} />
                  <Figure value={fmtNumber(pub.series_count)} label={pub.series_count === 1 ? 'Reihe' : 'Reihen'} />
                  <Figure value={fmtEuro(pub.total_value)} label="Wert" className="text-emerald-400" />
                  <Figure value={pub.avg_price === null || pub.avg_price === undefined ? '–' : fmtEuro(pub.avg_price)} label="Ø Preis" />
                  <Figure
                    value={pub.missing_count > 0 ? fmtEuro(pub.missing_value) : '–'}
                    label={pub.missing_count > 0 ? `fehlt (${fmtNumber(pub.missing_count)})` : 'fehlt'}
                    className="text-amber-300"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Overview card: the four largest publishers by owned volumes. */
export function TopPublishersCard({ publishers, onShowAll }) {
  const list = Array.isArray(publishers) ? publishers : [];
  return (
    <div className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-xs uppercase font-bold text-slate-400 tracking-wider flex items-center gap-2">
          <BuildingComplex className="w-4 h-4 text-sky-400" aria-hidden="true" /> Größte Verlage im Regal
        </h3>
        <button type="button" onClick={onShowAll} className="text-sky-400 hover:text-sky-300 font-medium text-xs">
          Alle anzeigen ↗
        </button>
      </div>
      <div className="space-y-3">
        {list.slice(0, 4).map(pub => (
          <div key={pub.publisher} className="space-y-1">
            <div className="flex justify-between items-center text-xs">
              <span className="font-medium text-slate-200 truncate">{pub.publisher}</span>
              <span className="font-mono text-slate-400 shrink-0">
                <strong className="text-white">{fmtNumber(pub.volume_count)}</strong> {pub.volume_count === 1 ? 'Band' : 'Bände'} ({fmtPct(pub.percentage)})
              </span>
            </div>
            <div aria-hidden="true" className="w-full h-2 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
              <div className="h-full bg-sky-500 rounded-full" style={{ width: `${cssPct(pub.percentage)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
