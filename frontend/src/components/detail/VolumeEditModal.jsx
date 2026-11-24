// Volume editor dialog: composes the volumeEdit/ field groups around useVolumeEditForm.
import { useCallback, useEffect, useRef, useState } from 'react';
import { TriangleExclamationPoint, X } from 'lucide-react';
import VolumePhotoManager from './VolumePhotoManager';
import EditHeader from './volumeEdit/EditHeader';
import AutofillPanel from './volumeEdit/AutofillPanel';
import { editionCurrency, isMpVolume } from '../../utils/editions';
import TypeNumberFields from './volumeEdit/TypeNumberFields';
import StatusPriceFields from './volumeEdit/StatusPriceFields';
import DetailFields from './volumeEdit/DetailFields';
import EditFooter from './volumeEdit/EditFooter';
import OwnersField from './volumeEdit/OwnersField';
import CopiesField from './volumeEdit/CopiesField';
import LastChanged from './volumeEdit/LastChanged';
import useVolumeEditForm from '../../hooks/useVolumeEditForm';
import useDialogA11y from '../../hooks/useDialogA11y';
import { t } from '../../i18n/index.js';
import { askConfirm } from '../modals/askConfirm';

// a confirmation (ConfirmDialog, also the askConfirm one) owns the keyboard while it is open
const confirmOpen = () => Boolean(document.querySelector('[role="dialog"][data-confirm]'));

/** Asks before unsaved input of the editor goes; resolves true when it may. */
export const confirmDiscard = () => askConfirm(t('Deine Eingaben wurden noch nicht gespeichert und gehen verloren.'), {
  title: t('Ungespeicherte Änderungen verwerfen?'), confirmLabel: t('Verwerfen')
});

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
    isEditDirty,
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
  const mpLookup = isMpVolume(activeVolume, manga) && isMpVolume(editVolForm, manga);

  const dialogRef = useDialogA11y(true);
  // closing (backdrop, X, "Abbrechen", Escape, the browser's back) asks first while there is unsaved input: changed
  // fields or an open copy form with changes; owners and copies added or removed are stored already
  const copyDraft = useRef(false);
  const onCopyDraft = useCallback((changed) => { copyDraft.current = changed; }, []);
  const dirtyRef = useRef(false);
  dirtyRef.current = isEditDirty;
  const asking = useRef(false);
  const requestClose = useCallback(async () => {
    if (!dirtyRef.current && !copyDraft.current) { onClose(); return; }
    if (asking.current) return;
    asking.current = true;
    try {
      if (await confirmDiscard()) onClose();
    } finally {
      asking.current = false;
    }
  }, [onClose]);
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || confirmOpen()) return;
      if (!dirtyRef.current && !copyDraft.current) return;
      // only while the editor is the topmost dialog (a picture opened from it closes first)
      const modal = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].pop();
      if (modal && modal !== dialogRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      requestClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [requestClose, dialogRef]);
  // the outer "Speichern" would drop an open copy form's input: asked first
  const saveVolume = async (e) => {
    if (copyDraft.current) {
      e.preventDefault();
      if (!(await confirmDiscard())) return;
      copyDraft.current = false;
      return handleSaveVolume({ preventDefault() {} });
    }
    return handleSaveVolume(e);
  };
  // an owners toggle adds or drops a copy: the copies list reads them again
  const [ownersVersion, setOwnersVersion] = useState(0);

  return (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={t('Band bearbeiten')}
          tabIndex={-1}
          className="outline-none dialog-overlay z-50 bg-black/80 backdrop-blur-md animate-fade-in"
          onClick={(e) => { if (e.target === e.currentTarget) requestClose(); }}
        >
          <div
            className="dialog-box glass-panel max-w-lg max-h-[92vh] supports-[height:100dvh]:max-h-[92dvh] short:max-h-none flex flex-col rounded-2xl sm:rounded-3xl border border-slate-700/80 shadow-2xl relative overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <EditHeader
              editVolForm={editVolForm}
              activeVolume={activeVolume}
              onClose={requestClose}
            />

            <form onSubmit={saveVolume} noValidate className="flex flex-col flex-1 min-h-0 overflow-hidden short:overflow-visible">
              {/* Scrollable Form Body */}
              <div className="flex-1 overflow-y-auto short:overflow-visible p-4 sm:p-6 space-y-4 custom-scrollbar">
                {/* Manga Passion only knows German editions: the stored and the edited volume language must both be German */}
                {mpLookup && (
                  <AutofillPanel
                    editVolForm={editVolForm}
                    autofillingVolume={autofillingVolume}
                    autofillMessage={autofillMessage}
                    setAutofillMessage={setAutofillMessage}
                    handleAutofillVolumeData={handleAutofillVolumeData}
                  />
                )}
                <TypeNumberFields
                  editVolForm={editVolForm}
                  setEditVolForm={setEditVolForm}
                  error={showErrors ? fieldErrors.volume_number : ''}
                  sortAfterError={showErrors ? fieldErrors.sort_after : ''}
                />
                <StatusPriceFields
                  editVolForm={editVolForm}
                  setEditVolForm={setEditVolForm}
                  errors={fieldErrors}
                  currency={editionCurrency(manga)}
                />
                {canEdit && (
                  <OwnersField
                    volumeId={activeVolume.id}
                    owners={activeVolume.owners}
                    users={manga?.reader_stats}
                    currentUser={user}
                    onChanged={(data) => { handleOwnersChanged(data); setOwnersVersion(n => n + 1); }}
                  />
                )}
                <CopiesField
                  volumeId={activeVolume.id}
                  mangaId={mangaId}
                  copies={activeVolume.copies}
                  currentUser={user}
                  canEdit={canEdit}
                  currency={editionCurrency(manga)}
                  ownersVersion={ownersVersion}
                  volume={activeVolume}
                  onChanged={() => handleOwnersChanged({})}
                  onDraftChange={onCopyDraft}
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
                  onCancelUpload={cancelVolumeImageUpload}
                />
                {photoError && (
                  <div role="alert" className="p-2.5 rounded-xl text-xs bg-amber-500/15 border border-amber-500/30 text-amber-300 flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0">
                      <TriangleExclamationPoint className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
                      <div className="min-w-0">
                        <p className="break-words">{photoError.text}{/* i18n-ignore: translated where produced (useVolumeEditForm) */}</p>
                        {photoError.externalUrl && (
                          <button
                            type="button"
                            onClick={() => addExternalImageUrl(photoError.externalUrl)}
                            className="mt-1 underline text-amber-200 hover:text-white"
                          >
                            {t('Trotzdem als externen Link hinzufügen')}
                          </button>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPhotoError(null)}
                      aria-label={t('Meldung schließen')}
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
                  mpLookup={mpLookup}
                />
                <LastChanged item={activeVolume} />
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
                onClose={requestClose}
              />
            </form>
          </div>
      </div>
  );
}
