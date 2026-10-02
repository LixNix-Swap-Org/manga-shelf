import ShoppingListView from './components/dashboard/ShoppingListView';
import ReleaseRadarView from './components/dashboard/ReleaseRadarView';
import MangaCollectionGrid from './components/dashboard/MangaCollectionGrid';
import CollectionToolbar from './components/dashboard/CollectionToolbar';
import DashboardHeader from './components/dashboard/DashboardHeader';
import MainViewSwitcher from './components/dashboard/MainViewSwitcher';
import CollectionStats from './components/dashboard/CollectionStats';
import DashboardFooter from './components/dashboard/DashboardFooter';
import UserManagementModal from './components/modals/UserManagementModal';
import BackupRestoreModal from './components/modals/BackupRestoreModal';
import StatsModal from './components/modals/StatsModal';
import AddMangaModal from './components/modals/AddMangaModal';
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { normalizePubName } from './utils/volumeHelpers';
import { GERMAN_MONTHS, formatGermanDate, getStatusBadge } from './utils/collectionHelpers';
import usePwaInstall from './hooks/usePwaInstall';
import useOfflineStatus from './hooks/useOfflineStatus';
import useMangaList from './hooks/useMangaList';
import useCollectionFilters from './hooks/useCollectionFilters';
import useShoppingList from './hooks/useShoppingList';
import useReleaseRadar from './hooks/useReleaseRadar';
import useDashboardKeyboard from './hooks/useDashboardKeyboard';

