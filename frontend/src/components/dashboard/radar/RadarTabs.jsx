import { Globe, Package, ExternalLink } from 'lucide-react';

/** Switch between the Manga-Passion calendar and the personal pre-order radar. */
export default function RadarTabs({
  radarSubView,
  setRadarSubView,
  radarData,
  mpData,
  mpYear,
  mpMonth,
  mpPrintOnly
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-1.5 bg-slate-900/90 rounded-2xl border border-slate-800 shadow-inner">
      <div className="flex items-center gap-1.5 p-1 bg-slate-950/80 rounded-xl border border-slate-800/80 w-full sm:w-auto">
        <button
          onClick={() => setRadarSubView('passion')}
          className={`flex-1 sm:flex-initial flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
            radarSubView === 'passion'
              ? 'bg-gradient-to-r from-sky-600 to-brand-600 text-white shadow-md shadow-sky-600/30'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Globe className="w-3.5 h-3.5 text-sky-400" />
          <span>Deutsche Neuheiten (Manga Passion)</span>
          {mpData && (
            <span className="bg-sky-500/20 text-sky-200 text-[10px] px-2 py-0.5 rounded-full font-mono font-bold">
              {mpPrintOnly ? mpData.print_count : mpData.total_items}
            </span>
          )}
        </button>
        <button
          onClick={() => setRadarSubView('personal')}
          className={`flex-1 sm:flex-initial flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
            radarSubView === 'personal'
              ? 'bg-gradient-to-r from-sky-600 to-brand-600 text-white shadow-md shadow-sky-600/30'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Package className="w-3.5 h-3.5 text-sky-400" />
          <span>Meine Vorbestellungen & Budget</span>
          {radarData && radarData.total_releases > 0 && (
            <span className="bg-emerald-500/20 text-emerald-300 text-[10px] px-2 py-0.5 rounded-full font-mono font-bold">
              {radarData.total_releases}
            </span>
          )}
        </button>
      </div>

      {radarSubView === 'passion' && (
        <div className="flex items-center gap-2 px-2 text-xs text-slate-400">
          <span className="hidden md:inline">Live-Daten via:</span>
          <a 
            href={`https://www.manga-passion.de/manga?year=${mpYear}&month=${mpMonth}`} 
            target="_blank" 
            rel="noreferrer" 
            className="text-sky-400 hover:text-sky-300 flex items-center gap-1 hover:underline font-medium"
          >
            manga-passion.de <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      )}
    </div>
  );
}
