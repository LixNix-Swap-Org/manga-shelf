import { ChevronDown, Star, Search, X, BookOpen, BuildingComplex } from 'lucide-react';
import { publisherOptions } from '../../../utils/radarHelpers';

/** Search, publisher and print / my-series filters of the Manga-Passion calendar. `mpCurrent`: mpData is the selected month. */
export default function MpFilters({
  mpData,
  mpCurrent,
  mpPrintOnly,
  setMpPrintOnly,
  mpMySeriesOnly,
  setMpMySeriesOnly,
  mpPublisherFilter,
  setMpPublisherFilter,
  mpSearch,
  setMpSearch,
  filtersActive,
  onResetFilters
}) {
  const shown = mpCurrent ? mpData : null;
  const mySeriesCount = shown ? (mpPrintOnly ? shown.user_series_print_count : shown.user_series_count) ?? 0 : null;
  // the previous month's list stays visible (disabled) while the next month loads
  const options = publisherOptions(mpData?.publishers, 'name', mpPublisherFilter);

  return (
    <div className="glass-panel p-3.5 sm:p-4 rounded-2xl border border-slate-800/80 flex flex-col md:flex-row justify-between items-stretch md:items-center gap-3">
      <div className="flex items-center gap-2 bg-slate-950/70 border border-slate-800 rounded-xl px-3 py-2 w-full md:w-72 shadow-inner focus-within:ring-2 focus-within:ring-brand-400 focus-within:border-brand-400">
        <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <input
          type="text"
          placeholder="Reihe, Band oder Verlag..."
          aria-label="Neuerscheinungen durchsuchen"
          className="w-full bg-transparent border-0 p-0 text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-0 text-base sm:text-xs"
          value={mpSearch}
          onChange={e => setMpSearch(e.target.value)}
        />
        {mpSearch && (
          <button type="button" onClick={() => setMpSearch('')} className="p-1.5 -m-1 rounded text-slate-400 hover:text-white" aria-label="Suche leeren">
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={mpPrintOnly}
          onClick={() => setMpPrintOnly(!mpPrintOnly)}
          className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all flex items-center gap-1.5 shrink-0 ${
            mpPrintOnly
              ? 'bg-sky-500/20 text-sky-300 border-sky-500/40 shadow-sm font-semibold'
              : 'bg-slate-900/80 text-slate-400 border-slate-800 hover:text-slate-200'
          }`}
        >
          <BookOpen className="w-3.5 h-3.5 text-sky-400" />
          <span>Nur Print-Bände</span>
        </button>

        <button
          type="button"
          aria-pressed={mpMySeriesOnly}
          onClick={() => setMpMySeriesOnly(!mpMySeriesOnly)}
          className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all flex items-center gap-1.5 shrink-0 ${
            mpMySeriesOnly
              ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 shadow-sm font-semibold'
              : 'bg-slate-900/80 text-slate-400 border-slate-800 hover:text-slate-200'
          }`}
        >
          <Star className="w-3.5 h-3.5 text-amber-400" />
          <span>Nur meine Reihen ({mySeriesCount ?? '…'})</span>
        </button>

        {(options.length > 0 || mpPublisherFilter !== 'ALL') && (
          <label className="flex items-center gap-1.5 bg-slate-950/70 hover:bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-xl px-3 py-2 text-xs cursor-pointer transition-all shadow-sm group">
            <BuildingComplex className="w-3.5 h-3.5 text-brand-400 shrink-0" />
            <select
              value={mpPublisherFilter}
              onChange={e => setMpPublisherFilter(e.target.value)}
              disabled={Boolean(mpData) && !mpCurrent}
              aria-label="Verlag"
              className="seamless-select filter-chip-select font-medium text-slate-200 group-hover:text-white cursor-pointer"
            >
              <option value="ALL" className="bg-slate-900 text-white">Alle Verlage</option>
              {options.map(o => (
                <option key={o.value} value={o.value} className="bg-slate-900 text-white">
                  {o.label}
                </option>
              ))}
            </select>
            <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" />
          </label>
        )}

        {filtersActive && (
          <button
            type="button"
            onClick={onResetFilters}
            className="btn-secondary text-xs py-2 px-3 text-slate-400 hover:text-white"
          >
            Filter zurücksetzen
          </button>
        )}
      </div>
    </div>
  );
}
