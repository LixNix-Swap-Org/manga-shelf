// The dialogs of the series page, each loaded on first use and mounted only while open (split from MangaDetail.jsx).
import { lazy, Suspense } from 'react';

const VolumeEditModal = lazy(() => import('./VolumeEditModal'));
const BatchAddModal = lazy(() => import('./BatchAddModal'));
const BatchReadModal = lazy(() => import('./BatchReadModal'));
const GapFillModal = lazy(() => import('./GapFillModal'));
const LightboxGallery = lazy(() => import('./LightboxGallery'));
const MpEditionModal = lazy(() => import('./MpEditionModal'));

export default function DetailDialogs({
  mangaId, activeVolume, editingVolume, setActiveVolume, manga, canEdit, user, fetchManga, showBatchModal, setShowBatchModal, mpGapData, readers, showBatchReadModal, setShowBatchReadModal, selectedReaderId, fillingGapNumber, setFillingGapNumber, mpGapMap, gapEditionUnconfirmed, fetchMpGaps, lightboxData, setLightboxData, showMpEditionModal, mpEnabled, setShowMpEditionModal, mpGapLoading, mpGapNotice, isOffline, handleSyncTotalVolumes, handleBatchAutofillManga, batchAutofilling, handleSelectMpEdition
}) {
  return (
    <Suspense fallback={null}>
      {activeVolume && (
        <VolumeEditModal
          isOpen
          activeVolume={editingVolume}
          onClose={() => setActiveVolume(null)}
          manga={manga}
          mangaId={mangaId}
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
          mangaId={mangaId}
          volumes={manga?.volumes}
          officialTotal={mpGapData?.total_official_volumes}
          people={readers}
          user={user}
          onSuccess={fetchManga}
        />
      )}

      {showBatchReadModal && (
        <BatchReadModal
          isOpen
          onClose={() => setShowBatchReadModal(false)}
          mangaId={mangaId}
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
          mangaId={mangaId}
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
  );
}
