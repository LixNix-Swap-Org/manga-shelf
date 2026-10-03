import { ChevronDown, Star, Search, X, BookOpen, Building2 } from 'lucide-react';

/** Search, publisher and print / my-series filters of the Manga-Passion calendar. */
export default function MpFilters({
  mpData,
  mpPrintOnly,
  setMpPrintOnly,
  mpMySeriesOnly,
  setMpMySeriesOnly,
  mpPublisherFilter,
  setMpPublisherFilter,
  mpSearch,
  setMpSearch
}) {
  return (
    <div className="glass-panel p-3.5 sm:p-4 rounded-2xl border border-slate-800/80 flex flex-col md:flex-row justify-between items-stretch md:items-center gap-3">
      <div className="flex items-center gap-2 bg-slate-950/70 border border-slate-800 rounded-xl px-3 py-2 w-full md:w-72 shadow-inner">
        <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <input
          type="text"
          placeholder="Reihe, Band oder Verlag..."
          className="w-full bg-transparent border-0 p-0 text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-0 text-xs"
          value={mpSearch}
          onChange={e => setMpSearch(e.target.value)}
        />
        {mpSearch && (
          <button onClick={() => setMpSearch('')} className="text-slate-500 hover:text-white">
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
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
          onClick={() => setMpMySeriesOnly(!mpMySeriesOnly)}
          className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all flex items-center gap-1.5 shrink-0 ${
            mpMySeriesOnly
              ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 shadow-sm font-semibold'
              : 'bg-slate-900/80 text-slate-400 border-slate-800 hover:text-slate-200'
          }`}
        >
          <Star className="w-3.5 h-3.5 text-amber-400" />
          <span>Nur meine Reihen ({mpData?.user_series_count || 0})</span>
        </button>

        {mpData && mpData.publishers && mpData.publishers.length > 0 && (
          <label className="flex items-center gap-1.5 bg-slate-950/70 hover:bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-xl px-3 py-2 text-xs cursor-pointer transition-all shadow-sm group">
            <Building2 className="w-3.5 h-3.5 text-brand-400 shrink-0" />
            <select
              value={mpPublisherFilter}
              onChange={e => setMpPublisherFilter(e.target.value)}
              className="seamless-select filter-chip-select font-medium text-slate-200 group-hover:text-white cursor-pointer"
            >
              <option value="ALL" className="bg-slate-900 text-white">Alle Verlage</option>
              {mpData.publishers.map(p => (
                <option key={p.name} value={p.name} className="bg-slate-900 text-white">
                  {p.name} ({p.count})
                </option>
              ))}
            </select>
            <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" />
          </label>
        )}

        {(mpSearch || mpPublisherFilter !== 'ALL' || !mpPrintOnly || mpMySeriesOnly) && (
          <button
            onClick={() => {
              setMpSearch('');
              setMpPublisherFilter('ALL');
              setMpPrintOnly(true);
              setMpMySeriesOnly(false);
            }}
            className="btn-secondary text-xs py-2 px-3 text-slate-400 hover:text-white"
          >
            Filter zurücksetzen
          </button>
        )}
      </div>
    </div>
  );
}
