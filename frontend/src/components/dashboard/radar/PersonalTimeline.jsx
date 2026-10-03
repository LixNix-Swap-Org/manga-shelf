import { Link } from 'react-router-dom';
import { getVolumeDisplayTitle } from '../../../utils/volumeHelpers';
import { filterRadarItems } from '../../../utils/radarHelpers';
import { Package, Calendar, RefreshCw, BookOpen, Check, Building2, Coins, Clock } from 'lucide-react';

/** Personal pre-orders grouped by month, with the empty state. */
export default function PersonalTimeline({
  setRadarSubView,
  radarData,
  radarPublisherFilter,
  radarStatusFilter,
  radarSearch,
  canEdit,
  handleMarkDelivered,
  markingDeliveredId
}) {
  return (
    <>
      {/* Empty State when no personal releases found */}
      {(!radarData || radarData.total_releases === 0) && (
        <div className="glass-panel p-10 rounded-2xl border border-slate-800/80 text-center">
          <div className="w-16 h-16 rounded-2xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center mx-auto mb-4 text-sky-400">
            <Package className="w-8 h-8" />
          </div>
          <h3 className="text-base font-bold text-white mb-1">Keine anstehenden Vorbestellungen eingetragen</h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto mb-5 leading-relaxed">
            Du hast aktuell keine Bände mit dem Status <strong>„Vorbestellt“</strong> oder <strong>„Erscheint bald“</strong> in deiner Sammlung. Wechsle zum Reiter <strong>„Deutsche Neuheiten“</strong>, um Neuerscheinungen mit 1 Klick vorzubestellen!
          </p>
          <button
            onClick={() => setRadarSubView('passion')}
            className="btn-primary text-xs px-4 py-2"
          >
            Zu den deutschen Neuheiten
          </button>
        </div>
      )}

      {/* Monthly Groups Timeline for Personal Releases */}
      {radarData && radarData.groups && radarData.groups.length > 0 && (
        <div className="space-y-8">
          {radarData.groups.map(group => {
            const visibleItems = filterRadarItems(group.items, { radarPublisherFilter, radarStatusFilter, radarSearch });

            if (visibleItems.length === 0) return null;

            const groupTotalVisible = visibleItems.reduce((sum, it) => sum + (it.price || 0), 0);
            const groupPreorderedVisible = visibleItems.filter(it => ['Vorbestellt', 'Bestellt'].includes(it.status)).length;

            return (
              <div key={group.key} className="space-y-3.5">
                <div className="flex flex-wrap items-center justify-between gap-3 pb-2 border-b border-slate-800/80">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-sky-500/20 to-brand-500/20 border border-sky-500/30 flex items-center justify-center text-sky-400 shadow-sm">
                      <Calendar className="w-4 h-4" />
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-white flex items-center gap-2">
                        <span>{group.label}</span>
                        <span className="text-xs font-mono font-normal text-slate-400">
                          ({visibleItems.length} {visibleItems.length === 1 ? 'Band' : 'Bände'})
                        </span>
                      </h3>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-xs">
                    {groupPreorderedVisible > 0 && (
                      <span className="inline-flex items-center gap-1 bg-sky-500/15 border border-sky-500/30 text-sky-300 font-semibold px-2.5 py-1 rounded-xl">
                        <Package className="w-3 h-3 text-sky-400" />
                        <span>{groupPreorderedVisible} Vorbestellt</span>
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1 bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-mono font-bold px-2.5 py-1 rounded-xl">
                      <Coins className="w-3 h-3 text-emerald-400" />
                      <span>{groupTotalVisible.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
                  {visibleItems.map(item => {
                    const isPreordered = ['Vorbestellt', 'Bestellt'].includes(item.status);
                    const isComingSoon = item.status === 'Erscheint bald';
                    const displayTitle = getVolumeDisplayTitle(item);

                    return (
                      <div
                        key={item.id}
                        className={`glass-card rounded-2xl p-3.5 border transition-all flex flex-col justify-between group relative ${
                          isPreordered 
                            ? 'border-sky-500/40 bg-gradient-to-b from-sky-950/20 via-slate-900/60 to-slate-900/80 hover:border-sky-500/70 shadow-lg shadow-sky-950/20' 
                            : isComingSoon
                            ? 'border-purple-500/40 bg-gradient-to-b from-purple-950/20 via-slate-900/60 to-slate-900/80 hover:border-purple-500/70 shadow-lg shadow-purple-950/20'
                            : 'border-slate-800/80 hover:border-slate-700 bg-slate-900/60'
                        }`}
                      >
                        <div>
                          <div className="flex items-center justify-between gap-1.5 mb-2.5">
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-lg border flex items-center gap-1 shrink-0 ${
                              isPreordered
                                ? 'bg-sky-500/20 text-sky-300 border-sky-500/50'
                                : isComingSoon
                                ? 'bg-purple-500/20 text-purple-300 border-purple-500/50'
                                : 'bg-slate-800 text-slate-300 border-slate-700'
                            }`}>
                              {isPreordered ? <Package className="w-2.5 h-2.5" /> : <Clock className="w-2.5 h-2.5" />}
                              <span>{item.status}</span>
                            </span>

                            {item.countdown_label && (
                              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-lg border truncate ${
                                item.days_until === 0
                                  ? 'bg-emerald-500/25 border-emerald-500/60 text-emerald-300 animate-pulse'
                                  : item.days_until > 0 && item.days_until <= 7
                                  ? 'bg-sky-500/20 border-sky-500/40 text-sky-200'
                                  : item.days_until < 0
                                  ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                                  : 'bg-slate-800/80 border-slate-700/60 text-slate-400'
                              }`}>
                                {item.countdown_label}
                              </span>
                            )}
                          </div>

                          <div className="flex gap-3">
                            <Link 
                              to={`/manga/${item.manga_id}`}
                              className="shrink-0 relative group/thumb overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-md"
                            >
                              {item.vol_cover || item.manga_cover ? (
                                <img
                                  src={item.vol_cover || item.manga_cover}
                                  alt={item.manga_title}
                                  className="w-16 h-24 sm:w-18 sm:h-26 object-cover group-hover/thumb:scale-105 transition-transform duration-300"
                                />
                              ) : (
                                <div className="w-16 h-24 bg-slate-800 rounded-xl flex items-center justify-center text-slate-600">
                                  <BookOpen className="w-6 h-6" />
                                </div>
                              )}
                            </Link>

                            <div className="flex-1 min-w-0">
                              <Link
                                to={`/manga/${item.manga_id}`}
                                className="text-xs sm:text-sm font-bold text-white hover:text-brand-300 truncate block transition-colors leading-snug"
                                title={item.manga_title}
                              >
                                {item.manga_title}
                              </Link>

                              <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                                <span className="bg-sky-500/20 text-sky-300 border border-sky-500/30 text-xs font-bold px-2 py-0.5 rounded-lg font-mono">
                                  {displayTitle}
                                </span>
                              </div>

                              <p className="text-[11px] text-slate-400 mt-1.5 truncate flex items-center gap-1">
                                <Building2 className="w-3 h-3 text-brand-400 shrink-0" />
                                <span className="truncate">{item.effective_publisher}</span>
                              </p>

                              {item.release_date && (
                                <p className="text-[11px] text-slate-300 mt-1 flex items-center gap-1 font-mono">
                                  <Calendar className="w-3 h-3 text-sky-400 shrink-0" />
                                  <span>
                                    {item.release_date.split('-').length === 3 
                                      ? `${item.release_date.split('-')[2]}.${item.release_date.split('-')[1]}.${item.release_date.split('-')[0]}`
                                      : item.release_date}
                                  </span>
                                </p>
                              )}
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
                              <span className="text-xs text-slate-500">Preis n.a.</span>
                            )}
                          </div>

                          <div className="flex items-center gap-1.5">
                            <Link
                              to={`/manga/${item.manga_id}`}
                              className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors text-xs"
                              title="Zu den Manga-Details"
                            >
                              Details ↗
                            </Link>

                            {canEdit && (
                              <button
                                type="button"
                                onClick={() => handleMarkDelivered(item)}
                                disabled={markingDeliveredId === item.id}
                                className="bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/40 hover:border-emerald-500 py-1 px-2.5 rounded-xl text-xs font-semibold flex items-center gap-1 transition-all active:scale-95 shadow-sm"
                                title="Band als geliefert/erhalten markieren (Status wird auf 'Vorhanden' gesetzt)"
                              >
                                {markingDeliveredId === item.id ? (
                                  <RefreshCw className="w-3 h-3 animate-spin" />
                                ) : (
                                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                                )}
                                <span>Geliefert</span>
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
