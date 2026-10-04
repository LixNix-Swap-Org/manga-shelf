import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getVolumeDisplayTitle } from '../../../utils/volumeHelpers';
import {
  selectVisibleRadarGroups, radarViewState, isOrderedStatus, UPCOMING_STATUS, deliveredLabel, formatReleaseDate
} from '../../../utils/radarHelpers';
import { Package, Calendar, RefreshCw, BookOpen, Check, BuildingComplex, Coins, Clock, CircleAlert, SearchX } from 'lucide-react';
import CoverImage from '../../common/CoverImage';
import { formatCount, formatEuro } from '../../../utils/format';

const EMPTY_SET = new Set();
// items per month before 'Alle N anzeigen'; long months otherwise mount hundreds of cards at once
export const GROUP_PREVIEW = 24;

const COVER_FALLBACK = (
  <div aria-hidden="true" className="w-16 h-24 sm:w-18 sm:h-26 bg-slate-800 rounded-xl flex items-center justify-center text-slate-500">
    <BookOpen className="w-6 h-6" />
  </div>
);

function RadarCover({ item, failedImages, setFailedImages }) {
  // volume cover, else the series cover; a URL the dashboard already knows as broken is skipped
  const sources = [item.vol_cover, item.manga_cover].filter((url) => url && !failedImages[`personal-${url}`]);
  return (
    <CoverImage
      src={sources}
      alt={item.manga_title}
      fallback={COVER_FALLBACK}
      onFail={setFailedImages ? (url) => setFailedImages((prev) => ({ ...prev, [`personal-${url}`]: true })) : undefined}
      className="w-16 h-24 sm:w-18 sm:h-26 object-cover group-hover/thumb:scale-105 transition-transform duration-300"
    />
  );
}

