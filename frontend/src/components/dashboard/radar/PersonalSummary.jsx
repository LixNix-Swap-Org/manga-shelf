import { Package, RefreshCw, Coins } from 'lucide-react';
import { formatCount, formatEuro } from '../../../utils/format';

const euro = (value) => formatEuro(value || 0);

/** Pre-order count and budget of the personal radar ('–' while nothing is loaded, never a made-up 0,00 €). */
export default function PersonalSummary({
  radarData,
  loadingRadar,
  fetchReleaseRadar
}) {
  return (
    <div className="glass-panel p-5 sm:p-6 rounded-2xl border border-slate-800/80 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-gradient-to-r from-slate-900/90 via-slate-900/70 to-sky-950/30">
      <div className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-2xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center shrink-0">
          <Package className="w-6 h-6 text-sky-400" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <span>Meine Vorbestellungen & Lieferungen</span>
            {radarData && (
              <span className="bg-sky-500/20 text-sky-300 text-xs px-2.5 py-0.5 rounded-full border border-sky-500/30 font-mono font-bold">
                {formatCount(radarData.total_releases, 'Band', 'Bände')}
              </span>
            )}
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Verfolge deine offenen Vorbestellungen und behalte dein geplantes Manga-Budget im Blick
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2.5 sm:gap-3 w-full md:w-auto">
        <div className="bg-slate-950/70 border border-slate-800 px-3.5 py-2 rounded-xl text-right flex-1 sm:flex-initial">
          <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold flex items-center justify-end gap-1">
            <Package className="w-3 h-3 text-sky-400" /> Vorbestellt ({radarData ? radarData.preordered_count : '–'})
          </p>
          <p className="text-base sm:text-lg font-extrabold text-sky-400 font-mono">
            {radarData ? euro(radarData.preordered_budget) : '–'}
          </p>
        </div>

        <div className="bg-slate-950/70 border border-slate-800 px-3.5 py-2 rounded-xl text-right flex-1 sm:flex-initial">
          <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold flex items-center justify-end gap-1">
            <Coins className="w-3 h-3 text-emerald-400" /> Gesamt geplant
          </p>
          <p className="text-base sm:text-lg font-extrabold text-emerald-400 font-mono">
            {radarData ? euro(radarData.total_budget) : '–'}
          </p>
        </div>

        <button
          type="button"
          onClick={fetchReleaseRadar}
          disabled={loadingRadar}
          className="btn-secondary text-xs p-2.5 text-slate-300 flex items-center gap-1.5 shrink-0"
          title="Release-Radar aktualisieren"
          aria-label="Release-Radar aktualisieren"
        >
          <RefreshCw className={`w-4 h-4 ${loadingRadar ? 'animate-spin' : ''}`} />
        </button>
      </div>
    </div>
  );
}
