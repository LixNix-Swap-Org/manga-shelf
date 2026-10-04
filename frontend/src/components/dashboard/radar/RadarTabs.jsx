import { Globe, Package, ExternalLink } from 'lucide-react';

const TAB_BASE = 'min-w-0 flex-1 sm:flex-initial flex items-center justify-center gap-2 px-3 sm:px-4 py-2 rounded-lg text-xs font-semibold transition-all';
const TAB_ACTIVE = 'bg-gradient-to-r from-brand-800 to-brand-700 text-white shadow-md shadow-sky-600/30';
const TAB_IDLE = 'text-slate-400 hover:text-slate-200';
const SUB_VIEWS = ['passion', 'personal'];
export const RADAR_PANEL_ID = 'radar-tabpanel';
export const radarTabId = (view) => `radar-tab-${view}`;

/**
 * Switch between the Manga-Passion calendar and the personal pre-order radar. Short labels below lg, where the
 * full ones would wrap. `mpCount` is null while the selected month is not loaded.
 */
export default function RadarTabs({
  radarSubView,
  setRadarSubView,
  radarData,
  mpCount,
  mpYear,
  mpMonth
}) {
  const tabProps = (view) => ({
    id: radarTabId(view),
    type: 'button',
    role: 'tab',
    'aria-selected': radarSubView === view,
    'aria-controls': RADAR_PANEL_ID,
    tabIndex: radarSubView === view ? 0 : -1,
    onClick: () => setRadarSubView(view),
    className: `${TAB_BASE} ${radarSubView === view ? TAB_ACTIVE : TAB_IDLE}`
  });

  const onKeyDown = (e) => {
    const index = SUB_VIEWS.indexOf(radarSubView);
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: SUB_VIEWS.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const view = SUB_VIEWS[(next + SUB_VIEWS.length) % SUB_VIEWS.length];
    setRadarSubView(view);
    document.getElementById(radarTabId(view))?.focus();
  };

  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-1.5 bg-slate-900/90 rounded-2xl border border-slate-800 shadow-inner">
      <div role="tablist" aria-label="Release-Radar" onKeyDown={onKeyDown} className="flex items-stretch gap-1.5 p-1 bg-slate-950/80 rounded-xl border border-slate-800/80 w-full sm:w-auto">
        <button
          {...tabProps('passion')}
          title="Deutsche Neuheiten (Manga Passion)"
        >
          <Globe className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          <span className="lg:hidden whitespace-nowrap truncate">Neuheiten</span>
          <span className="hidden lg:inline whitespace-nowrap">Deutsche Neuheiten (Manga Passion)</span>
          {mpCount != null && (
            <span className="shrink-0 bg-sky-500/20 text-sky-200 text-[10px] px-2 py-0.5 rounded-full font-mono font-bold">
              {mpCount}
            </span>
          )}
        </button>
        <button
          {...tabProps('personal')}
          title="Meine Vorbestellungen & Budget"
        >
          <Package className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          <span className="lg:hidden whitespace-nowrap truncate">Meine</span>
          <span className="hidden lg:inline whitespace-nowrap">Meine Vorbestellungen & Budget</span>
          {radarData && radarData.total_releases > 0 && (
            <span className="shrink-0 bg-emerald-500/20 text-emerald-300 text-[10px] px-2 py-0.5 rounded-full font-mono font-bold">
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
            <span className="sr-only">(öffnet in neuem Tab)</span>
          </a>
        </div>
      )}
    </div>
  );
}
