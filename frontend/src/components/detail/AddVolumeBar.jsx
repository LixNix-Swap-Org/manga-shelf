import { Camera, Plus, X } from 'lucide-react';

/** Inline form to add a single volume, special edition, schuber or special. Purely presentational; all state and handlers come in via props. */
export default function AddVolumeBar({
  canEdit,
  handleAddSingleVolume,
  handleUploadNewSingleCover,
  newVolumeCover,
  newVolumeNum,
  newVolumePrice,
  newVolumeReleaseDate,
  newVolumeStatus,
  newVolumeType,
  setNewVolumeCover,
  setNewVolumeNum,
  setNewVolumePrice,
  setNewVolumeReleaseDate,
  setNewVolumeStatus,
  setNewVolumeType,
  uploadingNewCover
}) {
  return (
    <>
      {canEdit && (
        <form onSubmit={handleAddSingleVolume} className="pt-6 border-t border-slate-800/80 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider block flex items-center gap-1.5">
              <Plus className="w-3.5 h-3.5 text-brand-400" />
              Band, Special Edition oder Schuber hinzufügen
            </span>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Typ (Einzelband, Special Edition, Schuber oder Special), Nummer, Status und optional Preis oder Coverfoto eingeben
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 w-full md:w-auto">
            {/* Type Selection */}
            <div className="w-36 sm:w-40 shrink-0">
              <select 
                className="input-field bg-slate-950 text-sm py-2 px-2.5 w-full cursor-pointer font-medium"
                value={newVolumeType}
                onChange={e => setNewVolumeType(e.target.value)}
              >
                <option value="volume">📖 Einzelband</option>
                <option value="special_edition">✨ Special Edition</option>
                <option value="schuber">📦 Schuber</option>
                <option value="special">⭐ Special / Extra</option>
              </select>
            </div>

            <div className="w-28 sm:w-32 shrink-0">
              <input 
                type="text" 
                placeholder={
                  newVolumeType === 'schuber' ? 'Schuber-Nr. (z.B. 1)' :
                  newVolumeType === 'special_edition' ? 'Band-Nr. (z.B. 1)' :
                  newVolumeType === 'special' ? 'Bezeichnung (z.B. 1)' :
                  'Band-Nr. (z.B. 11)'
                }
                className="input-field text-sm py-2 px-3 w-full font-medium" 
                value={newVolumeNum} 
                onChange={e => setNewVolumeNum(e.target.value)} 
              />
            </div>

            <div className="w-28 sm:w-32 shrink-0">
              <input 
                type="text" 
                placeholder="Preis (€, z.B. 7.99)" 
                className="input-field text-sm py-2 px-3 w-full font-mono text-emerald-400" 
                value={newVolumePrice} 
                onChange={e => setNewVolumePrice(e.target.value)} 
              />
            </div>

            {/* Status Selection */}
            <div className="w-36 sm:w-40 shrink-0">
              <select 
                className="input-field bg-slate-950 text-sm py-2 px-2.5 w-full cursor-pointer font-medium"
                value={newVolumeStatus}
                onChange={e => setNewVolumeStatus(e.target.value)}
              >
                <option value="Vorhanden">✓ Im Besitz</option>
                <option value="Vorbestellt">📦 Vorbestellt</option>
                <option value="Erscheint bald">⏳ Erscheint bald</option>
                <option value="Fehlt">✕ Fehlt noch</option>
              </select>
            </div>

            {/* Release Date for Radar */}
            <div className="w-36 sm:w-40 shrink-0" title="Erscheinungsdatum (für Release-Radar)">
              <input 
                type="date" 
                className="input-field text-sm py-2 px-2.5 w-full font-mono bg-slate-950" 
                value={newVolumeReleaseDate} 
                onChange={e => setNewVolumeReleaseDate(e.target.value)} 
              />
            </div>

            {/* Optional Cover upload for new volume */}
            <label className="cursor-pointer btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 shrink-0" title="Foto/Cover für diesen Band auswählen">
              <Camera className="w-3.5 h-3.5 text-brand-400" />
              <span>{uploadingNewCover ? 'Lädt...' : (newVolumeCover ? '✓ Foto' : 'Foto')}</span>
              <input 
                type="file" 
                accept="image/*" 
                className="hidden" 
                onChange={e => {
                  if (e.target.files && e.target.files[0]) {
                    handleUploadNewSingleCover(e.target.files[0]);
                  }
                }} 
              />
            </label>

            {newVolumeCover && (
              <div className="relative group shrink-0">
                <img src={newVolumeCover} alt="Cover" className="w-8 h-8 rounded-lg object-cover border border-brand-500" />
                <button 
                  type="button" 
                  onClick={() => setNewVolumeCover('')} 
                  className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-0.5 text-[8px]"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            )}

            <button 
              type="submit" 
              className="btn-primary text-sm py-2 px-4 flex items-center gap-1.5 shadow-lg shrink-0"
            >
              <Plus className="w-4 h-4" /> Hinzufügen
            </button>
          </div>
        </form>
      )}
    </>
  );
}
