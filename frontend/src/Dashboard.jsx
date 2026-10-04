import ShoppingListView from './components/dashboard/ShoppingListView';
import ReleaseRadarView from './components/dashboard/ReleaseRadarView';
import MangaCollectionGrid from './components/dashboard/MangaCollectionGrid';
import CollectionToolbar from './components/dashboard/CollectionToolbar';
import DashboardHeader from './components/dashboard/DashboardHeader';
import MainViewSwitcher from './components/dashboard/MainViewSwitcher';
import CollectionStats from './components/dashboard/CollectionStats';
import DashboardFooter from './components/dashboard/DashboardFooter';
import ScanCandidatesDialog from './components/dashboard/ScanCandidatesDialog';
import { MAIN_ID, SkipLink, useDocumentTitle, usePageHeading } from './components/common/PageChrome';
import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { normalizePubName } from './utils/volumeHelpers';
import { buildScanPrefill } from './utils/scanHelpers';
import { GERMAN_MONTHS, getStatusBadge } from './utils/collectionHelpers';
import { mpMatchesSelection } from './utils/radarHelpers';
import {
  parseInitialView, viewSearch, scanDashboardAction, SCAN_OFFLINE_MESSAGE, SCAN_FAILED_MESSAGE
} from './components/dashboard/dashboardShell';
import usePwaInstall from './hooks/usePwaInstall';
import useOfflineStatus from './hooks/useOfflineStatus';
import useMangaList from './hooks/useMangaList';
import useCollectionFilters from './hooks/useCollectionFilters';
import useShoppingList from './hooks/useShoppingList';
import useReleaseRadar from './hooks/useReleaseRadar';
import useDashboardKeyboard from './hooks/useDashboardKeyboard';
import { apiFetch, readJson, TIMEOUTS } from './utils/api';
import { notify } from './utils/notify';

// dialogs are loaded on first use and mounted only while open
const UserManagementModal = lazy(() => import('./components/modals/UserManagementModal'));
const ChangePasswordModal = lazy(() => import('./components/modals/ChangePasswordModal'));
const BackupRestoreModal = lazy(() => import('./components/modals/BackupRestoreModal'));
const StatsModal = lazy(() => import('./components/modals/StatsModal'));
const AddMangaModal = lazy(() => import('./components/modals/AddMangaModal'));
const CsvExchangeModal = lazy(() => import('./components/dashboard/CsvExchangeModal'));

const VIEW_TITLES = { shelf: 'Sammlung', shopping: 'Einkaufsliste', radar: 'Release-Radar' };

