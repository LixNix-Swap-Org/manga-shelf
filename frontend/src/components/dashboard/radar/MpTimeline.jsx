import { Link } from 'react-router-dom';
import { getVolumeDisplayTitle } from '../../../utils/volumeHelpers';
import { Package, Calendar, Star, RefreshCw, BookOpen, Building2, CheckCircle2, ShoppingCart } from 'lucide-react';

/** Calendar entries grouped by release day, with loading and empty states. */
export default function MpTimeline({
  loadingMp,
  mpYear,
  mpMonth,
  setMpPrintOnly,
  mpMySeriesOnly,
  setMpMySeriesOnly,
  mpPublisherFilter,
  setMpPublisherFilter,
  mpSearch,
  setMpSearch,
  canEdit,
  handleImportMangaPassion,
  importingMpId,
  failedImages,
  setFailedImages,
  GERMAN_MONTHS,
  mpDateGroups
}) {
  return (
    <>
      {/* Loading State */}
      {loadingMp && (
        <div className="glass-panel p-12 rounded-2xl border border-slate-800/80 text-center">
          <RefreshCw className="w-8 h-8 text-sky-400 animate-spin mx-auto mb-3" />
          <p className="text-sm font-semibold text-white">Lade Neuerscheinungen von Manga Passion...</p>
          <p className="text-xs text-slate-400 mt-1">Erscheinungstermine, Bände und Preise werden abgeglichen</p>
        </div>
      )}

      {/* Empty State */}
      {!loadingMp && mpDateGroups.length === 0 && (
        <div className="glass-panel p-10 rounded-2xl border border-slate-800/80 text-center">
          <div className="w-16 h-16 rounded-2xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center mx-auto mb-4 text-sky-400">
            <Calendar className="w-8 h-8" />
          </div>
          <h3 className="text-base font-bold text-white mb-1">Keine Neuerscheinungen für diese Auswahl</h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto mb-5 leading-relaxed">
            Für {GERMAN_MONTHS[mpMonth - 1]} {mpYear} wurden mit den aktiven Filtern keine Bände gefunden. Probiere einen anderen Monat oder setze die Filter zurück.
          </p>
          {(mpSearch || mpPublisherFilter !== 'ALL' || mpMySeriesOnly) && (
            <button
              onClick={() => {
                setMpSearch('');
                setMpPublisherFilter('ALL');
                setMpPrintOnly(true);
                setMpMySeriesOnly(false);
              }}
              className="btn-primary text-xs px-4 py-2"
            >
              Filter zurücksetzen
            </button>
          )}
        </div>
      )}

      {/* Grouped by Date Timeline */}
      {!loadingMp && mpDateGroups.length > 0 && (
        <div className="space-y-8">
          {mpDateGroups.map(group => (
            <div key={group.dateKey} className="space-y-3.5">
              <div className="flex flex-wrap items-center justify-between gap-3 pb-2 border-b border-slate-800/80">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-sky-500/20 to-brand-500/20 border border-sky-500/30 flex items-center justify-center text-sky-400 shadow-sm">
                    <Calendar className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-white flex items-center gap-2">
                      <span>{group.dateLabel}</span>
                      <span className="text-xs font-mono font-normal text-slate-400">
                        ({group.items.length} {group.items.length === 1 ? 'Band' : 'Bände'})
                      </span>
                    </h3>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3.5 sm:gap-4">
                {group.items.map(item => {
                  const isOwned = item.user_volume_status === 'Vorhanden';
                  const isPreordered = item.user_volume_status === 'Vorbestellt';
                  const isMissing = item.user_volume_status === 'Fehlt';

                  return (
                    <div
                      key={item.id}
                      className={`glass-card rounded-2xl p-3.5 border transition-all flex flex-col justify-between group relative ${
                        isOwned
                          ? 'border-emerald-500/40 bg-gradient-to-b from-emerald-950/20 via-slate-900/60 to-slate-900/80 shadow-emerald-950/20'
                          : isPreordered
                          ? 'border-sky-500/40 bg-gradient-to-b from-sky-950/20 via-slate-900/60 to-slate-900/80 shadow-sky-950/20'
                          : item.in_collection
                          ? 'border-brand-500/40 bg-gradient-to-b from-brand-950/20 via-slate-900/60 to-slate-900/80 shadow-brand-950/20'
                          : 'border-slate-800/80 hover:border-slate-700 bg-slate-900/60'
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between gap-1.5 mb-2.5">
                          {isOwned ? (
                            <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-[10px] font-bold px-2 py-0.5 rounded-lg flex items-center gap-1">
                              <CheckCircle2 className="w-2.5 h-2.5 text-emerald-400" />
                              <span>Im Regal</span>
                            </span>
                          ) : isPreordered ? (
                            <span className="bg-sky-500/20 text-sky-300 border border-sky-500/40 text-[10px] font-bold px-2 py-0.5 rounded-lg flex items-center gap-1">
                              <Package className="w-2.5 h-2.5 text-sky-400" />
                              <span>Vorbestellt</span>
                            </span>
                          ) : isMissing ? (
                            <span className="bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px] font-bold px-2 py-0.5 rounded-lg flex items-center gap-1">
                              <ShoppingCart className="w-2.5 h-2.5 text-amber-400" />
                              <span>Einkaufsliste</span>
                            </span>
                          ) : item.in_collection ? (
                            <span className="bg-brand-500/20 text-brand-300 border border-brand-500/40 text-[10px] font-bold px-2 py-0.5 rounded-lg flex items-center gap-1" title="Diese Reihe steht bereits in deiner Sammlung">
                              <Star className="w-2.5 h-2.5 text-brand-400" />
                              <span>Reihe im Regal</span>
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-500 font-medium px-1">
                              Neuheit
                            </span>
                          )}

                          {item.is_digital && (
                            <span className="bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-[9px] font-bold px-1.5 py-0.5 rounded-md">
                              eBook
                            </span>
                          )}
                        </div>

                        <div className="flex gap-3">
                          <div className="shrink-0 relative overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-md">
                            {item.cover_image && !failedImages[`radar-${item.id || item.manga_passion_id || item.title}`] ? (
                              <img
                                src={item.cover_image}
                                alt={item.title}
                                loading="lazy"
                                onError={() => setFailedImages(prev => ({ ...prev, [`radar-${item.id || item.manga_passion_id || item.title}`]: true }))}
                                className="w-16 h-24 sm:w-18 sm:h-26 object-cover group-hover:scale-105 transition-transform duration-300"
                              />
                            ) : (
                              <div className="w-16 h-24 sm:w-18 sm:h-26 bg-slate-800 rounded-xl flex items-center justify-center text-slate-600">
                                <BookOpen className="w-6 h-6" />
                              </div>
                            )}
                          </div>

                          <div className="flex-1 min-w-0">
                            {item.in_collection && item.user_manga_id ? (
                              <Link
                                to={`/manga/${item.user_manga_id}`}
                                className="text-xs sm:text-sm font-bold text-white hover:text-sky-300 truncate block transition-colors leading-snug"
                                title={`${item.title} (In deiner Sammlung ansehen)`}
                              >
                                {item.title}
                              </Link>
                            ) : (
                              <span 
                                className="text-xs sm:text-sm font-bold text-white truncate block leading-snug"
                                title={item.title}
                              >
                                {item.title}
                              </span>
                            )}

                            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                              <span className="bg-sky-500/20 text-sky-300 border border-sky-500/30 text-xs font-bold px-2 py-0.5 rounded-lg font-mono">
                                {getVolumeDisplayTitle(item)}
                              </span>
                            </div>

                            <p className="text-[11px] text-slate-400 mt-1.5 truncate flex items-center gap-1">
                              <Building2 className="w-3 h-3 text-brand-400 shrink-0" />
                              <span className="truncate">{item.publisher}</span>
                            </p>

                            <p className="text-[11px] text-slate-300 mt-1 flex items-center gap-1 font-mono">
                              <Calendar className="w-3 h-3 text-sky-400 shrink-0" />
                              <span>
                                {item.date ? item.date.split('-').reverse().join('.') : 'Datum offen'}
                              </span>
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="mt-3 pt-3 border-t border-slate-800/80 flex items-center justify-between gap-2">
                        <div className="font-mono">
                          {item.price > 0 ? (
                            <span className="text-sm font-extrabold text-emerald-400">
                              {item.price.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                            </span>
                          ) : (
                            <span className="text-xs text-slate-500">Preis k.A.</span>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5">
                          {isOwned ? (
                            <Link
                              to={`/manga/${item.user_manga_id}`}
                              className="p-1 px-2.5 rounded-xl bg-emerald-500/20 text-emerald-300 text-xs font-semibold flex items-center gap-1 hover:bg-emerald-500/30 transition-colors"
                            >
                              <span>Im Regal</span> ↗
                            </Link>
                          ) : (
                            <>
                              {canEdit && (
                                <>
                                  {!isPreordered && (
                                    <button
                                      type="button"
                                      disabled={importingMpId === item.id}
                                      onClick={() => handleImportMangaPassion(item, 'Vorbestellt')}
                                      className="bg-sky-600/20 hover:bg-sky-600 text-sky-300 hover:text-white border border-sky-500/40 hover:border-sky-500 py-1 px-2.5 rounded-xl text-xs font-semibold flex items-center gap-1 transition-all active:scale-95 shadow-sm"
                                      title="Diesen Band als vorbestellt in deine Sammlung übernehmen"
                                    >
                                      {importingMpId === item.id ? (
                                        <RefreshCw className="w-3 h-3 animate-spin" />
                                      ) : (
                                        <Package className="w-3 h-3 text-sky-400" />
                                      )}
                                      <span>Vorbestellen</span>
                                    </button>
                                  )}
                                  {!isMissing && !isPreordered && (
                                    <button
                                      type="button"
                                      disabled={importingMpId === item.id}
                                      onClick={() => handleImportMangaPassion(item, 'Fehlt')}
                                      className="bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 py-1 px-2 rounded-xl text-xs font-medium flex items-center gap-1 transition-all active:scale-95"
                                      title="Diesen Band auf die Einkaufsliste setzen"
                                    >
                                      <ShoppingCart className="w-3 h-3 text-slate-400" />
                                    </button>
                                  )}
                                </>
                              )}
                              {item.in_collection && item.user_manga_id && (
                                <Link
                                  to={`/manga/${item.user_manga_id}`}
                                  className="p-1 px-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white text-xs transition-colors"
                                  title="Zu den Manga-Details"
                                >
                                  ↗
                                </Link>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
