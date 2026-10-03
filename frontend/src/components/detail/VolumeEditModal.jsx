import VolumePhotoManager from './VolumePhotoManager';
import EditHeader from './volumeEdit/EditHeader';
import AutofillPanel from './volumeEdit/AutofillPanel';
import TypeNumberFields from './volumeEdit/TypeNumberFields';
import StatusPriceFields from './volumeEdit/StatusPriceFields';
import DetailFields from './volumeEdit/DetailFields';
import EditFooter from './volumeEdit/EditFooter';
import useVolumeEditForm from '../../hooks/useVolumeEditForm';

export default function VolumeEditModal({
  isOpen,
  activeVolume,
  onClose,
  manga,
  mangaId,
  canEdit,
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
    handleUploadVolumeImages,
    handleAddImageUrl,
    handleMoveVolumeImage,
    handleRemoveVolumeImage,
    handleSetVolumeCover,
    handleAutofillVolumeData,
    handleSaveVolume,
    handleDeleteVolume
  } = useVolumeEditForm({ activeVolume, mangaId, canEdit, onClose, onSuccess });

  if (!isOpen || !activeVolume) return null;

  return (
        <div 
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-2 sm:p-4 animate-fade-in overflow-hidden"
          onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <div 
            className="glass-panel w-full max-w-lg max-h-[92vh] flex flex-col rounded-2xl sm:rounded-3xl border border-slate-700/80 shadow-2xl relative overflow-hidden my-auto" 
            onClick={e => e.stopPropagation()}
          >
            <EditHeader
              editVolForm={editVolForm}
              activeVolume={activeVolume}
              onClose={onClose}
            />

            <form onSubmit={handleSaveVolume} className="flex flex-col flex-1 min-h-0 overflow-hidden">
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
                />
                <StatusPriceFields
                  editVolForm={editVolForm}
                  setEditVolForm={setEditVolForm}
                />

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
                />

                <DetailFields
                  editVolForm={editVolForm}
                  setEditVolForm={setEditVolForm}
                  autofillingVolume={autofillingVolume}
                  handleAutofillVolumeData={handleAutofillVolumeData}
                  manga={manga}
                />
              </div>

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
