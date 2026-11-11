import ShoppingListView from './components/dashboard/ShoppingListView';
import ReleaseRadarView from './components/dashboard/ReleaseRadarView';
import AnimeView from './components/dashboard/AnimeView';
import MangaCollectionGrid, { SHELF_SCROLL_KEY } from './components/dashboard/MangaCollectionGrid';
import CollectionToolbar from './components/dashboard/CollectionToolbar';
import DashboardHeader, { opensCollection } from './components/dashboard/DashboardHeader';
import MainViewSwitcher from './components/dashboard/MainViewSwitcher';
import { STATS_PATH, statsPath, statsTabFromPath } from './utils/statsRoute';
import CollectionStats from './components/dashboard/CollectionStats';
import ContinueReading from './components/dashboard/ContinueReading';
import TodoList from './components/dashboard/TodoList';
import AnimeSearchHits, { animeSearchHits, ANIME_SEARCH_MIN_CHARS } from './components/dashboard/AnimeSearchHits';
import DashboardFooter from './components/dashboard/DashboardFooter';
import ScanCandidatesDialog from './components/dashboard/ScanCandidatesDialog';
import { MAIN_ID, SkipLink, useDocumentTitle, usePageHeading } from './components/common/PageChrome';
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, lazy, Suspense } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { normalizePubName } from './utils/volumeHelpers';
import { buildScanPrefill } from './utils/scanHelpers';
import { getStatusBadge } from './utils/collectionHelpers';
import { monthNames } from './utils/format';
import { mpMatchesSelection } from './utils/radarHelpers';
import {
  parseInitialView, viewSearch
} from './components/dashboard/dashboardShell';
import usePwaInstall from './hooks/usePwaInstall';
import useOfflineStatus from './hooks/useOfflineStatus';
import useMangaList from './hooks/useMangaList';
import useCollectionFilters, { loadPublisherNames } from './hooks/useCollectionFilters';
import useShoppingList from './hooks/useShoppingList';
import useReleaseRadar from './hooks/useReleaseRadar';
import useAnimeList from './hooks/useAnimeList';
import useEpisodeAlerts from './hooks/useEpisodeAlerts';
import { tagCounts } from './utils/animeHub';
import useShareIntake from './hooks/useShareIntake';
import useDashboardKeyboard from './hooks/useDashboardKeyboard';
import useSearchScope, { ONLINE_MIN_CHARS } from './hooks/useSearchScope';
import { dialogEntryOnTop } from './hooks/useDialogA11y';
import usePullToRefresh, { useForegroundRefresh, PULL_THRESHOLD_PX } from './hooks/usePullToRefresh';
import { invalidateShelves } from './utils/shelfScope';
import { notify } from './utils/notify';
import useDashboardScan from './hooks/useDashboardScan';
import useAccountDialogRequests from './hooks/useAccountDialogRequests';
import useAccountDefaults from './hooks/useAccountDefaults';
import { t } from './i18n/index.js';

// dialogs are loaded on first use and mounted only while open
const UserManagementModal = lazy(() => import('./components/modals/UserManagementModal'));
import DashboardAnimeDialogs from './components/dashboard/DashboardAnimeDialogs';
import DashboardToolDialogs from './components/dashboard/DashboardToolDialogs';
const AccountModal = lazy(() => import('./components/modals/AccountModal'));
const BackupRestoreModal = lazy(() => import('./components/modals/BackupRestoreModal'));
const StatsPage = lazy(() => import('./components/modals/StatsPage'));
const AddMangaModal = lazy(() => import('./components/modals/AddMangaModal'));
const CsvExchangeModal = lazy(() => import('./components/dashboard/CsvExchangeModal'));
const AnimeRadarView = lazy(() => import('./components/dashboard/AnimeRadarView'));
const OnlineResults = lazy(() => import('./components/dashboard/OnlineResults'));
const ConfirmDialog = lazy(() => import('./components/modals/ConfirmDialog'));

