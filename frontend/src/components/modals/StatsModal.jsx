import { lazy, Suspense, useState, useEffect, useCallback, useId } from 'react';
import { TrendingUp, Coins, BuildingComplex, BookCheck, X, Calendar, ChartColumn, Trash2, BrushCleaning, GitMerge } from 'lucide-react';
import SpendingCard from './SpendingCard';
import OwnerStatsCard from './OwnerStatsCard';
import KpiCards from './stats/KpiCards';
import TopSeriesCard from './stats/TopSeriesCard';
import AnimeStatsCard from './stats/AnimeStatsCard';
import PublisherTab, { TopPublishersCard } from './stats/PublisherTab';
import ReadingTab, { ReadingSummaryCard } from './stats/ReadingTab';
import useDialogA11y from '../../hooks/useDialogA11y';
import { readApiError } from '../../hooks/useVolumeActions';
import useLatestRequest from '../../hooks/useLatestRequest';
import { apiFetch, readJson } from '../../utils/api';
import { localISODate } from '../../utils/radarHelpers';

const ReadingOverTime = lazy(() => import('./stats/ReadingOverTime'));
const TrashModal = lazy(() => import('./TrashModal'));
const PublishersModal = lazy(() => import('./PublishersModal'));
const CleanupModal = lazy(() => import('./CleanupModal'));

const TABS = [
  { id: 'overview', label: 'Finanzen & Sammelzeit', Icon: Coins },
  { id: 'publishers', label: 'Verlagsdiagramm', Icon: BuildingComplex },
  { id: 'reading', label: 'Lese-Tracking (Nutzer)', Icon: BookCheck },
  { id: 'timeline', label: 'Leseverlauf', Icon: ChartColumn }
];
const LOADING_TEXT = 'Berechne Statistiken & Finanzdaten...';

// without a stored start date the editor starts at today (the server derives the real one from the oldest purchase)
const defaultStartDate = () => new Date().toISOString().slice(0, 10);
const READER_SERIES_STEP = 30;

/**
 * Statistics dialog; its footer also opens the collection tools (Papierkorb, Sammlung aufräumen, Verlage for admins)
 * above it. `onDataChanged` runs after a tool changed data (restore, merge, fix), so the caller can reload its lists.
 */
