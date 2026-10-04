import { useId } from 'react';
import { Camera, Plus, X } from 'lucide-react';
import { assetImgProps } from '../../utils/api';
import FilePickerButton from '../common/FilePickerButton';

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
  const ids = useId();
  // Enter in a text field submits too: while the photo uploads the volume would be created without it
  const handleSubmit = (e) => {
    if (uploadingNewCover) {
      e.preventDefault();
      return;
    }
    handleAddSingleVolume(e);
  };

  const handlePickCover = (e) => {
    const file = e.target.files?.[0];
    // reset, so picking the same file again (after removing it or a failed upload) fires onChange
    e.target.value = '';
    if (file) handleUploadNewSingleCover(file);
  };

  return (
    <>
      {canEdit && (
        <form onSubmit={handleSubmit} aria-labelledby={`${ids}-title`} className="pt-6 border-t border-slate-800/80 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <h3 id={`${ids}-title`} className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <Plus className="w-3.5 h-3.5 text-brand-400" />
              Band, Special Edition oder Schuber hinzufügen
            </h3>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Typ (Einzelband, Special Edition, Schuber oder Special), Nummer, Status und optional Preis oder Coverfoto eingeben
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 w-full md:w-auto">
            {/* Type Selection */}
            <div className="w-36 sm:w-40 shrink-0">
              <label htmlFor={`${ids}-type`} className="sr-only">Typ</label>
              <select 
                id={`${ids}-type`}
                className="input-field bg-slate-950 text-base sm:text-sm py-2 px-2.5 w-full cursor-pointer font-medium"
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
              <label htmlFor={`${ids}-number`} className="sr-only">{newVolumeType === 'special' ? 'Bezeichnung' : 'Nummer'}</label>
              <input 
                id={`${ids}-number`}
                type="text" 
                placeholder={
                  newVolumeType === 'schuber' ? 'Schuber-Nr. (z. B. 1)' :
                  newVolumeType === 'special_edition' ? 'Band-Nr. (z. B. 1)' :
                  newVolumeType === 'special' ? 'Bezeichnung (z. B. 1)' :
                  'Band-Nr. (z. B. 11)'
                }
                className="input-field text-base sm:text-sm py-2 px-3 w-full font-medium" 
                value={newVolumeNum} 
                onChange={e => setNewVolumeNum(e.target.value)} 
              />
            </div>

            <div className="w-28 sm:w-32 shrink-0">
              <label htmlFor={`${ids}-price`} className="sr-only">Preis in Euro</label>
              <input 
                id={`${ids}-price`}
                type="text" 
                inputMode="decimal"
                placeholder="Preis (€, z. B. 7,99)" 
                className="input-field text-base sm:text-sm py-2 px-3 w-full font-mono text-emerald-400" 
                value={newVolumePrice} 
                onChange={e => setNewVolumePrice(e.target.value)} 
              />
            </div>

            {/* Status Selection */}
            <div className="w-36 sm:w-40 shrink-0">
              <label htmlFor={`${ids}-status`} className="sr-only">Status</label>
              <select 
                id={`${ids}-status`}
                className="input-field bg-slate-950 text-base sm:text-sm py-2 px-2.5 w-full cursor-pointer font-medium"
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
              <label htmlFor={`${ids}-date`} className="sr-only">Erscheinungsdatum (für Release-Radar)</label>
              <input 
                id={`${ids}-date`}
                type="date" 
                className="input-field text-base sm:text-sm py-2 px-2.5 w-full font-mono bg-slate-950" 
                value={newVolumeReleaseDate} 
                onChange={e => setNewVolumeReleaseDate(e.target.value)} 
              />
            </div>

            {/* Optional Cover upload for new volume */}
            <FilePickerButton
              accept="image/*"
              disabled={uploadingNewCover}
              onChange={handlePickCover}
              title="Foto/Cover für diesen Band auswählen"
              label={uploadingNewCover ? 'Foto wird hochgeladen' : (newVolumeCover ? 'Anderes Foto auswählen' : 'Foto auswählen')}
              className={`btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 shrink-0 ${uploadingNewCover ? 'cursor-wait opacity-70' : 'cursor-pointer'}`}
            >
              <Camera className="w-3.5 h-3.5 text-brand-400" />
              <span>{uploadingNewCover ? 'Lädt...' : (newVolumeCover ? '✓ Foto' : 'Foto')}</span>
            </FilePickerButton>

            {newVolumeCover && (
              <div className="relative group shrink-0">
                <img {...assetImgProps(newVolumeCover)} alt="Gewähltes Foto" className="w-8 h-8 rounded-lg object-cover border border-brand-500" />
                <button 
                  type="button" 
                  onClick={() => setNewVolumeCover('')} 
                  disabled={uploadingNewCover}
                  aria-label="Foto entfernen"
                  title="Foto entfernen"
                  className="absolute -top-2 -right-2 bg-red-600 text-white rounded-full min-w-6 min-h-6 flex items-center justify-center disabled:opacity-50"
                >
                  <X className="w-3 h-3" aria-hidden="true" />
                </button>
              </div>
            )}

            <button 
              type="submit" 
              disabled={uploadingNewCover}
              title={uploadingNewCover ? 'Foto wird noch hochgeladen' : undefined}
              className="btn-primary text-sm py-2 px-4 flex items-center gap-1.5 shadow-lg shrink-0 disabled:opacity-60 disabled:cursor-wait"
            >
              <Plus className="w-4 h-4" /> Hinzufügen
            </button>
          </div>
        </form>
      )}
    </>
  );
}
