import { useState } from 'react';
import { Camera, ChevronLeft, ChevronRight, Lightbulb, Link as LinkIcon, Plus, Sparkles, Star, Trash, Upload, X } from 'lucide-react';
import LightboxGallery from './LightboxGallery';
import { getVolumeDisplayTitle } from '../../utils/volumeHelpers';
import { assetImgProps } from '../../utils/api';
import FilePickerButton from '../common/FilePickerButton';
import { t } from '../../i18n/index.js';
import { rich } from '../../i18n/react.jsx';

/**
 * The photos in the editor's order, without duplicates; a cover that is not one of them goes first. Picking another
 * cover in the lightbox therefore never reorders the images under it.
 */
export const editorGalleryImages = (form) => {
  const list = [];
  (Array.isArray(form.images) ? form.images : []).forEach((img) => {
    if (img && !list.includes(img)) list.push(img);
  });
  if (form.cover_image && !list.includes(form.cover_image)) list.unshift(form.cover_image);
  return list;
};

/**
 * Cover and photo gallery manager for a volume; form state comes in via props. In the enlarged view
 * "Als Cover festlegen" only changes the form, the editor's Save stores it.
 */
export default function VolumePhotoManager({
  editVolForm,
  handleAddImageUrl,
  handleMoveVolumeImage,
  handleRemoveVolumeImage,
  handleSetVolumeCover,
  handleUploadVolumeImages,
  manualImageUrl,
  setManualImageUrl,
  setShowUrlInput,
  showUrlInput,
  uploadingVolImage,
  onCancelUpload
}) {
  const [previewIndex, setPreviewIndex] = useState(null);
  const galleryImages = editorGalleryImages(editVolForm);

  const buildLightbox = (index) => (index === null || galleryImages.length === 0 ? null : {
    title: getVolumeDisplayTitle(editVolForm),
    subtitle: t('Vorschau (nicht gespeicherte Änderungen)'),
    volume: { cover_image: editVolForm.cover_image },
    images: galleryImages,
    currentIndex: Math.min(index, galleryImages.length - 1)
  });
  const lightboxData = buildLightbox(previewIndex);
  const setLightboxData = (update) => setPreviewIndex((prev) => {
    const next = typeof update === 'function' ? update(buildLightbox(prev)) : update;
    return next ? next.currentIndex : null;
  });
  const onFilesPicked = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleUploadVolumeImages(Array.from(e.target.files));
      e.target.value = '';
    }
  };
  const openPreview = (imgUrl) => {
    const idx = galleryImages.indexOf(imgUrl);
    if (idx !== -1) setPreviewIndex(idx);
  };

  return (
    <div className="p-3.5 sm:p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
        <div>
          <h3 className="text-xs font-bold text-white flex items-center gap-1.5">
            <Camera className="w-4 h-4 text-brand-400" />
            {t('Fotos & Cover für diesen Band')}
          </h3>
          <p className="text-[11px] text-slate-400 mt-0.5">
            {t('Cover, Buchrücken oder Fotos vom Zustand hinzufügen')}
          </p>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <button
            type="button"
            onClick={() => setShowUrlInput(!showUrlInput)}
            aria-expanded={showUrlInput}
            className="flex-1 sm:flex-initial justify-center text-xs text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-850 border border-slate-800 px-2.5 py-1.5 rounded-xl transition-all flex items-center gap-1.5 shadow-sm"
          >
            <LinkIcon className="w-3.5 h-3.5 text-slate-400" />
            <span>{showUrlInput ? t('Abbrechen') : t('URL eingeben')}</span>
          </button>

          <FilePickerButton
            multiple
            accept="image/*"
            disabled={uploadingVolImage}
            onChange={onFilesPicked}
            className="flex-1 sm:flex-initial justify-center btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5 cursor-pointer shadow-md"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>{uploadingVolImage ? t('Lädt...') : t('Fotos hochladen')}</span>
          </FilePickerButton>
          {uploadingVolImage && onCancelUpload && (
            <button
              type="button"
              onClick={onCancelUpload}
              className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 shrink-0 text-red-300 hover:text-red-200"
              title={t('Foto-Upload abbrechen')}
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" /> {t('Upload abbrechen')}
            </button>
          )}
        </div>
      </div>

      {/* Manual URL Input dropdown if toggled */}
      {showUrlInput && (
        <div className="space-y-1.5 p-2.5 bg-slate-900/90 rounded-xl border border-slate-800 animate-fade-in">
          <div className="flex items-center gap-2">
            <input 
              type="text"
              aria-label={t('Bild-URL oder Manga-Passion-Link')}
              placeholder={t('Bild-URL oder Manga-Passion-Link (z. B. https://www.manga-passion.de/volumes/9736/...)')}
              className="input-field text-base sm:text-xs py-1.5 flex-1"
              value={manualImageUrl}
              onChange={e => setManualImageUrl(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddImageUrl(); } }}
            />
            <button
              type="button"
              onClick={handleAddImageUrl}
              className="btn-primary text-xs py-1.5 px-3 shrink-0 flex items-center gap-1.5"
            >
              {manualImageUrl.includes('manga-passion.de')
                ? <><Sparkles className="w-3.5 h-3.5" aria-hidden="true" />{t('Importieren')}</>
                : t('Hinzufügen')}
            </button>
          </div>
          <p className="text-[10px] text-slate-400 flex items-start gap-1">
            <Lightbulb className="w-3 h-3 shrink-0 mt-px text-amber-300" aria-hidden="true" />
            <span>{rich('Unterstützt direkte Bild-Links sowie offizielle {links} (lädt Cover, Titel & Datum automatisch herunter).', { links: <span className="text-sky-400 font-medium">{t('Manga Passion Bände- & Schuber-URLs')}</span> })}</span>
          </p>
        </div>
      )}

      {/* Uploaded Images Gallery */}
      {editVolForm.images && editVolForm.images.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-1">
          {editVolForm.images.map((imgUrl, idx) => {
            const isCover = editVolForm.cover_image === imgUrl;
            return (
              <div 
                key={idx} 
                className={`group relative rounded-xl border overflow-hidden aspect-[3/4] bg-slate-900 flex flex-col justify-between transition-all ${
                  isCover 
                    ? 'border-brand-500 shadow-md ring-2 ring-brand-500/40' 
                    : 'border-slate-800 hover:border-slate-700'
                }`}
              >
                <button
                  type="button"
                  onClick={() => openPreview(imgUrl)}
                  aria-label={t('Foto {number} vergrößern', { number: idx + 1 })}
                  className="w-full h-full overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400"
                >
                  <img 
                    {...assetImgProps(imgUrl)} 
                    alt={t('Foto {number}', { number: idx + 1 })} 
                    className="w-full h-full object-cover cursor-pointer hover:scale-105 transition-transform duration-200"
                  />
                </button>

                {/* Quick Actions (Move & Delete): Accessible on mobile and desktop */}
                <div className="absolute top-1.5 right-1.5 flex items-center gap-1 [@media(pointer:coarse)]:gap-2 z-10">
                  {idx > 0 && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleMoveVolumeImage(idx, idx - 1); }}
                      className="hit-44 w-6 h-6 [@media(pointer:coarse)]:w-9 [@media(pointer:coarse)]:h-9 rounded-lg bg-black/80 hover:bg-slate-700 text-white text-xs flex items-center justify-center transition-colors shadow border border-white/10"
                      title={t('Nach links verschieben')}
                      aria-label={t('Foto {number} nach links verschieben', { number: idx + 1 })}
                    >
                      <ChevronLeft className="w-3 h-3" aria-hidden="true" />
                    </button>
                  )}
                  {idx < editVolForm.images.length - 1 && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleMoveVolumeImage(idx, idx + 1); }}
                      className="hit-44 w-6 h-6 [@media(pointer:coarse)]:w-9 [@media(pointer:coarse)]:h-9 rounded-lg bg-black/80 hover:bg-slate-700 text-white text-xs flex items-center justify-center transition-colors shadow border border-white/10"
                      title={t('Nach rechts verschieben')}
                      aria-label={t('Foto {number} nach rechts verschieben', { number: idx + 1 })}
                    >
                      <ChevronRight className="w-3 h-3" aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleRemoveVolumeImage(imgUrl); }}
                    className="hit-44 w-6 h-6 [@media(pointer:coarse)]:w-9 [@media(pointer:coarse)]:h-9 rounded-lg bg-red-600/90 hover:bg-red-700 text-white shadow flex items-center justify-center transition-colors"
                    title={t('Bild löschen')}
                    aria-label={t('Foto {number} löschen', { number: idx + 1 })}
                  >
                    <Trash className="w-3 h-3" />
                  </button>
                </div>

                {/* Bottom Cover Action / Indicator */}
                <div className="absolute bottom-1.5 inset-x-1.5 z-10">
                  {isCover ? (
                    <span className="w-full py-1 px-1.5 rounded-lg text-[10px] font-bold bg-brand-700 text-white shadow-md flex items-center justify-center gap-1">
                      <Star className="w-3 h-3 fill-current" /> {t('Cover')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleSetVolumeCover(imgUrl); }}
                      className="w-full py-1 px-1.5 text-[10px] bg-black/80 hover:bg-brand-700 text-slate-200 hover:text-white rounded-lg shadow-md font-semibold transition-colors flex items-center justify-center gap-1 border border-white/10"
                      title={t('Als Hauptcover festlegen')}
                      aria-label={t('Foto {number} als Cover festlegen', { number: idx + 1 })}
                    >
                      <Star className="w-3 h-3" /> {t('Als Cover')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {/* Add More Photos tile */}
          <FilePickerButton
            multiple
            accept="image/*"
            disabled={uploadingVolImage}
            onChange={onFilesPicked}
            label={t('Weitere Fotos hinzufügen')}
            className="rounded-xl border-2 border-dashed border-slate-800 hover:border-brand-500/60 aspect-[3/4] bg-slate-900/40 hover:bg-slate-900/80 flex flex-col items-center justify-center text-slate-400 hover:text-brand-300 cursor-pointer transition-all group"
          >
            <Plus className="w-5 h-5 mb-1 text-slate-400 group-hover:text-brand-400 transition-colors" />
            <span className="text-[11px] font-semibold">{t('+ Foto')}</span>
          </FilePickerButton>
        </div>
      ) : (
        <FilePickerButton
          multiple
          accept="image/*"
          disabled={uploadingVolImage}
          onChange={onFilesPicked}
          className="w-full border-2 border-dashed border-slate-800 hover:border-brand-500/60 rounded-2xl p-5 text-center transition-all bg-slate-900/30 hover:bg-slate-900/70 cursor-pointer flex flex-col items-center justify-center group"
        >
          <div className="w-10 h-10 rounded-xl bg-brand-500/10 border border-brand-500/30 flex items-center justify-center text-brand-400 mb-2 group-hover:scale-110 group-hover:bg-brand-500/20 transition-all">
            <Upload className="w-5 h-5" />
          </div>
          <span className="text-xs font-semibold text-slate-200 group-hover:text-brand-300 transition-colors">
            {uploadingVolImage ? t('Fotos werden hochgeladen...') : t('Hier klicken oder Fotos auswählen')}
          </span>
          <span className="text-[11px] text-slate-400 mt-1">
            {t('Unterstützt JPG, PNG, WebP (Cover, Buchrücken, Detailfotos)')}
          </span>
        </FilePickerButton>
      )}

      <LightboxGallery
        lightboxData={lightboxData}
        setLightboxData={setLightboxData}
        onClose={() => setPreviewIndex(null)}
        canEdit
        onSetCover={handleSetVolumeCover}
      />
    </div>
  );
}