export default function Dashboard({ user, onLogout }) {
  const isVisitor = !user || user.role === 'visitor' || user.role === 'guest';
  const canEdit = user && (user.role === 'admin' || user.role === 'editor');
  // Offline (server unreachable) the user is demoted to read-only, but queued shopping purchases still work
  const canQuickBuy = Boolean(user) && !['visitor', 'guest'].includes(user.realRole || user.role);

  const navigate = useNavigate();
  const searchInputRef = useRef(null);

  // Main view switcher: 'shelf' | 'shopping' | 'radar' (initialized from URL if present)
  const [activeMainView, setActiveMainView] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const v = params.get('view');
      if (v === 'shopping' || v === 'radar') return v;
    } catch (_) {}
    return 'shelf';
  });

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [failedImages, setFailedImages] = useState({});

  // Modal visibility states
  const [showStatsModal, setShowStatsModal] = useState(false);
  const [showUsersModal, setShowUsersModal] = useState(false);
  const [showRestoreModal, setShowRestoreModal] = useState(false);

  const { isInstallable, isInstalledApp, handleInstallClick } = usePwaInstall();

  // Points at the functions below once they exist; called when the browser comes back online
  const onOnlineRef = useRef(() => {});
  const { networkOffline, setNetworkOffline, isOfflineMode, offlineCopyAt, refreshingCopy, handleRefreshOfflineCopy } =
    useOfflineStatus({ user, onOnlineRef });

  const { mangas, loading, fetchMangas, handleDeleteManga } = useMangaList({ user, canEdit });

  const {
    search, setSearch, statusFilter, setStatusFilter, publisherFilter, setPublisherFilter, sortBy, setSortBy, viewMode, setViewMode,
    availablePublishers, filterCounts, filtered, totalSeries, totalOwnedVolumes, totalCollectionValue, completedSeries
  } = useCollectionFilters(mangas);

  const {
    shoppingData, loadingShopping, shoppingPublisherFilter, setShoppingPublisherFilter,
    shoppingSearch, setShoppingSearch, buyingId, offlineLastUpdated,
    fetchShoppingList, handleQuickBuy, syncPendingPurchases
  } = useShoppingList({ setNetworkOffline, fetchMangas });

  const {
    radarData, loadingRadar, radarPublisherFilter, setRadarPublisherFilter, radarStatusFilter, setRadarStatusFilter,
    radarSearch, setRadarSearch, markingDeliveredId, radarSubView, setRadarSubView,
    mpYear, setMpYear, mpMonth, setMpMonth, mpData, loadingMp, mpSearch, setMpSearch,
    mpPublisherFilter, setMpPublisherFilter, mpPrintOnly, setMpPrintOnly, mpMySeriesOnly, setMpMySeriesOnly, importingMpId,
    fetchReleaseRadar, handleMarkDelivered, fetchMangaPassionReleases,
    handlePrevMonth, handleNextMonth, handleCurrentMonth, handleImportMangaPassion
  } = useReleaseRadar({ canEdit, activeMainView, fetchMangas, fetchShoppingList });

  onOnlineRef.current = () => {
    syncPendingPurchases();
    fetchShoppingList();
    fetchMangas();
  };

  useEffect(() => {
    fetchMangas();
    fetchShoppingList();
    if (!user?.offline) fetchReleaseRadar();
  }, [user?.offline]);

  useDashboardKeyboard({
    showAddModal, setShowAddModal, showStatsModal, setShowStatsModal, showUsersModal, setShowUsersModal,
    showRestoreModal, setShowRestoreModal, mobileMenuOpen, setMobileMenuOpen, search, setSearch, searchInputRef
  });

  const handleBarcodeDetected = async (scannedCode) => {
    setSearch(scannedCode);
    try {
      const res = await fetch(`/api/lookup/isbn?isbn=${encodeURIComponent(scannedCode)}`);
      const data = await res.json();
      if (data && data.found && data.matched_manga) {
        setSearch(data.matched_manga.title);
        navigate(`/manga/${data.matched_manga.id}`);
      } else if (data && data.found && data.book) {
        setSearch(data.book.title);
      }
    } catch (e) {
      console.warn('Barcode lookup failed:', e);
    }
  };

  const handleOpenStats = () => {
    setShowStatsModal(true);
  };

  const handleOpenModal = () => {
    if (!canEdit) return;
    setShowAddModal(true);
  };

  const handleOpenUsersModal = () => {
    setShowUsersModal(true);
  };

  const handleOpenRestoreModal = () => {
    setShowRestoreModal(true);
  };

  return (
    <div className="min-h-screen pb-16 overflow-x-hidden">
      {/* Top Navbar */}
      <DashboardHeader
        activeMainView={activeMainView}
        canEdit={canEdit}
        fetchReleaseRadar={fetchReleaseRadar}
        fetchShoppingList={fetchShoppingList}
        handleBarcodeDetected={handleBarcodeDetected}
        handleInstallClick={handleInstallClick}
        handleOpenModal={handleOpenModal}
        handleOpenRestoreModal={handleOpenRestoreModal}
        handleOpenStats={handleOpenStats}
        handleOpenUsersModal={handleOpenUsersModal}
        isInstallable={isInstallable}
        isInstalledApp={isInstalledApp}
        isOfflineMode={isOfflineMode}
        isVisitor={isVisitor}
        mobileMenuOpen={mobileMenuOpen}
        onLogout={onLogout}
        radarData={radarData}
        search={search}
        searchInputRef={searchInputRef}
        setActiveMainView={setActiveMainView}
        setMobileMenuOpen={setMobileMenuOpen}
        setSearch={setSearch}
        shoppingData={shoppingData}
        user={user}
      />

      {/* Main Container */}
      <main className="max-w-[1720px] 2xl:max-w-[1840px] mx-auto px-4 sm:px-6 lg:px-8 2xl:px-10">
        
        <MainViewSwitcher
          activeMainView={activeMainView}
          setActiveMainView={setActiveMainView}
          mangaCount={mangas.length}
          shoppingData={shoppingData}
          radarData={radarData}
          fetchShoppingList={fetchShoppingList}
          fetchReleaseRadar={fetchReleaseRadar}
          fetchMangaPassionReleases={fetchMangaPassionReleases}
        />

        {/* SHELF VIEW */}
        {activeMainView === 'shelf' && (
          <>
            <CollectionStats
              totalSeries={totalSeries}
              totalOwnedVolumes={totalOwnedVolumes}
              totalCollectionValue={totalCollectionValue}
              completedSeries={completedSeries}
              handleOpenStats={handleOpenStats}
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
          viewMode={viewMode}
        />
        {/* Grid or Empty State */}
        <MangaCollectionGrid
          canEdit={canEdit}
          failedImages={failedImages}
          filtered={filtered}
          getStatusBadge={getStatusBadge}
          handleDeleteManga={handleDeleteManga}
          handleOpenModal={handleOpenModal}
          loading={loading}
          publisherFilter={publisherFilter}
          search={search}
          setFailedImages={setFailedImages}
          setPublisherFilter={setPublisherFilter}
          setSearch={setSearch}
          setStatusFilter={setStatusFilter}
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
        setActiveMainView={setActiveMainView}
        canEdit={canQuickBuy}
        handleQuickBuy={handleQuickBuy}
        buyingId={buyingId}
        failedImages={failedImages}
        setFailedImages={setFailedImages}
      />
    )}

    {/* RELEASE RADAR / ERSCHEINUNGSKALENDER VIEW */}
    {activeMainView === 'radar' && (
      <ReleaseRadarView
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
        importingMpId={importingMpId}
        handleMarkDelivered={handleMarkDelivered}
        markingDeliveredId={markingDeliveredId}
        failedImages={failedImages}
        setFailedImages={setFailedImages}
        setActiveMainView={setActiveMainView}
        GERMAN_MONTHS={GERMAN_MONTHS}
        formatGermanDate={formatGermanDate}
      />
    )}
    </main>

      <DashboardFooter
        user={user}
        isOfflineMode={isOfflineMode}
        networkOffline={networkOffline}
        offlineCopyAt={offlineCopyAt}
        refreshingCopy={refreshingCopy}
        handleRefreshOfflineCopy={handleRefreshOfflineCopy}
        isInstallable={isInstallable}
        isInstalledApp={isInstalledApp}
        handleInstallClick={handleInstallClick}
      />

      {/* MODALS */}
      <AddMangaModal 
        isOpen={showAddModal} 
        onClose={() => setShowAddModal(false)} 
        onSuccess={() => fetchMangas()} 
      />

      <UserManagementModal 
        isOpen={showUsersModal} 
        onClose={() => setShowUsersModal(false)} 
        currentUser={user} 
      />

      <BackupRestoreModal 
        isOpen={showRestoreModal} 
        onClose={() => setShowRestoreModal(false)} 
        user={user} 
        onRestoreSuccess={() => {
          fetchMangas();
          fetchShoppingList();
          fetchReleaseRadar();
        }} 
      />

      <StatsModal 
        isOpen={showStatsModal} 
        onClose={() => setShowStatsModal(false)} 
        user={user} 
      />

    </div>
  );
}
