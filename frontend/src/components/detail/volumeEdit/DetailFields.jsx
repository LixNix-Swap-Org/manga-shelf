import { useId } from 'react';
import BarcodeScannerButton from '../../common/BarcodeScannerButton';
import { Sparkles, Calendar, Hash, BuildingComplex, FileText, Languages } from 'lucide-react';
import { isFullDate, partialDateLabel } from './editorUtils';
import { t } from '../../../i18n/index.js';
import { EDITION_LANGUAGES, editionLanguage, isMpEdition, languageName, withCurrent } from '../../../utils/editions';

// i18n
const PRECISION = { 4: 'nur Jahr', 7: 'nur Monat' };

/** A stored YYYY or YYYY-MM date cannot be shown by a date input: name it and let the user clear it. */
function PartialDateHint({ value, onClear, className }) {
  const label = partialDateLabel(value);
  if (!label) return null;
  const precision = PRECISION[String(value).trim().length];
  return (
    <p className={`text-[11px] mt-1 flex items-center gap-1.5 flex-wrap ${className}`}>
      <span>{precision ? t('Gespeichert: {date} ({precision})', { date: label, precision: t(precision) }) : t('Gespeichert: {date}', { date: label })}</span>
      <button type="button" onClick={onClear} className="inline-flex items-center [@media(pointer:coarse)]:min-h-[44px] underline hover:text-white">{t('entfernen')}</button>
    </p>
  );
}

/** Publisher, condition, year, pages, ISBN, dates and notes. */
export default function DetailFields({
  editVolForm,
  setEditVolForm,
  autofillingVolume,
  handleAutofillVolumeData,
  manga,
  mpLookup = isMpEdition(manga)
}) {
  const id = useId();
  const setValue = (key, value) => setEditVolForm(prev => ({ ...prev, [key]: value }));
  const setField = (key) => (e) => setValue(key, e.target.value);
  const releaseDate = editVolForm.release_date || '';
  const purchaseDate = editVolForm.purchase_date || '';

  return (
    <div className="space-y-4">
                  <div>
                    <div className="flex flex-wrap items-center justify-between gap-x-2 mb-1">
                      <label htmlFor={`${id}-publisher`} className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                        <BuildingComplex className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" /> {t('Verlag')}
                      </label>
                      {manga?.publisher && (
                        <button
                          type="button"
                          onClick={() => setValue('publisher', manga.publisher)}
                          className="inline-flex items-center [@media(pointer:coarse)]:min-h-[44px] text-right text-[11px] text-brand-400 hover:text-brand-300 underline"
                        >
                          {t('Vom Manga ({publisher}) übernehmen', { publisher: manga.publisher })}
                        </button>
                      )}
                    </div>
                    <input
                      id={`${id}-publisher`}
                      type="text"
                      placeholder={t('z. B. {publisher}', { publisher: manga?.publisher || t('Carlsen Manga, Tokyopop, ...') })}
                      className="input-field"
                      value={editVolForm.publisher ?? ''}
                      onChange={setField('publisher')}
                    />
                  </div>

                  {/* Row 3: Condition & Release Year */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor={`${id}-condition`} className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                        <Sparkles className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" /> {t('Zustand')}
                      </label>
                      <select
                        id={`${id}-condition`}
                        className="input-field bg-slate-950"
                        value={editVolForm.condition ?? ''}
                        onChange={setField('condition')}
                      >
                        <option value="">{t('-- Keine Angabe --')}</option>
                        <option value="Neuwertig">{t('Neuwertig (Mint / Wie neu)')}</option>
                        <option value="Sehr gut">{t('Sehr gut (Leichte Spuren)')}</option>
                        <option value="Gut">{t('Gut (Normal gelesen)')}</option>
                        <option value="Akzeptabel">{t('Akzeptabel (Vergilbt / Knicke)')}</option>
                        <option value="Mängelexemplar">{t('Mängelexemplar / Stempel')}</option>
                      </select>
                    </div>

                    <div>
                      <label htmlFor={`${id}-year`} className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                        <Calendar className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" /> {t('Erscheinungsjahr')}
                      </label>
                      <input
                        id={`${id}-year`}
                        type="number"
                        inputMode="numeric"
                        placeholder={t('z. B. 2023')}
                        className="input-field"
                        value={editVolForm.release_year ?? ''}
                        onChange={setField('release_year')}
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor={`${id}-language`} className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                      <Languages className="w-3.5 h-3.5 text-teal-400" aria-hidden="true" /> {t('Sprache dieses Bands')}
                    </label>
                    <select
                      id={`${id}-language`}
                      className="input-field bg-slate-950"
                      value={editVolForm.language ?? ''}
                      onChange={setField('language')}
                    >
                      <option value="">{t('Wie die Reihe ({language})', { language: languageName(editionLanguage(manga)) })}</option>
                      {withCurrent(EDITION_LANGUAGES, editVolForm.language || '').map((code) => <option key={code} value={code}>{languageName(code)}</option>)}
                    </select>
                  </div>

                  {/* Row 4: Pages & ISBN */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor={`${id}-pages`} className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                        <FileText className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" /> {t('Seitenzahl')}
                      </label>
                      <input
                        id={`${id}-pages`}
                        type="number"
                        inputMode="numeric"
                        placeholder={t('z. B. 192')}
                        className="input-field"
                        value={editVolForm.pages ?? ''}
                        onChange={setField('pages')}
                      />
                    </div>

                    <div>
                      {/* the scanner sits next to the label, not inside it: a label activates its first control */}
                      <div className="mb-1 flex items-center justify-between">
                        <label htmlFor={`${id}-isbn`} className="text-xs font-semibold text-slate-300 flex items-center gap-1">
                          <Hash className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" /> {t('ISBN-Nummer')}
                        </label>
                        <BarcodeScannerButton
                          compact
                          buttonText={t('Scannen')}
                          onDetected={(isbn) => setValue('isbn', isbn)}
                        />
                      </div>
                      <input
                        id={`${id}-isbn`}
                        type="text"
                        placeholder={t('z. B. 978-3-551-78901-2')}
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
                          <Calendar className="w-3.5 h-3.5" aria-hidden="true" /> {t('Erscheinungsdatum (Radar)')}
                        </label>
                        {/* the lookup asks Manga Passion, which only knows German editions */}
                        {mpLookup && (
                          <button
                            type="button"
                            onClick={() => handleAutofillVolumeData()}
                            disabled={autofillingVolume}
                            className="inline-flex items-center [@media(pointer:coarse)]:min-h-[44px] gap-1 text-[11px] text-sky-400 hover:text-sky-300 underline font-normal cursor-pointer"
                            title={t('Erscheinungsdatum und Details automatisch suchen')}
                          >
                            <Sparkles className="w-3 h-3" aria-hidden="true" />
                            {autofillingVolume ? t('Lade...') : t('Auto-Ausfüllen')}
                          </button>
                        )}
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
                        <Calendar className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" /> {t('Kaufdatum')}
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
                      {t('Notizen & Besonderheiten (z. B. Extras, Erstauflage, Farbschnitt)')}
                    </label>
                    <textarea
                      id={`${id}-notes`}
                      rows="2"
                      placeholder={t('z. B. Erstauflage mit Postkarte, Limited Variant Cover')}
                      className="input-field resize-none text-base sm:text-xs"
                      value={editVolForm.notes ?? ''}
                      onChange={setField('notes')}
                    />
                  </div>
    </div>
  );
}
