import { Link } from 'react-router-dom';
import { Award, BookOpen } from 'lucide-react';
import CoverImage from '../../common/CoverImage';
import { fmtEuro, countLabel } from '../statsFormat';

const COVER_FALLBACK = (
  <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-b from-slate-900 to-slate-950 p-2">
    <BookOpen className="w-6 h-6 opacity-40 mb-1 text-slate-500" aria-hidden="true" />
    <span className="text-[10px] text-slate-400 line-clamp-1">Kein Cover</span>
  </div>
);

/**
 * Most valuable series (owned value) with what completing them still costs. From sm a cover grid (2 x 5 on md),
 * below sm a compact ranking (place, title, value) in the same elements.
 */
export default function TopSeriesCard({ topSeries, onNavigate }) {
  if (!Array.isArray(topSeries) || topSeries.length === 0) return null;
  return (
    <div id="stats-top-series" className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
      <h3 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-4 flex items-center gap-2">
        <Award className="w-4 h-4 text-amber-400" aria-hidden="true" /> Wertvollste Reihen
      </h3>
      <ol className="grid grid-cols-1 sm:grid-cols-3 md:grid-cols-5 gap-1.5 sm:gap-3">
        {topSeries.map((ts, idx) => {
          const value = ts.owned_value ?? ts.total_value;
          return (
            <li key={ts.id}>
              <Link
                to={`/manga/${ts.id}`}
                onClick={onNavigate}
                className="group h-full px-3 py-2 sm:p-2.5 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-brand-500/50 hover:bg-slate-850 transition-all flex items-center gap-3 sm:flex-col sm:gap-0 sm:text-center"
              >
                <span aria-hidden="true" className="sm:hidden w-6 shrink-0 text-amber-400 font-mono text-xs font-bold">#{idx + 1}</span>
                <div className="hidden sm:block relative w-full aspect-[2/3] rounded-lg overflow-hidden mb-2 bg-slate-950 border border-slate-800">
                  <CoverImage
                    src={ts.cover_image}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                    fallback={COVER_FALLBACK}
                  />
                  <span aria-hidden="true" className="absolute top-1 left-1 bg-black/90 text-amber-400 font-mono text-[10px] px-1.5 py-0.5 rounded font-bold border border-amber-500/30 z-10 shadow">
                    #{idx + 1}
                  </span>
                </div>
                <span className="flex-1 min-w-0 font-semibold text-xs text-white truncate sm:w-full group-hover:text-brand-300">
                  <span className="sr-only">Platz {idx + 1}: </span>{ts.title}
                </span>
                <span className="shrink-0 flex flex-col items-end sm:items-center">
                  <span className="text-[11px] font-mono text-emerald-400 sm:mt-0.5">{fmtEuro(value)}</span>
                  <span className="hidden sm:block text-[10px] text-slate-400">{countLabel(ts.owned_volumes, 'Band', 'Bände')}</span>
                  {ts.missing_value > 0 && (
                    <span className="text-[10px] text-amber-300">noch {fmtEuro(ts.missing_value)} bis komplett</span>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
