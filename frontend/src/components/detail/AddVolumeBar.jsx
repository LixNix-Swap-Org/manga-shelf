import { useId } from 'react';
import { regularVolumeNumber } from '../../utils/volumeHelpers';
import { Barcode, Camera, Check, Plus, X } from 'lucide-react';
import { assetImgProps } from '../../utils/api';
import FilePickerButton from '../common/FilePickerButton';
import { t } from '../../i18n/index.js';
import { rich } from '../../i18n/react.jsx';
import { currencySymbol } from '../../utils/format';
import { currencyName } from '../../utils/editions';

const LABEL = 'block text-xs font-semibold text-slate-400 mb-1 truncate';

/** Stable id of the number field: the scan prefill focuses it. */
export const ADD_VOLUME_NUMBER_ID = 'add-volume-number';

// i18n
const SPECIAL_LABELS = ['Guidebook', 'Fanbook', 'Artbook', 'Anthologie'];

/** Highest regular volume number of the series (0 without any). */
export const highestRegularNumber = (volumes = []) => volumes.reduce((max, v) => Math.max(max, regularVolumeNumber(v) ?? 0), 0);

/**
 * One-click presets for entries outside the numbered run: { key, name (translated), type, number, sortAfter }. Band 0 and a
 * half volume stay regular volumes (they sort by their number and count as extras); a guidebook, fanbook, artbook or
 * anthology is a special that stands right after the highest regular volume.
 */
export function specialPresets(volumes = []) {
  const highest = highestRegularNumber(volumes);
  const after = highest > 0 ? String(highest) : '';
  return [
    { key: 'zero', name: t('Band {number}', { number: '0' }), type: 'volume', number: '0', sortAfter: '' },
    { key: 'half', name: t('Band {number}', { number: `${highest}.5` }), type: 'volume', number: `${highest}.5`, sortAfter: '' },
    ...SPECIAL_LABELS.map(label => ({ key: label, name: t(label), type: 'special', number: t(label), sortAfter: after }))
  ];
}

