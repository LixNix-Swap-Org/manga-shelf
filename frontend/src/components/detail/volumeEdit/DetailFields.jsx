import BarcodeScannerButton from '../../common/BarcodeScannerButton';
import { Sparkles, Calendar, Hash, Building2, FileText } from 'lucide-react';

/** Publisher, condition, year, pages, ISBN, dates and notes. */
export default function DetailFields({
  editVolForm,
  setEditVolForm,
  autofillingVolume,
  handleAutofillVolumeData,
  manga
}) {
  return (
    <div className="space-y-4">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                        <Building2 className="w-3.5 h-3.5 text-brand-400" /> Verlag
                      </label>
                      {manga.publisher && (
                        <button
                          type="button"
                          onClick={() => setEditVolForm({ ...editVolForm, publisher: manga.publisher })}
                          className="text-[11px] text-brand-400 hover:text-brand-300 underline"
                        >
                          Vom Manga ({manga.publisher}) übernehmen
                        </button>
                      )}
                    </div>
                    <input 
                      type="text" 
                      placeholder={`z. B. ${manga.publisher || 'Carlsen Manga, Tokyopop, ...'}`}
                      className="input-field" 
                      value={editVolForm.publisher} 
                      onChange={e => setEditVolForm({ ...editVolForm, publisher: e.target.value })} 
                    />
                  </div>

                  {/* Row 3: Condition & Release Year */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                        <Sparkles className="w-3.5 h-3.5 text-amber-400" /> Zustand
                      </label>
                      <select 
                        className="input-field bg-slate-950"
                        value={editVolForm.condition} 
                        onChange={e => setEditVolForm({ ...editVolForm, condition: e.target.value })}
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
                      <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                        <Calendar className="w-3.5 h-3.5 text-slate-400" /> Erscheinungsjahr
                      </label>
                      <input 
                        type="number" 
                        placeholder="z. B. 2023"
                        className="input-field" 
                        value={editVolForm.release_year} 
                        onChange={e => setEditVolForm({ ...editVolForm, release_year: e.target.value })} 
                      />
                    </div>
                  </div>

                  {/* Row 4: Pages & ISBN */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                        <FileText className="w-3.5 h-3.5 text-slate-400" /> Seitenzahl
                      </label>
                      <input 
                        type="number" 
                        placeholder="z. B. 192"
                        className="input-field" 
                        value={editVolForm.pages} 
                        onChange={e => setEditVolForm({ ...editVolForm, pages: e.target.value })} 
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center justify-between">
                        <span className="flex items-center gap-1">
                          <Hash className="w-3.5 h-3.5 text-slate-400" /> ISBN-Nummer
                        </span>
                        <BarcodeScannerButton 
                          compact 
                          buttonText="Scannen"
                          onDetected={(isbn) => {
                            setEditVolForm(prev => ({ ...prev, isbn }));
                          }} 
                        />
                      </label>
                      <input 
                        type="text" 
                        placeholder="z. B. 978-3-551-78901-2"
                        className="input-field font-mono" 
                        value={editVolForm.isbn} 
                        onChange={e => setEditVolForm({ ...editVolForm, isbn: e.target.value })} 
                      />
                    </div>
                  </div>

                  {/* Row 5: Release date & Purchase date */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-3.5">
                    <div>
                      <label className="block text-xs font-semibold text-sky-400 mb-1 flex items-center justify-between">
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3.5 h-3.5" /> Erscheinungsdatum (Radar)
                        </span>
                        <button
                          type="button"
                          onClick={() => handleAutofillVolumeData()}
                          disabled={autofillingVolume}
                          className="text-[10px] text-sky-400 hover:text-sky-300 underline font-normal flex items-center gap-1 cursor-pointer"
                          title="Erscheinungsdatum und Details automatisch suchen"
                        >
                          <Sparkles className="w-3 h-3" />
                          {autofillingVolume ? 'Lade...' : 'Auto-Ausfüllen'}
                        </button>
                      </label>
                      <input 
                        type="date" 
                        className="input-field bg-slate-950 border-sky-500/30 focus:border-sky-500 text-sky-200" 
                        value={editVolForm.release_date || ''} 
                        onChange={e => setEditVolForm({ ...editVolForm, release_date: e.target.value })} 
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                        <Calendar className="w-3.5 h-3.5 text-slate-400" /> Kaufdatum
                      </label>
                      <input 
                        type="date" 
                        className="input-field bg-slate-950" 
                        value={editVolForm.purchase_date} 
                        onChange={e => setEditVolForm({ ...editVolForm, purchase_date: e.target.value })} 
                      />
                    </div>
                  </div>

                  {/* Row 6: Notes & Extras */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      Notizen & Besonderheiten (z. B. Extras, Erstauflage, Farbschnitt)
                    </label>
                    <textarea 
                      rows="2" 
                      placeholder="z. B. Erstauflage mit Postkarte, Limited Variant Cover"
                      className="input-field resize-none text-xs" 
                      value={editVolForm.notes} 
                      onChange={e => setEditVolForm({ ...editVolForm, notes: e.target.value })} 
                    />
                  </div>
    </div>
  );
}