export default function StatsModal({ isOpen, onClose, user, onDataChanged }) {
  const [statsData, setStatsData] = useState(null);
  const [statsError, setStatsError] = useState(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const beginStatsRequest = useLatestRequest();
  const [editingStartDate, setEditingStartDate] = useState(false);
  const [newStartDate, setNewStartDate] = useState('');
  const [savingStartDate, setSavingStartDate] = useState(false);
  const [startDateError, setStartDateError] = useState(null);
  const [statsTab, setStatsTab] = useState('overview'); // 'overview' | 'publishers' | 'reading' | 'timeline'
  const [tool, setTool] = useState(null); // null | 'trash' | 'cleanup' | 'publishers'
  const [toolChanged, setToolChanged] = useState(false);
  const [detailedReaderStats, setDetailedReaderStats] = useState(null);
  const beginReaderRequest = useLatestRequest(); // the newest click wins when reader details load out of order
  const [loadingDetailedStats, setLoadingDetailedStats] = useState(false);
  const [readerError, setReaderError] = useState(null);
  const [visibleReaderSeries, setVisibleReaderSeries] = useState(READER_SERIES_STEP);
  const titleId = useId();
  const startDateId = useId();

  const fetchStats = useCallback(async () => {
    const { signal, isCurrent } = beginStatsRequest();
    setLoadingStats(true);
    setStatsError(null);
    try {
      const res = await apiFetch('/api/stats', { signal });
      if (!isCurrent()) return;
      if (!res.ok) {
        const message = await readApiError(res, 'Statistiken konnten nicht geladen werden');
        if (!isCurrent()) return;
        setStatsData(null);
        setStatsError(message);
        return;
      }
      const data = await readJson(res);
      if (!isCurrent()) return;
      if (data === null) throw new Error('Antwort ist kein JSON');
      setStatsData(data);
      setNewStartDate(data.summary?.collection_start_date || defaultStartDate());
    } catch (e) {
      if (!isCurrent()) return;
      setStatsData(null);
      setStatsError('Netzwerkfehler: Statistiken konnten nicht geladen werden.');
    } finally {
      if (isCurrent()) setLoadingStats(false);
    }
  }, [beginStatsRequest]);

  useEffect(() => {
    // Responses that arrive after a close or reopen belong to the old session: aborted and dropped.
    beginReaderRequest();
    setLoadingDetailedStats(false);
    if (!isOpen) {
      beginStatsRequest();
      setLoadingStats(false);
      return;
    }
    setStatsTab('overview');
    setTool(null);
    setDetailedReaderStats(null);
    setReaderError(null);
    setEditingStartDate(false);
    setStartDateError(null);
    setStatsData(null);
    fetchStats();
  }, [isOpen, fetchStats, beginStatsRequest, beginReaderRequest]);

  const fetchReaderDetailedStats = async (userId) => {
    const { signal, isCurrent } = beginReaderRequest();
    setLoadingDetailedStats(true);
    setReaderError(null);
    try {
      const res = await apiFetch(`/api/users/${userId}/stats`, { signal });
      if (!isCurrent()) return;
      if (!res.ok) {
        const message = await readApiError(res, 'Fehler beim Laden der Leser-Details');
        if (isCurrent()) setReaderError(message);
        return;
      }
      const data = await readJson(res);
      if (!isCurrent()) return;
      if (data === null) throw new Error('Antwort ist kein JSON');
      setVisibleReaderSeries(READER_SERIES_STEP);
      setDetailedReaderStats(data);
    } catch (e) {
      if (isCurrent()) setReaderError('Netzwerkfehler: Leser-Details konnten nicht geladen werden.');
    } finally {
      if (isCurrent()) setLoadingDetailedStats(false);
    }
  };

  const toggleStartDateEditor = () => {
    if (editingStartDate) setNewStartDate(statsData?.summary?.collection_start_date || defaultStartDate());
    setStartDateError(null);
    setEditingStartDate(!editingStartDate);
  };

  const handleSaveStartDate = async (e) => {
    e.preventDefault();
    if (!newStartDate) return;
    setSavingStartDate(true);
    setStartDateError(null);
    try {
      const res = await apiFetch('/api/stats/settings', { method: 'PUT', body: { collection_start_date: newStartDate } });
      if (res.ok) {
        setEditingStartDate(false);
        await fetchStats();
      } else {
        setStartDateError(await readApiError(res, 'Fehler beim Speichern'));
      }
    } catch (err) {
      setStartDateError('Netzwerkfehler: Datum wurde nicht gespeichert.');
    } finally {
      setSavingStartDate(false);
    }
  };

  const dialogRef = useDialogA11y(isOpen);
  if (!isOpen) return null;

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
  const navigateAway = () => {
    setTool(null);
    onClose();
  };

  return (
    <>
    <div 
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="outline-none dialog-overlay z-50 bg-black/80 backdrop-blur-md animate-fade-in"
    >
      <div className="dialog-box glass-panel max-w-4xl max-h-[90vh] supports-[height:100dvh]:max-h-[90dvh] short:max-h-none max-sm:max-h-none rounded-3xl p-6 sm:p-8 short:p-4 border border-slate-700/80 shadow-2xl relative flex flex-col overflow-hidden">
        
        <div className="flex items-start justify-between gap-3 pb-5 short:pb-2 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 short:hidden shrink-0 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-lg shadow-emerald-950/40">
              <TrendingUp className="w-5 h-5" />
            </div>
            <div>
              <h2 id={titleId} className="text-xl font-extrabold text-white tracking-tight flex items-center gap-2">
                Statistik- & Finanz-Dashboard
              </h2>
              <p className="text-xs text-slate-400 mt-0.5 short:hidden max-sm:hidden">
                Finanzen, Monatsausgaben, Verlagsdiagramm, Sammelzeit & Lese-Tracking
              </p>
            </div>
          </div>
          <button 
            id="btn-close-stats-modal-x"
            type="button"
            onClick={onClose} 
            className="hit-44 shrink-0 text-slate-400 hover:text-white p-1 rounded-xl hover:bg-slate-800 transition-colors"
            title="Schließen"
            aria-label="Schließen"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div role="group" aria-label="Bereiche" className="flex flex-nowrap items-center gap-2 pt-4 pb-2 shrink-0 border-b border-slate-800/80 overflow-x-auto no-scrollbar">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              aria-pressed={statsTab === id}
              onClick={() => setStatsTab(id)}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                statsTab === id
                  ? 'bg-emerald-700 text-white shadow-md'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <Icon className="w-3.5 h-3.5" aria-hidden="true" /> {label}
            </button>
          ))}
        </div>

        {/* one live region that stays mounted, so the loading text is announced */}
        <p role="status" className="sr-only">{loadingStats ? LOADING_TEXT : ''}</p>
        <div className="overflow-y-auto max-sm:overflow-visible short:overflow-visible custom-scrollbar flex-1 pr-1 pt-4 space-y-6">
          {loadingStats ? (
            <div aria-hidden="true" className="py-20 flex flex-col items-center justify-center text-slate-400 gap-3">
              <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
              <p className="text-xs">{LOADING_TEXT}</p>
            </div>
          ) : statsError ? (
            <div role="alert" className="py-12 flex flex-col items-center gap-3 text-center">
              <p className="text-sm text-rose-300">{statsError}</p>
              <button type="button" onClick={fetchStats} className="btn-secondary text-xs px-4 py-2">
                Erneut versuchen
              </button>
            </div>
          ) : !statsData ? (
            <div className="py-12 text-center text-slate-400 text-sm">
              Keine Statistikdaten verfügbar.
            </div>
          ) : (() => {
              const summary = statsData.summary || {};
              const ownedVols = summary.total_owned_volumes ?? 0;
              const publishersList = Array.isArray(statsData.publishers) ? statsData.publishers : [];
              const readersList = Array.isArray(statsData.user_reading_stats) ? statsData.user_reading_stats : [];

              return (
                <>
                  {statsTab === 'overview' && (
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
                              Sammlungs-Startdatum festlegen (Berechnung der Sammelzeit & Monatsausgaben)
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
                            {savingStartDate ? 'Speichert...' : 'Datum speichern'}
                          </button>
                        </form>
                      )}

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <ReadingSummaryCard readers={readersList} ownedVols={ownedVols} />
                        <SpendingCard spending={statsData.spending} />
                        <OwnerStatsCard ownerStats={statsData.owner_stats} ownerPublishers={statsData.owner_publishers} />
                        <TopPublishersCard publishers={publishersList} onShowAll={() => setStatsTab('publishers')} />
                        <AnimeStatsCard anime={statsData.anime} />
                      </div>

                      <TopSeriesCard topSeries={statsData.top_series} onNavigate={onClose} />
                    </div>
                  )}

                  {statsTab === 'publishers' && <PublisherTab publishers={publishersList} />}

                  {statsTab === 'timeline' && (
                    <Suspense fallback={<p className="text-sm text-slate-400 py-8 text-center">Leseverlauf wird geladen…</p>}>
                      <ReadingOverTime readers={readersList} user={user} onNavigate={onClose} />
                    </Suspense>
                  )}

                  {statsTab === 'reading' && (
                    <ReadingTab
                      readers={readersList}
                      ownedVols={ownedVols}
                      details={detailedReaderStats}
                      visibleSeries={visibleReaderSeries}
                      onShowMore={() => setVisibleReaderSeries(n => n + READER_SERIES_STEP)}
                      onBack={() => setDetailedReaderStats(null)}
                      readerError={readerError}
                      loadingDetails={loadingDetailedStats}
                      onLoadDetails={fetchReaderDetailedStats}
                      onNavigate={onClose}
                    />
                  )}
                </>
              );
            })()}
        </div>

        <div className="pt-4 mt-4 border-t border-slate-800 flex flex-wrap items-center justify-end gap-2 shrink-0">
          <div role="group" aria-label="Werkzeuge" className="flex flex-wrap gap-2 mr-auto">
            <button id="btn-open-trash" type="button" onClick={() => setTool('trash')} className="btn-secondary text-xs px-3 py-2 flex items-center gap-1.5">
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> Papierkorb
            </button>
            <button id="btn-open-cleanup" type="button" onClick={() => setTool('cleanup')} className="btn-secondary text-xs px-3 py-2 flex items-center gap-1.5">
              <BrushCleaning className="w-3.5 h-3.5" aria-hidden="true" /> Sammlung aufräumen
            </button>
            {user?.role === 'admin' && (
              <button id="btn-open-publishers" type="button" onClick={() => setTool('publishers')} className="btn-secondary text-xs px-3 py-2 flex items-center gap-1.5">
                <GitMerge className="w-3.5 h-3.5" aria-hidden="true" /> Verlage zusammenführen
              </button>
            )}
          </div>
          <button 
            id="btn-close-stats-modal"
            type="button" 
            onClick={onClose} 
            className="btn-secondary text-xs px-4 py-2"
          >
            Schließen
          </button>
        </div>

      </div>
    </div>
    <Suspense fallback={null}>
    {tool === 'trash' && <TrashModal onClose={closeTool} user={user} onChanged={toolChangedData} />}
    {tool === 'cleanup' && (
      <CleanupModal
        onClose={closeTool}
        user={user}
        onChanged={toolChangedData}
        onNavigate={navigateAway}
        onOpenPublishers={user?.role === 'admin' ? () => setTool('publishers') : undefined}
      />
    )}
    {tool === 'publishers' && <PublishersModal onClose={closeTool} user={user} onChanged={toolChangedData} />}
    </Suspense>
    </>
  );
}