// i18n
const VIEW_TITLES = { shelf: 'Sammlung', shopping: 'Einkaufsliste', radar: 'Release-Radar', anime: 'Anime', episodes: 'Anime-Radar' };
const ANIME_VIEW = 'anime';
const savedShelfScroll = () => {
  try { return Number(window.sessionStorage.getItem(SHELF_SCROLL_KEY)) || 0; } catch (_) { return 0; }
};

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
export { SHARED_NO_ISBN_MESSAGE, SHARED_MP_LINK_MESSAGE } from './hooks/useDashboardScan';

export default function Dashboard({ user, onLogout, onLocalReplaced }) {
  const isVisitor = !user || user.role === 'visitor' || user.role === 'guest';
  const canEdit = Boolean(user) && (user.role === 'admin' || user.role === 'editor');
  // Offline (server unreachable) the user is demoted to read-only, but queued shopping purchases still work
  const canQuickBuy = Boolean(user) && !['visitor', 'guest'].includes(user.realRole || user.role);

  const navigate = useNavigate();
  const [todoCount, setTodoCount] = useState(0);
  const location = useLocation();
  const searchInputRef = useRef(null);

  // 'shelf' | 'shopping' | 'radar' from ?view= (each change is a history entry, so Back returns to the previous view);
  // ?view=stats (app shortcut) leads to the statistics page; /statistik/<tab> shows it in place of the main views
  const [initialView] = useState(() => parseInitialView(location.search));
  const activeMainView = parseInitialView(location.search).mainView;
  const statsRoute = statsTabFromPath(location.pathname);
  useDocumentTitle(t(statsRoute ? 'Statistiken' : (VIEW_TITLES[activeMainView] || VIEW_TITLES.shelf)));
  const headingRef = usePageHeading();

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [scanPrefill, setScanPrefill] = useState(null); // ISBN scan without a matching series: opens the add dialog prefilled
  const [scanChoice, setScanChoice] = useState(null); // { candidates, book, isbn }: several series match a scan

  // Modal visibility states
  const [showUsersModal, setShowUsersModal] = useState(false);
  const { showPasswordModal, setShowPasswordModal, accountTab, handleOpenPasswordModal, openApiKeys } = useAccountDialogRequests({ location, navigate });
  const [animeAdd, setAnimeAdd] = useState(null); // { mangaId, query?, share? } while the add dialog is open
  const [animeDetailId, setAnimeDetailId] = useState(null);
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [showCsvModal, setShowCsvModal] = useState(false);
  const [activeToolModal, setActiveToolModal] = useState(null); // 'shelves' | 'trash' | 'cleanup' | 'publishers' | null

  const { isInstallable, isInstalledApp, handleInstallClick } = usePwaInstall();

  // Points at the functions below once they exist; called when the browser comes back online
  const onOnlineRef = useRef(() => {});
  const {
    networkOffline, setNetworkOffline, isOfflineMode, offlineCopyAt, refreshingCopy, refreshError, handleRefreshOfflineCopy
  } = useOfflineStatus({ user, onOnlineRef });
  // "Zu erledigen" can be switched off per account (Einstellungen, Allgemein); unknown counts as on
  const accountDefaults = useAccountDefaults({ enabled: !isOfflineMode && Boolean(user) });
  const showTodo = accountDefaults.showTodo !== false;

  // the badges of the other views follow a delete and a restore from the trash toast
  const afterDeleteRef = useRef(null);
  const onSeriesRestored = useCallback(() => afterDeleteRef.current?.(), []);
  const { mangas, loading, refreshing, dataAt, error: mangasError, fetchMangas, handleDeleteManga } = useMangaList({
    user, canEdit, onRestored: onSeriesRestored
  });

  // the shelf filters are mirrored into the query string (replacing the entry), next to ?view=
  const filterUrl = {
    search: location.search,
    replace: (nextSearch) => navigate({ search: nextSearch }, { replace: true, state: location.state })
  };
  const {
    search, setSearch, deferredSearch, statusFilter, setStatusFilter, publisherFilter, setPublisherFilter, sortBy, setSortBy,
    viewMode, setViewMode, availablePublishers, filterCounts, statusTabs, filtered, totalSeries, totalOwnedVolumes,
    totalCollectionValue, completedSeries, collectFilter, setCollectFilter, collectCounts, authorFilter, setAuthorFilter,
    groupBy, setGroupBy, groups, availableTags, tagFilter, setTagFilter, availableLanguages, languageFilter, setLanguageFilter, shelfFilter, setShelfFilter, availableShelves, personFilter, setPersonFilter, availablePersons,
    shelves, otherCurrencyTotals
  } = useCollectionFilters(mangas, {
    loading: loading || refreshing, userId: user?.id, url: filterUrl, shelvesEnabled: !isOfflineMode, loadShelfRoles: canEdit && !isOfflineMode
  });
  const handleAuthorClick = useCallback((name) => setAuthorFilter(String(name || '').trim()), [setAuthorFilter]);
  // shelves where the user is a viewer: their series cards offer no delete
  const readOnlyShelves = useMemo(() => new Set((shelves || []).filter((s) => s.role === 'viewer').map((s) => s.id)), [shelves]);
  // their series: a scanned volume of one is not bookable in the shop basket
  const readOnlySeries = useMemo(() => new Set(readOnlyShelves.size ? (mangas || []).filter((m) => readOnlyShelves.has(m.shelf_id)).map((m) => m.id) : []), [mangas, readOnlyShelves]);
  // the chosen shelf narrows statistics, trash, shopping list and radar too; those screens name it and can clear it
  const scopedShelfId = shelfFilter !== 'ALL' ? shelfFilter : null;
  const scopedShelfName = scopedShelfId
    ? (availableShelves.find((s) => String(s.id) === scopedShelfId)?.name || (shelves || []).find((s) => String(s.id) === scopedShelfId)?.name || `#${scopedShelfId}`)
    : null;
  const clearShelfScope = useCallback(() => setShelfFilter('ALL'), [setShelfFilter]);
  const onShelfMissing = useCallback(() => {
    invalidateShelves();
    setShelfFilter('ALL');
  }, [setShelfFilter]);

  const lookupAvailable = Boolean(user) && !user.offline && !isOfflineMode;
  // the statistics page needs the server: offline, /statistik shows the shelf
  const statsTab = isOfflineMode ? null : statsRoute;
  const shownView = statsTab ? null : activeMainView;
  const leaveStats = useCallback(() => {
    // back where the page was opened from; a page opened from outside (a link, the app shortcut) leads to the shelf
    if ((window.history.state?.idx ?? 0) > 0) navigate(-1);
    else navigate('/', { replace: true });
  }, [navigate]);
  useEffect(() => {
    if (statsRoute && isOfflineMode) navigate('/', { replace: true });
  }, [statsRoute, isOfflineMode, navigate]);
  const statsShown = Boolean(statsTab);
  useEffect(() => {
    if (!statsShown) return;
    try { window.scrollTo(0, 0); } catch (_) { /* jsdom */ }
  }, [statsShown]);
  const searchScope = useSearchScope({ enabled: lookupAvailable });
  const { onlineQuery, onlineSeq, pending: onlinePending, submitOnline, clearOnline } = searchScope;
  const searchCleared = search.trim() === '';
  useEffect(() => {
    if (searchCleared) clearOnline();
  }, [searchCleared, clearOnline]);

  const {
    shoppingData, loadingShopping, shoppingPublisherFilter, setShoppingPublisherFilter,
    shoppingSearch, setShoppingSearch, buyingIds, shoppingError, offlineLastUpdated, cacheWriteFailed, pendingPurchases, failedPurchases,
    fetchShoppingList, handleQuickBuy, handleAddBought, syncPendingPurchases
  } = useShoppingList({ user, setNetworkOffline, fetchMangas, shelfFilter, onShelfMissing });

  const {
    radarData, loadingRadar, radarError, radarPublisherFilter, setRadarPublisherFilter, radarStatusFilter, setRadarStatusFilter,
    radarSearch, setRadarSearch, markingDeliveredIds, radarSubView, setRadarSubView,
    mpYear, setMpYear, mpMonth, setMpMonth, mpData, loadingMp, mpError, mpSearch, setMpSearch,
    mpPublisherFilter, setMpPublisherFilter, mpPrintOnly, setMpPrintOnly, mpMySeriesOnly, setMpMySeriesOnly, importingMpIds,
    fetchReleaseRadar, handleMarkDelivered, fetchMangaPassionReleases,
    handlePrevMonth, handleNextMonth, handleCurrentMonth, handleImportMangaPassion
  } = useReleaseRadar({ canEdit, activeMainView, fetchMangas, fetchShoppingList, offline: Boolean(user?.offline), shelfFilter, onShelfMissing });

  // the tab badges count the chosen shelf too, so both lists follow a changed shelf
  const shelfSeen = useRef(shelfFilter);
  useEffect(() => {
    if (shelfSeen.current === shelfFilter) return;
    shelfSeen.current = shelfFilter;
    fetchShoppingList();
    if (!user?.offline) fetchReleaseRadar();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to a changed shelf
  }, [shelfFilter]);

  const anime = useAnimeList({ user });
  const episodeAlerts = useEpisodeAlerts(anime.list);
  const animeTagNames = useMemo(() => tagCounts(anime.list).map((x) => x.name), [anime.list]);
  const activeViewRef = useRef(activeMainView);
  activeViewRef.current = activeMainView;
  const setViewRef = useRef(null);
  const showAnimeView = useCallback(() => {
    if (activeViewRef.current !== ANIME_VIEW) setViewRef.current?.(ANIME_VIEW);
  }, []);
  const shareDialogRef = useRef(null);
  const openShareAdd = useCallback((query) => setAnimeAdd({ mangaId: null, query, share: true }), []);
  const share = useShareIntake({ anime, user, canEdit, showAnime: showAnimeView, openAddAnime: openShareAdd });
  const matchSearch = useRef(null);
  const settleMatchSearch = useCallback((answer) => {
    const resolve = matchSearch.current;
    matchSearch.current = null;
    resolve?.(answer);
  }, []);
  const searchAnimeForMatch = useCallback((query) => new Promise((resolve) => {
    settleMatchSearch(null);
    matchSearch.current = resolve;
    setAnimeAdd({ mangaId: null, query });
  }), [settleMatchSearch]);

  onOnlineRef.current = () => {
    syncPendingPurchases();
    fetchShoppingList();
    fetchMangas();
  };

  // the installed app comes back from the background: reload the shelf (the shopping list refreshes itself)
  useForegroundRefresh(() => { if (!isOfflineMode) fetchMangas(); });
  const { pullDistance, refreshing: pulling } = usePullToRefresh(async () => {
    await Promise.all([fetchMangas(), activeMainView === 'shopping' ? fetchShoppingList() : null, (activeMainView === ANIME_VIEW || activeMainView === 'episodes') ? anime.fetchAnime() : null]);
  }, { enabled: !isOfflineMode });

  useEffect(() => {
    fetchMangas();
    fetchShoppingList();
    if (!user?.offline) fetchReleaseRadar();
    if (activeMainView === ANIME_VIEW) {
      anime.fetchAnime();
      anime.fetchSources();
      anime.syncList();
    }
    if (activeMainView === 'episodes') {
      anime.fetchAnime();
      anime.syncList();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount and on an offline change
  }, [user?.offline]);

  // ?view=anime&add=<seriesId> (the "Anime-Adaption" button of a series) opens the add dialog linked to that series
  useEffect(() => {
    const target = addTargetOf(location.search);
    if (target === null) return;
    if (canEdit && !user?.offline) setAnimeAdd({ mangaId: target });
    navigate({ search: viewSearch(location.search, ANIME_VIEW) }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts only to the URL
  }, [location.search]);

  // the start URL was read once; ?view=stats becomes the statistics page
  useEffect(() => {
    if (!initialView.openStats) return;
    navigate({ pathname: isOfflineMode ? '/' : STATS_PATH, search: viewSearch(location.search, 'shelf') }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount
  }, []);

  const loadViewData = (view) => {
    if (view === 'shopping') fetchShoppingList();
    if (view === ANIME_VIEW) {
      anime.fetchAnime();
      anime.fetchSources();
      anime.syncList();
    }
    if (view === 'episodes') {
      anime.fetchAnime();
      anime.syncList();
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

  // a view chosen in the app opens at its top, not at the old view's scroll offset (under the sticky header); the shelf
  // restores its own saved position
  const scrollResetRef = useRef(null);
  useLayoutEffect(() => {
    if (scrollResetRef.current !== activeMainView) return;
    scrollResetRef.current = null;
    if (activeMainView === 'shelf' && savedShelfScroll() > 0) return;
    if (window.scrollY > 0) window.scrollTo(0, 0);
  }, [activeMainView]);

  /** The one way to change the main view: a ?view= history entry; choosing the open view again reloads its data. */
  const setView = (next) => {
    const nextSearch = viewSearch(location.search, next);
    if (statsRoute) {
      // a view chosen on the statistics page leaves it
      navigate({ pathname: '/', search: nextSearch });
      return;
    }
    if (nextSearch === location.search) {
      loadViewData(next);
      return;
    }
    if (next !== activeMainView) scrollResetRef.current = next;
    navigate({ search: nextSearch });
  };
  setViewRef.current = setView;

  const closeAddModal = useCallback(() => {
    setShowAddModal(false);
    setScanPrefill(null);
  }, []);

  useDashboardKeyboard({
    showAddModal, setShowAddModal, closeAddModal, showUsersModal, setShowUsersModal,
    showRestoreModal, setShowRestoreModal, showPasswordModal, setShowPasswordModal,
    activeToolModal, closeToolModal: () => setActiveToolModal(null),
    mobileMenuOpen, setMobileMenuOpen, search, setSearch, searchInputRef
  });

  const openAddWithPrefill = (prefill) => {
    if (!canEdit) return;
    setScanPrefill(prefill);
    setShowAddModal(true);
  };
  const openAddRef = useRef(openAddWithPrefill);
  openAddRef.current = openAddWithPrefill;
  const openPrefilled = useCallback((prefill) => openAddRef.current(prefill), []);
  const onlineFocusRef = useRef(false);

  const shelfQuery = deferredSearch.trim();
  // the header search also names matching entries of the anime list; the list loads once for it (cached copy first)
  const animeHits = useMemo(() => (activeMainView === 'shelf' ? animeSearchHits(anime.list, shelfQuery) : []), [activeMainView, anime.list, shelfQuery]);
  const animeLoadAsked = useRef(false);
  useEffect(() => {
    if (activeMainView !== 'shelf' || shelfQuery.length < ANIME_SEARCH_MIN_CHARS || !user || isOfflineMode) return;
    if (anime.loaded || anime.loading || animeLoadAsked.current) return;
    animeLoadAsked.current = true;
    anime.fetchAnime();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchAnime is stable; one load per page
  }, [activeMainView, shelfQuery, user, isOfflineMode, anime.loaded, anime.loading]);
  const showOnline = lookupAvailable && (onlineQuery !== '' || (onlinePending && searchScope.scope === 'online'));
  const searchExtras = useMemo(() => {
    if (!shelfQuery) return null;
    return {
      query: shelfQuery,
      renderSection: showOnline ? (embedded) => (
        <Suspense fallback={null}>
          <OnlineResults query={onlineQuery} seq={onlineSeq} mangas={mangas} canEdit={canEdit} onAdd={openPrefilled} embedded={embedded} focusRequest={onlineFocusRef} pending={onlinePending} typed={shelfQuery} />
        </Suspense>
      ) : null,
      onSearchOnline: lookupAvailable && !showOnline && !onlinePending && shelfQuery.length >= ONLINE_MIN_CHARS ? () => {
        onlineFocusRef.current = true;
        submitOnline(shelfQuery);
      } : null,
      onCreateSeries: canEdit ? () => openPrefilled({ form: { title: shelfQuery }, volume: null }) : null
    };
  }, [shelfQuery, showOnline, onlineQuery, onlineSeq, mangas, canEdit, openPrefilled, lookupAvailable, onlinePending, submitOnline]);

  // right after a dialog closed its history entry is still current: the series replaces it
  const navigateFromDialog = (path) => navigate(path, dialogEntryOnTop() ? { replace: true } : undefined);

  const openSeries = (manga) => {
    setSearch(manga.title || '');
    navigateFromDialog(`/manga/${manga.id}`);
  };

  const handleBarcodeDetected = useDashboardScan({ isOfflineMode, canEdit, openSeries, openAddWithPrefill, setScanChoice, share, location, navigate });

  const handleOpenStats = useCallback(() => {
    if (isOfflineMode) return;
    navigate(STATS_PATH);
  }, [isOfflineMode, navigate]);

  const handleOpenModal = useCallback(() => {
    if (!canEdit) return;
    setScanPrefill(null);
    setShowAddModal(true);
  }, [canEdit]);

  const [deleteTarget, setDeleteTarget] = useState(null);

  // stable for the memoised grid
  afterDeleteRef.current = () => {
    fetchShoppingList();
    if (!user?.offline) fetchReleaseRadar();
  };
  const onDeleteManga = useCallback((e, id, title) => {
    e?.stopPropagation?.();
    e?.preventDefault?.();
    setDeleteTarget({ id, title });
  }, []);


  // a restore from the header's local backup dialog: App reloads the profile, the shelf reloads its data
  const handleLocalReplaced = async () => {
    const outcome = await onLocalReplaced?.();
    if (opensCollection(outcome)) {
      loadPublisherNames({ force: true });
      fetchMangas();
      fetchShoppingList();
      fetchReleaseRadar();
    }
    return outcome;
  };

  const animeEntry = (id) => anime.list.find((a) => a.id === id);
  const handleAnimePlusOne = useCallback((entry) => {
    anime.updateProgress(entry.id, { episodes_watched: (entry.my_progress?.episodes_watched || 0) + 1 });
  }, [anime.updateProgress]); // eslint-disable-line react-hooks/exhaustive-deps -- the action is stable
  const handleAnimeStatus = useCallback((entry, status) => {
    if (status) anime.updateProgress(entry.id, { status });
  }, [anime.updateProgress]); // eslint-disable-line react-hooks/exhaustive-deps -- the action is stable
  const handleAnimeLink = useCallback(async (id, mangaId) => {
    try { await anime.update(id, { manga_id: mangaId }); } catch (err) { notify.error(err); }
  }, [anime.update]); // eslint-disable-line react-hooks/exhaustive-deps -- the action is stable
  const handleOpenAnime = useCallback((entry) => setAnimeDetailId(entry.id), []);

  const handleOpenUsersModal = () => {
    setShowUsersModal(true);
  };

  const handleOpenTool = useCallback((tool) => {
    setActiveToolModal(tool);
  }, []);

  const handleOpenRestoreModal = () => {
    setShowRestoreModal(true);
  };

  const handleOpenCsvModal = () => {
    setShowCsvModal(true);
  };

  return (
    <div className="min-h-screen pb-16 overflow-x-clip">
      <SkipLink />
      <DashboardHeader
        activeMainView={statsTab ? 'stats' : activeMainView}
        canEdit={canEdit}
        handleBarcodeDetected={handleBarcodeDetected}
        handleInstallClick={handleInstallClick}
        handleOpenCsvModal={handleOpenCsvModal}
        handleOpenModal={handleOpenModal}
        handleOpenRestoreModal={handleOpenRestoreModal}
        handleOpenStats={handleOpenStats}
        handleOpenUsersModal={handleOpenUsersModal}
        handleOpenTool={handleOpenTool}
        headingRef={headingRef}
        handleOpenPasswordModal={handleOpenPasswordModal}
        isInstallable={isInstallable}
        isInstalledApp={isInstalledApp}
        isOfflineMode={isOfflineMode}
        isVisitor={isVisitor}
        mangas={mangas}
        todoCount={todoCount}
        onOpenSeries={(id) => navigate(`/manga/${id}`)}
        mobileMenuOpen={mobileMenuOpen}
        onLogout={onLogout}
        onLocalReplaced={handleLocalReplaced}
        radarData={radarData}
        search={search}
        searchInputRef={searchInputRef}
        searchScope={searchScope}
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
          {pulling && <span className="sr-only">{t('Wird aktualisiert…')}</span>}
        </div>
      )}

      <main id={MAIN_ID} tabIndex={-1} className="focus:outline-none max-w-[1720px] 2xl:max-w-[1840px] mx-auto px-4 sm:px-6 lg:px-8 2xl:px-10">

        {statsTab && (
          <Suspense fallback={<p role="status" className="py-16 text-center text-sm text-slate-400">{t('Lädt...')}</p>}>
            <StatsPage
              user={user}
              tab={statsTab}
              onTab={(tab) => navigate(statsPath(tab), { replace: true })}
              onBack={leaveStats}
              onDataChanged={() => {
                loadPublisherNames({ force: true });
                fetchMangas();
                fetchShoppingList();
                fetchReleaseRadar();
              }}
              shelfId={scopedShelfId}
              shelfName={scopedShelfName}
              shelves={availableShelves}
              setShelfFilter={setShelfFilter}
              onClearShelf={clearShelfScope}
              onShelfMissing={onShelfMissing}
            />
          </Suspense>
        )}

        {!statsTab && <MainViewSwitcher
          activeMainView={activeMainView}
          onSelectView={setView}
          mangaCount={mangas.length}
          animeCount={anime.list.length}
          shoppingData={shoppingData}
          radarData={radarData}
        />}

        {/* SHELF VIEW */}
        {shownView === 'shelf' && (
          <>
            <h2 className="sr-only">{t('Sammlung')}</h2>
            <CollectionStats
              totalSeries={totalSeries}
              totalOwnedVolumes={totalOwnedVolumes}
              totalCollectionValue={totalCollectionValue}
              otherCurrencyTotals={otherCurrencyTotals}
              completedSeries={completedSeries}
              handleOpenStats={handleOpenStats}
              isOfflineMode={isOfflineMode}
            />
            <ContinueReading userId={user?.id} enabled={!isOfflineMode} canMark={canEdit} onChanged={fetchMangas} />
            <TodoList enabled={showTodo && !isOfflineMode && Boolean(user)} shelfId={scopedShelfId} reloadKey={dataAt} onCount={setTodoCount} />

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
          availableTags={availableTags}
          tagFilter={tagFilter}
          setTagFilter={setTagFilter}
          availableLanguages={availableLanguages}
          languageFilter={languageFilter}
          setLanguageFilter={setLanguageFilter}
          availableShelves={availableShelves}
          shelfFilter={shelfFilter}
          setShelfFilter={setShelfFilter}
          availablePersons={availablePersons}
          personFilter={personFilter}
          setPersonFilter={setPersonFilter}
          userId={user?.id}
          saved={{
            userId: user?.id,
            offline: isOfflineMode,
            shelves: availableShelves,
            persons: availablePersons,
            current: { status: statusFilter, publisher: publisherFilter, collect: collectFilter, author: authorFilter, tags: tagFilter, lang: languageFilter, shelf: shelfFilter, person: personFilter, sort: sortBy, group: groupBy },
            filtersActive: statusFilter !== 'ALL' || publisherFilter !== 'ALL' || collectFilter !== 'ALL' || Boolean(authorFilter)
              || (Array.isArray(tagFilter) && tagFilter.length > 0) || languageFilter !== 'ALL' || shelfFilter !== 'ALL' || personFilter !== 'ALL',
            apply: (f) => {
              setStatusFilter(f.status);
              setPublisherFilter(f.publisher);
              setCollectFilter(f.collect);
              setAuthorFilter(f.author);
              setTagFilter(f.tags);
              setLanguageFilter(f.lang);
              setShelfFilter(f.shelf);
              setPersonFilter(f.person || 'ALL');
              setSortBy(f.sort);
              setGroupBy(f.group);
            }
          }}
        />
        <AnimeSearchHits hits={animeHits} onOpen={handleOpenAnime} onShowAll={() => setView(ANIME_VIEW)} />
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
          tagFilter={tagFilter}
          setTagFilter={setTagFilter}
          languageFilter={languageFilter}
          setLanguageFilter={setLanguageFilter}
          shelfFilter={shelfFilter}
          setShelfFilter={setShelfFilter}
          readOnlyShelves={readOnlyShelves}
          onAuthorClick={handleAuthorClick}
          searchExtras={searchExtras}
        />
      </>
    )}

    {/* SHOPPING LIST VIEW */}
    {shownView === 'shopping' && (
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
        handleAddBought={handleAddBought}
        buyingIds={buyingIds}
        shoppingError={shoppingError}
        user={user}
        fetchMangas={fetchMangas}
        pendingPurchases={pendingPurchases}
        failedPurchases={failedPurchases}
        cacheWriteFailed={cacheWriteFailed}
        shelfName={scopedShelfName}
        onClearShelf={clearShelfScope}
        readOnlySeries={readOnlySeries}
      />
    )}

    {shownView === ANIME_VIEW && (
      <AnimeView
        list={anime.list}
        loaded={anime.loaded}
        loading={anime.loading}
        error={anime.error}
        fromCache={anime.fromCache}
        cacheAt={anime.cacheAt}
        sources={anime.sources}
        listSync={anime.listSync}
        canEdit={canEdit}
        user={user}
        onAdd={() => setAnimeAdd({ mangaId: null })}
        onPasteLink={share.paste}
        onOpen={handleOpenAnime}
        onPlusOne={handleAnimePlusOne}
        onStatusChange={handleAnimeStatus}
        onRetry={anime.fetchAnime}
        onOpenAccount={user?.offline ? null : openApiKeys}
        onRefresh={anime.refreshList}
        watchLast={anime.watchLast}
        onSearchAnime={searchAnimeForMatch}
      />
    )}

    {shownView === 'episodes' && (
      <Suspense fallback={null}>
        <AnimeRadarView
          list={anime.list}
          mangas={mangas}
          loaded={anime.loaded}
          error={anime.error}
          canEdit={canEdit && !user?.offline}
          userId={user?.id}
          username={user?.username}
          onOpen={handleOpenAnime}
          onOpenId={setAnimeDetailId}
          onAddEntry={anime.add}
          alerts={episodeAlerts}
          onLink={handleAnimeLink}
          onRefreshCover={anime.refresh}
          onRetry={anime.fetchAnime}
        />
      </Suspense>
    )}

    {/* RELEASE RADAR / ERSCHEINUNGSKALENDER VIEW */}
    {shownView === 'radar' && (
      <ReleaseRadarView
        isOffline={Boolean(user?.offline)}
        foreignEditions={availableLanguages.some((l) => l.code !== 'de')}
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
        GERMAN_MONTHS={monthNames('long')}
        shelfName={scopedShelfName}
        onClearShelf={clearShelfScope}
        shelves={availableShelves}
        shelfFilter={shelfFilter}
        setShelfFilter={setShelfFilter}
        userId={user?.id}
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
              // a scan and a copy from another shelf lead to the new series
              if ((scanPrefill || created?.copied) && created?.id) navigateFromDialog(`/manga/${created.id}`);
            }}
            prefill={scanPrefill}
            mangas={mangas}
            onOpenExisting={(manga) => navigateFromDialog(`/manga/${manga.id}`)}
          />
        )}

        {showPasswordModal && <AccountModal isOpen onClose={() => setShowPasswordModal(false)} user={user} initialTab={accountTab} />}

        <DashboardAnimeDialogs
          anime={anime}
          share={share}
          shareDialogRef={shareDialogRef}
          canEdit={canEdit}
          user={user}
          mangas={mangas}
          animeAdd={animeAdd}
          setAnimeAdd={setAnimeAdd}
          matchSearch={matchSearch}
          settleMatchSearch={settleMatchSearch}
          animeDetailId={animeDetailId}
          setAnimeDetailId={setAnimeDetailId}
          animeEntry={animeEntry}
          animeTagNames={animeTagNames}
        />

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

        {deleteTarget && (
          <ConfirmDialog
            isOpen
            title={t('Manga löschen')}
            message={t('Möchtest du "{title}" wirklich löschen? Die Reihe kommt mit allen Bänden in den Papierkorb (30 Tage wiederherstellbar).', { title: deleteTarget.title })}
            confirmLabel={t('Löschen')}
            cancelLabel={t('Abbrechen')}
            isDanger={true}
            onConfirm={async () => {
              const target = deleteTarget;
              setDeleteTarget(null);
              if (target && (await handleDeleteManga(null, target.id, target.title, true))) {
                afterDeleteRef.current();
              }
            }}
            onCancel={() => setDeleteTarget(null)}
          />
        )}

        <DashboardToolDialogs
          tool={activeToolModal}
          setTool={setActiveToolModal}
          user={user}
          onDataChanged={() => {
            loadPublisherNames({ force: true });
            fetchMangas();
            fetchShoppingList();
            fetchReleaseRadar();
          }}
          shelfId={scopedShelfId}
          shelfName={scopedShelfName}
          onClearShelf={clearShelfScope}
          onShelfMissing={onShelfMissing}
        />
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