export default function Dashboard({ user, onLogout }) {
  const isVisitor = !user || user.role === 'visitor' || user.role === 'guest';
  const canEdit = Boolean(user) && (user.role === 'admin' || user.role === 'editor');
  // Offline (server unreachable) the user is demoted to read-only, but queued shopping purchases still work
  const canQuickBuy = Boolean(user) && !['visitor', 'guest'].includes(user.realRole || user.role);

  const navigate = useNavigate();
  const location = useLocation();
  const searchInputRef = useRef(null);

  // 'shelf' | 'shopping' | 'radar' from ?view= (each change is a history entry, so Back returns to the previous view);
  // ?view=stats (app shortcut) opens the statistics over the shelf
  const [initialView] = useState(() => parseInitialView(location.search));
  const activeMainView = parseInitialView(location.search).mainView;
  useDocumentTitle(VIEW_TITLES[activeMainView] || VIEW_TITLES.shelf);
  const headingRef = usePageHeading();

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [scanPrefill, setScanPrefill] = useState(null); // ISBN scan without a matching series: opens the add dialog prefilled
  const [scanChoice, setScanChoice] = useState(null); // { candidates, book, isbn }: several series match a scan
  const scanRequestRef = useRef(0);
  const scanToastRef = useRef(null);
  const [failedImages, setFailedImages] = useState({}); // shopping list and radar covers

  // Modal visibility states
  const [showStatsModal, setShowStatsModal] = useState(false);
  const [showUsersModal, setShowUsersModal] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [showCsvModal, setShowCsvModal] = useState(false);

  const { isInstallable, isInstalledApp, handleInstallClick } = usePwaInstall();

  // Points at the functions below once they exist; called when the browser comes back online
  const onOnlineRef = useRef(() => {});
  const {
    networkOffline, setNetworkOffline, isOfflineMode, offlineCopyAt, refreshingCopy, refreshError, handleRefreshOfflineCopy
  } = useOfflineStatus({ user, onOnlineRef });

  const { mangas, loading, refreshing, dataAt, error: mangasError, fetchMangas, handleDeleteManga } = useMangaList({ user, canEdit });

  const {
    search, setSearch, deferredSearch, statusFilter, setStatusFilter, publisherFilter, setPublisherFilter, sortBy, setSortBy,
    viewMode, setViewMode, availablePublishers, filterCounts, statusTabs, filtered, totalSeries, totalOwnedVolumes,
    totalCollectionValue, completedSeries
  } = useCollectionFilters(mangas, { loading: loading || refreshing, userId: user?.id });

  const {
    shoppingData, loadingShopping, shoppingPublisherFilter, setShoppingPublisherFilter,
    shoppingSearch, setShoppingSearch, buyingIds, shoppingError, offlineLastUpdated, cacheWriteFailed, pendingPurchases, failedPurchases,
    fetchShoppingList, handleQuickBuy, syncPendingPurchases
  } = useShoppingList({ user, setNetworkOffline, fetchMangas });

  const {
    radarData, loadingRadar, radarError, radarPublisherFilter, setRadarPublisherFilter, radarStatusFilter, setRadarStatusFilter,
    radarSearch, setRadarSearch, markingDeliveredIds, radarSubView, setRadarSubView,
    mpYear, setMpYear, mpMonth, setMpMonth, mpData, loadingMp, mpError, mpSearch, setMpSearch,
    mpPublisherFilter, setMpPublisherFilter, mpPrintOnly, setMpPrintOnly, mpMySeriesOnly, setMpMySeriesOnly, importingMpIds,
    fetchReleaseRadar, handleMarkDelivered, fetchMangaPassionReleases,
    handlePrevMonth, handleNextMonth, handleCurrentMonth, handleImportMangaPassion
  } = useReleaseRadar({ canEdit, activeMainView, fetchMangas, fetchShoppingList, offline: Boolean(user?.offline) });

  onOnlineRef.current = () => {
    syncPendingPurchases();
    fetchShoppingList();
    fetchMangas();
  };

  useEffect(() => {
    fetchMangas();
    fetchShoppingList();
    if (!user?.offline) fetchReleaseRadar();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nur beim Mount und beim Offline-Wechsel
  }, [user?.offline]);

  // the start URL was read once; strip ?view=stats so a reload does not reopen the dialog
  useEffect(() => {
    if (!initialView.openStats) return;
    if (!isOfflineMode) setShowStatsModal(true);
    navigate({ search: viewSearch(location.search, 'shelf') }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nur beim Mount
  }, []);

  const loadViewData = (view) => {
    if (view === 'shopping') fetchShoppingList();
    if (view === 'radar') {
      fetchReleaseRadar();
      // an explicit entry retries a month whose last load failed; a loaded month is not fetched again
      if (!mpMatchesSelection(mpData, mpYear, mpMonth)) fetchMangaPassionReleases();
    }
  };
  const loadViewDataRef = useRef(loadViewData);
  loadViewDataRef.current = loadViewData;

  // entering a view (tab, header button, Back / Forward) refreshes its data
  const shownViewRef = useRef(activeMainView);
  useEffect(() => {
    if (shownViewRef.current === activeMainView) return;
    shownViewRef.current = activeMainView;
    loadViewDataRef.current(activeMainView);
  }, [activeMainView]);

  /** The one way to change the main view: a ?view= history entry; choosing the open view again reloads its data. */
  const setView = (next) => {
    const nextSearch = viewSearch(location.search, next);
    if (nextSearch !== location.search) navigate({ search: nextSearch });
    else loadViewData(next);
  };

  const closeAddModal = useCallback(() => {
    setShowAddModal(false);
    setScanPrefill(null);
  }, []);

  useDashboardKeyboard({
    showAddModal, setShowAddModal, closeAddModal, showStatsModal, setShowStatsModal, showUsersModal, setShowUsersModal,
    showRestoreModal, setShowRestoreModal, showPasswordModal, setShowPasswordModal,
    mobileMenuOpen, setMobileMenuOpen, search, setSearch, searchInputRef
  });

  /** One scan message at a time in the app's toast stack; a busy or action message stays until replaced or closed. */
  const showScanToast = (kind, message, options) => {
    if (scanToastRef.current !== null) notify.dismiss(scanToastRef.current);
    scanToastRef.current = kind ? notify[kind](message, options) : null;
  };
  useEffect(() => () => {
    if (scanToastRef.current !== null) notify.dismiss(scanToastRef.current);
  }, []);

  const openAddWithPrefill = (prefill) => {
    if (!canEdit) return;
    setScanPrefill(prefill);
    setShowAddModal(true);
  };

  const openSeries = (manga) => {
    setSearch(manga.title || '');
    navigate(`/manga/${manga.id}`);
  };

  const handleBarcodeDetected = async (scannedCode) => {
    const requestId = ++scanRequestRef.current;
    const isLatest = () => requestId === scanRequestRef.current;
    if (isOfflineMode) {
      showScanToast('error', SCAN_OFFLINE_MESSAGE);
      return;
    }
    showScanToast('info', `ISBN ${scannedCode} wird gesucht...`, { duration: 0 });
    let res;
    let data = null;
    try {
      res = await apiFetch(`/api/lookup/isbn?isbn=${encodeURIComponent(scannedCode)}`, { timeout: TIMEOUTS.lookup });
      data = await readJson(res); // a proxy 502/504 answers with HTML
    } catch (_) {
      if (isLatest()) showScanToast('error', SCAN_FAILED_MESSAGE);
      return;
    }
    if (!isLatest()) return;
    const isbn = data?.isbn || scannedCode;
    const action = scanDashboardAction({ ok: res.ok, data, canEdit });
    switch (action.type) {
      case 'navigate':
        showScanToast(null);
        openSeries(action.manga);
        break;
      case 'choose':
        showScanToast(null);
        setScanChoice({ candidates: action.candidates, book: action.book, isbn });
        break;
      case 'prefill':
        showScanToast(null);
        openAddWithPrefill(buildScanPrefill(action.book, isbn));
        break;
      case 'notFound':
        showScanToast('info', action.message, action.canAdd ? {
          duration: 0,
          action: { label: 'Reihe manuell anlegen', onClick: () => openAddWithPrefill(buildScanPrefill({}, isbn)) }
        } : { duration: 8000 });
        break;
      case 'notice':
        showScanToast('info', action.message, { duration: 8000 });
        break;
      default:
        showScanToast('error', action.message);
    }
  };

  const handleOpenStats = useCallback(() => {
    if (isOfflineMode) return;
    setShowStatsModal(true);
  }, [isOfflineMode]);

  const handleOpenModal = useCallback(() => {
    if (!canEdit) return;
    setScanPrefill(null);
    setShowAddModal(true);
  }, [canEdit]);

  // stable for the memoised grid; the badges of the other views follow a delete
  const afterDeleteRef = useRef(null);
  afterDeleteRef.current = () => {
    fetchShoppingList();
    if (!user?.offline) fetchReleaseRadar();
  };
  const onDeleteManga = useCallback(async (e, id, title) => {
    if (await handleDeleteManga(e, id, title)) afterDeleteRef.current();
  }, [handleDeleteManga]);

  const handleOpenPasswordModal = () => {
    setShowPasswordModal(true);
  };

  const handleOpenUsersModal = () => {
    setShowUsersModal(true);
  };

  const handleOpenRestoreModal = () => {
    setShowRestoreModal(true);
  };

  const handleOpenCsvModal = () => {
    setShowCsvModal(true);
  };

  return (
    <div className="min-h-screen pb-16 overflow-x-hidden">
      <SkipLink />
      <DashboardHeader
        activeMainView={activeMainView}
        canEdit={canEdit}
        handleBarcodeDetected={handleBarcodeDetected}
        handleInstallClick={handleInstallClick}
        handleOpenCsvModal={handleOpenCsvModal}
        handleOpenModal={handleOpenModal}
        handleOpenRestoreModal={handleOpenRestoreModal}
        handleOpenStats={handleOpenStats}
        handleOpenUsersModal={handleOpenUsersModal}
        headingRef={headingRef}
        handleOpenPasswordModal={handleOpenPasswordModal}
        isInstallable={isInstallable}
        isInstalledApp={isInstalledApp}
        isOfflineMode={isOfflineMode}
        isVisitor={isVisitor}
        mobileMenuOpen={mobileMenuOpen}
        onLogout={onLogout}
        radarData={radarData}
        search={search}
        searchInputRef={searchInputRef}
        setMobileMenuOpen={setMobileMenuOpen}
        setSearch={setSearch}
        setView={setView}
        shoppingData={shoppingData}
        user={user}
      />

      <main id={MAIN_ID} tabIndex={-1} className="focus:outline-none max-w-[1720px] 2xl:max-w-[1840px] mx-auto px-4 sm:px-6 lg:px-8 2xl:px-10">
        
        <MainViewSwitcher
          activeMainView={activeMainView}
          onSelectView={setView}
          mangaCount={mangas.length}
          shoppingData={shoppingData}
          radarData={radarData}
        />

        {/* SHELF VIEW */}
        {activeMainView === 'shelf' && (
          <>
            <h2 className="sr-only">Sammlung</h2>
            <CollectionStats
              totalSeries={totalSeries}
              totalOwnedVolumes={totalOwnedVolumes}
              totalCollectionValue={totalCollectionValue}
              completedSeries={completedSeries}
              handleOpenStats={handleOpenStats}
              isOfflineMode={isOfflineMode}
            />

        {/* Filter & Sort Toolbar */}
        <CollectionToolbar
          availablePublishers={availablePublishers}
          filterCounts={filterCounts}
          filtered={filtered}
          publisherFilter={publisherFilter}
          search={search}
          setPublisherFilter={setPublisherFilter}
          setSearch={setSearch}
          setSortBy={setSortBy}
          setStatusFilter={setStatusFilter}
          setViewMode={setViewMode}
          sortBy={sortBy}
          statusFilter={statusFilter}
          statusTabs={statusTabs}
          viewMode={viewMode}
        />
        {/* Grid or Empty State */}
        <MangaCollectionGrid
          canEdit={canEdit}
          error={mangasError}
          filtered={filtered}
          getStatusBadge={getStatusBadge}
          handleDeleteManga={onDeleteManga}
          handleOpenModal={handleOpenModal}
          isOffline={isOfflineMode}
          loading={loading}
          refreshing={refreshing}
          dataAt={dataAt}
          onRetry={fetchMangas}
          publisherFilter={publisherFilter}
          search={deferredSearch}
          setPublisherFilter={setPublisherFilter}
          setSearch={setSearch}
          setStatusFilter={setStatusFilter}
          sortBy={sortBy}
          statusFilter={statusFilter}
          viewMode={viewMode}
        />
      </>
    )}

    {/* SHOPPING LIST VIEW */}
    {activeMainView === 'shopping' && (
      <ShoppingListView
        shoppingData={shoppingData}
        loadingShopping={loadingShopping}
        fetchShoppingList={fetchShoppingList}
        isOfflineMode={isOfflineMode}
        offlineLastUpdated={offlineLastUpdated}
        syncPendingPurchases={syncPendingPurchases}
        shoppingSearch={shoppingSearch}
        setShoppingSearch={setShoppingSearch}
        shoppingPublisherFilter={shoppingPublisherFilter}
        setShoppingPublisherFilter={setShoppingPublisherFilter}
        normalizePubName={normalizePubName}
        setActiveMainView={setView}
        canEdit={canQuickBuy}
        handleQuickBuy={handleQuickBuy}
        buyingIds={buyingIds}
        shoppingError={shoppingError}
        user={user}
        fetchMangas={fetchMangas}
        pendingPurchases={pendingPurchases}
        failedPurchases={failedPurchases}
        cacheWriteFailed={cacheWriteFailed}
        failedImages={failedImages}
        setFailedImages={setFailedImages}
      />
    )}

    {/* RELEASE RADAR / ERSCHEINUNGSKALENDER VIEW */}
    {activeMainView === 'radar' && (
      <ReleaseRadarView
        isOffline={Boolean(user?.offline)}
        radarError={radarError}
        mpError={mpError}
        radarSubView={radarSubView}
        setRadarSubView={setRadarSubView}
        radarData={radarData}
        loadingRadar={loadingRadar}
        fetchReleaseRadar={fetchReleaseRadar}
        radarPublisherFilter={radarPublisherFilter}
        setRadarPublisherFilter={setRadarPublisherFilter}
        radarStatusFilter={radarStatusFilter}
        setRadarStatusFilter={setRadarStatusFilter}
        radarSearch={radarSearch}
        setRadarSearch={setRadarSearch}
        mpData={mpData}
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
        setMpPrintOnly={setMpPrintOnly}
        mpMySeriesOnly={mpMySeriesOnly}
        setMpMySeriesOnly={setMpMySeriesOnly}
        mpPublisherFilter={mpPublisherFilter}
        setMpPublisherFilter={setMpPublisherFilter}
        mpSearch={mpSearch}
        setMpSearch={setMpSearch}
        canEdit={canEdit}
        handleImportMangaPassion={handleImportMangaPassion}
        importingMpIds={importingMpIds}
        handleMarkDelivered={handleMarkDelivered}
        markingDeliveredIds={markingDeliveredIds}
        failedImages={failedImages}
        setFailedImages={setFailedImages}
        GERMAN_MONTHS={GERMAN_MONTHS}
      />
    )}
    </main>

      <DashboardFooter
        user={user}
        isOfflineMode={isOfflineMode}
        networkOffline={networkOffline}
        offlineCopyAt={offlineCopyAt}
        refreshingCopy={refreshingCopy}
        refreshError={refreshError}
        handleRefreshOfflineCopy={handleRefreshOfflineCopy}
        pendingPurchases={pendingPurchases}
        isInstallable={isInstallable}
        isInstalledApp={isInstalledApp}
        handleInstallClick={handleInstallClick}
      />

      {/* MODALS */}
      <Suspense fallback={null}>
        {showAddModal && (
          <AddMangaModal
            isOpen
            onClose={closeAddModal}
            onSeriesCreated={() => fetchMangas()}
            onSuccess={(created) => {
              fetchMangas();
              if (scanPrefill && created?.id) navigate(`/manga/${created.id}`);
            }}
            prefill={scanPrefill}
          />
        )}

        {showPasswordModal && <ChangePasswordModal isOpen onClose={() => setShowPasswordModal(false)} />}

        {showUsersModal && <UserManagementModal isOpen onClose={() => setShowUsersModal(false)} currentUser={user} />}

        {showRestoreModal && (
          <BackupRestoreModal
            isOpen
            onClose={() => setShowRestoreModal(false)}
            user={user}
            onRestoreSuccess={() => {
              fetchMangas();
              fetchShoppingList();
              fetchReleaseRadar();
            }}
          />
        )}

        {showStatsModal && <StatsModal isOpen onClose={() => setShowStatsModal(false)} user={user} />}

        {showCsvModal && (
          <CsvExchangeModal
            isOpen
            onClose={() => setShowCsvModal(false)}
            canEdit={canEdit}
            onImported={() => {
              fetchMangas();
              fetchShoppingList();
              if (!user?.offline) fetchReleaseRadar();
            }}
          />
        )}
      </Suspense>

      {scanChoice && (
        <ScanCandidatesDialog
          candidates={scanChoice.candidates}
          bookTitle={scanChoice.book?.title}
          canEdit={canEdit}
          onChoose={(manga) => {
            setScanChoice(null);
            openSeries(manga);
          }}
          onCreateNew={() => {
            const choice = scanChoice;
            setScanChoice(null);
            openAddWithPrefill(buildScanPrefill(choice?.book || {}, choice?.isbn));
          }}
          onClose={() => setScanChoice(null)}
        />
      )}

    </div>
  );
}
