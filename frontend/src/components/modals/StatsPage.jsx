import { lazy, Suspense, useState, useEffect, useCallback, useId, useRef } from 'react';
import { TrendingUp, Coins, BuildingComplex, BookCheck, ArrowLeft, Calendar, ChartColumn, Trash2, BrushCleaning, GitMerge, Library, LayoutGrid, Users, HandHelping, Tv, History } from 'lucide-react';
import SpendingCard from './SpendingCard';
import OwnerStatsCard from './OwnerStatsCard';
import KpiCards from './stats/KpiCards';
import TopSeriesCard from './stats/TopSeriesCard';
import AnimeStatsCard from './stats/AnimeStatsCard';
import AnimeInsightsCard from './stats/AnimeInsightsCard';
import EditionsCard from './stats/EditionsCard';
import LentCard from './stats/LentCard';
import ActivityCard from './stats/ActivityCard';
import PublisherTab, { TopPublishersCard } from './stats/PublisherTab';
import ReadingTab, { ReadingSummaryCard } from './stats/ReadingTab';
import { readApiError } from '../../hooks/useVolumeActions';
import useLatestRequest from '../../hooks/useLatestRequest';
import { apiFetch, isLocalMode, readJson } from '../../utils/api';
import { shelfQuery } from '../../utils/shelfScope';
import ShelfPersonChip from '../dashboard/ShelfPersonChip';
import { localISODate } from '../../utils/radarHelpers';
import { STATS_TAB_IDS } from '../../utils/statsRoute';
import { t } from '../../i18n/index.js';

const ReadingOverTime = lazy(() => import('./stats/ReadingOverTime'));
const TrashModal = lazy(() => import('./TrashModal'));
const PublishersModal = lazy(() => import('./PublishersModal'));
const ShelvesModal = lazy(() => import('./ShelvesModal'));
const CleanupModal = lazy(() => import('./CleanupModal'));

// The tabs of the statistics page, in the order of STATS_TAB_IDS; the id is the last part of the address.
// i18n
const STATS_TABS = [
  { id: 'ueberblick', label: 'Überblick', Icon: LayoutGrid },
  { id: 'finanzen', label: 'Finanzen', Icon: Coins },
  { id: 'personen', label: 'Pro Person', Icon: Users },
  { id: 'lesen', label: 'Lesen', Icon: BookCheck },
  { id: 'verlauf', label: 'Leseverlauf', Icon: ChartColumn },
  { id: 'verlage', label: 'Verlage', Icon: BuildingComplex },
  { id: 'verliehen', label: 'Verliehen', Icon: HandHelping },
  { id: 'aktivitaet', label: 'Aktivität', Icon: History },
  { id: 'anime', label: 'Anime', Icon: Tv }
];
// a tab whose card has nothing to show yet says so instead of staying blank
const EmptyTab = ({ children }) => (
  <p className="py-12 text-center text-sm text-slate-400">{children}</p>
);

// i18n
const LOADING_TEXT = 'Berechne Statistiken & Finanzdaten...';

// without a stored start date the editor starts at today (the server derives the real one from the oldest purchase)
const defaultStartDate = () => new Date().toISOString().slice(0, 10);
const READER_SERIES_STEP = 30;

/**
 * The statistics page (/statistik/<tab>) in place of the shelf, with "Zurück" (`onBack`) and tabs (`tab`, `onTab`);
 * its footer also opens the collection tools (Papierkorb, Sammlung aufräumen, Regale, Verlage for admins) as dialogs.
 * `onDataChanged` runs after a tool changed data (restore, merge, fix), so the caller can reload its lists.
 * `shelfId`: the shelf chosen in the collection toolbar narrows the figures; `shelves`/`setShelfFilter` show the shelf
 * chip to change it. `onShelfMissing` runs when that shelf answers 404.
 */
