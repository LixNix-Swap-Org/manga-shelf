import { Library, ShoppingCart, Calendar } from 'lucide-react';

/** Tabs Sammlung / Einkaufsliste / Release-Radar plus the mode hint next to them. */
export default function MainViewSwitcher({
  activeMainView, setActiveMainView, mangaCount, shoppingData, radarData,
  fetchShoppingList, fetchReleaseRadar, fetchMangaPassionReleases
}) {
  return (
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
        <div className="flex items-center bg-slate-900/90 border border-slate-800 p-1 rounded-2xl shadow-inner">
          <button
            id="btn-nav-shelf"
            onClick={() => {
              setActiveMainView('shelf');
              try { window.history.replaceState(null, '', window.location.pathname); } catch (_) {}
            }}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all ${
              activeMainView === 'shelf'
                ? 'bg-gradient-to-r from-brand-600 to-sky-500 text-white shadow-lg shadow-brand-500/25'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Library className="w-4 h-4" />
            <span>Sammlung ({mangaCount})</span>
          </button>
          <button
            id="btn-nav-shopping"
            onClick={() => {
              setActiveMainView('shopping');
              try { window.history.replaceState(null, '', '?view=shopping'); } catch (_) {}
              fetchShoppingList();
            }}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all ${
              activeMainView === 'shopping'
                ? 'bg-gradient-to-r from-brand-600 to-sky-500 text-white shadow-lg shadow-brand-500/25'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <ShoppingCart className="w-4 h-4 text-emerald-400" />
            <span>Einkaufsliste</span>
            {shoppingData && shoppingData.total_missing > 0 && (
              <span className="bg-emerald-500/30 text-emerald-300 text-[11px] font-mono px-2 py-0.5 rounded-full font-bold">
                {shoppingData.total_missing}
              </span>
            )}
          </button>
          <button
            id="btn-nav-radar"
            onClick={() => {
              setActiveMainView('radar');
              try { window.history.replaceState(null, '', '?view=radar'); } catch (_) {}
              fetchReleaseRadar();
              fetchMangaPassionReleases();
            }}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all ${
              activeMainView === 'radar'
                ? 'bg-gradient-to-r from-brand-600 to-sky-500 text-white shadow-lg shadow-brand-500/25'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Calendar className="w-4 h-4 text-sky-400" />
            <span>Release-Radar</span>
            {radarData && radarData.total_releases > 0 && (
              <span className="bg-sky-500/30 text-sky-300 text-[11px] font-mono px-2 py-0.5 rounded-full font-bold">
                {radarData.total_releases}
              </span>
            )}
          </button>
        </div>

        {activeMainView === 'shopping' && (
          <div className="text-xs text-slate-400 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>Laden-Modus: Fehlende Bände abhaken & direkt einbuchen</span>
          </div>
        )}

        {activeMainView === 'radar' && (
          <div className="text-xs text-slate-400 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse"></span>
            <span>Kalender-Modus: Vorbestellungen & Neuerscheinungen im Blick</span>
          </div>
        )}
      </div>
  );
}
