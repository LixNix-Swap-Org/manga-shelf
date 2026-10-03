import RadarTabs from './radar/RadarTabs';
import MpMonthNav from './radar/MpMonthNav';
import MpFilters from './radar/MpFilters';
import MpTimeline from './radar/MpTimeline';
import PersonalSummary from './radar/PersonalSummary';
import PersonalFilters from './radar/PersonalFilters';
import PersonalTimeline from './radar/PersonalTimeline';
import { filterMpItems, groupMpItemsByDate } from '../../utils/radarHelpers';

export default function ReleaseRadarView({
  radarSubView,
  setRadarSubView,
  radarData,
  loadingRadar,
  fetchReleaseRadar,
  radarPublisherFilter,
  setRadarPublisherFilter,
  radarStatusFilter,
  setRadarStatusFilter,
  radarSearch,
  setRadarSearch,
  mpData,
  loadingMp,
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
  importingMpId,
  handleMarkDelivered,
  markingDeliveredId,
  failedImages,
  setFailedImages,
  setActiveMainView,
  GERMAN_MONTHS,
  formatGermanDate
}) {
  const mpDateGroups = groupMpItemsByDate(filterMpItems(mpData?.items || [], { mpPrintOnly, mpMySeriesOnly, mpPublisherFilter, mpSearch }));

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Sub-View Switcher: Manga Passion Kalender vs. Persönlicher Vorbestellungs-Radar */}
      <RadarTabs
        radarSubView={radarSubView}
        setRadarSubView={setRadarSubView}
        radarData={radarData}
        mpData={mpData}
        mpYear={mpYear}
        mpMonth={mpMonth}
        mpPrintOnly={mpPrintOnly}
      />

      {/* VIEW A: MANGA PASSION MONATSKALENDER */}
      {radarSubView === 'passion' && (
        <div className="space-y-6">
          <MpMonthNav
            mpData={mpData}
            loadingMp={loadingMp}
            fetchMangaPassionReleases={fetchMangaPassionReleases}
            mpYear={mpYear}
            setMpYear={setMpYear}
            mpMonth={mpMonth}
            setMpMonth={setMpMonth}
            handlePrevMonth={handlePrevMonth}
            handleNextMonth={handleNextMonth}
            mpPrintOnly={mpPrintOnly}
            GERMAN_MONTHS={GERMAN_MONTHS}
          />
          <MpFilters
            mpData={mpData}
            mpPrintOnly={mpPrintOnly}
            setMpPrintOnly={setMpPrintOnly}
            mpMySeriesOnly={mpMySeriesOnly}
            setMpMySeriesOnly={setMpMySeriesOnly}
            mpPublisherFilter={mpPublisherFilter}
            setMpPublisherFilter={setMpPublisherFilter}
            mpSearch={mpSearch}
            setMpSearch={setMpSearch}
          />
          <MpTimeline
            loadingMp={loadingMp}
            mpYear={mpYear}
            mpMonth={mpMonth}
            setMpPrintOnly={setMpPrintOnly}
            mpMySeriesOnly={mpMySeriesOnly}
            setMpMySeriesOnly={setMpMySeriesOnly}
            mpPublisherFilter={mpPublisherFilter}
            setMpPublisherFilter={setMpPublisherFilter}
            mpSearch={mpSearch}
            setMpSearch={setMpSearch}
            canEdit={canEdit}
            handleImportMangaPassion={handleImportMangaPassion}
            importingMpId={importingMpId}
            failedImages={failedImages}
            setFailedImages={setFailedImages}
            GERMAN_MONTHS={GERMAN_MONTHS}
            mpDateGroups={mpDateGroups}
          />
        </div>
      )}

      {/* VIEW B: PERSÖNLICHER VORBESTELLUNGS- & BUDGET-RADAR */}
      {radarSubView === 'personal' && (
        <div className="space-y-6">
          <PersonalSummary
            radarData={radarData}
            loadingRadar={loadingRadar}
            fetchReleaseRadar={fetchReleaseRadar}
          />
          <PersonalFilters
            radarData={radarData}
            radarPublisherFilter={radarPublisherFilter}
            setRadarPublisherFilter={setRadarPublisherFilter}
            radarStatusFilter={radarStatusFilter}
            setRadarStatusFilter={setRadarStatusFilter}
            radarSearch={radarSearch}
            setRadarSearch={setRadarSearch}
          />
          <PersonalTimeline
            setRadarSubView={setRadarSubView}
            radarData={radarData}
            radarPublisherFilter={radarPublisherFilter}
            radarStatusFilter={radarStatusFilter}
            radarSearch={radarSearch}
            canEdit={canEdit}
            handleMarkDelivered={handleMarkDelivered}
            markingDeliveredId={markingDeliveredId}
          />
        </div>
      )}
    </div>
  );
}