/** Personal pre-orders grouped by month, with loading, error, empty and no-match states. */
export default function PersonalTimeline({
  setRadarSubView,
  radarData,
  loadingRadar,
  radarError,
  onRetry,
  radarPublisherFilter,
  radarStatusFilter,
  radarSearch,
  onResetFilters,
  canEdit,
  onMarkDelivered,
  markingDeliveredIds = EMPTY_SET,
  failedImages = {},
  setFailedImages
}) {
  const view = radarViewState({
    loading: loadingRadar && !radarData,
    error: radarError,
    hasData: Boolean(radarData),
    count: radarData?.total_releases || 0
  });
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const visibleGroups = useMemo(
    () => selectVisibleRadarGroups(radarData?.groups, { radarPublisherFilter, radarStatusFilter, radarSearch }),
    [radarData, radarPublisherFilter, radarStatusFilter, radarSearch]
  );

  if (view === 'idle') return null;

  if (view === 'loading') {
    return (
      <div role="status" className="glass-panel p-12 rounded-2xl border border-slate-800/80 text-center">
        <RefreshCw className="w-8 h-8 text-sky-400 animate-spin mx-auto mb-3" />
        <p className="text-sm font-semibold text-white">Lade deine Vorbestellungen...</p>
      </div>
    );
  }

  if (view === 'error') {
    return (
      <div role="alert" className="glass-panel p-10 rounded-2xl border border-rose-500/30 text-center">
        <div className="w-16 h-16 rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center mx-auto mb-4 text-rose-400">
          <CircleAlert className="w-8 h-8" />
        </div>
        <h3 className="text-base font-bold text-white mb-1">Vorbestellungen konnten nicht geladen werden</h3>
        <p className="text-xs text-slate-400 max-w-md mx-auto mb-5 leading-relaxed">{radarError}</p>
        <button type="button" onClick={onRetry} className="btn-primary text-xs px-4 py-2">
          Erneut laden
        </button>
      </div>
    );
  }

  return (
    <>
      {radarError && (
        <div role="alert" className="p-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-xs text-amber-200 flex flex-wrap items-center justify-between gap-2">
          <span>Aktualisieren fehlgeschlagen ({radarError}) – angezeigt wird der zuletzt geladene Stand.</span>
          <button type="button" onClick={onRetry} className="btn-secondary text-xs px-3 py-1.5">Erneut laden</button>
        </div>
      )}

      {view === 'empty' && (
        <div className="glass-panel p-10 rounded-2xl border border-slate-800/80 text-center">
          <div className="w-16 h-16 rounded-2xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center mx-auto mb-4 text-sky-400">
            <Package className="w-8 h-8" />
          </div>
          <h3 className="text-base font-bold text-white mb-1">Keine anstehenden Vorbestellungen eingetragen</h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto mb-5 leading-relaxed">
            Hier erscheinen vorbestellte und bestellte Bände, Bände mit dem Status <strong>„Erscheint bald“</strong> sowie
            fehlende Bände mit einem Erscheinungstermin ab diesem Monat. Wechsle zum Reiter <strong>„Deutsche Neuheiten“</strong>,
            um Neuerscheinungen mit 1 Klick vorzubestellen!
          </p>
          <button
            type="button"
            onClick={() => setRadarSubView('passion')}
            className="btn-primary text-xs px-4 py-2"
          >
            Zu den deutschen Neuheiten
          </button>
        </div>
      )}

      {view === 'list' && visibleGroups.length === 0 && (
        <div className="glass-panel p-10 rounded-2xl border border-slate-800/80 text-center">
          <div className="w-16 h-16 rounded-2xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center mx-auto mb-4 text-sky-400">
            <SearchX className="w-8 h-8" />
          </div>
          <h3 className="text-base font-bold text-white mb-1">Keine Bände für diese Filter</h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto mb-5 leading-relaxed">
            Keiner deiner {radarData.total_releases} anstehenden Bände passt zu Suche, Status oder Verlag.
          </p>
          <button type="button" onClick={onResetFilters} className="btn-primary text-xs px-4 py-2">
            Filter zurücksetzen
          </button>
        </div>
      )}

      {view === 'list' && visibleGroups.length > 0 && (
        <div className="space-y-8">
          {visibleGroups.map(group => {
            const { visibleItems } = group;
            const capped = !expandedGroups.has(group.key) && visibleItems.length > GROUP_PREVIEW;
            const shownItems = capped ? visibleItems.slice(0, GROUP_PREVIEW) : visibleItems;
            const groupTotalVisible = visibleItems.reduce((sum, it) => sum + (it.price || 0), 0);
            const groupPreorderedVisible = visibleItems.filter(it => isOrderedStatus(it.status)).length;

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
                          ({formatCount(visibleItems.length, 'Band', 'Bände')})
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
                      <span>{formatEuro(groupTotalVisible)}</span>
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
                  {shownItems.map(item => {
                    const isPreordered = isOrderedStatus(item.status);
                    const isComingSoon = item.status === UPCOMING_STATUS;
                    const busy = markingDeliveredIds.has(item.id);
                    const actionLabel = deliveredLabel(item.status);

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
                              tabIndex={-1}
                              aria-hidden="true"
                              className="shrink-0 relative group/thumb overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-md"
                            >
                              <RadarCover item={item} failedImages={failedImages} setFailedImages={setFailedImages} />
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
                                  {getVolumeDisplayTitle(item)}
                                </span>
                              </div>

                              <p className="text-[11px] text-slate-400 mt-1.5 truncate flex items-center gap-1">
                                <BuildingComplex className="w-3 h-3 text-brand-400 shrink-0" />
                                <span className="truncate">{item.effective_publisher}</span>
                              </p>

                              {item.release_date && (
                                <p className="text-[11px] text-slate-300 mt-1 flex items-center gap-1 font-mono">
                                  <Calendar className="w-3 h-3 text-sky-400 shrink-0" />
                                  <span>{formatReleaseDate(item.release_date)}</span>
                                </p>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="mt-3 pt-3 border-t border-slate-800/80 flex items-center justify-between gap-2">
                          <div className="font-mono">
                            {item.price > 0 ? (
                              <span className="text-sm font-extrabold text-emerald-400">{formatEuro(item.price)}</span>
                            ) : (
                              <span className="text-xs text-slate-400">Preis unbekannt</span>
                            )}
                          </div>

                          <div className="flex items-center gap-1.5">
                            <Link
                              to={`/manga/${item.manga_id}`}
                              className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors text-xs"
                              title="Zu den Manga-Details"
                            >
                              Details <span aria-hidden="true">↗</span>
                            </Link>

                            {canEdit && (
                              <button
                                type="button"
                                onClick={() => onMarkDelivered(item)}
                                disabled={busy}
                                className="bg-emerald-600/20 hover:bg-emerald-700 text-emerald-300 hover:text-white border border-emerald-500/40 hover:border-emerald-500 py-1 px-2.5 rounded-xl text-xs font-semibold flex items-center gap-1 transition-all active:scale-95 shadow-sm"
                                title={`Band als ${actionLabel.toLowerCase()} markieren (Status wird auf „Im Besitz“ gesetzt)`}
                              >
                                {busy ? (
                                  <RefreshCw className="w-3 h-3 animate-spin" />
                                ) : (
                                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                                )}
                                <span>{actionLabel}</span>
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {capped && (
                  <div className="flex justify-center">
                    <button
                      type="button"
                      onClick={() => setExpandedGroups((prev) => new Set(prev).add(group.key))}
                      className="btn-secondary text-xs py-1.5 px-3"
                    >
                      Alle {visibleItems.length} anzeigen
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
