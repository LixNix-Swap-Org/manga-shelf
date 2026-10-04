import { useId } from 'react';
import { Library, Layers, Coins, CircleCheck } from 'lucide-react';
import { formatEuro } from '../../utils/format';

/** Quick stats bar: series, owned volumes, collection value, completed series. */
// four columns from md: the icon tiles return at xl, below they would push the value past the card edge
export default function CollectionStats({ totalSeries, totalOwnedVolumes, totalCollectionValue, completedSeries, handleOpenStats, isOfflineMode = false }) {
  const valueText = formatEuro(totalCollectionValue ?? 0);
  const tileId = useId();
  return (
      <section className="grid grid-cols-2 md:grid-cols-4 gap-2.5 sm:gap-4 mb-6 sm:mb-8">
    <div className="glass-panel p-3 sm:p-4 rounded-2xl flex items-center gap-2.5 sm:gap-3.5 border border-slate-800/80">
      <div className="w-9 h-9 sm:w-11 sm:h-11 md:hidden xl:flex rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center shrink-0">
        <Library className="w-4 h-4 sm:w-5 sm:h-5 text-sky-400" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] sm:text-[11px] text-slate-400 uppercase tracking-wider font-medium leading-tight break-words hyphens-auto">Reihen</p>
        <p className="text-lg sm:text-2xl font-extrabold text-white">{totalSeries}</p>
      </div>
    </div>

    <div className="glass-panel p-3 sm:p-4 rounded-2xl flex items-center gap-2.5 sm:gap-3.5 border border-slate-800/80">
      <div className="w-9 h-9 sm:w-11 sm:h-11 md:hidden xl:flex rounded-xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center shrink-0">
        <Layers className="w-4 h-4 sm:w-5 sm:h-5 text-indigo-400" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] sm:text-[11px] text-slate-400 uppercase tracking-wider font-medium leading-tight break-words hyphens-auto">Bände im Besitz</p>
        <p className="text-lg sm:text-2xl font-extrabold text-white">{totalOwnedVolumes}</p>
      </div>
    </div>

    <button
      type="button"
      onClick={handleOpenStats}
      disabled={isOfflineMode}
      aria-labelledby={`${tileId}-label ${tileId}-value ${tileId}-hint`}
      title={isOfflineMode ? 'Offline nicht verfügbar' : 'Klicken für das vollständige Finanz- & Statistik-Dashboard'}
      className="glass-panel w-full text-left p-3 sm:p-4 rounded-2xl flex items-center gap-2.5 sm:gap-3.5 border border-slate-800/80 enabled:hover:border-emerald-500/50 enabled:hover:bg-slate-900/90 enabled:cursor-pointer disabled:cursor-default transition-all duration-200 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
    >
      <div className="w-9 h-9 sm:w-11 sm:h-11 md:hidden xl:flex rounded-xl bg-emerald-500/10 border border-emerald-500/30 group-enabled:group-hover:scale-105 group-enabled:group-hover:bg-emerald-500/20 transition-all flex items-center justify-center shrink-0">
        <Coins className="w-4 h-4 sm:w-5 sm:h-5 text-emerald-400" aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-1.5">
          <p id={`${tileId}-label`} className="min-w-0 text-[10px] sm:text-[11px] text-slate-400 uppercase tracking-wider font-medium leading-tight break-words hyphens-auto">Sammlungswert</p>
          {!isOfflineMode && (
            <span aria-hidden="true" className="shrink-0 text-[10px] leading-tight text-emerald-400 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity font-semibold hidden xl:inline">Details ↗</span>
          )}
        </div>
        <p id={`${tileId}-value`} className="text-sm sm:text-xl lg:text-2xl font-extrabold text-emerald-400 font-mono tracking-tight whitespace-nowrap">
          {valueText}
        </p>
        <span id={`${tileId}-hint`} className="sr-only">– {isOfflineMode ? 'Statistik offline nicht verfügbar' : 'Statistik öffnen'}</span>
      </div>
    </button>

    <div className="glass-panel p-3 sm:p-4 rounded-2xl flex items-center gap-2.5 sm:gap-3.5 border border-slate-800/80">
      <div className="w-9 h-9 sm:w-11 sm:h-11 md:hidden xl:flex rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center shrink-0">
        <CircleCheck className="w-4 h-4 sm:w-5 sm:h-5 text-purple-400" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] sm:text-[11px] text-slate-400 uppercase tracking-wider font-medium leading-tight break-words hyphens-auto">Komplett</p>
        <p className="text-lg sm:text-2xl font-extrabold text-white">{completedSeries}</p>
      </div>
    </div>
  </section>
  );
}
