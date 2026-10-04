import { Library, ShoppingCart, Calendar, Tv } from 'lucide-react';
import { t } from '../../i18n/index.js';

const tabClass = (active) => `flex items-center gap-1.5 sm:gap-2 px-2 min-[380px]:px-2.5 sm:px-4 py-2 [@media(pointer:coarse)]:py-3.5 rounded-xl text-xs sm:text-sm font-semibold whitespace-nowrap shrink-0 transition-all ${
  active
    ? 'bg-gradient-to-r from-brand-800 to-brand-700 text-white shadow-lg shadow-brand-500/25'
    : 'text-slate-400 hover:text-white'
}`;

// the mode hint only next to the tabs (lg+); below it would squeeze them
const HINT_CLASS = 'hidden lg:flex min-w-0 items-center gap-2 text-xs text-slate-400';

/** Full label from sm on, a short one below; phones also drop the count pills (the bottom navigation shows them), so the
 * four tabs fit 360 px. */
const Label = ({ full, short }) => (
  <>
    <span className="hidden sm:inline">{full}</span>
    <span className="sm:hidden">{short}</span>
  </>
);

/**
 * Tabs Sammlung / Einkaufsliste / Release-Radar / Anime plus the mode hint next to them. `onSelectView` is Dashboard's
 * setView (state, ?view= and the view's data in one place).
 */
export default function MainViewSwitcher({ activeMainView, onSelectView, mangaCount, animeCount = 0, shoppingData, radarData }) {
  return (
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-3 mb-6">
        <nav aria-label={t('Hauptansicht')} className="flex items-center max-w-full shrink-0 overflow-x-auto overscroll-x-contain bg-slate-900/90 border border-slate-800 p-1 rounded-2xl shadow-inner">
          <button
            id="btn-nav-shelf"
            type="button"
            aria-current={activeMainView === 'shelf' ? 'page' : undefined}
            onClick={() => onSelectView('shelf')}
            className={tabClass(activeMainView === 'shelf')}
          >
            <Library className="w-4 h-4 hidden sm:block" aria-hidden="true" />
            <span>{t('Sammlung ({mangaCount})', { mangaCount })}</span>
          </button>
          <button
            id="btn-nav-shopping"
            type="button"
            aria-current={activeMainView === 'shopping' ? 'page' : undefined}
            onClick={() => onSelectView('shopping')}
            className={tabClass(activeMainView === 'shopping')}
          >
            <ShoppingCart className="w-4 h-4 text-emerald-400 hidden sm:block" aria-hidden="true" />
            {/* i18n-ignore: both props are translated */}
            <Label full={t('Einkaufsliste')} short={t('Einkauf')} />
            {shoppingData && shoppingData.total_missing > 0 && (
              <span className="bg-emerald-500/30 text-emerald-300 text-[11px] font-mono px-2 py-0.5 rounded-full font-bold hidden sm:inline">
                {shoppingData.total_missing}
              </span>
            )}
          </button>
          <button
            id="btn-nav-radar"
            type="button"
            aria-current={activeMainView === 'radar' ? 'page' : undefined}
            onClick={() => onSelectView('radar')}
            className={tabClass(activeMainView === 'radar')}
          >
            <Calendar className="w-4 h-4 text-sky-400 hidden sm:block" aria-hidden="true" />
            {/* i18n-ignore: both props are translated */}
            <Label full={t('Release-Radar')} short={t('Radar')} />
            {radarData && radarData.total_releases > 0 && (
              <span className="bg-sky-500/30 text-sky-300 text-[11px] font-mono px-2 py-0.5 rounded-full font-bold hidden sm:inline">
                {radarData.total_releases}
              </span>
            )}
          </button>
          <button
            id="btn-nav-anime"
            type="button"
            aria-current={activeMainView === 'anime' ? 'page' : undefined}
            onClick={() => onSelectView('anime')}
            className={tabClass(activeMainView === 'anime')}
          >
            <Tv className="w-4 h-4 text-fuchsia-400 hidden sm:block" aria-hidden="true" />
            <span>{t('Anime')}</span>
            {animeCount > 0 && (
              <span className="bg-fuchsia-500/30 text-fuchsia-200 text-[11px] font-mono px-2 py-0.5 rounded-full font-bold hidden sm:inline">
                {animeCount}
              </span>
            )}
          </button>
        </nav>

        {activeMainView === 'shopping' && (
          <div className={HINT_CLASS}>
            <span aria-hidden="true" className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>{t('Laden-Modus: Fehlende Bände abhaken & direkt einbuchen')}</span>
          </div>
        )}

        {activeMainView === 'anime' && (
          <div className={HINT_CLASS}>
            <span aria-hidden="true" className="w-2 h-2 rounded-full bg-fuchsia-400 animate-pulse"></span>
            <span>{t('Anime-Modus: Folgen zählen, Daten von AniList & MyAnimeList')}</span>
          </div>
        )}

        {activeMainView === 'radar' && (
          <div className={HINT_CLASS}>
            <span aria-hidden="true" className="w-2 h-2 rounded-full bg-sky-400 animate-pulse"></span>
            <span>{t('Kalender-Modus: Vorbestellungen & Neuerscheinungen im Blick')}</span>
          </div>
        )}
      </div>
  );
}