/** Inline form to add a single volume, special edition, schuber or special. Purely presentational: state and handlers via props. */
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
  uploadingNewCover,
  onCancelUpload,
  newVolumeIsbn = '',
  setNewVolumeIsbn,
  newVolumeSortAfter = '',
  setNewVolumeSortAfter,
  volumes = [],
  currency = 'EUR'
}) {
  const ids = useId();
  const cancelUpload = onCancelUpload ?? handleUploadNewSingleCover?.cancel;
  // Enter in a text field submits too: while the photo uploads the volume would be created without it
  const handleSubmit = (e) => {
    if (uploadingNewCover) {
      e.preventDefault();
      return;
    }
    handleAddSingleVolume(e);
  };

  const applyPreset = (preset) => {
    setNewVolumeType(preset.type);
    setNewVolumeNum(preset.number);
    setNewVolumeSortAfter?.(preset.sortAfter);
    document.getElementById(ADD_VOLUME_NUMBER_ID)?.focus();
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
        <form onSubmit={handleSubmit} aria-labelledby={`${ids}-title`} className="pt-6 border-t border-slate-800/80 flex flex-col xl:flex-row items-start xl:items-center justify-between gap-4">
          <div>
            <h3 id={`${ids}-title`} className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <Plus className="w-3.5 h-3.5 text-brand-400" />
              {t('Band, Special Edition oder Schuber hinzufügen')}
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              {t('Typ (Einzelband, Special Edition, Schuber oder Special), Nummer, Status und optional Preis oder Coverfoto eingeben')}
            </p>
            {setNewVolumeSortAfter && (
              <div role="group" aria-labelledby={`${ids}-presets`} className="mt-2 flex flex-wrap items-center gap-1.5 [@media(pointer:coarse)]:gap-2.5">
                <span id={`${ids}-presets`} className="text-xs font-semibold text-slate-400">{t('Sonderband')}</span>
                {specialPresets(volumes).map(preset => (
                  <button
                    key={preset.key}
                    type="button"
                    data-preset={preset.key}
                    onClick={() => applyPreset(preset)}
                    className="hit-44 rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-200 hover:border-brand-500 hover:text-white"
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div id="add-volume-fields" className="grid grid-cols-2 grid-flow-row-dense items-end gap-2.5 w-full sm:flex sm:flex-wrap xl:w-auto">
            <div className="min-w-0 sm:w-40 sm:shrink-0">
              <label htmlFor={`${ids}-type`} className={LABEL}>{t('Typ')}</label>
              <select 
                id={`${ids}-type`}
                className="input-field bg-slate-950 text-base sm:text-sm py-2 px-2 w-full cursor-pointer font-medium"
                value={newVolumeType}
                onChange={e => setNewVolumeType(e.target.value)}
              >
                <option value="volume">{t('Einzelband')}</option>
                <option value="special_edition">{t('Special Edition')}</option>
                <option value="schuber">{t('Schuber')}</option>
                <option value="special">{t('Special / Extra')}</option>
              </select>
            </div>

            <div className="min-w-0 sm:w-32 sm:shrink-0">
              <label htmlFor={ADD_VOLUME_NUMBER_ID} className={LABEL}>{newVolumeType === 'special' ? t('Bezeichnung') : t('Nummer')}</label>
              <input 
                id={ADD_VOLUME_NUMBER_ID}
                type="text" 
                inputMode={newVolumeType === 'special' ? 'text' : 'decimal'}
                placeholder={
                  newVolumeType === 'schuber' ? t('Schuber-Nr.') :
                  newVolumeType === 'special' ? t('z. B. 1') :
                  t('Band-Nr.')
                }
                className="input-field text-base sm:text-sm py-2 px-3 w-full font-medium" 
                value={newVolumeNum} 
                onChange={e => setNewVolumeNum(e.target.value)} 
              />
            </div>

            {newVolumeType === 'special' && setNewVolumeSortAfter && (
              <div className="min-w-0 sm:w-36 sm:shrink-0">
                <label htmlFor={`${ids}-after`} className={LABEL}>{t('Einsortieren nach Band')}</label>
                <input
                  id={`${ids}-after`}
                  type="text"
                  inputMode="decimal"
                  placeholder={t('am Ende')}
                  className="input-field text-base sm:text-sm py-2 px-3 w-full"
                  value={newVolumeSortAfter}
                  onChange={e => setNewVolumeSortAfter(e.target.value)}
                />
              </div>
            )}

            <div className="min-w-0 col-span-2 sm:w-44 sm:shrink-0">
              <label htmlFor={`${ids}-price`} className={LABEL}>{rich('Preis{hint}', { hint: <span className="sr-only"> {t('in {currency}', { currency: currencyName(currency) })}</span> })}</label>
              <input 
                id={`${ids}-price`}
                type="text" 
                inputMode="decimal"
                placeholder={t('Preis ({symbol}, z. B. 7,99)', { symbol: currencySymbol(currency) })} 
                className="input-field text-base sm:text-sm py-2 px-3 w-full text-emerald-400" 
                value={newVolumePrice} 
                onChange={e => setNewVolumePrice(e.target.value)} 
              />
            </div>

            <div className="min-w-0 sm:w-40 sm:shrink-0">
              <label htmlFor={`${ids}-status`} className={LABEL}>{t('Status')}</label>
              <select 
                id={`${ids}-status`}
                className="input-field bg-slate-950 text-base sm:text-sm py-2 px-2 w-full cursor-pointer font-medium"
                value={newVolumeStatus}
                onChange={e => setNewVolumeStatus(e.target.value)}
              >
                <option value="Vorhanden">{t('Im Besitz')}</option>
                <option value="Vorbestellt">{t('Vorbestellt')}</option>
                <option value="Erscheint bald">{t('Erscheint bald')}</option>
                <option value="Fehlt">{t('Fehlt noch')}</option>
              </select>
            </div>

            <div className="min-w-0 col-span-2 sm:w-40 sm:shrink-0" title={t('Erscheinungsdatum (für Release-Radar)')}>
              <label htmlFor={`${ids}-date`} className={LABEL}>{rich('Erscheinungsdatum{hint}', { hint: <span className="sr-only"> {t('(für Release-Radar)')}</span> })}</label>
              <input 
                id={`${ids}-date`}
                type="date" 
                className="input-field text-base sm:text-sm py-2 px-2 w-full min-h-[2.625rem] bg-slate-950" 
                value={newVolumeReleaseDate} 
                onChange={e => setNewVolumeReleaseDate(e.target.value)} 
              />
            </div>

            {/* Optional Cover upload for new volume */}
            <FilePickerButton
              accept="image/*"
              disabled={uploadingNewCover}
              onChange={handlePickCover}
              title={t('Foto/Cover für diesen Band auswählen')}
              label={uploadingNewCover ? t('Foto wird hochgeladen') : (newVolumeCover ? t('Anderes Foto auswählen') : t('Foto auswählen'))}
              className={`btn-secondary text-xs py-2 px-3 min-h-[2.625rem] flex items-center justify-center gap-1.5 shrink-0 ${uploadingNewCover ? 'cursor-wait opacity-70' : 'cursor-pointer'}`}
            >
              {newVolumeCover && !uploadingNewCover
                ? <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                : <Camera className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" />}
              <span>{uploadingNewCover ? t('Lädt...') : t('Foto')}</span>
            </FilePickerButton>

            {uploadingNewCover && cancelUpload && (
              <button
                type="button"
                onClick={cancelUpload}
                className="btn-secondary text-xs py-2 px-3 min-h-[2.625rem] flex items-center justify-center gap-1.5 shrink-0 text-red-300 hover:text-red-200"
                title={t('Foto-Upload abbrechen')}
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" /> {t('Upload abbrechen')}
              </button>
            )}

            {newVolumeCover && (
              <div className="relative group shrink-0 justify-self-start self-center">
                <img {...assetImgProps(newVolumeCover)} alt={t('Gewähltes Foto')} className="w-8 h-8 rounded-lg object-cover border border-brand-500" />
                <button 
                  type="button" 
                  onClick={() => setNewVolumeCover('')} 
                  disabled={uploadingNewCover}
                  aria-label={t('Foto entfernen')}
                  title={t('Foto entfernen')}
                  className="absolute -top-2 -right-2 bg-red-600 text-white rounded-full min-w-6 min-h-6 flex items-center justify-center disabled:opacity-50"
                >
                  <X className="w-3 h-3" aria-hidden="true" />
                </button>
              </div>
            )}

            {newVolumeIsbn && (
              <span className="col-span-2 justify-self-start inline-flex items-center gap-1.5 shrink-0 rounded-lg border border-brand-500/40 bg-brand-500/10 pl-2.5 pr-1 py-1 text-xs font-mono text-brand-200" title={t('Gescannte ISBN wird mit dem Band gespeichert')}>
                <Barcode className="w-3.5 h-3.5" aria-hidden="true" />
                <span>ISBN {newVolumeIsbn}</span>
                {setNewVolumeIsbn && (
                  <button
                    type="button"
                    onClick={() => setNewVolumeIsbn('')}
                    aria-label={t('Gescannte ISBN entfernen')}
                    title={t('Gescannte ISBN entfernen')}
                    className="min-w-6 min-h-6 flex items-center justify-center rounded-md text-slate-300 hover:text-white"
                  >
                    <X className="w-3 h-3" aria-hidden="true" />
                  </button>
                )}
              </span>
            )}

            <button 
              type="submit" 
              disabled={uploadingNewCover}
              title={uploadingNewCover ? t('Foto wird noch hochgeladen') : undefined}
              className="col-span-2 btn-primary text-sm py-2 px-4 min-h-[2.625rem] flex items-center justify-center gap-1.5 shadow-lg shrink-0 disabled:opacity-60 disabled:cursor-wait"
            >
              <Plus className="w-4 h-4" /> {t('Hinzufügen')}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
