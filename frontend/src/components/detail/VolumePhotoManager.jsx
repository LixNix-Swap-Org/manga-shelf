import { Camera, Link as LinkIcon, Plus, Star, Trash2, Upload } from 'lucide-react';

/** Cover and photo gallery manager for a volume (upload, URL, reorder, delete, set cover). Purely presentational; all state and handlers come in via props. */
export default function VolumePhotoManager({
  editVolForm,
  handleAddImageUrl,
  handleMoveVolumeImage,
  handleRemoveVolumeImage,
  handleSetVolumeCover,
  handleUploadVolumeImages,
  manualImageUrl,
  onPreviewImage,
  setManualImageUrl,
  setShowUrlInput,
  showUrlInput,
  uploadingVolImage
}) {
  return (
    <div className="p-3.5 sm:p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
        <div>
          <span className="text-xs font-bold text-white flex items-center gap-1.5">
            <Camera className="w-4 h-4 text-brand-400" />
            Fotos & Cover für diesen Band
          </span>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Cover, Buchrücken oder Fotos vom Zustand hinzufügen
          </p>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <button
            type="button"
            onClick={() => setShowUrlInput(!showUrlInput)}
            className="flex-1 sm:flex-initial justify-center text-xs text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-850 border border-slate-800 px-2.5 py-1.5 rounded-xl transition-all flex items-center gap-1.5 shadow-sm"
          >
            <LinkIcon className="w-3.5 h-3.5 text-slate-400" />
            <span>{showUrlInput ? 'Abbrechen' : 'URL eingeben'}</span>
          </button>

          <label className={`flex-1 sm:flex-initial justify-center btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5 cursor-pointer shadow-md ${uploadingVolImage ? 'opacity-50 pointer-events-none' : ''}`}>
            <Upload className="w-3.5 h-3.5" />
            <span>{uploadingVolImage ? 'Lädt...' : 'Fotos hochladen'}</span>
            <input 
              type="file" 
              multiple 
              accept="image/*" 
              className="hidden" 
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  handleUploadVolumeImages(Array.from(e.target.files));
                  e.target.value = '';
                }
              }} 
            />
          </label>
        </div>
      </div>

      {/* Manual URL Input dropdown if toggled */}
      {showUrlInput && (
        <div className="space-y-1.5 p-2.5 bg-slate-900/90 rounded-xl border border-slate-800 animate-fade-in">
          <div className="flex items-center gap-2">
            <input 
              type="text"
              placeholder="Bild-URL oder Manga-Passion Link (z. B. https://www.manga-passion.de/volumes/9736/...)"
              className="input-field text-xs py-1.5 flex-1"
              value={manualImageUrl}
              onChange={e => setManualImageUrl(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddImageUrl(); } }}
            />
            <button
              type="button"
              onClick={handleAddImageUrl}
              className="btn-primary text-xs py-1.5 px-3 shrink-0"
            >
              {manualImageUrl.includes('manga-passion.de') ? '✨ Importieren' : 'Hinzufügen'}
            </button>
          </div>
          <p className="text-[10px] text-slate-400">
            💡 Unterstützt direkte Bild-Links sowie offizielle <span className="text-sky-400 font-medium">Manga Passion Bände- & Schuber-URLs</span> (lädt Cover, Titel & Datum automatisch herunter).
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
                <img 
                  src={imgUrl} 
                  alt={`Foto ${idx + 1}`} 
                  className="w-full h-full object-cover cursor-pointer hover:scale-105 transition-transform duration-200"
                  onClick={() => onPreviewImage?.(imgUrl)}
                />

                {/* Quick Actions (Move & Delete): Accessible on mobile and desktop */}
                <div className="absolute top-1.5 right-1.5 flex items-center gap-1 z-10">
                  {idx > 0 && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleMoveVolumeImage(idx, idx - 1); }}
                      className="w-6 h-6 rounded-lg bg-black/80 hover:bg-slate-700 text-white text-xs flex items-center justify-center transition-colors shadow border border-white/10"
                      title="Nach links verschieben"
                    >
                      ◀
                    </button>
                  )}
                  {idx < editVolForm.images.length - 1 && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleMoveVolumeImage(idx, idx + 1); }}
                      className="w-6 h-6 rounded-lg bg-black/80 hover:bg-slate-700 text-white text-xs flex items-center justify-center transition-colors shadow border border-white/10"
                      title="Nach rechts verschieben"
                    >
                      ▶
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleRemoveVolumeImage(imgUrl); }}
                    className="w-6 h-6 rounded-lg bg-red-600/90 hover:bg-red-500 text-white shadow flex items-center justify-center transition-colors"
                    title="Bild löschen"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>

                {/* Bottom Cover Action / Indicator */}
                <div className="absolute bottom-1.5 inset-x-1.5 z-10">
                  {isCover ? (
                    <span className="w-full py-1 px-1.5 rounded-lg text-[10px] font-bold bg-brand-500 text-white shadow-md flex items-center justify-center gap-1">
                      <Star className="w-3 h-3 fill-current" /> Cover
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleSetVolumeCover(imgUrl); }}
                      className="w-full py-1 px-1.5 text-[10px] bg-black/80 hover:bg-brand-600 text-slate-200 hover:text-white rounded-lg shadow-md font-semibold transition-colors flex items-center justify-center gap-1 border border-white/10"
                      title="Als Hauptcover festlegen"
                    >
                      <Star className="w-3 h-3" /> Setze Cover
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {/* Add More Photos tile */}
          <label className="rounded-xl border-2 border-dashed border-slate-800 hover:border-brand-500/60 aspect-[3/4] bg-slate-900/40 hover:bg-slate-900/80 flex flex-col items-center justify-center text-slate-400 hover:text-brand-300 cursor-pointer transition-all group">
            <Plus className="w-5 h-5 mb-1 text-slate-500 group-hover:text-brand-400 transition-colors" />
            <span className="text-[11px] font-semibold">+ Foto</span>
            <input 
              type="file" 
              multiple 
              accept="image/*" 
              className="hidden" 
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  handleUploadVolumeImages(Array.from(e.target.files));
                  e.target.value = '';
                }
              }} 
            />
          </label>
        </div>
      ) : (
        <label className="border-2 border-dashed border-slate-800 hover:border-brand-500/60 rounded-2xl p-5 text-center transition-all bg-slate-900/30 hover:bg-slate-900/70 cursor-pointer flex flex-col items-center justify-center group block">
          <input 
            type="file" 
            multiple 
            accept="image/*" 
            className="hidden" 
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                handleUploadVolumeImages(Array.from(e.target.files));
                e.target.value = '';
              }
            }} 
          />
          <div className="w-10 h-10 rounded-xl bg-brand-500/10 border border-brand-500/30 flex items-center justify-center text-brand-400 mb-2 group-hover:scale-110 group-hover:bg-brand-500/20 transition-all">
            <Upload className="w-5 h-5" />
          </div>
          <span className="text-xs font-semibold text-slate-200 group-hover:text-brand-300 transition-colors">
            {uploadingVolImage ? 'Fotos werden hochgeladen...' : 'Hier klicken oder Fotos auswählen'}
          </span>
          <span className="text-[11px] text-slate-500 mt-1">
            Unterstützt JPG, PNG, WebP (Cover, Buchrücken, Detailfotos)
          </span>
        </label>
      )}
    </div>
  );
}
