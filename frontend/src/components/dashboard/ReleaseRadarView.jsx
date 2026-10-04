import { useState, useEffect } from 'react';
import { WifiOff, Info, X } from 'lucide-react';
import RadarTabs, { RADAR_PANEL_ID, radarTabId } from './radar/RadarTabs';
import MpMonthNav from './radar/MpMonthNav';
import MpFilters from './radar/MpFilters';
import MpTimeline from './radar/MpTimeline';
import PersonalSummary from './radar/PersonalSummary';
import PersonalDateChanges from './radar/PersonalDateChanges';
import PersonalFilters from './radar/PersonalFilters';
import PersonalTimeline from './radar/PersonalTimeline';
import useRadarDateChanges from './radar/useRadarDateChanges';
import { filterMpItems, groupMpItemsByDate, mpMatchesSelection, importNotice } from '../../utils/radarHelpers';

const NOTICE_MS = 8000;

export default function ReleaseRadarView({
  isOffline = false,
  radarSubView,
  setRadarSubView,
  radarData,
  loadingRadar,
  radarError,
  fetchReleaseRadar,
  radarPublisherFilter,
  setRadarPublisherFilter,
  radarStatusFilter,
  setRadarStatusFilter,
  radarSearch,
  setRadarSearch,
  mpData,
  loadingMp,
  mpError,
  fetchMangaPassionReleases,
  mpYear,
  setMpYear,
  mpMonth,
  setMpMonth,
  handlePrevMonth,
  handleNextMonth,
  handleCurrentMonth,
  mpPrintOnly,
  setMpPrintOnly,
  mpMySeriesOnly,
  setMpMySeriesOnly,
  mpPublisherFilter,
  setMpPublisherFilter,
  mpSearch,
  setMpSearch,
  canEdit,
  handleImportMangaPassion,
  importingMpIds,
  handleMarkDelivered,
  markingDeliveredIds,
  failedImages,
  setFailedImages,
  GERMAN_MONTHS
}) {
  const [notice, setNotice] = useState(null);
  const dateChanges = useRadarDateChanges({
    enabled: radarSubView === 'personal' && !isOffline,
    onApplied: fetchReleaseRadar
  });

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  if (isOffline) {
    return (
      <div className="glass-panel p-10 rounded-2xl border border-slate-800/80 text-center animate-fade-in">
        <div className="w-16 h-16 rounded-2xl bg-slate-800/60 border border-slate-700 flex items-center justify-center mx-auto mb-4 text-slate-400">
          <WifiOff className="w-8 h-8" />
        </div>
        <h2 className="text-base font-bold text-white mb-1">Release-Radar ist offline nicht verfügbar</h2>
        <p className="text-xs text-slate-400 max-w-md mx-auto leading-relaxed">
          Neuerscheinungen und Vorbestellungen werden geladen, sobald der Server wieder erreichbar ist.
        </p>
      </div>
    );
  }

  const mpCurrent = !loadingMp && mpMatchesSelection(mpData, mpYear, mpMonth);
  const mpDateGroups = groupMpItemsByDate(filterMpItems(mpData?.items || [], { mpPrintOnly, mpMySeriesOnly, mpPublisherFilter, mpSearch }));
  const mpFiltersActive = Boolean(mpSearch) || mpPublisherFilter !== 'ALL' || !mpPrintOnly || mpMySeriesOnly;
  const resetMpFilters = () => {
    setMpSearch('');
    setMpPublisherFilter('ALL');
    setMpPrintOnly(true);
    setMpMySeriesOnly(false);
  };
  const radarFiltersActive = Boolean(radarSearch) || radarPublisherFilter !== 'ALL' || radarStatusFilter !== 'ALL';
  const resetRadarFilters = () => {
    setRadarSearch('');
    setRadarPublisherFilter('ALL');
    setRadarStatusFilter('ALL');
  };

  const onImport = async (item, targetStatus) => {
    const result = await handleImportMangaPassion(item, targetStatus);
    if (!result) return;
    dateChanges.invalidate();
    setNotice(importNotice(item, result));
  };

  const onMarkDelivered = async (item) => {
    if (await handleMarkDelivered(item)) dateChanges.dropVolume(item.id);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <RadarTabs
        radarSubView={radarSubView}
        setRadarSubView={setRadarSubView}
        radarData={radarData}
        mpCount={mpCurrent ? (mpPrintOnly ? mpData.print_count : mpData.total_items) : null}
        mpYear={mpYear}
        mpMonth={mpMonth}
      />

      {radarSubView === 'passion' && (
        <div id={RADAR_PANEL_ID} role="tabpanel" aria-labelledby={radarTabId('passion')} className="space-y-6">
          <h2 className="sr-only">Deutsche Neuheiten</h2>
          <MpMonthNav
            mpData={mpData}
            mpCurrent={mpCurrent}
            loadingMp={loadingMp}
            fetchMangaPassionReleases={fetchMangaPassionReleases}
            mpYear={mpYear}
            setMpYear={setMpYear}
            mpMonth={mpMonth}
            setMpMonth={setMpMonth}
            handlePrevMonth={handlePrevMonth}
            handleNextMonth={handleNextMonth}
            handleCurrentMonth={handleCurrentMonth}
            mpPrintOnly={mpPrintOnly}
            GERMAN_MONTHS={GERMAN_MONTHS}
          />
          <MpFilters
            mpData={mpData}
            mpCurrent={mpCurrent}
            mpPrintOnly={mpPrintOnly}
            setMpPrintOnly={setMpPrintOnly}
            mpMySeriesOnly={mpMySeriesOnly}
            setMpMySeriesOnly={setMpMySeriesOnly}
            mpPublisherFilter={mpPublisherFilter}
            setMpPublisherFilter={setMpPublisherFilter}
            mpSearch={mpSearch}
            setMpSearch={setMpSearch}
            filtersActive={mpFiltersActive}
            onResetFilters={resetMpFilters}
          />
          {notice && (
            <div role="status" className="p-3 rounded-xl border border-sky-500/40 bg-sky-500/10 text-xs text-sky-200 flex items-start justify-between gap-2">
              <span className="flex items-center gap-2"><Info className="w-4 h-4 shrink-0" />{notice}</span>
              <button type="button" onClick={() => setNotice(null)} className="p-1 -m-1 rounded text-sky-300 hover:text-white" aria-label="Hinweis schließen">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          <MpTimeline
            mpData={mpData}
            loadingMp={loadingMp}
            mpError={mpError}
            onRetry={() => fetchMangaPassionReleases(mpYear, mpMonth)}
            mpYear={mpYear}
            mpMonth={mpMonth}
            canEdit={canEdit}
            onImport={onImport}
            importingMpIds={importingMpIds}
            failedImages={failedImages}
            setFailedImages={setFailedImages}
            GERMAN_MONTHS={GERMAN_MONTHS}
            mpDateGroups={mpDateGroups}
            filtersActive={mpFiltersActive}
            onResetFilters={resetMpFilters}
          />
        </div>
      )}

      {radarSubView === 'personal' && (
        <div id={RADAR_PANEL_ID} role="tabpanel" aria-labelledby={radarTabId('personal')} className="space-y-6">
          <PersonalSummary
            radarData={radarData}
            loadingRadar={loadingRadar}
            fetchReleaseRadar={fetchReleaseRadar}
          />
          <PersonalDateChanges
            changes={dateChanges.changes}
            canEdit={canEdit}
            onApply={dateChanges.apply}
            applyingIds={dateChanges.applyingIds}
          />
          <PersonalFilters
            radarData={radarData}
            radarPublisherFilter={radarPublisherFilter}
            setRadarPublisherFilter={setRadarPublisherFilter}
            radarStatusFilter={radarStatusFilter}
            setRadarStatusFilter={setRadarStatusFilter}
            radarSearch={radarSearch}
            setRadarSearch={setRadarSearch}
            filtersActive={radarFiltersActive}
            onResetFilters={resetRadarFilters}
          />
          <PersonalTimeline
            setRadarSubView={setRadarSubView}
            radarData={radarData}
            loadingRadar={loadingRadar}
            radarError={radarError}
            onRetry={fetchReleaseRadar}
            radarPublisherFilter={radarPublisherFilter}
            radarStatusFilter={radarStatusFilter}
            radarSearch={radarSearch}
            onResetFilters={resetRadarFilters}
            canEdit={canEdit}
            onMarkDelivered={onMarkDelivered}
            markingDeliveredIds={markingDeliveredIds}
            failedImages={failedImages}
            setFailedImages={setFailedImages}
          />
        </div>
      )}
    </div>
  );
}
