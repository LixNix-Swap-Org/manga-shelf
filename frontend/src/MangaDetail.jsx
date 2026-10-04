import { useState, useEffect, useLayoutEffect, useMemo, useRef, lazy, Suspense } from 'react';
import { useParams, Link, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { ArrowLeft, Layers, Plus, BookOpen, BookCheck, RotateCcw, TriangleAlert, Library } from 'lucide-react';
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
import BulkActionBar from './components/detail/BulkActionBar';
import DetailBottomBar, { revealAboveKeyboard } from './components/detail/DetailBottomBar';
import { MAIN_ID, SkipLink, useDocumentTitle, usePageHeading } from './components/common/PageChrome';
import useMangaData from './hooks/useMangaData';
import useVolumeFilters from './hooks/useVolumeFilters';
import useMpGaps from './hooks/useMpGaps';
import useVolumeActions from './hooks/useVolumeActions';
import useVolumeSelection from './hooks/useVolumeSelection';
import useVolumeGallery from './hooks/useVolumeGallery';
import useShelfLayout from './hooks/useShelfLayout';
import useDetailKeyboard from './hooks/useDetailKeyboard';
import { PURCHASE_RECORDED_EVENT } from './appShell';
import { readCache, cacheOwner, LIST_KEY } from './utils/dataCache';
import { OUTBOX_SYNCED_EVENT } from './utils/outbox';
import { viewSessionEnding } from './utils/viewState';
import { inferVolumeType, regularVolumeNumber, getSeriesProgress, getVolumeProgressCounts, getVolumeDisplayTitle, buildDisplayVolumeItems } from './utils/volumeHelpers';
import { t } from './i18n/index.js';
import { editionCurrency } from './utils/editions';
import { rich } from './i18n/react.jsx';

// dialogs are loaded on first use and mounted only while open
const VolumeEditModal = lazy(() => import('./components/detail/VolumeEditModal'));
const BatchAddModal = lazy(() => import('./components/detail/BatchAddModal'));
const BatchReadModal = lazy(() => import('./components/detail/BatchReadModal'));
const GapFillModal = lazy(() => import('./components/detail/GapFillModal'));
const LightboxGallery = lazy(() => import('./components/detail/LightboxGallery'));
const MpEditionModal = lazy(() => import('./components/detail/MpEditionModal'));

export const DETAIL_SCROLL_KEY = 'mangashelf_detail_scroll';
const MAX_SCROLL_ENTRIES = 30;

function readScrollPositions() {
  try {
    const map = JSON.parse(window.sessionStorage.getItem(DETAIL_SCROLL_KEY));
    return map && typeof map === 'object' ? map : {};
  } catch (_) {
    return {};
  }
}

/**
 * A series opened by a link starts at the top (the shelf may have been scrolled far down); Back / Forward to a
 * history entry returns to where that entry was left. Positions are kept per entry for this tab.
 */
function useDetailScroll(ready) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const handled = useRef(null);

  useLayoutEffect(() => {
    if (!ready || handled.current === location.key) return;
    handled.current = location.key;
    const target = navigationType === 'POP' ? Number(readScrollPositions()[location.key]) || 0 : 0;
    if (window.scrollY !== target) window.scrollTo(0, target);
  }, [ready, location.key, navigationType]);

  useLayoutEffect(() => {
    const entryKey = location.key;
    let y = window.scrollY;
    const onScroll = () => { y = window.scrollY; };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (viewSessionEnding()) return;
      const map = readScrollPositions();
      delete map[entryKey];
      map[entryKey] = Math.round(y);
      const keys = Object.keys(map);
      for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SCROLL_ENTRIES))) delete map[old];
      try { window.sessionStorage.setItem(DETAIL_SCROLL_KEY, JSON.stringify(map)); } catch (_) { /* storage unavailable */ }
    };
  }, [location.key]);
}

