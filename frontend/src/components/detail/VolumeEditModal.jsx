import { TriangleAlert, X } from 'lucide-react';
import VolumePhotoManager from './VolumePhotoManager';
import EditHeader from './volumeEdit/EditHeader';
import AutofillPanel from './volumeEdit/AutofillPanel';
import TypeNumberFields from './volumeEdit/TypeNumberFields';
import StatusPriceFields from './volumeEdit/StatusPriceFields';
import DetailFields from './volumeEdit/DetailFields';
import EditFooter from './volumeEdit/EditFooter';
import OwnersField from './volumeEdit/OwnersField';
import useVolumeEditForm from '../../hooks/useVolumeEditForm';
import useDialogA11y from '../../hooks/useDialogA11y';

export default function VolumeEditModal({ isOpen, activeVolume, ...props }) {
  if (!isOpen || !activeVolume) return null;
  // a fresh editor per volume: state and pending requests of the previous one are dropped with it
  return <VolumeEditDialog key={activeVolume.id} activeVolume={activeVolume} {...props} />;
}

function VolumeEditDialog({
  activeVolume,
  onClose,
  manga,
  mangaId,
  canEdit,
  user,
  onSuccess,
  onPreviewImage
}) {
  const {
    editVolForm,
    setEditVolForm,
    savingVol,
    uploadingVolImage,
    showUrlInput,
    setShowUrlInput,
    manualImageUrl,
    setManualImageUrl,
    autofillingVolume,
    autofillMessage,
    setAutofillMessage,
    photoError,
    setPhotoError,
    formError,
    fieldErrors,
    showErrors,
    addExternalImageUrl,
    handleUploadVolumeImages,
    cancelVolumeImageUpload,
    handleAddImageUrl,
    handleMoveVolumeImage,
    handleRemoveVolumeImage,
    handleSetVolumeCover,
    handleAutofillVolumeData,
    handleOwnersChanged,
    handleSaveVolume,
    handleDeleteVolume
  } = useVolumeEditForm({ activeVolume, mangaId, canEdit, onClose, onSuccess });

  const dialogRef = useDialogA11y(true);

  return (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Band bearbeiten"
          tabIndex={-1}
          className="outline-none fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-2 sm:p-4 animate-fade-in overflow-hidden"
          onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <div
            className="glass-panel w-full max-w-lg max-h-[92vh] supports-[height:100dvh]:max-h-[92dvh] flex flex-col rounded-2xl sm:rounded-3xl border border-slate-700/80 shadow-2xl relative overflow-hidden my-auto"
            onClick={e => e.stopPropagation()}
          >
            <EditHeader
              editVolForm={editVolForm}
              activeVolume={activeVolume}
              onClose={onClose}
            />

            <form onSubmit={handleSaveVolume} noValidate className="flex flex-col flex-1 min-h-0 overflow-hidden">
              {/* Scrollable Form Body */}
              <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 custom-scrollbar">
                <AutofillPanel
                  editVolForm={editVolForm}
                  autofillingVolume={autofillingVolume}
                  autofillMessage={autofillMessage}
                  setAutofillMessage={setAutofillMessage}
                  handleAutofillVolumeData={handleAutofillVolumeData}
                />
                <TypeNumberFields
                  editVolForm={editVolForm}
                  setEditVolForm={setEditVolForm}
                  error={showErrors ? fieldErrors.volume_number : ''}
                />
                <StatusPriceFields
                  editVolForm={editVolForm}
                  setEditVolForm={setEditVolForm}
                  errors={fieldErrors}
                />
                {canEdit && (
                  <OwnersField
                    volumeId={activeVolume.id}
                    owners={activeVolume.owners}
                    users={manga?.reader_stats}
                    currentUser={user}
                    onChanged={handleOwnersChanged}
                  />
                )}

                {/* Volume Cover & Images Section */}
                <VolumePhotoManager
                  editVolForm={editVolForm}
                  handleAddImageUrl={handleAddImageUrl}
                  handleMoveVolumeImage={handleMoveVolumeImage}
                  handleRemoveVolumeImage={handleRemoveVolumeImage}
                  handleSetVolumeCover={handleSetVolumeCover}
                  handleUploadVolumeImages={handleUploadVolumeImages}
                  manualImageUrl={manualImageUrl}
                  onPreviewImage={onPreviewImage}
                  setManualImageUrl={setManualImageUrl}
                  setShowUrlInput={setShowUrlInput}
                  showUrlInput={showUrlInput}
                  uploadingVolImage={uploadingVolImage}
                  onCancelUpload={cancelVolumeImageUpload}
                />
                {photoError && (
                  <div role="alert" className="p-2.5 rounded-xl text-xs bg-amber-500/15 border border-amber-500/30 text-amber-300 flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0">
                      <TriangleAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
                      <div className="min-w-0">
                        <p className="break-words">{photoError.text}</p>
                        {photoError.externalUrl && (
                          <button
                            type="button"
                            onClick={() => addExternalImageUrl(photoError.externalUrl)}
                            className="mt-1 underline text-amber-200 hover:text-white"
                          >
                            Trotzdem als externen Link hinzufügen
                          </button>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPhotoError(null)}
                      aria-label="Meldung schließen"
                      className="p-1 -m-1 rounded text-slate-400 hover:text-white shrink-0"
                    >
                      <X className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                )}

                <DetailFields
                  editVolForm={editVolForm}
                  setEditVolForm={setEditVolForm}
                  autofillingVolume={autofillingVolume}
                  handleAutofillVolumeData={handleAutofillVolumeData}
                  manga={manga}
                />
              </div>

              {formError && (
                <p role="alert" className="shrink-0 px-4 sm:px-6 py-2 text-xs text-red-300 bg-red-500/10 border-t border-red-500/30">
                  {formError}
                </p>
              )}
              <EditFooter
                savingVol={savingVol}
                handleDeleteVolume={handleDeleteVolume}
                activeVolume={activeVolume}
                onClose={onClose}
              />
            </form>
          </div>
      </div>
  );
}
