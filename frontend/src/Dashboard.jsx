import ShoppingListView from './components/dashboard/ShoppingListView';
import ReleaseRadarView from './components/dashboard/ReleaseRadarView';
import AnimeView from './components/dashboard/AnimeView';
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
import { RefreshCw } from 'lucide-react';
import { normalizePubName } from './utils/volumeHelpers';
import { buildScanPrefill, parseSharedScan } from './utils/scanHelpers';
import { lookupLocalIsbn } from './utils/offlineStore';
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
import useAnimeList from './hooks/useAnimeList';
import useDashboardKeyboard from './hooks/useDashboardKeyboard';
import { dialogEntryOnTop } from './hooks/useDialogA11y';
import usePullToRefresh, { useForegroundRefresh, PULL_THRESHOLD_PX } from './hooks/usePullToRefresh';
import { apiFetch, readJson, TIMEOUTS } from './utils/api';
import { notify } from './utils/notify';

// dialogs are loaded on first use and mounted only while open
const UserManagementModal = lazy(() => import('./components/modals/UserManagementModal'));
const AccountModal = lazy(() => import('./components/modals/AccountModal'));
const AddAnimeModal = lazy(() => import('./components/modals/AddAnimeModal'));
const AnimeDetailModal = lazy(() => import('./components/modals/AnimeDetailModal'));
const BackupRestoreModal = lazy(() => import('./components/modals/BackupRestoreModal'));
const StatsModal = lazy(() => import('./components/modals/StatsModal'));
const AddMangaModal = lazy(() => import('./components/modals/AddMangaModal'));
const CsvExchangeModal = lazy(() => import('./components/dashboard/CsvExchangeModal'));

const VIEW_TITLES = { shelf: 'Sammlung', shopping: 'Einkaufsliste', radar: 'Release-Radar', anime: 'Anime' };
const ANIME_VIEW = 'anime';

// older names of the dashboardShell helpers (animeTab.test.jsx imports them from here)
export const mainViewOf = (search) => parseInitialView(search).mainView;
export const searchForView = viewSearch;

