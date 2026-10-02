import { BookCheck, BookOpen, Building2, Coins, Plus, Trash2, X } from 'lucide-react';
import { Link } from 'react-router-dom';

/** Loading / empty state / grid / list of all mangas on the shelf. Purely presentational; all state and handlers come in via props. */
export default function MangaCollectionGrid({
  canEdit,
  failedImages,
  filtered,
  getStatusBadge,
  handleDeleteManga,
  handleOpenModal,
  loading,
  publisherFilter,
  search,
  setFailedImages,
  setPublisherFilter,
  setSearch,
  setStatusFilter,
  statusFilter,
  viewMode
}) {
  return (
    <>
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 text-slate-400 gap-3">
          <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-sm">Lade Sammlung...</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="glass-panel p-8 sm:p-12 rounded-3xl text-center max-w-lg mx-auto my-12 border border-slate-800 animate-fade-in">
          <div className="w-16 h-16 rounded-2xl bg-brand-500/10 border border-brand-500/20 text-brand-400 flex items-center justify-center mx-auto mb-4">
            <BookOpen className="w-8 h-8" />
          </div>
          <h3 className="text-lg font-bold text-white mb-2">
            {search || statusFilter !== 'ALL' || publisherFilter !== 'ALL'
              ? 'Keine Treffer gefunden'
              : 'Deine Sammlung ist noch leer'}
          </h3>
          <p className="text-sm text-slate-400 mb-6">
            {search || statusFilter !== 'ALL' || publisherFilter !== 'ALL'
              ? 'Für die aktuellen Such- und Filtereinstellungen wurden keine passenden Mangas gefunden.'
              : 'Füge deinen ersten Manga hinzu, um Bände und deinen Fortschritt zu verfolgen.'}
          </p>
          {search || statusFilter !== 'ALL' || publisherFilter !== 'ALL' ? (
            <button 
              onClick={() => {
                setSearch('');
                setStatusFilter('ALL');
                setPublisherFilter('ALL');
              }} 
              className="btn-secondary text-sm inline-flex items-center gap-2"
            >
              <X className="w-4 h-4" /> Filter & Suche zurücksetzen
            </button>
          ) : (
            <button onClick={handleOpenModal} className="btn-primary text-sm inline-flex items-center gap-2">
              <Plus className="w-4 h-4" /> Ersten Manga anlegen
            </button>
          )}
        </div>
      ) : viewMode === 'list' ? (
        /* COMPACT LIST VIEW */
        <div className="glass-panel rounded-2xl border border-slate-800/80 overflow-hidden shadow-xl animate-fade-in">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950/60 text-slate-400 font-semibold uppercase tracking-wider text-[11px]">
                  <th className="py-3 px-4 w-16">Cover</th>
                  <th className="py-3 px-4">Titel & Autor</th>
                  <th className="py-3 px-4 hidden sm:table-cell">Verlag</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Bände / Fortschritt</th>
                  <th className="py-3 px-4 text-right hidden md:table-cell">Wert</th>
                  <th className="py-3 px-4 text-right w-24">Aktion</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filtered.map(manga => {
                  const total = manga.total_volumes || 0;
                  const owned = manga.owned_volumes || 0;
                  const pct = total > 0 ? Math.min(100, Math.round((owned / total) * 100)) : null;

                  return (
                    <tr key={manga.id} className="hover:bg-slate-850/60 transition-colors group">
                      <td className="py-2.5 px-4">
                        <Link to={`/manga/${manga.id}`} className="block w-10 h-14 rounded-lg overflow-hidden bg-slate-950 border border-slate-800 shrink-0">
                          {manga.cover_image && !failedImages[manga.id] ? (
                            <img 
                              src={manga.cover_image} 
                              alt="" 
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform" 
                              onError={() => setFailedImages(prev => ({ ...prev, [manga.id]: true }))} 
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-700">
                              <BookOpen className="w-4 h-4" />
                            </div>
                          )}
                        </Link>
                      </td>
                      <td className="py-2.5 px-4">
                        <Link to={`/manga/${manga.id}`} className="font-bold text-white hover:text-brand-400 transition-colors text-sm line-clamp-1">
                          {manga.title}
                        </Link>
                        <div className="text-slate-400 text-xs mt-0.5 line-clamp-1">
                          {manga.author || 'Kein Autor'}
                          {manga.alt_title && <span className="text-slate-500 ml-1.5">({manga.alt_title})</span>}
                        </div>
                      </td>
                      <td className="py-2.5 px-4 hidden sm:table-cell text-slate-300">
                        {manga.publisher ? (
                          <span className="flex items-center gap-1">
                            <Building2 className="w-3 h-3 text-brand-400 shrink-0" />
                            <span>{manga.publisher}</span>
                          </span>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                      <td className="py-2.5 px-4">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider border ${getStatusBadge(manga.status)}`}>
                          {manga.status}
                        </span>
                      </td>
                      <td className="py-2.5 px-4">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white font-mono">
                            {owned} {total > 0 ? `/ ${total}` : 'Bde.'}
                          </span>
                          {manga.read_volume_count > 0 ? (
                            <span className={`text-[10px] font-mono ${
                              manga.read_volume_count >= (manga.owned_volumes || manga.volume_count) && (manga.owned_volumes > 0 || manga.volume_count > 0)
                                ? 'text-emerald-400 font-bold' 
                                : 'text-sky-300'
                            }`}>
                              ({manga.read_volume_count} gelesen • {Math.round(((manga.read_volume_count || 0) / (manga.owned_volumes || manga.volume_count || 1)) * 100)}%)
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-500 font-mono">(Ungelesen)</span>
                          )}
                        </div>
                        {pct !== null && (
                          <div className="w-24 h-1.5 bg-slate-900 rounded-full overflow-hidden border border-slate-800 mt-1">
                            <div 
                              className="h-full bg-gradient-to-r from-brand-500 to-emerald-400 rounded-full" 
                              style={{ width: `${pct}%` }} 
                            />
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-right hidden md:table-cell font-mono font-bold text-emerald-400">
                        {manga.total_value > 0 
                          ? `${manga.total_value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €` 
                          : '—'}
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <Link 
                            to={`/manga/${manga.id}`} 
                            className="btn-secondary py-1 px-2.5 text-xs text-brand-400 hover:text-white"
                          >
                            Details
                          </Link>
                          {canEdit && (
                            <button
                              onClick={(e) => handleDeleteManga(e, manga.id, manga.title)}
                              className="p-1 hover:bg-red-500/20 text-slate-500 hover:text-red-400 rounded-lg transition-colors"
                              title="Manga löschen"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* POSTER / GRID VIEW */
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 min-[1800px]:grid-cols-8 gap-4 sm:gap-5 lg:gap-6 animate-fade-in">
          {filtered.map(manga => {
            const total = manga.total_volumes || 0;
            const owned = manga.owned_volumes || 0;
            const pct = total > 0 ? Math.min(100, Math.round((owned / total) * 100)) : null;

            return (
              <div key={manga.id} className="group relative flex flex-col">
                <Link 
                  to={`/manga/${manga.id}`} 
                  className="glass-card rounded-2xl overflow-hidden border border-slate-800 flex flex-col h-full hover:shadow-2xl hover:shadow-brand-500/10 hover:-translate-y-1.5 transition-all duration-300"
                >
                  {/* Cover Aspect Container */}
                  <div className="aspect-[2/3] bg-slate-950 relative overflow-hidden">
                    {manga.cover_image && !failedImages[manga.id] ? (
                      <img 
                        src={manga.cover_image} 
                        alt="" 
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" 
                        loading="lazy"
                        onError={() => setFailedImages(prev => ({ ...prev, [manga.id]: true }))}
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center text-slate-600 bg-gradient-to-b from-slate-900 to-slate-950 p-4 text-center">
                        <BookOpen className="w-10 h-10 mb-2 opacity-50" />
                        <span className="text-xs text-slate-500">Kein Cover</span>
                      </div>
                    )}

                    {/* Top Badges */}
                    <div className="absolute top-2 left-2 right-2 flex justify-between items-start gap-1 pointer-events-none min-w-0">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider backdrop-blur-md border truncate shrink-0 max-w-[65%] ${getStatusBadge(manga.status)}`}>
                        {manga.status}
                      </span>

                      <span className="bg-slate-950/80 border border-slate-800 text-white text-[11px] font-bold px-1.5 py-0.5 rounded-lg backdrop-blur-md shrink-0">
                        {owned} {total > 0 ? `/ ${total}` : 'Bde.'}
                      </span>
                    </div>

                    {/* Reading Progress Badge */}
                    {manga.read_volume_count > 0 && (
                      <div className="absolute top-9 right-2 pointer-events-none">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md backdrop-blur-md flex items-center gap-1 border shadow-sm ${
                          manga.read_volume_count >= (manga.owned_volumes || manga.volume_count) && (manga.owned_volumes > 0 || manga.volume_count > 0)
                            ? 'bg-emerald-950/90 border-emerald-500/50 text-emerald-300'
                            : 'bg-slate-950/85 border-sky-500/40 text-sky-300'
                        }`}>
                          <BookCheck className="w-2.5 h-2.5" />
                          <span>{manga.read_volume_count}{manga.read_volume_count >= (manga.owned_volumes || manga.volume_count) && (manga.owned_volumes > 0 || manga.volume_count > 0) ? ' ✓' : `/${manga.owned_volumes || manga.volume_count}`}</span>
                        </span>
                      </div>
                    )}

                    {/* Progress Bar at bottom of poster */}
                    {pct !== null && (
                      <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-black/60 backdrop-blur-xs">
                        <div 
                          className="h-full bg-gradient-to-r from-brand-500 to-emerald-400 transition-all duration-500" 
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}
                  </div>

                  {/* Card Body */}
                  <div className="p-3.5 flex flex-col flex-1 justify-between bg-slate-900/40">
                    <div>
                      <h3 className="font-bold text-sm text-white line-clamp-2 min-h-[2.5rem] leading-snug group-hover:text-brand-400 transition-colors" title={manga.title}>
                        {manga.title}
                      </h3>
                      <p className="text-xs text-slate-400 truncate mt-0.5" title={manga.author || ''}>
                        {manga.author || 'Kein Autor'}
                      </p>
                      {manga.publisher && (
                        <p className="text-[11px] text-slate-500 flex items-center gap-1 mt-1 truncate" title={`Verlag: ${manga.publisher}`}>
                          <Building2 className="w-3 h-3 text-brand-400 shrink-0" />
                          <span className="truncate">{manga.publisher}</span>
                        </p>
                      )}
                    </div>

                    <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-[11px]">
                      {manga.total_value > 0 ? (
                        <span className="font-mono font-bold text-emerald-400 flex items-center gap-1">
                          <Coins className="w-3 h-3 text-emerald-400" />
                          {manga.total_value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                        </span>
                      ) : (
                        <span className="text-slate-500">
                          {pct !== null ? `${pct}% komplett` : `${owned} Bände`}
                        </span>
                      )}
                      <span className="text-brand-400 font-semibold group-hover:translate-x-0.5 transition-transform">Details &rarr;</span>
                    </div>
                  </div>
                </Link>

                {/* Delete button (hover) */}
                {canEdit && (
                  <button
                    onClick={(e) => handleDeleteManga(e, manga.id, manga.title)}
                    className="absolute top-2.5 right-2.5 opacity-0 group-hover:opacity-100 bg-red-950/90 hover:bg-red-900 text-red-300 p-1.5 rounded-lg border border-red-700/50 backdrop-blur-md transition-all shadow-lg hover:scale-105 z-10"
                    title="Manga löschen"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
