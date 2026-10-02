import { AlertCircle, BookOpen, Building2, CheckCircle2, Coins, Edit3, RefreshCw, Save, Sparkles, Trash2, Upload } from 'lucide-react';

/** Cover, metadata, edit form and progress of the series. Purely presentational; all state and handlers come in via props. */
export default function MangaHeroCard({
  applyEditLookupResult,
  canEdit,
  completionPct,
  editLookingUp,
  editLookupError,
  editLookupResults,
  editing,
  failedCover,
  formData,
  handleCoverUpload,
  handleDeleteManga,
  handleEditLookup,
  handleUpdate,
  manga,
  ownedCount,
  saving,
  setEditLookupResults,
  setEditing,
  setFailedCover,
  setFormData,
  totalOwnedValue,
  totalTarget,
  uploadingCover
}) {
  return (
    <div className="glass-panel p-6 sm:p-8 rounded-3xl border border-slate-800/80 shadow-2xl flex flex-col md:flex-row gap-8 mb-8 relative overflow-hidden">

      {/* Subtle glow background */}
      <div className="absolute top-0 right-0 w-96 h-96 bg-brand-500/10 rounded-full blur-3xl pointer-events-none -mr-20 -mt-20"></div>

      {/* Cover Column */}
      <div className="w-full md:w-64 lg:w-72 shrink-0 flex flex-col items-center">
        <div className="relative group w-48 sm:w-56 md:w-full aspect-[2/3] rounded-2xl overflow-hidden shadow-2xl border border-slate-700/80 bg-slate-950 flex items-center justify-center">
          {manga.cover_image && !failedCover ? (
            <img 
              src={manga.cover_image} 
              alt={manga.title} 
              onError={() => setFailedCover(true)}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" 
            />
          ) : (
            <div className="flex flex-col items-center justify-center text-slate-600 gap-2 p-4 text-center">
              <BookOpen className="w-12 h-12 stroke-[1.5]" />
              <span className="text-xs font-medium">Kein Cover vorhanden</span>
            </div>
          )}

          {/* Cover Upload Overlay */}
          {canEdit && (
            <label 
              htmlFor="cover-upload" 
              className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center gap-2 cursor-pointer transition-opacity backdrop-blur-sm text-white text-xs font-semibold"
            >
              <Upload className="w-6 h-6 text-brand-400" />
              <span>Cover ändern</span>
              <input 
                id="cover-upload" 
                type="file" 
                accept="image/*" 
                className="hidden" 
                onChange={handleCoverUpload}
                disabled={uploadingCover}
              />
            </label>
          )}

          {uploadingCover && (
            <div className="absolute inset-0 bg-black/80 flex items-center justify-center">
              <div className="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"></div>
            </div>
          )}
        </div>

        {/* Quick stats under cover */}
        <div className="w-full mt-4 bg-slate-950/60 rounded-xl p-3 border border-slate-800/80 flex justify-around text-center">
          <div>
            <span className="text-[10px] uppercase font-semibold text-slate-400 block">Bände</span>
            <span className="text-sm font-bold text-white">{ownedCount} / {totalTarget || '?'}</span>
          </div>
          <div className="w-[1px] bg-slate-800"></div>
          <div>
            <span className="text-[10px] uppercase font-semibold text-emerald-400 block">Sammlungswert</span>
            <span className="text-sm font-bold text-emerald-400 font-mono">
              {totalOwnedValue.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
            </span>
          </div>
        </div>
      </div>

      {/* Details Column */}
      <div className="flex-1 relative z-10">
        {editing ? (
          /* EDIT MODE */
          <form onSubmit={handleUpdate} className="space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Edit3 className="w-4 h-4 text-brand-400" /> Manga bearbeiten
              </h2>
              <div className="flex gap-2">
                <button 
                  type="button" 
                  onClick={() => setEditing(false)} 
                  className="btn-secondary text-xs py-1.5 px-3"
                >
                  Abbrechen
                </button>
                <button 
                  type="submit" 
                  className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5"
                  disabled={saving}
                >
                  <Save className="w-3.5 h-3.5" /> {saving ? 'Speichert...' : 'Speichern'}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">Titel der Reihe</label>
                <div className="flex gap-2 items-center">
                  <input 
                    type="text" 
                    className="input-field flex-1" 
                    required
                    value={formData.title} 
                    onChange={e => setFormData({ ...formData, title: e.target.value })} 
                  />
                  <button
                    type="button"
                    onClick={handleEditLookup}
                    disabled={editLookingUp || !formData.title.trim()}
                    className="btn-secondary text-xs flex items-center gap-1.5 whitespace-nowrap px-3 py-2.5 bg-gradient-to-r hover:from-emerald-600/30 hover:to-sky-600/30 border-brand-500/40 text-brand-300 hover:text-white shrink-0"
                    title="Sucht offizielle deutsche Ausgaben über Manga Passion (mit AniList-Fallback)"
                  >
                    {editLookingUp ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Suche...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3.5 h-3.5 text-brand-400" />
                        <span>Auto-Fill</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">Alternativer Titel</label>
                <input 
                  type="text" 
                  className="input-field" 
                  value={formData.alt_title} 
                  onChange={e => setFormData({ ...formData, alt_title: e.target.value })} 
                />
              </div>
            </div>

            {/* Edit Lookup Error */}
            {editLookupError && (
              <div className="bg-amber-500/15 border border-amber-500/30 text-amber-300 p-2.5 rounded-xl text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 text-amber-400" />
                <span>{editLookupError}</span>
              </div>
            )}

            {/* Edit Lookup Results Selector */}
            {editLookupResults && editLookupResults.length > 0 && (
              <div className="bg-slate-950/95 border border-brand-500/40 rounded-xl p-3 space-y-2.5 shadow-xl">
                <div className="flex justify-between items-center text-xs">
                  <span className="font-semibold text-brand-400 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5" /> Treffer auswählen (Manga Passion zuerst):
                  </span>
                  <button 
                    type="button" 
                    onClick={() => setEditLookupResults(null)}
                    className="text-slate-400 hover:text-white text-[11px]"
                  >
                    Schließen
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto custom-scrollbar pr-1">
                  {editLookupResults.map(item => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => applyEditLookupResult(item)}
                      className={`flex items-center gap-2.5 p-2 rounded-lg border text-left transition-all group ${
                        item.source === 'manga_passion'
                          ? 'bg-gradient-to-r from-emerald-950/30 to-slate-900/90 border-emerald-500/40 hover:border-emerald-400 hover:from-emerald-950/50'
                          : 'bg-slate-900/80 hover:bg-brand-950/60 border-slate-800 hover:border-brand-500/50'
                      }`}
                    >
                      {item.cover_image ? (
                        <img 
                          src={item.cover_image} 
                          alt={item.title} 
                          className="w-10 h-14 object-cover rounded shadow shrink-0" 
                        />
                      ) : (
                        <div className="w-10 h-14 bg-slate-800 rounded shrink-0 flex items-center justify-center text-slate-500">
                          <BookOpen className="w-5 h-5" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          {item.source === 'manga_passion' ? (
                            <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-1 py-0.2 rounded text-[9px] font-bold shrink-0">
                              🇩🇪 Manga Passion
                            </span>
                          ) : (
                            <span className="bg-sky-500/20 text-sky-300 border border-sky-500/40 px-1 py-0.2 rounded text-[9px] font-medium shrink-0">
                              🌐 AniList
                            </span>
                          )}
                        </div>
                        <p className="text-xs font-semibold text-white truncate group-hover:text-brand-300">
                          {item.title}
                        </p>
                        <p className="text-[11px] text-slate-400 truncate">
                          {item.author || item.alt_title || 'Unbekannt'}
                        </p>
                        <div className="flex flex-wrap gap-1 mt-1 text-[10px]">
                          {item.publisher && (
                            <span className="bg-purple-500/20 text-purple-300 border border-purple-500/30 px-1.5 py-0.5 rounded font-medium truncate max-w-[120px]">
                              {item.publisher}
                            </span>
                          )}
                          {item.total_volumes && (
                            <span className="bg-slate-800 text-slate-200 border border-slate-700/80 px-1.5 py-0.5 rounded font-bold">
                              {item.total_volumes} Bände
                            </span>
                          )}
                          <span className="bg-slate-800/80 px-1.5 py-0.5 rounded text-slate-400">
                            {item.status}
                          </span>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">Autor / Mangaka</label>
                <input 
                  type="text" 
                  className="input-field" 
                  value={formData.author} 
                  onChange={e => setFormData({ ...formData, author: e.target.value })} 
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">Standard-Verlag</label>
                <input 
                  type="text" 
                  className="input-field" 
                  value={formData.publisher} 
                  onChange={e => setFormData({ ...formData, publisher: e.target.value })} 
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">Status</label>
                <select 
                  className="input-field bg-slate-950"
                  value={formData.status} 
                  onChange={e => setFormData({ ...formData, status: e.target.value })}
                >
                  <option value="Laufend">Laufend</option>
                  <option value="Abgeschlossen">Abgeschlossen</option>
                  <option value="Pausiert">Pausiert</option>
                  <option value="Geplant">Geplant</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">Geplante Gesamtbände</label>
                <input 
                  type="number" 
                  min="1"
                  className="input-field" 
                  value={formData.total_volumes} 
                  onChange={e => setFormData({ ...formData, total_volumes: e.target.value })} 
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">Cover-Bild</label>
                <div className="flex gap-2 items-center">
                  <input 
                    type="text" 
                    className="input-field flex-1" 
                    placeholder="URL oder Datei hochladen"
                    value={formData.cover_image} 
                    onChange={e => setFormData({ ...formData, cover_image: e.target.value })} 
                  />
                  <label className="btn-secondary text-xs flex items-center gap-1.5 cursor-pointer shrink-0 py-2.5 px-3">
                    <Upload className="w-3.5 h-3.5" />
                    Bild
                    <input 
                      type="file" 
                      accept="image/*" 
                      className="hidden" 
                      onChange={handleCoverUpload}
                      disabled={uploadingCover}
                    />
                  </label>
                </div>
                {uploadingCover && (
                  <p className="text-xs text-brand-400 mt-1 flex items-center gap-1.5">
                    <span className="w-3 h-3 border-2 border-brand-500 border-t-transparent rounded-full animate-spin inline-block"></span>
                    Cover wird hochgeladen...
                  </p>
                )}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1">Beschreibung</label>
              <textarea 
                rows="3" 
                className="input-field resize-none" 
                value={formData.description} 
                onChange={e => setFormData({ ...formData, description: e.target.value })} 
              />
            </div>
          </form>
        ) : (
          /* VIEW MODE */
          <div className="flex flex-col h-full justify-between">
            <div>
              {/* Title & Action Buttons */}
              <div className="flex flex-col sm:flex-row justify-between items-start gap-4 mb-3">
                <div>
                  <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
                    {manga.title}
                  </h1>
                  {manga.alt_title && (
                    <p className="text-sm text-slate-400 mt-0.5">{manga.alt_title}</p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {canEdit ? (
                    <>
                      <button 
                        onClick={() => setEditing(true)} 
                        className="btn-secondary text-xs flex items-center gap-1.5 py-2 px-3"
                      >
                        <Edit3 className="w-3.5 h-3.5" /> Bearbeiten
                      </button>
                      <button 
                        onClick={handleDeleteManga} 
                        className="btn-danger text-xs flex items-center gap-1.5 py-2 px-3"
                        title="Reihe löschen"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  ) : (
                    <span className="text-xs bg-slate-800/80 text-slate-400 px-3 py-1.5 rounded-xl border border-slate-700/60 font-medium">
                      Nur Leseansicht (Gast)
                    </span>
                  )}
                </div>
              </div>

              {/* Badges */}
              <div className="flex flex-wrap items-center gap-2 text-xs mb-6">
                <span className="bg-slate-800/90 text-slate-200 px-3 py-1 rounded-xl border border-slate-700/80 font-medium">
                  Autor: <strong className="text-white">{manga.author || 'Unbekannt'}</strong>
                </span>
                <span className="bg-slate-800/90 text-slate-200 px-3 py-1 rounded-xl border border-slate-700/80 font-medium flex items-center gap-1.5">
                  <Building2 className="w-3.5 h-3.5 text-brand-400" />
                  Verlag: <strong className="text-white">{manga.publisher || 'Unbekannt'}</strong>
                </span>
                <span className="bg-sky-500/20 text-sky-300 border border-sky-500/40 px-3 py-1 rounded-xl font-semibold">
                  {manga.status || 'Laufend'}
                </span>
                <span className="bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 px-3 py-1 rounded-xl font-semibold">
                  Gesamt: {totalTarget > 0 ? `${totalTarget} Bände` : 'Unbekannt'}
                </span>
                <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-3 py-1 rounded-xl font-semibold flex items-center gap-1.5">
                  <Coins className="w-3.5 h-3.5 text-emerald-400" />
                  Sammlungswert: <strong className="text-white font-mono">{totalOwnedValue.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</strong>
                </span>
              </div>

              {/* Description */}
              <div className="mb-6">
                <h3 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-2">Beschreibung</h3>
                <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-line max-w-2xl bg-slate-950/40 p-4 rounded-2xl border border-slate-800/60">
                  {manga.description || 'Keine Beschreibung vorhanden. Klicke auf "Bearbeiten", um eine Inhaltsangabe hinzuzufügen.'}
                </p>
              </div>
            </div>

            {/* Progress bar */}
            <div className="pt-4 border-t border-slate-800/80">
              <div className="flex justify-between items-center text-xs mb-2">
                <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  Sammlungs-Fortschritt
                </span>
                <span className="text-slate-400 font-mono">
                  <strong className="text-emerald-400">{ownedCount}</strong> {totalTarget > 0 ? `/ ${totalTarget}` : 'im Besitz'} 
                  {completionPct !== null && ` (${completionPct}%)`}
                </span>
              </div>
              <div className="w-full h-2.5 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                <div 
                  className="h-full bg-gradient-to-r from-brand-500 to-emerald-400 transition-all duration-500"
                  style={{ width: `${completionPct !== null ? completionPct : 0}%` }}
                />
              </div>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
