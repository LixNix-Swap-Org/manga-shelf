import { Library, Layers, Coins, CheckCircle2 } from 'lucide-react';

/** Quick stats bar: series, owned volumes, collection value, completed series. */
export default function CollectionStats({ totalSeries, totalOwnedVolumes, totalCollectionValue, completedSeries, handleOpenStats }) {
  return (
      <section className="grid grid-cols-2 md:grid-cols-4 gap-2.5 sm:gap-4 mb-6 sm:mb-8">
    <div className="glass-panel p-3 sm:p-4 rounded-2xl flex items-center gap-2.5 sm:gap-3.5 border border-slate-800/80">
      <div className="w-9 h-9 sm:w-11 sm:h-11 rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center shrink-0">
        <Library className="w-4 h-4 sm:w-5 sm:h-5 text-sky-400" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] sm:text-[11px] text-slate-400 uppercase tracking-wider font-medium">Reihen</p>
        <p className="text-lg sm:text-2xl font-extrabold text-white">{totalSeries}</p>
      </div>
    </div>

    <div className="glass-panel p-3 sm:p-4 rounded-2xl flex items-center gap-2.5 sm:gap-3.5 border border-slate-800/80">
      <div className="w-9 h-9 sm:w-11 sm:h-11 rounded-xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center shrink-0">
        <Layers className="w-4 h-4 sm:w-5 sm:h-5 text-indigo-400" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] sm:text-[11px] text-slate-400 uppercase tracking-wider font-medium">Bände im Besitz</p>
        <p className="text-lg sm:text-2xl font-extrabold text-white">{totalOwnedVolumes}</p>
      </div>
    </div>

    <div 
      onClick={handleOpenStats}
      className="glass-panel p-3 sm:p-4 rounded-2xl flex items-center gap-2.5 sm:gap-3.5 border border-slate-800/80 hover:border-emerald-500/50 hover:bg-slate-900/90 cursor-pointer transition-all duration-200 group"
      title="Klicken für das vollständige Finanz- & Statistik-Dashboard"
    >
      <div className="w-9 h-9 sm:w-11 sm:h-11 rounded-xl bg-emerald-500/10 border border-emerald-500/30 group-hover:scale-105 group-hover:bg-emerald-500/20 transition-all flex items-center justify-center shrink-0">
        <Coins className="w-4 h-4 sm:w-5 sm:h-5 text-emerald-400" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <p className="text-[10px] sm:text-[11px] text-slate-400 uppercase tracking-wider font-medium truncate">Sammlungswert</p>
          <span className="text-[10px] text-emerald-400 opacity-0 group-hover:opacity-100 transition-opacity font-semibold hidden sm:inline">Details ↗</span>
        </div>
        <p className="text-sm sm:text-xl lg:text-2xl font-extrabold text-emerald-400 font-mono tracking-tight whitespace-nowrap">
          {totalCollectionValue.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
        </p>
      </div>
    </div>

    <div className="glass-panel p-3 sm:p-4 rounded-2xl flex items-center gap-2.5 sm:gap-3.5 border border-slate-800/80">
      <div className="w-9 h-9 sm:w-11 sm:h-11 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center shrink-0">
        <CheckCircle2 className="w-4 h-4 sm:w-5 sm:h-5 text-purple-400" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] sm:text-[11px] text-slate-400 uppercase tracking-wider font-medium">Abgeschlossen</p>
        <p className="text-lg sm:text-2xl font-extrabold text-white">{completedSeries}</p>
      </div>
    </div>
  </section>
  );
}