/** ?add=<seriesId> next to ?view=anime: the series the add dialog links to. */
const addTargetOf = (search) => {
  try {
    const params = new URLSearchParams(search || '');
    const id = params.get('add');
    return params.get('view') === ANIME_VIEW && /^\d+$/.test(id || '') ? Number(id) : null;
  } catch (_) {
    return null;
  }
};
export const SHARED_NO_ISBN_MESSAGE = 'Im geteilten Text wurde keine ISBN gefunden.';
export const SHARED_MP_LINK_MESSAGE = 'Manga-Passion-Link erkannt: Lege die Reihe an und übernimm die Daten per Auto-Fill.';

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

  // Modal visibility states
  const [showStatsModal, setShowStatsModal] = useState(false);
  const [showUsersModal, setShowUsersModal] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [accountTab, setAccountTab] = useState('password');
  const [animeAdd, setAnimeAdd] = useState(null); // { mangaId } while the add dialog is open
  const [animeDetailId, setAnimeDetailId] = useState(null);
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [showCsvModal, setShowCsvModal] = useState(false);

  const { isInstallable, isInstalledApp, handleInstallClick } = usePwaInstall();

  // Points at the functions below once they exist; called when the browser comes back online
  const onOnlineRef = useRef(() => {});
  const {
    networkOffline, setNetworkOffline, isOfflineMode, offlineCopyAt, refreshingCopy, refreshError, handleRefreshOfflineCopy
  } = useOfflineStatus({ user, onOnlineRef });

  const { mangas, loading, refreshing, dataAt, error: mangasError, fetchMangas, handleDeleteManga } = useMangaList({ user, canEdit });

  // the shelf filters are mirrored into the query string (replacing the entry), next to ?view=
  const filterUrl = {
    search: location.search,
    replace: (nextSearch) => navigate({ search: nextSearch }, { replace: true, state: location.state })
  };
  const {
    search, setSearch, deferredSearch, statusFilter, setStatusFilter, publisherFilter, setPublisherFilter, sortBy, setSortBy,
    viewMode, setViewMode, availablePublishers, filterCounts, statusTabs, filtered, totalSeries, totalOwnedVolumes,
    totalCollectionValue, completedSeries, collectFilter, setCollectFilter, collectCounts, authorFilter, setAuthorFilter,
    groupBy, setGroupBy, groups
  } = useCollectionFilters(mangas, { loading: loading || refreshing, userId: user?.id, url: filterUrl });
  const handleAuthorClick = useCallback((name) => setAuthorFilter(String(name || '').trim()), [setAuthorFilter]);

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

  const anime = useAnimeList({ user });

  onOnlineRef.current = () => {
    syncPendingPurchases();
    fetchShoppingList();
    fetchMangas();
  };

  // the installed app comes back from the background: reload the shelf (the shopping list refreshes itself)
  useForegroundRefresh(() => { if (!isOfflineMode) fetchMangas(); });
  const { pullDistance, refreshing: pulling } = usePullToRefresh(async () => {
    await Promise.all([fetchMangas(), activeMainView === 'shopping' ? fetchShoppingList() : null, activeMainView === ANIME_VIEW ? anime.fetchAnime() : null]);
  }, { enabled: !isOfflineMode });

  useEffect(() => {
    fetchMangas();
    fetchShoppingList();
    if (!user?.offline) fetchReleaseRadar();
    if (activeMainView === ANIME_VIEW) {
      anime.fetchAnime();
      anime.fetchSources();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nur beim Mount und beim Offline-Wechsel
  }, [user?.offline]);

  // ?view=anime&add=<seriesId> (the "Anime-Adaption" button of a series) opens the add dialog linked to that series
  useEffect(() => {
    const target = addTargetOf(location.search);
    if (target === null) return;
    if (canEdit && !user?.offline) setAnimeAdd({ mangaId: target });
    navigate({ search: viewSearch(location.search, ANIME_VIEW) }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reagiert nur auf die URL
  }, [location.search]);

  // the start URL was read once; strip ?view=stats so a reload does not reopen the dialog
  useEffect(() => {
    if (!initialView.openStats) return;
    if (!isOfflineMode) setShowStatsModal(true);
    navigate({ search: viewSearch(location.search, 'shelf') }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nur beim Mount
  }, []);

  const loadViewData = (view) => {
    if (view === 'shopping') fetchShoppingList();
    if (view === ANIME_VIEW) {
      anime.fetchAnime();
      anime.fetchSources();
    }
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

  // right after a dialog closed its history entry is still current: the series replaces it
  const navigateFromDialog = (path) => navigate(path, dialogEntryOnTop() ? { replace: true } : undefined);

  const openSeries = (manga) => {
    setSearch(manga.title || '');
    navigateFromDialog(`/manga/${manga.id}`);
  };

  const handleBarcodeDetected = async (scannedCode) => {
    const requestId = ++scanRequestRef.current;
    const isLatest = () => requestId === scanRequestRef.current;
    // a volume of the offline copy opens its series at once, also offline and without asking the server
    const local = await lookupLocalIsbn(scannedCode);
    if (!isLatest()) return;
    if (local?.manga) {
      showScanToast(null);
      openSeries(local.manga);
      return;
    }
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

  // share target (manifest share_text / share_url): an ISBN is looked up like a scan, then the parameters are removed
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has('share_text') && !params.has('share_url')) return;
    const shared = parseSharedScan({ text: params.get('share_text') || '', url: params.get('share_url') || '' });
    params.delete('share_text');
    params.delete('share_url');
    const rest = params.toString();
    navigate({ search: rest ? `?${rest}` : '' }, { replace: true });
    // after the first paint: a toast stack mounted after the dashboard would miss a message sent during mount
    const timer = setTimeout(() => {
      if (shared?.isbn) handleBarcodeDetected(shared.isbn);
      else if (shared?.mpUrl && canEdit) {
        showScanToast('info', SHARED_MP_LINK_MESSAGE, { duration: 0, action: { label: 'Reihe anlegen', onClick: () => openAddWithPrefill(null) } });
      } else showScanToast('info', SHARED_NO_ISBN_MESSAGE, { duration: 8000 });
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nur beim Mount
  }, []);

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
    setAccountTab('password');
    setShowPasswordModal(true);
  };

  const openApiKeys = () => {
    setAccountTab('keys');
    setShowPasswordModal(true);
  };

  const animeEntry = (id) => anime.list.find((a) => a.id === id);
  const handleAnimePlusOne = useCallback((entry) => {
    anime.updateProgress(entry.id, { episodes_watched: (entry.my_progress?.episodes_watched || 0) + 1 });
  }, [anime.updateProgress]); // eslint-disable-line react-hooks/exhaustive-deps -- the action is stable
  const handleAnimeStatus = useCallback((entry, status) => {
    if (status) anime.updateProgress(entry.id, { status });
  }, [anime.updateProgress]); // eslint-disable-line react-hooks/exhaustive-deps -- the action is stable
  const handleOpenAnime = useCallback((entry) => setAnimeDetailId(entry.id), []);

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

      {(pullDistance > 0 || pulling) && (
        <div className="flex justify-center py-2" role="status" aria-live="polite">
          <RefreshCw
            className={`w-5 h-5 text-brand-400 ${pulling ? 'animate-spin' : ''}`}
            style={pulling ? undefined : { transform: `rotate(${pullDistance * 4}deg)`, opacity: Math.min(1, pullDistance / PULL_THRESHOLD_PX) }}
            aria-hidden="true"
          />
          {pulling && <span className="sr-only">Wird aktualisiert…</span>}
        </div>
      )}

      <main id={MAIN_ID} tabIndex={-1} className="focus:outline-none max-w-[1720px] 2xl:max-w-[1840px] mx-auto px-4 sm:px-6 lg:px-8 2xl:px-10">

        <MainViewSwitcher
          activeMainView={activeMainView}
          onSelectView={setView}
          mangaCount={mangas.length}
          animeCount={anime.list.length}
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
          collectFilter={collectFilter}
          setCollectFilter={setCollectFilter}
          collectCounts={collectCounts}
          authorFilter={authorFilter}
          setAuthorFilter={setAuthorFilter}
          groupBy={groupBy}
          setGroupBy={setGroupBy}
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
          groups={groups}
          groupBy={groupBy}
          collectFilter={collectFilter}
          setCollectFilter={setCollectFilter}
          authorFilter={authorFilter}
          setAuthorFilter={setAuthorFilter}
          onAuthorClick={handleAuthorClick}
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
      />
    )}

    {activeMainView === ANIME_VIEW && (
      <AnimeView
        list={anime.list}
        loaded={anime.loaded}
        loading={anime.loading}
        error={anime.error}
        fromCache={anime.fromCache}
        cacheAt={anime.cacheAt}
        sources={anime.sources}
        canEdit={canEdit}
        user={user}
        onAdd={() => setAnimeAdd({ mangaId: null })}
        onOpen={handleOpenAnime}
        onPlusOne={handleAnimePlusOne}
        onStatusChange={handleAnimeStatus}
        onRetry={anime.fetchAnime}
        onOpenAccount={user?.offline ? null : openApiKeys}
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
              if (scanPrefill && created?.id) navigateFromDialog(`/manga/${created.id}`);
            }}
            prefill={scanPrefill}
          />
        )}

        {showPasswordModal && <AccountModal isOpen onClose={() => setShowPasswordModal(false)} user={user} initialTab={accountTab} />}

        {animeAdd && (
          <AddAnimeModal
            isOpen
            onClose={() => setAnimeAdd(null)}
            search={anime.search}
            loadAdaptations={anime.adaptations}
            onAdd={anime.add}
            onOpenExisting={(id) => setAnimeDetailId(id)}
            mangas={mangas}
            initialMangaId={animeAdd.mangaId}
          />
        )}

        {animeDetailId !== null && (
          <AnimeDetailModal
            isOpen
            animeId={animeDetailId}
            fallback={animeEntry(animeDetailId)}
            onClose={() => setAnimeDetailId(null)}
            canEdit={canEdit && !user?.offline}
            mangas={mangas}
            fetchDetail={anime.fetchDetail}
            updateProgress={anime.updateProgress}
            removeFromMyList={anime.removeFromMyList}
            update={anime.update}
            refresh={anime.refresh}
            remove={anime.remove}
            onAdd={anime.add}
            onOpenAnime={(id) => setAnimeDetailId(id)}
          />
        )}

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