export default function StatsPage({
  user, onDataChanged, shelfId = null, shelfName = null, shelves = [], setShelfFilter, onClearShelf, onShelfMissing,
  tab = 'ueberblick', onTab, onBack
}) {
  const [statsData, setStatsData] = useState(null);
  const [statsError, setStatsError] = useState(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const beginStatsRequest = useLatestRequest();
  const [editingStartDate, setEditingStartDate] = useState(false);
  const [newStartDate, setNewStartDate] = useState('');
  const [savingStartDate, setSavingStartDate] = useState(false);
  const [startDateError, setStartDateError] = useState(null);
  const statsTab = STATS_TAB_IDS.includes(tab) ? tab : 'ueberblick';
  const setStatsTab = (id) => onTab?.(id);
  const [tool, setTool] = useState(null); // null | 'trash' | 'cleanup' | 'publishers' | 'shelves'
  const [toolChanged, setToolChanged] = useState(false);
  const [detailedReaderStats, setDetailedReaderStats] = useState(null);
  const beginReaderRequest = useLatestRequest(); // the newest click wins when reader details load out of order
  const [loadingDetailedStats, setLoadingDetailedStats] = useState(false);
  const [readerError, setReaderError] = useState(null);
  const [visibleReaderSeries, setVisibleReaderSeries] = useState(READER_SERIES_STEP);
  const titleId = useId();
  const headingRef = useRef(null);
  // arriving on the page puts the focus on its heading, like a page change
  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, []);
  const startDateId = useId();
  const shelfRef = useRef(shelfId);
  shelfRef.current = shelfId;
  const shelfMissingRef = useRef(onShelfMissing);
  shelfMissingRef.current = onShelfMissing;

  const fetchStats = useCallback(async () => {
    const { signal, isCurrent } = beginStatsRequest();
    setLoadingStats(true);
    setStatsError(null);
    const scope = shelfQuery(shelfRef.current);
    try {
      const res = await apiFetch(`/api/stats${scope}`, { signal });
      if (!isCurrent()) return;
      if (res.status === 404 && scope && shelfMissingRef.current) {
        shelfMissingRef.current();
        return;
      }
      if (!res.ok) {
        const message = await readApiError(res, t('Statistiken konnten nicht geladen werden'));
        if (!isCurrent()) return;
        setStatsData(null);
        setStatsError(message);
        return;
      }
      const data = await readJson(res);
      if (!isCurrent()) return;
      if (data === null) throw new Error(t('Antwort ist kein JSON'));
      setStatsData(data);
      setNewStartDate(data.summary?.collection_start_date || defaultStartDate());
    } catch (e) {
      if (!isCurrent()) return;
      setStatsData(null);
      setStatsError(t('Netzwerkfehler: Statistiken konnten nicht geladen werden.'));
    } finally {
      if (isCurrent()) setLoadingStats(false);
    }
  }, [beginStatsRequest]);

  useEffect(() => {
    fetchStats();
    // responses that arrive after leaving the page are aborted and dropped
    return () => {
      beginStatsRequest();
      beginReaderRequest();
    };
  }, [fetchStats, beginStatsRequest, beginReaderRequest]);

  // another shelf (or every shelf again) reloads the figures without leaving the tab
  const shownShelfRef = useRef(shelfId);
  useEffect(() => {
    if (shownShelfRef.current === shelfId) return;
    shownShelfRef.current = shelfId;
    fetchStats();
  }, [shelfId, fetchStats]);

  const fetchReaderDetailedStats = async (userId) => {
    const { signal, isCurrent } = beginReaderRequest();
    setLoadingDetailedStats(true);
    setReaderError(null);
    try {
      const res = await apiFetch(`/api/users/${userId}/stats`, { signal });
      if (!isCurrent()) return;
      if (!res.ok) {
        const message = await readApiError(res, t('Fehler beim Laden der Leser-Details'));
        if (isCurrent()) setReaderError(message);
        return;
      }
      const data = await readJson(res);
      if (!isCurrent()) return;
      if (data === null) throw new Error(t('Antwort ist kein JSON'));
      setVisibleReaderSeries(READER_SERIES_STEP);
      setDetailedReaderStats(data);
    } catch (e) {
      if (isCurrent()) setReaderError(t('Netzwerkfehler: Leser-Details konnten nicht geladen werden.'));
    } finally {
      if (isCurrent()) setLoadingDetailedStats(false);
    }
  };

  const toggleStartDateEditor = () => {
    if (editingStartDate) setNewStartDate(statsData?.summary?.collection_start_date || defaultStartDate());
    setStartDateError(null);
    setEditingStartDate(!editingStartDate);
  };

  const saveStartDate = async (value) => {
    setSavingStartDate(true);
    setStartDateError(null);
    try {
      const res = await apiFetch('/api/stats/settings', { method: 'PUT', body: { collection_start_date: value } });
      if (res.ok) {
        setEditingStartDate(false);
        await fetchStats();
      } else {
        setStartDateError(await readApiError(res, t('Fehler beim Speichern')));
      }
    } catch (err) {
      setStartDateError(t('Netzwerkfehler: Datum wurde nicht gespeichert.'));
    } finally {
      setSavingStartDate(false);
    }
  };

  const handleSaveStartDate = (e) => {
    e.preventDefault();
    if (!newStartDate) return;
    saveStartDate(newStartDate);
  };

  const toolChangedData = () => {
    setToolChanged(true);
    onDataChanged?.();
  };
  const closeTool = () => {
    setTool(null);
    // the figures may have changed underneath
    if (toolChanged) {
      setToolChanged(false);
      fetchStats();
    }
  };
  const navigateAway = () => setTool(null);
  const shelfPicker = setShelfFilter && shelves.length > 1;

  return (
    <>
    <section aria-labelledby={titleId} className="max-w-5xl mx-auto pt-2 pb-8 animate-fade-in">
        <div className="flex flex-wrap items-center gap-3 pb-4 border-b border-slate-800">
          <button
            id="btn-stats-back"
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 min-h-[44px] rounded-xl px-2 -ml-2 text-sm font-semibold text-slate-300 hover:text-white hover:bg-slate-800/60"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" /> {t('Zurück')}
          </button>
          <div className="flex items-center gap-3 min-w-0 mr-auto">
            <div className="w-10 h-10 short:hidden max-sm:hidden shrink-0 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-lg shadow-emerald-950/40">
              <TrendingUp className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <h2 id={titleId} ref={headingRef} tabIndex={-1} className="text-xl font-extrabold text-white tracking-tight focus:outline-none">
                {t('Statistiken')}
              </h2>
              <p className="text-xs text-slate-400 mt-0.5 max-sm:hidden">
                {t('Finanzen, Monatsausgaben, Verlagsdiagramm, Sammelzeit & Lese-Tracking')}
              </p>
            </div>
          </div>
          {shelfPicker && (
            <ShelfPersonChip shelves={shelves} shelfFilter={shelfId ? String(shelfId) : 'ALL'} setShelfFilter={setShelfFilter} userId={user?.id} />
          )}
          {!shelfPicker && shelfName && <span className="text-xs text-slate-400">{t('Regal: {name}', { name: shelfName })}</span>}
        </div>

        <div role="group" aria-label={t('Bereiche')} className="flex flex-nowrap items-center gap-2 pt-4 pb-2 border-b border-slate-800/80 overflow-x-auto no-scrollbar">
          {STATS_TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              id={`btn-stats-tab-${id}`}
              type="button"
              aria-pressed={statsTab === id}
              onClick={() => setStatsTab(id)}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                statsTab === id
                  ? 'bg-emerald-700 text-white shadow-md'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <Icon className="w-3.5 h-3.5" aria-hidden="true" /> {t(label)}
            </button>
          ))}
        </div>

        {/* one live region that stays mounted, so the loading text is announced */}
        <p role="status" className="sr-only">{loadingStats ? t(LOADING_TEXT) : ''}</p>
        <div className="pt-4 space-y-6">
          {loadingStats ? (
            <div aria-hidden="true" className="py-20 flex flex-col items-center justify-center text-slate-400 gap-3">
              <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
              <p className="text-xs">{t(LOADING_TEXT)}</p>
            </div>
          ) : statsError ? (
            <div role="alert" className="py-12 flex flex-col items-center gap-3 text-center">
              <p className="text-sm text-rose-300">{statsError}</p>
              <button type="button" onClick={fetchStats} className="btn-secondary text-xs px-4 py-2">
                {t('Erneut versuchen')}
              </button>
            </div>
          ) : !statsData ? (
            <div className="py-12 text-center text-slate-400 text-sm">
              {t('Keine Statistikdaten verfügbar.')}
            </div>
          ) : (() => {
              const summary = statsData.summary || {};
              const ownedVols = summary.total_owned_volumes ?? 0;
              const publishersList = Array.isArray(statsData.publishers) ? statsData.publishers : [];
              const readersList = Array.isArray(statsData.user_reading_stats) ? statsData.user_reading_stats : [];

              return (
                <>
                  {statsTab === 'ueberblick' && (
                    <div className="space-y-6 animate-fade-in">
                      <KpiCards
                        summary={summary}
                        canEditStartDate={user?.role === 'admin'}
                        editingStartDate={editingStartDate}
                        onToggleStartDate={toggleStartDateEditor}
                      />

                      {editingStartDate && user?.role === 'admin' && (
                        <form onSubmit={handleSaveStartDate} className="p-4 bg-slate-950/90 rounded-2xl border border-amber-500/40 flex flex-wrap items-center gap-3">
                          <Calendar className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
                          <div className="flex-1 min-w-[200px]">
                            <label htmlFor={startDateId} className="block text-xs font-semibold text-slate-300 mb-1">
                              {t('Sammlungs-Startdatum festlegen (Berechnung der Sammelzeit & Monatsausgaben)')}
                            </label>
                            <input
                              id={startDateId}
                              type="date"
                              required
                              min="1900-01-01"
                              max={localISODate()}
                              className="input-field text-base sm:text-xs py-1.5"
                              value={newStartDate}
                              onChange={e => setNewStartDate(e.target.value)}
                            />
                            {startDateError && <p role="alert" className="text-[11px] text-rose-300 mt-1">{startDateError}</p>}
                          </div>
                          <button
                            type="submit"
                            disabled={savingStartDate}
                            className="btn-primary text-xs py-2 px-3 !bg-amber-700 hover:!bg-amber-800 text-white mt-auto"
                          >
                            {savingStartDate ? t('Speichert...') : t('Datum speichern')}
                          </button>
                          {summary.collection_start_date_source === 'stored' && (
                            <button
                              type="button"
                              disabled={savingStartDate}
                              onClick={() => saveStartDate(null)}
                              className="btn-secondary text-xs py-2 px-3 mt-auto"
                            >
                              {t('Automatisch aus den Daten')}
                            </button>
                          )}
                        </form>
                      )}

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <ReadingSummaryCard readers={readersList} ownedVols={ownedVols} />
                        <TopPublishersCard publishers={publishersList} onShowAll={() => setStatsTab('verlage')} />
                        <EditionsCard languages={statsData.languages} currencies={statsData.currencies} />
                      </div>

                      <TopSeriesCard topSeries={statsData.top_series} />
                    </div>
                  )}

                  {statsTab === 'finanzen' && (statsData.spending
                    ? <SpendingCard spending={statsData.spending} />
                    : <EmptyTab>{t('Noch keine Käufe mit Kaufdatum erfasst.')}</EmptyTab>)}

                  {statsTab === 'personen' && ((statsData.owner_stats || []).length >= 2
                    ? <OwnerStatsCard ownerStats={statsData.owner_stats} ownerPublishers={statsData.owner_publishers} />
                    : <EmptyTab>{t('Sobald mehrere Personen Bände besitzen, steht hier, wem was gehört.')}</EmptyTab>)}

                  {statsTab === 'verliehen' && <LentCard shelfId={shelfId} emptyText={t('Gerade ist nichts verliehen oder ausgeliehen.')} />}

                  {statsTab === 'aktivitaet' && <ActivityCard shelfId={shelfId} />}

                  {statsTab === 'anime' && !statsData.anime?.total && <EmptyTab>{t('Noch keine Anime in der Liste')}</EmptyTab>}
                  {statsTab === 'anime' && Boolean(statsData.anime?.total) && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <AnimeStatsCard anime={statsData.anime} />
                      <AnimeInsightsCard insights={statsData.anime?.insights} />
                    </div>
                  )}

                  {statsTab === 'verlage' && <PublisherTab publishers={publishersList} />}

                  {statsTab === 'verlauf' && (
                    <Suspense fallback={<p className="text-sm text-slate-400 py-8 text-center">{t('Leseverlauf wird geladen…')}</p>}>
                      <ReadingOverTime readers={readersList} user={user} shelfId={shelfId} />
                    </Suspense>
                  )}

                  {statsTab === 'lesen' && (
                    <ReadingTab
                      readers={readersList}
                      ownedVols={ownedVols}
                      shelves={statsData.shelf_reading}
                      details={detailedReaderStats}
                      visibleSeries={visibleReaderSeries}
                      onShowMore={() => setVisibleReaderSeries(n => n + READER_SERIES_STEP)}
                      onBack={() => setDetailedReaderStats(null)}
                      readerError={readerError}
                      loadingDetails={loadingDetailedStats}
                      onLoadDetails={fetchReaderDetailedStats}
                    />
                  )}
                </>
              );
            })()}
        </div>

        <div className="pt-4 mt-6 border-t border-slate-800 flex flex-wrap items-center gap-2">
          <div role="group" aria-label={t('Werkzeuge')} className="flex flex-wrap gap-2 mr-auto">
            <button id="btn-open-trash" type="button" onClick={() => setTool('trash')} className="btn-secondary text-xs px-3 py-2 flex items-center gap-1.5">
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> {t('Papierkorb')}
            </button>
            <button id="btn-open-cleanup" type="button" onClick={() => setTool('cleanup')} className="btn-secondary text-xs px-3 py-2 flex items-center gap-1.5">
              <BrushCleaning className="w-3.5 h-3.5" aria-hidden="true" /> {t('Sammlung aufräumen')}
            </button>
            {!isLocalMode() && (
              <button id="btn-open-shelves" type="button" onClick={() => setTool('shelves')} className="btn-secondary text-xs px-3 py-2 flex items-center gap-1.5">
                <Library className="w-3.5 h-3.5" aria-hidden="true" /> {t('Regale')}
              </button>
            )}
            {user?.role === 'admin' && (
              <button id="btn-open-publishers" type="button" onClick={() => setTool('publishers')} className="btn-secondary text-xs px-3 py-2 flex items-center gap-1.5">
                <GitMerge className="w-3.5 h-3.5" aria-hidden="true" /> {t('Verlage zusammenführen')}
              </button>
            )}
          </div>
        </div>
    </section>
    <Suspense fallback={null}>
    {tool === 'trash' && (
      <TrashModal
        onClose={closeTool}
        user={user}
        onChanged={toolChangedData}
        shelfId={shelfId}
        shelfName={shelfName}
        onClearShelf={onClearShelf}
        onShelfMissing={onShelfMissing}
      />
    )}
    {tool === 'cleanup' && (
      <CleanupModal
        onClose={closeTool}
        user={user}
        onChanged={toolChangedData}
        onNavigate={navigateAway}
        onOpenPublishers={user?.role === 'admin' ? () => setTool('publishers') : undefined}
      />
    )}
    {tool === 'shelves' && <ShelvesModal onClose={closeTool} user={user} onChanged={toolChangedData} />}
    {tool === 'publishers' && <PublishersModal onClose={closeTool} user={user} onChanged={toolChangedData} />}
    </Suspense>
    </>
  );
}