/** Same type and number more than once; "Band 5" and "5" are the same regular volume (the server rejects that pair too). */
export function findDuplicateEntries(volumes) {
  const groups = new Map();
  for (const v of volumes || []) {
    const type = inferVolumeType(v);
    const regular = type === 'volume' ? regularVolumeNumber(v) : null;
    const key = `${type}:${regular !== null ? regular : String(v.volume_number ?? '').trim().toLowerCase()}`;
    groups.set(key, [...(groups.get(key) || []), v]);
  }
  return [...groups.values()].filter(g => g.length > 1).map(g => ({ label: getVolumeDisplayTitle(g[0]), count: g.length }));
}

/** Where "Zurück zur Übersicht" leads: the in-app page that linked here (e.g. the shopping list), else the shelf. */
export function backLinkTarget(state) {
  const from = state?.from;
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//') || from.includes('\\')) return '/';
  return from;
}

// phones: room for the context bar (3.5rem + inset) and, offline, the banner; a selection's bar sits above it
const PAGE_CLASS = 'min-h-screen pb-20 overflow-x-clip max-sm:[&_#bulk-action-bar]:bottom-[calc(4.25rem+env(safe-area-inset-bottom))]';
const PHONE_PADDING = 'max-sm:pb-[calc(5.5rem+env(safe-area-inset-bottom))]';
const PHONE_PADDING_OFFLINE = 'max-sm:pb-[calc(8rem+env(safe-area-inset-bottom))]';

// i18n
const LOAD_ERRORS = {
  server: { title: 'Server nicht erreichbar', text: 'Die Reihe konnte gerade nicht geladen werden.' },
  'offline-missing': { title: 'Nicht in der Offline-Kopie', text: 'Diese Reihe war beim letzten Abgleich noch nicht gespeichert. Mit Verbindung erneut öffnen.' },
  unauthorized: { title: 'Sitzung abgelaufen', text: 'Bitte melde dich neu an.' }
};

