import { ChevronDown, Search, X, BuildingComplex } from 'lucide-react';
import { RADAR_STATUS_CHIPS, publisherOptions } from '../../../utils/radarHelpers';

/** Search, status and publisher filters of the personal radar. */
export default function PersonalFilters({
  radarData,
  radarPublisherFilter,
  setRadarPublisherFilter,
  radarStatusFilter,
  setRadarStatusFilter,
  radarSearch,
  setRadarSearch,
  filtersActive,
  onResetFilters
}) {
  const options = publisherOptions(radarData?.publishers, 'publisher', radarPublisherFilter);
  return (
    <div className="glass-panel p-3.5 sm:p-4 rounded-2xl border border-slate-800/80 flex flex-col md:flex-row justify-between items-stretch md:items-center gap-3">
      <div className="flex items-center gap-2 bg-slate-950/70 border border-slate-800 rounded-xl px-3 py-2 w-full md:w-72 shadow-inner focus-within:ring-2 focus-within:ring-brand-400 focus-within:border-brand-400">
        <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <input
          type="text"
          placeholder="Reihe oder Verlag suchen..."
          aria-label="Vorbestellungen durchsuchen"
          className="w-full bg-transparent border-0 p-0 text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-0 text-base sm:text-xs"
          value={radarSearch}
          onChange={e => setRadarSearch(e.target.value)}
        />
        {radarSearch && (
          <button type="button" onClick={() => setRadarSearch('')} className="p-1.5 -m-1 text-slate-400 hover:text-white" aria-label="Suche löschen">
            <X className="w-3 h-3" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Status-Filter" className="flex items-center gap-1 bg-slate-900/90 p-1 rounded-xl border border-slate-800 text-xs overflow-x-auto">
          {RADAR_STATUS_CHIPS.map(st => (
            <button
              type="button"
              key={st.id}
              aria-pressed={radarStatusFilter === st.id}
              onClick={() => setRadarStatusFilter(st.id)}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all shrink-0 ${
                radarStatusFilter === st.id
                  ? 'bg-sky-700 text-white shadow-sm font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {st.label}
            </button>
          ))}
        </div>

        {(options.length > 0 || radarPublisherFilter !== 'ALL') && (
          <label className="flex items-center gap-1.5 bg-slate-950/70 hover:bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-xl px-3 py-2 text-xs cursor-pointer transition-all shadow-sm group">
            <BuildingComplex className="w-3.5 h-3.5 text-brand-400 shrink-0" />
            <select
              value={radarPublisherFilter}
              onChange={e => setRadarPublisherFilter(e.target.value)}
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
