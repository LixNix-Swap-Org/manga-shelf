import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Layers, Plus, BookOpen, BookCheck, RotateCcw } from 'lucide-react';
import VolumeEditModal from './components/detail/VolumeEditModal';
import BatchAddModal from './components/detail/BatchAddModal';
import BatchReadModal from './components/detail/BatchReadModal';
import GapFillModal from './components/detail/GapFillModal';
import LightboxGallery from './components/detail/LightboxGallery';
import MpEditionModal from './components/detail/MpEditionModal';
import VolumeListView from './components/detail/VolumeListView';
import VolumeShelfView from './components/detail/VolumeShelfView';
import VolumeGridView from './components/detail/VolumeGridView';
import AddVolumeBar from './components/detail/AddVolumeBar';
import VolumeFilterBar from './components/detail/VolumeFilterBar';
import MangaHeroCard from './components/detail/MangaHeroCard';
import ReaderBar from './components/detail/ReaderBar';
import OwnerFilterBar from './components/detail/OwnerFilterBar';
import GapNotices from './components/detail/GapNotices';
import ShelfSpine from './components/detail/ShelfSpine';
import useMangaData from './hooks/useMangaData';
import useVolumeFilters from './hooks/useVolumeFilters';
import useMpGaps from './hooks/useMpGaps';
import useVolumeActions from './hooks/useVolumeActions';
import useVolumeGallery from './hooks/useVolumeGallery';
import useShelfLayout from './hooks/useShelfLayout';
import useDetailKeyboard from './hooks/useDetailKeyboard';
import { inferVolumeType, volumeNumberOf, getSeriesProgress, getVolumeDisplayTitle, buildDisplayVolumeItems } from './utils/volumeHelpers';