export default function MangaDetail({ user, onUnauthorized }) {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const backTo = backLinkTarget(location.state);
  const addVolumeRef = useRef(null);

  // Role permissions (visitor / guest are read-only)
  const canEdit = user && (user.role === 'admin' || user.role === 'editor');

  const isOffline = Boolean(user?.offline);
  // offline the app makes every user a visitor; editors can still record read/owned toggles (queued in the outbox)
  const canToggle = Boolean(canEdit || (isOffline && ['admin', 'editor'].includes(user?.realRole)));

  const {
    manga, loading, notFound, loadError, refreshError, clearRefreshError,
    editing, setEditing, startEditing, cancelEditing, isEditDirty, saving, formData, setFormData,
    uploadingCover,
    editLookingUp, editLookupResults, setEditLookupResults, editLookupError,
    applyEditLookupResult, handleEditLookup,
    fetchManga, handleUpdate, handleDeleteManga, handleCoverUpload, cancelCoverUpload, patchManga,
    canFillTags, fillingTags, handleFillTags
  } = useMangaData({ id, user, canEdit, onUnauthorized });

  const volumes = useMemo(() => manga?.volumes || [], [manga?.volumes]);

  // Reader whose read status is shown
  const [selectedReaderId, setSelectedReaderId] = useState(user?.id || 'ALL');

  useEffect(() => {
    if (user?.id && (selectedReaderId === 'ALL' || !selectedReaderId)) {
      setSelectedReaderId(user.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on a user change, 'Alle' stays selectable
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
    filteredVolumes, hasActiveFilters, gapsAllowedByFilters, handleResetFilters
  } = useVolumeFilters({ volumes, manga, user, selectedReaderId });

  const {
    showGaps, handleToggleShowGaps, fillingGapLoading,
    mpGapData, mpGapLoading, mpGapError, mpGapNotice, fetchMpGaps, batchAutofilling, handleBatchAutofillManga,
    handleBatchFillGaps, handleSyncTotalVolumes, handleSelectMpEdition, mpEnabled,
    gapEditionUnconfirmed, canSyncVolumeCount,
    mpGapMap, detectedGapEntries, detectedGaps
  } = useMpGaps({ id, canEdit, volumes, manga, fetchManga, setShowMpEditionModal, user });

  const {
    newVolumeType, setNewVolumeType, newVolumeNum, setNewVolumeNum, newVolumeStatus, setNewVolumeStatus,
    newVolumeReleaseDate, setNewVolumeReleaseDate, newVolumePrice, setNewVolumePrice,
    newVolumeCover, setNewVolumeCover, uploadingNewCover, newVolumeIsbn, setNewVolumeIsbn, readDate, setReadDate,
    activeVolume, setActiveVolume, canToggleOthers,
    handleAddSingleVolume, handleUploadNewSingleCover, cancelNewCoverUpload,
    handleToggleVolume, handleToggleVolumeRead, handleOpenEditVolume, handleDeleteVolume, handleBulkEdit
  } = useVolumeActions({ id, user, canEdit, canToggle, selectedReaderId, fetchManga, patchManga, volumes, onUnauthorized });

  const { lightboxData, setLightboxData, openVolumeGallery } = useVolumeGallery({ manga });
  // the editor follows a refreshed copy of its volume (useVolumeEditForm rebases the untouched fields)
  const editingVolume = useMemo(
    () => activeVolume && (volumes.find((v) => String(v.id) === String(activeVolume.id)) || activeVolume),
    [activeVolume, volumes]
  );

  useEffect(() => {
    fetchManga();
    if (!user?.offline) fetchMpGaps();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on a series or offline change
  }, [id, user?.offline]);

  // A quick buy from the shopping list can land after this page loaded (sent when the list view closed)
  const purchaseRefetchRef = useRef(null);
  purchaseRefetchRef.current = (volumeId) => {
    if (!manga || volumes.some((v) => String(v.id) === String(volumeId))) fetchManga();
  };
  useEffect(() => {
    const onPurchase = (event) => purchaseRefetchRef.current(event.detail?.volumeId);
    window.addEventListener(PURCHASE_RECORDED_EVENT, onPurchase);
    return () => window.removeEventListener(PURCHASE_RECORDED_EVENT, onPurchase);
  }, []);

  // queued changes replayed by the outbox can belong to this series
  const outboxRefetchRef = useRef(null);
  outboxRefetchRef.current = () => fetchManga();
  useEffect(() => {
    const onSynced = () => outboxRefetchRef.current();
    window.addEventListener(OUTBOX_SYNCED_EVENT, onSynced);
    return () => window.removeEventListener(OUTBOX_SYNCED_EVENT, onSynced);
  }, []);

  const ownedCount = volumes.filter(v => v.status === 'Vorhanden').length;
  const missingCount = volumes.filter(v => v.status === 'Fehlt').length;
  const preorderedCount = volumes.filter(v => v.status === 'Vorbestellt').length;
  const upcomingCount = volumes.filter(v => v.status === 'Erscheint bald').length;
  // progress counts distinct regular volumes only; schuber/extras show as "+N", a stale total follows the highest owned number
  const seriesProgress = getSeriesProgress({ ...getVolumeProgressCounts(volumes), total_volumes: manga?.total_volumes });
  const duplicateEntries = useMemo(() => findDuplicateEntries(volumes), [volumes]);
  const totalTarget = seriesProgress.total;
  const completionPct = seriesProgress.pct;

  // Total value calculation
  const totalOwnedValue = manga?.total_value !== undefined ? manga.total_value : volumes
    .filter(v => v.status === 'Vorhanden')
    .reduce((sum, v) => sum + (typeof v.price === 'number' ? v.price : (parseFloat(v.price) || 0)), 0);

  // Readers stats
  const readers = manga?.reader_stats || [];
  const currentReaderStats = readers.find(r => String(r.user_id) === String(selectedReaderId)) || readers.find(r => String(r.user_id) === String(user?.id)) || null;
  const currentReaderReadCount = currentReaderStats ? currentReaderStats.read_count : volumes.filter(v => v.is_read && v.status === 'Vorhanden').length;
  const currentReaderUnreadCount = currentReaderStats ? currentReaderStats.unread_count : Math.max(0, ownedCount - currentReaderReadCount);

  // Items to render across Spine Shelf, Grid View, and Table View (interleaving gaps if showGaps is active)
  const gapsOfficial = Boolean(mpGapData?.matched && mpGapData.link_confirmed !== false);

  const displayVolumeItems = useMemo(() => buildDisplayVolumeItems({
    filteredVolumes, detectedGapEntries, detectedGaps, mpGapMap, showGaps, volumeTypeFilter, volumeFilter, volumeSearch, volumeSort,
    volumePublisherFilter, volumeConditionFilter, volumeOwnerFilter, volumeOwnerMissing
  }), [showGaps, detectedGaps, detectedGapEntries, volumeTypeFilter, volumeFilter, volumeSearch, volumeSort, filteredVolumes, mpGapMap,
    volumePublisherFilter, volumeConditionFilter, volumeOwnerFilter, volumeOwnerMissing]);

  const {
    shelfMode, shelfScale, focusedVolumeId, setFocusedVolumeId, shelfScrollRef,
    handleSetShelfMode, handleSetShelfScale, scrollShelf, shelfRows, isFitMultiRow, shelfMeasureRef
  } = useShelfLayout(displayVolumeItems);

  const selection = useVolumeSelection({ volumes });
  const canSelect = Boolean(canEdit) && !isOffline;
  const selecting = canSelect && selection.active;
  const visibleVolumeIds = useMemo(() => displayVolumeItems.filter((item) => !item.isGap).map((item) => item.volume.id), [displayVolumeItems]);
  const allVisibleSelected = visibleVolumeIds.length > 0 && visibleVolumeIds.every((volId) => selection.selected.has(volId));
  const selectVolume = (vol, e) => selection.toggle(vol.id, { range: Boolean(e?.shiftKey), orderedIds: visibleVolumeIds });
  const [bulkBusy, setBulkBusy] = useState(false);
  const applyBulk = async (change, doneText) => {
    setBulkBusy(true);
    try {
      const ok = await handleBulkEdit(selection.ids, change, doneText);
      if (ok && change.delete) selection.clear();
      return ok;
    } finally {
      setBulkBusy(false);
    }
  };
  const selectionProps = selecting
    ? { selectionMode: true, isSelected: selection.isSelected, onSelectVolume: selectVolume }
    : {};

  // while loading: the title the shelf already knows, else null (the previous title stays, no generic title in between)
  const listTitle = useMemo(
    () => readCache(cacheOwner(user), LIST_KEY)?.data?.find((m) => String(m.id) === String(id))?.title || null,
    [user, id]
  );
  let documentTitle = listTitle;
  if (notFound) documentTitle = t('Manga nicht gefunden');
  else if (!loading && manga?.title) documentTitle = manga.title;
  else if (!loading && loadError) documentTitle = t((LOAD_ERRORS[loadError] || LOAD_ERRORS.server).title);
  useDocumentTitle(documentTitle);
  const headingRef = usePageHeading(!loading);
  useDetailScroll(!loading && Boolean(manga));

  useDetailKeyboard({
    lightboxData, setLightboxData, activeVolume, setActiveVolume, showBatchModal, setShowBatchModal,
    showBatchReadModal, setShowBatchReadModal, fillingGapNumber, setFillingGapNumber,
    showMpEditionModal, setShowMpEditionModal, editing, setEditing, cancelEditing, isEditDirty, volumeViewMode,
    filteredVolumes, focusedVolumeId, setFocusedVolumeId, canEdit, canToggle, handleToggleVolumeRead, handleOpenEditVolume
  });

  const focusAddVolume = () => {
    const field = addVolumeRef.current?.querySelector('input[id$="-number"]');
    if (!field) return;
    field.scrollIntoView?.({ block: 'center' });
    field.focus({ preventScroll: true });
    revealAboveKeyboard(field);
  };
  const openScannedVolume = (vol) => {
    if (canEdit) {
      handleOpenEditVolume(vol);
      return;
    }
    document.querySelector(`[data-volume-id="${vol.id}"]`)?.scrollIntoView?.({ block: 'center' });
  };
  const prefillScannedVolume = ({ number, price, isbn }) => {
    if (number) {
      setNewVolumeType('volume');
      setNewVolumeNum(number);
    }
    if (price) setNewVolumePrice(price);
    setNewVolumeIsbn(isbn || '');
    focusAddVolume();
  };

  const renderShelfSpine = (item, idx, currentMode = shelfMode) => (
    <ShelfSpine
      key={item.isGap ? `gap-${item.gapNumber}-${idx}` : item.volume.id}
      item={item}
      currentMode={currentMode}
      isFitMultiRow={isFitMultiRow}
      totalCount={displayVolumeItems.length}
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
      gapsOfficial={gapsOfficial}
      selectionMode={selecting}
      selected={selecting && !item.isGap && selection.isSelected(item.volume.id)}
      onSelect={selectVolume}
    />
  );

  if (loading) {
    return (
      <main id={MAIN_ID} tabIndex={-1} className="focus:outline-none min-h-screen flex items-center justify-center text-slate-400">
        <div role="status" className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" aria-hidden="true"></div>
          <p className="text-sm">{t('Lade Manga-Details...')}</p>
        </div>
      </main>
    );
  }

  if (notFound) {
    return (
      <main id={MAIN_ID} tabIndex={-1} className="focus:outline-none min-h-screen flex flex-col items-center justify-center text-slate-400 gap-6 px-4">
        <div className="w-20 h-20 rounded-2xl bg-slate-800/60 border border-slate-700/50 flex items-center justify-center" aria-hidden="true">
          <Library className="w-10 h-10 text-slate-500" />
        </div>
        <div className="text-center">
          <h1 ref={headingRef} tabIndex={-1} className="focus:outline-none text-2xl font-bold text-slate-200 mb-2">{t('Manga nicht gefunden')}</h1>
          <p className="text-slate-400 text-sm">{t('Dieser Manga existiert nicht oder wurde gelöscht.')}</p>
        </div>
        <Link
          to={backTo}
          className="btn-primary flex items-center gap-2 px-5 py-2.5"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('Zurück zur Übersicht')}
        </Link>
      </main>
    );
  }

  if (!manga && loadError) {
    const info = LOAD_ERRORS[loadError] || LOAD_ERRORS.server;
    return (
      <main id={MAIN_ID} tabIndex={-1} className="focus:outline-none min-h-screen flex flex-col items-center justify-center text-slate-400 gap-6 px-4">
        <div className="w-20 h-20 rounded-2xl bg-slate-800/60 border border-slate-700/50 flex items-center justify-center" aria-hidden="true">
          <Library className="w-10 h-10 text-slate-500" />
        </div>
        <div className="text-center" role="alert">
          <h1 ref={headingRef} tabIndex={-1} className="focus:outline-none text-2xl font-bold text-slate-200 mb-2">{t(info.title)}</h1>
          <p className="text-slate-400 text-sm">{t(info.text)}</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">
          {loadError === 'server' && (
            <button type="button" onClick={() => fetchManga()} className="btn-secondary flex items-center gap-2 px-5 py-2.5">
              <RotateCcw className="w-4 h-4" aria-hidden="true" />
              {t('Erneut versuchen')}
            </button>
          )}
          {loadError === 'unauthorized' ? (
            <Link to="/login" className="btn-primary flex items-center gap-2 px-5 py-2.5">
              {t('Zur Anmeldung')}
            </Link>
          ) : (
            <Link to={backTo} className="btn-primary flex items-center gap-2 px-5 py-2.5">
              <ArrowLeft className="w-4 h-4" aria-hidden="true" />
              {t('Zurück zur Übersicht')}
            </Link>
          )}
        </div>
      </main>
    );
  }

  if (!manga) return null;

  return (
    <div className={`${PAGE_CLASS} ${isOffline ? PHONE_PADDING_OFFLINE : PHONE_PADDING}`}>
      <SkipLink />
      <nav aria-label={t('Seitennavigation')} className="max-w-[1680px] 2xl:max-w-[1800px] mx-auto px-4 sm:px-6 lg:px-8 pt-[max(1.5rem,env(safe-area-inset-top))] pb-4">
        <Link 
          to={backTo} 
          className="inline-flex items-center gap-2 text-slate-400 hover:text-white transition-colors text-sm font-medium bg-slate-900/60 hover:bg-slate-800/80 px-3.5 py-2 rounded-xl border border-slate-800 shadow-sm"
        >
          <ArrowLeft className="w-4 h-4 text-brand-400" /> {t('Zurück zur Übersicht')}
        </Link>
      </nav>

      <main id={MAIN_ID} tabIndex={-1} className="focus:outline-none max-w-[1680px] 2xl:max-w-[1800px] mx-auto px-4 sm:px-6 lg:px-8">
        
        {refreshError && (
          <div role="status" className="mb-4 p-3 bg-amber-500/10 border border-amber-500/40 rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs text-amber-200">
            <span className="flex items-center gap-2">
              <TriangleAlert className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
              {refreshError}
            </span>
            <button
              type="button"
              onClick={clearRefreshError}
              className="px-2.5 py-1 bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white rounded-lg text-xs font-medium cursor-pointer"
            >
              {t('Schließen')}
            </button>
          </div>
        )}

        {/* Hero Card */}
        <MangaHeroCard
          isOffline={isOffline}
          applyEditLookupResult={applyEditLookupResult}
          canEdit={canEdit}
          completionPct={completionPct}
          editLookingUp={editLookingUp}
          editLookupError={editLookupError}
          editLookupResults={editLookupResults}
          editing={editing}
          formData={formData}
          headingRef={headingRef}
          handleCoverUpload={handleCoverUpload}
          onCancelCoverUpload={cancelCoverUpload}
          handleDeleteManga={handleDeleteManga}
          handleEditLookup={handleEditLookup}
          handleUpdate={handleUpdate}
          manga={manga}
          ownedCount={seriesProgress.owned}
          extrasCount={seriesProgress.extras}
          saving={saving}
          setEditLookupResults={setEditLookupResults}
          setEditing={setEditing}
          startEditing={startEditing}
          cancelEditing={cancelEditing}
          setFormData={setFormData}
          totalOwnedValue={totalOwnedValue}
          totalTarget={totalTarget}
          uploadingCover={uploadingCover}
          onCollectingSaved={(collecting) => patchManga((m) => ({ ...m, collecting }))}
          canFillTags={canFillTags}
          fillingTags={fillingTags}
          handleFillTags={handleFillTags}
          onEditionsChanged={fetchManga}
        />

        {/* VOLUMES CHECKLIST SECTION */}
        <section aria-labelledby="volumes-heading" className="glass-panel p-6 sm:p-8 rounded-3xl border border-slate-800/80 shadow-2xl">
          
          {/* Header & Controls */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 pb-6 border-b border-slate-800">
            <div>
              <h2 id="volumes-heading" className="text-xl font-bold text-white flex items-center gap-2.5">
                <Layers className="w-5 h-5 text-brand-400" />
                {t('Bände-Checkliste')}
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                {rich('Klicke auf das Häkchen für Schnell-Status oder auf die Karte für {details}', { details: <b>{t('Preise & Detailangaben')}</b> })}
              </p>
            </div>

            {/* Quick Actions */}
            {canEdit && (
              <div className="flex flex-wrap items-center gap-2">
                <button 
                  onClick={() => setShowBatchReadModal(true)} 
                  className="btn-secondary text-xs flex items-center gap-1.5 py-2 px-3 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10"
                  title={t('Mehrere Bände auf einmal als gelesen oder ungelesen markieren')}
                >
                  <BookCheck className="w-3.5 h-3.5 text-emerald-400" /> {t('Bis Band X als gelesen')}
                </button>
                <button 
                  onClick={() => setShowBatchModal(true)} 
                  className="btn-secondary text-xs flex items-center gap-1.5 py-2 px-3"
                >
                  <Plus className="w-3.5 h-3.5 text-brand-400" /> {t('Mehrere Bände anlegen')}
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
            canToggle={canToggle}
            readDate={readDate}
            setReadDate={setReadDate}
          />

          {/* Ownership per person (only with several users) */}
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
            gapsAllowedByFilters={gapsAllowedByFilters}
            isOffline={isOffline}
            handleResetFilters={handleResetFilters}
            handleSetVolumeViewMode={handleSetVolumeViewMode}
            handleToggleShowGaps={handleToggleShowGaps}
            hasActiveFilters={hasActiveFilters}
            missingCount={missingCount}
            mpGapData={mpGapData}
            mpGapError={mpGapError}
            mpGapLoading={mpGapLoading}
            mpEnabled={mpEnabled}
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
            canSelect={canSelect}
            selectionMode={selecting}
            onToggleSelectionMode={selection.toggleMode}
          />

          {/* Edition confirmation, duplicates, Manga-Passion discrepancy and gaps: also above an empty (filtered) list */}
          <GapNotices
            duplicateEntries={duplicateEntries}
            canEdit={canEdit}
            isOffline={isOffline}
            showGaps={showGaps}
            detectedGaps={detectedGaps}
            detectedGapEntries={detectedGapEntries}
            volumeFilter={volumeFilter}
            volumeSearch={volumeSearch}
            gapsAllowedByFilters={gapsAllowedByFilters}
            volumeViewMode={volumeViewMode}
            mpGapData={mpGapData}
            mpGapLoading={mpGapLoading}
            mpGapNotice={mpGapNotice}
            canSyncVolumeCount={canSyncVolumeCount}
            gapEditionUnconfirmed={gapEditionUnconfirmed}
            fillingGapLoading={fillingGapLoading}
            handleSyncTotalVolumes={handleSyncTotalVolumes}
            handleBatchFillGaps={handleBatchFillGaps}
            handleSelectMpEdition={handleSelectMpEdition}
            setShowMpEditionModal={setShowMpEditionModal}
            collecting={manga.collecting}
          />

          {/* Volumes Grid */}
          {displayVolumeItems.length === 0 ? (
            <div className="p-8 text-center bg-slate-950/40 rounded-2xl border border-slate-800/60 my-4">
              <BookOpen className="w-8 h-8 text-slate-500 mx-auto mb-2" />
              <p className="text-sm text-slate-400">
                {volumes.length === 0 
                  ? t('Noch keine Bände erfasst. Nutze untenstehendes Feld oder "Mehrere Bände", um loszulegen.') 
                  : t('Keine Bände mit diesen Filtereinstellungen gefunden.')}
              </p>
              {volumes.length > 0 && hasActiveFilters && (
                <button
                  type="button"
                  onClick={handleResetFilters}
                  className="mt-3.5 inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-brand-600/30 hover:bg-brand-600/50 text-brand-300 border border-brand-500/40 transition-all cursor-pointer shadow-sm"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> {t('Filter zurücksetzen')}
                </button>
              )}
            </div>
          ) : (
            <>

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
                  shelfMeasureRef={shelfMeasureRef}
                  spineShelfItems={displayVolumeItems}
                  canEdit={Boolean(canEdit)}
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
                  canToggle={canToggle}
                  canToggleOthers={canToggleOthers}
                  gapsOfficial={gapsOfficial}
                  selectedReaderId={selectedReaderId}
                  setFillingGapNumber={setFillingGapNumber}
                  openVolumeGallery={openVolumeGallery}
                  handleToggleVolume={handleToggleVolume}
                  handleToggleVolumeRead={handleToggleVolumeRead}
                  handleOpenEditVolume={handleOpenEditVolume}
                  handleDeleteVolume={handleDeleteVolume}
                  {...selectionProps}
                />
              )}

              {/* GRID VIEW */}
              {volumeViewMode === 'grid' && (
                <VolumeGridView
                  canEdit={canEdit}
                  canToggle={canToggle}
                  canToggleOthers={canToggleOthers}
                  gapsOfficial={gapsOfficial}
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
                  {...selectionProps}
                />
              )}
            </>
          )}

          {selecting && (
            <BulkActionBar
              count={selection.count}
              visibleCount={visibleVolumeIds.length}
              allVisibleSelected={allVisibleSelected}
              onSelectAllVisible={() => selection.selectAll(visibleVolumeIds)}
              onClear={selection.clear}
              onClose={selection.exit}
              onApply={applyBulk}
              busy={bulkBusy}
              userId={user?.id}
              currency={editionCurrency(manga)}
              readerId={canToggleOthers && selectedReaderId !== 'ALL' ? selectedReaderId : user?.id}
            />
          )}

          {/* Add Single Volume / Schuber Bar */}
          <div ref={addVolumeRef} className="contents">
            <AddVolumeBar
              canEdit={canEdit}
              handleAddSingleVolume={handleAddSingleVolume}
              handleUploadNewSingleCover={handleUploadNewSingleCover}
              onCancelUpload={cancelNewCoverUpload}
              newVolumeCover={newVolumeCover}
              newVolumeIsbn={newVolumeIsbn}
              setNewVolumeIsbn={setNewVolumeIsbn}
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
              currency={editionCurrency(manga)}
            />
          </div>

        </section>
      </main>

      <DetailBottomBar
        backTo={backTo}
        mangaId={manga.id}
        volumes={volumes}
        canEdit={Boolean(canEdit)}
        isOffline={isOffline}
        onOpenVolume={openScannedVolume}
        onPrefill={prefillScannedVolume}
        onOtherSeries={(other) => navigate(`/manga/${other.id}`, { state: location.state })}
        onAddVolume={focusAddVolume}
      />

      {/* MODALS & OVERLAYS */}
      <Suspense fallback={null}>
        {activeVolume && (
          <VolumeEditModal
            isOpen
            activeVolume={editingVolume}
            onClose={() => setActiveVolume(null)}
            manga={manga}
            mangaId={id}
            canEdit={canEdit}
            user={user}
            onSuccess={fetchManga}
          />
        )}

        {showBatchModal && (
          <BatchAddModal
            isOpen
            onClose={() => setShowBatchModal(false)}
            manga={manga}
            mangaId={id}
            onSuccess={fetchManga}
          />
        )}

        {showBatchReadModal && (
          <BatchReadModal
            isOpen
            onClose={() => setShowBatchReadModal(false)}
            mangaId={id}
            readers={readers}
            selectedReaderId={selectedReaderId}
            user={user}
            onSuccess={fetchManga}
          />
        )}

        {fillingGapNumber !== null && (
          <GapFillModal
            isOpen
            gapNumber={fillingGapNumber}
            onClose={() => setFillingGapNumber(null)}
            manga={manga}
            mangaId={id}
            mpGapMap={mpGapMap}
            canEdit={canEdit}
            gapEditionUnconfirmed={gapEditionUnconfirmed}
            onSuccess={async () => {
              await fetchManga();
              await fetchMpGaps();
            }}
          />
        )}

        {lightboxData && (
          <LightboxGallery
            lightboxData={lightboxData}
            setLightboxData={setLightboxData}
            onClose={() => setLightboxData(null)}
            canEdit={canEdit}
            onSuccess={fetchManga}
          />
        )}

        {showMpEditionModal && mpEnabled && (
          <MpEditionModal
            isOpen
            onClose={() => setShowMpEditionModal(false)}
            manga={manga}
            mpGapData={mpGapData}
            mpGapLoading={mpGapLoading}
            mpGapNotice={mpGapNotice}
            canEdit={canEdit}
            isOffline={isOffline}
            fetchMpGaps={fetchMpGaps}
            handleSyncTotalVolumes={handleSyncTotalVolumes}
            handleBatchAutofillManga={handleBatchAutofillManga}
            batchAutofilling={batchAutofilling}
            handleSelectMpEdition={handleSelectMpEdition}
          />
        )}
      </Suspense>

    </div>
  );
}
