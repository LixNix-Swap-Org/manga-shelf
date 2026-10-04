import { useId } from 'react';
import BarcodeScannerButton from '../../common/BarcodeScannerButton';
import { Sparkles, Calendar, Hash, BuildingComplex, FileText } from 'lucide-react';
import { isFullDate, partialDateLabel } from './editorUtils';

const PRECISION = { 4: ' (nur Jahr)', 7: ' (nur Monat)' };

/** A stored YYYY or YYYY-MM date cannot be shown by a date input: name it and let the user clear it. */
function PartialDateHint({ value, onClear, className }) {
  const label = partialDateLabel(value);
  if (!label) return null;
  return (
    <p className={`text-[11px] mt-1 flex items-center gap-1.5 flex-wrap ${className}`}>
      <span>Gespeichert: {label}{PRECISION[String(value).trim().length] || ''}</span>
      <button type="button" onClick={onClear} className="underline hover:text-white">entfernen</button>
    </p>
  );
}

/** Publisher, condition, year, pages, ISBN, dates and notes. */
export default function DetailFields({
  editVolForm,
  setEditVolForm,
  autofillingVolume,
  handleAutofillVolumeData,
  manga
}) {
  const id = useId();
  const setValue = (key, value) => setEditVolForm(prev => ({ ...prev, [key]: value }));
  const setField = (key) => (e) => setValue(key, e.target.value);
  const releaseDate = editVolForm.release_date || '';
  const purchaseDate = editVolForm.purchase_date || '';

  return (
    <div className="space-y-4">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label htmlFor={`${id}-publisher`} className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                        <BuildingComplex className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" /> Verlag
                      </label>
                      {manga?.publisher && (
                        <button
                          type="button"
                          onClick={() => setValue('publisher', manga.publisher)}
                          className="text-[11px] text-brand-400 hover:text-brand-300 underline"
                        >
                          Vom Manga ({manga.publisher}) übernehmen
                        </button>
                      )}
                    </div>
                    <input
                      id={`${id}-publisher`}
                      type="text"
                      placeholder={`z. B. ${manga?.publisher || 'Carlsen Manga, Tokyopop, ...'}`}
                      className="input-field"
                      value={editVolForm.publisher ?? ''}
                      onChange={setField('publisher')}
                    />
                  </div>

                  {/* Row 3: Condition & Release Year */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor={`${id}-condition`} className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                        <Sparkles className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" /> Zustand
                      </label>
                      <select
                        id={`${id}-condition`}
                        className="input-field bg-slate-950"
                        value={editVolForm.condition ?? ''}
                        onChange={setField('condition')}
                      >
                        <option value="">-- Keine Angabe --</option>
                        <option value="Neuwertig">Neuwertig (Mint / Wie neu)</option>
                        <option value="Sehr gut">Sehr gut (Leichte Spuren)</option>
                        <option value="Gut">Gut (Normal gelesen)</option>
                        <option value="Akzeptabel">Akzeptabel (Vergilbt / Knicke)</option>
                        <option value="Mängelexemplar">Mängelexemplar / Stempel</option>
                      </select>
                    </div>

                    <div>
                      <label htmlFor={`${id}-year`} className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                        <Calendar className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" /> Erscheinungsjahr
                      </label>
                      <input
                        id={`${id}-year`}
                        type="number"
                        placeholder="z. B. 2023"
                        className="input-field"
                        value={editVolForm.release_year ?? ''}
                        onChange={setField('release_year')}
                      />
                    </div>
                  </div>

                  {/* Row 4: Pages & ISBN */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor={`${id}-pages`} className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                        <FileText className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" /> Seitenzahl
                      </label>
                      <input
                        id={`${id}-pages`}
                        type="number"
                        placeholder="z. B. 192"
                        className="input-field"
                        value={editVolForm.pages ?? ''}
                        onChange={setField('pages')}
                      />
                    </div>

                    <div>
                      {/* the scanner sits next to the label, not inside it: a label activates its first control */}
                      <div className="mb-1 flex items-center justify-between">
                        <label htmlFor={`${id}-isbn`} className="text-xs font-semibold text-slate-300 flex items-center gap-1">
                          <Hash className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" /> ISBN-Nummer
                        </label>
                        <BarcodeScannerButton
                          compact
                          buttonText="Scannen"
                          onDetected={(isbn) => setValue('isbn', isbn)}
                        />
                      </div>
                      <input
                        id={`${id}-isbn`}
                        type="text"
                        placeholder="z. B. 978-3-551-78901-2"
                        className="input-field font-mono"
                        value={editVolForm.isbn ?? ''}
                        onChange={setField('isbn')}
                      />
                    </div>
                  </div>

                  {/* Row 5: Release date & Purchase date */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-3.5">
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <label htmlFor={`${id}-release-date`} className="text-xs font-semibold text-sky-400 flex items-center gap-1">
                          <Calendar className="w-3.5 h-3.5" aria-hidden="true" /> Erscheinungsdatum (Radar)
                        </label>
                        <button
                          type="button"
                          onClick={() => handleAutofillVolumeData()}
                          disabled={autofillingVolume}
                          className="text-[10px] text-sky-400 hover:text-sky-300 underline font-normal flex items-center gap-1 cursor-pointer"
                          title="Erscheinungsdatum und Details automatisch suchen"
                        >
                          <Sparkles className="w-3 h-3" aria-hidden="true" />
                          {autofillingVolume ? 'Lade...' : 'Auto-Ausfüllen'}
                        </button>
                      </div>
                      <input
                        id={`${id}-release-date`}
                        type="date"
                        className="input-field bg-slate-950 border-sky-500/30 focus:border-sky-500 text-sky-200"
                        value={isFullDate(releaseDate) ? releaseDate : ''}
                        onChange={setField('release_date')}
                      />
                      <PartialDateHint value={releaseDate} onClear={() => setValue('release_date', '')} className="text-sky-300/80" />
                    </div>
                    <div>
                      <label htmlFor={`${id}-purchase-date`} className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                        <Calendar className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" /> Kaufdatum
                      </label>
                      <input
                        id={`${id}-purchase-date`}
                        type="date"
                        className="input-field bg-slate-950"
                        value={isFullDate(purchaseDate) ? purchaseDate : ''}
                        onChange={setField('purchase_date')}
                      />
                      <PartialDateHint value={purchaseDate} onClear={() => setValue('purchase_date', '')} className="text-slate-400" />
                    </div>
                  </div>

                  {/* Row 6: Notes & Extras */}
                  <div>
                    <label htmlFor={`${id}-notes`} className="block text-xs font-semibold text-slate-300 mb-1">
                      Notizen & Besonderheiten (z. B. Extras, Erstauflage, Farbschnitt)
                    </label>
                    <textarea
                      id={`${id}-notes`}
                      rows="2"
                      placeholder="z. B. Erstauflage mit Postkarte, Limited Variant Cover"
                      className="input-field resize-none text-base sm:text-xs"
                      value={editVolForm.notes ?? ''}
                      onChange={setField('notes')}
                    />
                  </div>
    </div>
  );
}