export default function MangaDetail({ user }) {
  const { id } = useParams();

  // Role permissions (visitor / guest are read-only)
  const canEdit = user && (user.role === 'admin' || user.role === 'editor');

  const {
    manga, loading, notFound, editing, setEditing, saving, formData, setFormData,
    uploadingCover, failedCover, setFailedCover,
    editLookingUp, editLookupResults, setEditLookupResults, editLookupError,
    applyEditLookupResult, handleEditLookup,
    fetchManga, handleUpdate, handleDeleteManga, handleCoverUpload
  } = useMangaData({ id, user, canEdit });

  const volumes = manga?.volumes || [];

  // Reader whose read status is shown
  const [selectedReaderId, setSelectedReaderId] = useState(user?.id || 'ALL');

  useEffect(() => {
    if (user?.id && (selectedReaderId === 'ALL' || !selectedReaderId)) {
      setSelectedReaderId(user.id);
    }
  }, [user?.id]);

  // Dialog visibility
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [showBatchReadModal, setShowBatchReadModal] = useState(false);
  const [fillingGapNumber, setFillingGapNumber] = useState(null);
  const [showMpEditionModal, setShowMpEditionModal] = useState(false);

  const {
    volumeFilter, setVolumeFilter, volumeTypeFilter, setVolumeTypeFilter,
    volumePublisherFilter, setVolumePublisherFilter, volumeConditionFilter, setVolumeConditionFilter,
    volumeSort, setVolumeSort, volumeSearch, setVolumeSearch,
    volumeViewMode, handleSetVolumeViewMode,
    availablePublishers, conditionsList, baseVolumesForType,
    schuberCount, specialEditionCount, specialCount, regularVolumeCount,
    volumeOwnerFilter, setVolumeOwnerFilter, volumeOwnerMissing, setVolumeOwnerMissing,
    filteredVolumes, hasActiveFilters, handleResetFilters
  } = useVolumeFilters({ volumes, manga, user, selectedReaderId });

  const {
    showGaps, handleToggleShowGaps, fillingGapLoading,
    mpGapData, mpGapLoading, fetchMpGaps, batchAutofilling, handleBatchAutofillManga,
    handleBatchFillGaps, handleSyncTotalVolumes, handleSelectMpEdition,
    mpGapMap, detectedGapEntries, detectedGaps
  } = useMpGaps({ id, canEdit, volumes, manga, fetchManga, setShowMpEditionModal });

  const {
    newVolumeType, setNewVolumeType, newVolumeNum, setNewVolumeNum, newVolumeStatus, setNewVolumeStatus,
    newVolumeReleaseDate, setNewVolumeReleaseDate, newVolumePrice, setNewVolumePrice,
    newVolumeCover, setNewVolumeCover, uploadingNewCover,
    activeVolume, setActiveVolume,
    handleAddSingleVolume, handleUploadNewSingleCover,
    handleToggleVolume, handleToggleVolumeRead, handleOpenEditVolume, handleDeleteVolume
  } = useVolumeActions({ id, user, canEdit, selectedReaderId, fetchManga });

  const { lightboxData, setLightboxData, openVolumeGallery, setPreviewImage } = useVolumeGallery({ manga, canEdit, fetchManga });

  useEffect(() => {
    fetchManga();
    if (!user?.offline) fetchMpGaps();
  }, [id, user?.offline]);

  const ownedCount = volumes.filter(v => v.status === 'Vorhanden').length;
  const missingCount = volumes.filter(v => v.status === 'Fehlt').length;
  const preorderedCount = volumes.filter(v => v.status === 'Vorbestellt').length;
  const upcomingCount = volumes.filter(v => v.status === 'Erscheint bald').length;
  // progress counts regular volumes only; schuber/extras show as "+N", a stale total follows the highest owned number
  const ownedRegular = volumes.filter(v => v.status === 'Vorhanden' && inferVolumeType(v) === 'volume' && volumeNumberOf(v) !== null);
  const seriesProgress = getSeriesProgress({
    regular_owned: new Set(ownedRegular.map(v => volumeNumberOf(v))).size, // distinct: a duplicate entry does not raise progress
    max_regular_number: Math.max(0, ...ownedRegular.map(v => volumeNumberOf(v))),
    total_volumes: manga?.total_volumes,
    owned_volumes: ownedCount
  });
  const duplicateEntries = useMemo(() => {
    const groups = new Map();
    for (const v of volumes) {
      const key = `${inferVolumeType(v)}:${String(v.volume_number).trim().toLowerCase()}`;
      groups.set(key, [...(groups.get(key) || []), v]);
    }
    return [...groups.values()].filter(g => g.length > 1).map(g => ({ label: getVolumeDisplayTitle(g[0]), count: g.length }));
  }, [volumes]);
  const totalTarget = seriesProgress.total;
  const completionPct = seriesProgress.pct;

  // Total value calculation
  const totalOwnedValue = manga?.total_value !== undefined ? manga.total_value : volumes
    .filter(v => v.status === 'Vorhanden')
    .reduce((sum, v) => sum + (typeof v.price === 'number' ? v.price : (parseFloat(v.price) || 0)), 0);

  // Readers stats
  const readers = manga?.reader_stats || [];
  const currentReaderStats = readers.find(r => String(r.user_id) === String(selectedReaderId)) || readers.find(r => String(r.user_id) === String(user?.id)) || null;
  const currentReaderReadCount = currentReaderStats ? currentReaderStats.read_count : volumes.filter(v => v.is_read).length;
  const currentReaderUnreadCount = currentReaderStats ? currentReaderStats.unread_count : Math.max(0, ownedCount - currentReaderReadCount);

  // Items to render across Spine Shelf, Grid View, and Table View (interleaving gaps if showGaps is active)
  const displayVolumeItems = useMemo(() => buildDisplayVolumeItems({
    filteredVolumes, detectedGapEntries, detectedGaps, mpGapMap, showGaps, volumeTypeFilter, volumeFilter, volumeSearch, volumeSort
  }), [showGaps, detectedGaps, detectedGapEntries, volumeTypeFilter, volumeFilter, volumeSearch, volumeSort, filteredVolumes, mpGapMap]);
  const spineShelfItems = displayVolumeItems;

  const {
    shelfMode, shelfScale, focusedVolumeId, setFocusedVolumeId, shelfScrollRef,
    handleSetShelfMode, handleSetShelfScale, scrollShelf, shelfRows, isFitMultiRow
  } = useShelfLayout(spineShelfItems);

  useDetailKeyboard({
    lightboxData, setLightboxData, activeVolume, setActiveVolume, showBatchModal, setShowBatchModal,
    showBatchReadModal, setShowBatchReadModal, fillingGapNumber, setFillingGapNumber,
    showMpEditionModal, setShowMpEditionModal, editing, setEditing,
    filteredVolumes, focusedVolumeId, setFocusedVolumeId, canEdit, handleToggleVolumeRead, handleOpenEditVolume
  });

  const renderShelfSpine = (item, idx, currentMode = shelfMode) => (
    <ShelfSpine
      key={item.isGap ? `gap-${item.gapNumber}-${idx}` : item.volume.id}
      item={item}
      currentMode={currentMode}
      isFitMultiRow={isFitMultiRow}
      totalCount={spineShelfItems.length}
      shelfScale={shelfScale}
      mpGapMap={mpGapMap}
      canEdit={canEdit}
      setFillingGapNumber={setFillingGapNumber}
      selectedReaderId={selectedReaderId}
      user={user}
      manga={manga}
      focusedVolumeId={focusedVolumeId}
      setFocusedVolumeId={setFocusedVolumeId}
      handleOpenEditVolume={handleOpenEditVolume}
    />
  );

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center text-slate-400 gap-3">
        <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"></div>
        <p className="text-sm">Lade Manga-Details...</p>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center text-slate-400 gap-6 px-4">
        <div className="w-20 h-20 rounded-2xl bg-slate-800/60 border border-slate-700/50 flex items-center justify-center text-5xl">
          📚
        </div>
        <div className="text-center">
          <h2 className="text-2xl font-bold text-slate-200 mb-2">Manga nicht gefunden</h2>
          <p className="text-slate-400 text-sm">Dieser Manga existiert nicht oder wurde gelöscht.</p>
        </div>
        <Link
          to="/"
          className="btn-primary flex items-center gap-2 px-5 py-2.5"
        >
          <ArrowLeft className="w-4 h-4" />
          Zurück zur Übersicht
        </Link>
      </div>
    );
  }

  if (!manga) return null;

  return (
    <div className="min-h-screen pb-20 overflow-x-hidden">
      {/* Top Bar */}
      <div className="max-w-[1680px] 2xl:max-w-[1800px] mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-4">
        <Link 
          to="/" 
          className="inline-flex items-center gap-2 text-slate-400 hover:text-white transition-colors text-sm font-medium bg-slate-900/60 hover:bg-slate-800/80 px-3.5 py-2 rounded-xl border border-slate-800 shadow-sm"
        >
          <ArrowLeft className="w-4 h-4 text-brand-400" /> Zurück zur Übersicht
        </Link>
      </div>

      {/* Main Container */}
      <div className="max-w-[1680px] 2xl:max-w-[1800px] mx-auto px-4 sm:px-6 lg:px-8">
        
        {/* Hero Card */}
        <MangaHeroCard
          isOffline={Boolean(user?.offline)}
          applyEditLookupResult={applyEditLookupResult}
          canEdit={canEdit}
          completionPct={completionPct}
          editLookingUp={editLookingUp}
          editLookupError={editLookupError}
          editLookupResults={editLookupResults}
          editing={editing}
          failedCover={failedCover}
          formData={formData}
          handleCoverUpload={handleCoverUpload}
          handleDeleteManga={handleDeleteManga}
          handleEditLookup={handleEditLookup}
          handleUpdate={handleUpdate}
          manga={manga}
          ownedCount={seriesProgress.owned}
          extrasCount={seriesProgress.extras}
          saving={saving}
          setEditLookupResults={setEditLookupResults}
          setEditing={setEditing}
          setFailedCover={setFailedCover}
          setFormData={setFormData}
          totalOwnedValue={totalOwnedValue}
          totalTarget={totalTarget}
          uploadingCover={uploadingCover}
        />

        {/* VOLUMES CHECKLIST SECTION */}
        <section className="glass-panel p-6 sm:p-8 rounded-3xl border border-slate-800/80 shadow-2xl">
          
          {/* Header & Controls */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 pb-6 border-b border-slate-800">
            <div>
              <h2 className="text-xl font-bold text-white flex items-center gap-2.5">
                <Layers className="w-5 h-5 text-brand-400" />
                Bände-Checkliste
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Klicke auf das Häkchen für Schnell-Status, oder auf die Karte für <b>Preise & Detailangaben</b>
              </p>
            </div>

            {/* Quick Actions */}
            {canEdit && (
              <div className="flex flex-wrap items-center gap-2">
                <button 
                  onClick={() => setShowBatchReadModal(true)} 
                  className="btn-secondary text-xs flex items-center gap-1.5 py-2 px-3 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10"
                  title="Mehrere Bände auf einmal als gelesen oder ungelesen markieren"
                >
                  <BookCheck className="w-3.5 h-3.5 text-emerald-400" /> Bis Band X als gelesen
                </button>
                <button 
                  onClick={() => setShowBatchModal(true)} 
                  className="btn-secondary text-xs flex items-center gap-1.5 py-2 px-3"
                >
                  <Plus className="w-3.5 h-3.5 text-brand-400" /> Mehrere Bände (Batch)
                </button>
              </div>
            )}
          </div>

          {/* Lese-Tracking Bar */}
          <ReaderBar
            readers={readers}
            selectedReaderId={selectedReaderId}
            setSelectedReaderId={setSelectedReaderId}
            user={user}
            ownedCount={ownedCount}
            currentReaderReadCount={currentReaderReadCount}
            currentReaderUnreadCount={currentReaderUnreadCount}
          />

          {/* Besitz pro Person (nur bei mehreren Nutzern) */}
          <OwnerFilterBar
            users={readers}
            volumes={volumes}
            ownerFilter={volumeOwnerFilter}
            setOwnerFilter={setVolumeOwnerFilter}
            ownerMissing={volumeOwnerMissing}
            setOwnerMissing={setVolumeOwnerMissing}
          />

          {/* Filter, View & Sort Controls */}
          <VolumeFilterBar
            availablePublishers={availablePublishers}
            baseVolumesForType={baseVolumesForType}
            conditionsList={conditionsList}
            currentReaderReadCount={currentReaderReadCount}
            currentReaderUnreadCount={currentReaderUnreadCount}
            detectedGaps={detectedGaps}
            handleResetFilters={handleResetFilters}
            handleSetVolumeViewMode={handleSetVolumeViewMode}
            handleToggleShowGaps={handleToggleShowGaps}
            hasActiveFilters={hasActiveFilters}
            missingCount={missingCount}
            mpGapData={mpGapData}
            mpGapLoading={mpGapLoading}
            ownedCount={ownedCount}
            preorderedCount={preorderedCount}
            regularVolumeCount={regularVolumeCount}
            schuberCount={schuberCount}
            setShowMpEditionModal={setShowMpEditionModal}
            setVolumeConditionFilter={setVolumeConditionFilter}
            setVolumeFilter={setVolumeFilter}
            setVolumePublisherFilter={setVolumePublisherFilter}
            setVolumeSearch={setVolumeSearch}
            setVolumeSort={setVolumeSort}
            setVolumeTypeFilter={setVolumeTypeFilter}
            showGaps={showGaps}
            specialCount={specialCount}
            specialEditionCount={specialEditionCount}
            upcomingCount={upcomingCount}
            volumeConditionFilter={volumeConditionFilter}
            volumeFilter={volumeFilter}
            volumePublisherFilter={volumePublisherFilter}
            volumeSearch={volumeSearch}
            volumeSort={volumeSort}
            volumeTypeFilter={volumeTypeFilter}
            volumeViewMode={volumeViewMode}
            volumes={volumes}
          />

          {/* Volumes Grid */}
          {displayVolumeItems.length === 0 ? (
            <div className="p-8 text-center bg-slate-950/40 rounded-2xl border border-slate-800/60 my-4">
              <BookOpen className="w-8 h-8 text-slate-600 mx-auto mb-2" />
              <p className="text-sm text-slate-400">
                {volumes.length === 0 
                  ? 'Noch keine Bände erfasst. Nutze untenstehendes Feld oder "Mehrere Bände", um loszulegen.' 
                  : 'Keine Bände mit diesen Filtereinstellungen gefunden.'}
              </p>
              {volumes.length > 0 && hasActiveFilters && (
                <button
                  type="button"
                  onClick={handleResetFilters}
                  className="mt-3.5 inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-brand-600/30 hover:bg-brand-600/50 text-brand-300 border border-brand-500/40 transition-all cursor-pointer shadow-sm"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Filter zurücksetzen
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Duplicate entries, Manga-Passion discrepancy and detected gaps */}
              <GapNotices
                duplicateEntries={duplicateEntries}
                canEdit={canEdit}
                showGaps={showGaps}
                detectedGaps={detectedGaps}
                detectedGapEntries={detectedGapEntries}
                volumeFilter={volumeFilter}
                volumeSearch={volumeSearch}
                mpGapData={mpGapData}
                mpGapLoading={mpGapLoading}
                fillingGapLoading={fillingGapLoading}
                handleSyncTotalVolumes={handleSyncTotalVolumes}
                handleBatchFillGaps={handleBatchFillGaps}
                handleSelectMpEdition={handleSelectMpEdition}
                setShowMpEditionModal={setShowMpEditionModal}
              />


              {/* SPINE VIEW */}
              {volumeViewMode === 'spine' && (
                <VolumeShelfView
                  handleSetShelfMode={handleSetShelfMode}
                  handleSetShelfScale={handleSetShelfScale}
                  isFitMultiRow={isFitMultiRow}
                  renderShelfSpine={renderShelfSpine}
                  scrollShelf={scrollShelf}
                  shelfMode={shelfMode}
                  shelfRows={shelfRows}
                  shelfScale={shelfScale}
                  shelfScrollRef={shelfScrollRef}
                  spineShelfItems={spineShelfItems}
                />
              )}

              {/* LIST VIEW */}
              {volumeViewMode === 'list' && (
                <VolumeListView
                  displayVolumeItems={displayVolumeItems}
                  mpGapMap={mpGapMap}
                  manga={manga}
                  user={user}
                  canEdit={canEdit}
                  selectedReaderId={selectedReaderId}
                  setFillingGapNumber={setFillingGapNumber}
                  openVolumeGallery={openVolumeGallery}
                  handleToggleVolume={handleToggleVolume}
                  handleToggleVolumeRead={handleToggleVolumeRead}
                  handleOpenEditVolume={handleOpenEditVolume}
                  handleDeleteVolume={handleDeleteVolume}
                />
              )}

              {/* GRID VIEW */}
              {volumeViewMode === 'grid' && (
                <VolumeGridView
                  canEdit={canEdit}
                  displayVolumeItems={displayVolumeItems}
                  handleDeleteVolume={handleDeleteVolume}
                  handleOpenEditVolume={handleOpenEditVolume}
                  handleToggleVolume={handleToggleVolume}
                  handleToggleVolumeRead={handleToggleVolumeRead}
                  manga={manga}
                  mpGapMap={mpGapMap}
                  openVolumeGallery={openVolumeGallery}
                  readers={readers}
                  selectedReaderId={selectedReaderId}
                  setFillingGapNumber={setFillingGapNumber}
                  user={user}
                />
              )}
            </>
          )}

          {/* Add Single Volume / Schuber Bar */}
          <AddVolumeBar
            canEdit={canEdit}
            handleAddSingleVolume={handleAddSingleVolume}
            handleUploadNewSingleCover={handleUploadNewSingleCover}
            newVolumeCover={newVolumeCover}
            newVolumeNum={newVolumeNum}
            newVolumePrice={newVolumePrice}
            newVolumeReleaseDate={newVolumeReleaseDate}
            newVolumeStatus={newVolumeStatus}
            newVolumeType={newVolumeType}
            setNewVolumeCover={setNewVolumeCover}
            setNewVolumeNum={setNewVolumeNum}
            setNewVolumePrice={setNewVolumePrice}
            setNewVolumeReleaseDate={setNewVolumeReleaseDate}
            setNewVolumeStatus={setNewVolumeStatus}
            setNewVolumeType={setNewVolumeType}
            uploadingNewCover={uploadingNewCover}
          />

        </section>
      </div>

      {/* MODALS & OVERLAYS */}
      <VolumeEditModal
        isOpen={Boolean(activeVolume)}
        activeVolume={activeVolume}
        onClose={() => setActiveVolume(null)}
        manga={manga}
        mangaId={id}
        canEdit={canEdit}
        user={user}
        onSuccess={fetchManga}
        onPreviewImage={setPreviewImage}
      />

      <BatchAddModal
        isOpen={showBatchModal}
        onClose={() => setShowBatchModal(false)}
        manga={manga}
        mangaId={id}
        onSuccess={fetchManga}
      />

      <BatchReadModal
        isOpen={showBatchReadModal}
        onClose={() => setShowBatchReadModal(false)}
        mangaId={id}
        readers={readers}
        selectedReaderId={selectedReaderId}
        setSelectedReaderId={setSelectedReaderId}
        user={user}
        onSuccess={fetchManga}
      />

      <GapFillModal
        isOpen={fillingGapNumber !== null}
        gapNumber={fillingGapNumber}
        onClose={() => setFillingGapNumber(null)}
        manga={manga}
        mangaId={id}
        mpGapMap={mpGapMap}
        canEdit={canEdit}
        onSuccess={async () => {
          await fetchManga();
          await fetchMpGaps();
        }}
      />

      <LightboxGallery
        lightboxData={lightboxData}
        setLightboxData={setLightboxData}
        onClose={() => setLightboxData(null)}
        canEdit={canEdit}
        onSuccess={fetchManga}
      />

      <MpEditionModal
        isOpen={showMpEditionModal}
        onClose={() => setShowMpEditionModal(false)}
        manga={manga}
        mangaId={id}
        mpGapData={mpGapData}
        mpGapLoading={mpGapLoading}
        fetchMpGaps={fetchMpGaps}
        handleSyncTotalVolumes={handleSyncTotalVolumes}
        handleBatchAutofillManga={handleBatchAutofillManga}
        batchAutofilling={batchAutofilling}
        handleSelectMpEdition={handleSelectMpEdition}
      />

    </div>
  );
}
