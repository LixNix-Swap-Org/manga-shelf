import { Link } from 'react-router-dom';
import { getVolumeDisplayTitle } from '../../../utils/volumeHelpers';
import { formatReleaseDate, mpCardActions, radarViewState, volumeStatusGroup } from '../../../utils/radarHelpers';
import { Package, Calendar, Star, RefreshCw, BookOpen, BuildingComplex, CircleCheck, ShoppingCart, Clock, CircleAlert, Heart, CircleOff, CirclePause } from 'lucide-react';
import { formatCount, formatEuro } from '../../../utils/format';
import CoverImage from '../../common/CoverImage';

const EMPTY_SET = new Set();
const LOADING_TEXT = 'Lade Neuerscheinungen von Manga Passion...';
const COVER_FALLBACK = (
  <div aria-hidden="true" className="w-16 h-24 sm:w-18 sm:h-26 bg-slate-800 rounded-xl flex items-center justify-center text-slate-500">
    <BookOpen className="w-6 h-6" />
  </div>
);
const BADGE = 'text-[10px] font-bold px-2 py-0.5 rounded-lg flex items-center gap-1 border';

/** The series of the entry is no longer collected (mangas.collecting 'abgebrochen'): greyed, never "Einkaufsliste". */
export const isDroppedSeries = (item) => Boolean(item?.in_collection) && item.user_manga_collecting === 'abgebrochen';

const DROPPED_BADGE = (
  <span className={`${BADGE} bg-slate-800 text-slate-400 border-slate-700`} title="Diese Reihe sammelst du nicht mehr">
    <CircleOff className="w-2.5 h-2.5 text-slate-400" />
    <span>Nicht mehr gesammelt</span>
  </span>
);

function StatusBadge({ item }) {
  const status = item.user_volume_status;
  const group = volumeStatusGroup(status);
  if (isDroppedSeries(item) && group !== 'owned' && group !== 'ordered') return DROPPED_BADGE;
  if (group === 'missing' && item.user_manga_collecting === 'pausiert') {
    return (
      <span className={`${BADGE} bg-amber-500/10 text-amber-200 border-amber-500/30`} title="Die Reihe ist pausiert und steht nicht auf der Einkaufsliste">
        <CirclePause className="w-2.5 h-2.5 text-amber-300" />
        <span>Pausiert</span>
      </span>
    );
  }
  switch (group) {
    case 'owned':
      return (
        <span className={`${BADGE} bg-emerald-500/20 text-emerald-300 border-emerald-500/40`}>
          <CircleCheck className="w-2.5 h-2.5 text-emerald-400" />
          <span>{status === 'Gelesen' ? 'Gelesen' : 'Im Besitz'}</span>
        </span>
      );
    case 'ordered':
      return (
        <span className={`${BADGE} bg-sky-500/20 text-sky-300 border-sky-500/40`}>
          <Package className="w-2.5 h-2.5 text-sky-400" />
          <span>{status}</span>
        </span>
      );
    case 'upcoming':
      return (
        <span className={`${BADGE} bg-purple-500/20 text-purple-300 border-purple-500/40`}>
          <Clock className="w-2.5 h-2.5 text-purple-400" />
          <span>Erscheint bald</span>
        </span>
      );
    case 'missing':
      return (
        <span className={`${BADGE} bg-amber-500/20 text-amber-300 border-amber-500/40`}>
          <ShoppingCart className="w-2.5 h-2.5 text-amber-400" />
          <span>Einkaufsliste</span>
        </span>
      );
    default:
      if (item.in_collection && item.match_kind === 'prefix') {
        return (
          <span
            className={`${BADGE} bg-slate-800 text-slate-300 border-slate-700`}
            title={item.user_manga_title ? `Ähnlich wie „${item.user_manga_title}“ in deiner Sammlung` : 'Ähnlicher Titel in deiner Sammlung'}
          >
            <Star className="w-2.5 h-2.5 text-slate-400" />
            <span>Ähnlicher Titel</span>
          </span>
        );
      }
      if (item.in_collection && item.user_manga_wished) {
        return (
          <span className={`${BADGE} bg-rose-500/20 text-rose-300 border-rose-500/40`} title="Diese Reihe steht auf deiner Wunschliste">
            <Heart className="w-2.5 h-2.5 text-rose-400" />
            <span>Auf Wunschliste</span>
          </span>
        );
      }
      if (item.in_collection) {
        return (
          <span className={`${BADGE} bg-brand-500/20 text-brand-300 border-brand-500/40`} title="Diese Reihe steht bereits in deiner Sammlung">
            <Star className="w-2.5 h-2.5 text-brand-400" />
            <span>Reihe im Regal</span>
          </span>
        );
      }
      return <span className="text-[10px] text-slate-400 font-medium px-1">Neuheit</span>;
  }
}

const cardTone = (item) => {
  const group = volumeStatusGroup(item.user_volume_status);
  if (isDroppedSeries(item) && group !== 'owned' && group !== 'ordered') return 'border-slate-800/80 bg-slate-900/40 opacity-60 hover:opacity-100';
  switch (group) {
    case 'owned': return 'border-emerald-500/40 bg-gradient-to-b from-emerald-950/20 via-slate-900/60 to-slate-900/80 shadow-emerald-950/20';
    case 'ordered': return 'border-sky-500/40 bg-gradient-to-b from-sky-950/20 via-slate-900/60 to-slate-900/80 shadow-sky-950/20';
    case 'upcoming': return 'border-purple-500/40 bg-gradient-to-b from-purple-950/20 via-slate-900/60 to-slate-900/80 shadow-purple-950/20';
    default:
      return item.in_collection && item.match_kind !== 'prefix'
        ? 'border-brand-500/40 bg-gradient-to-b from-brand-950/20 via-slate-900/60 to-slate-900/80 shadow-brand-950/20'
        : 'border-slate-800/80 hover:border-slate-700 bg-slate-900/60';
  }
};

/** Calendar entries grouped by release day, with loading, error and empty states. */
export default function MpTimeline({
  mpData,
  loadingMp,
  mpError,
  onRetry,
  mpYear,
  mpMonth,
  canEdit,
  onImport,
  importingMpIds = EMPTY_SET,
  GERMAN_MONTHS,
  mpDateGroups,
  filtersActive,
  onResetFilters
}) {
  const view = radarViewState({ loading: loadingMp, error: mpError, hasData: Boolean(mpData), count: mpDateGroups.length });
  const monthLabel = `${GERMAN_MONTHS[mpMonth - 1]} ${mpYear}`;

  // one live region that stays mounted whatever the view, so the loading text is announced
  const status = <div role="status" className="sr-only">{view === 'loading' ? LOADING_TEXT : ''}</div>;

  if (view === 'idle') return <>{status}</>;

  if (view === 'loading') {
    return (
      <>
        {status}
        <div aria-hidden="true" className="glass-panel p-12 rounded-2xl border border-slate-800/80 text-center">
          <RefreshCw className="w-8 h-8 text-sky-400 animate-spin mx-auto mb-3" />
          <p className="text-sm font-semibold text-white">{LOADING_TEXT}</p>
          <p className="text-xs text-slate-400 mt-1">Erscheinungstermine, Bände und Preise werden abgeglichen</p>
        </div>
      </>
    );
  }

  if (view === 'error') {
    return (
      <>
        {status}
        <div role="alert" className="glass-panel p-10 rounded-2xl border border-rose-500/30 text-center">
          <div className="w-16 h-16 rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center mx-auto mb-4 text-rose-400">
            <CircleAlert className="w-8 h-8" />
          </div>
          <h3 className="text-base font-bold text-white mb-1">Neuerscheinungen für {monthLabel} nicht verfügbar</h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto mb-5 leading-relaxed">{mpError}</p>
          <button type="button" onClick={onRetry} className="btn-primary text-xs px-4 py-2">
            Erneut versuchen
          </button>
        </div>
      </>
    );
  }

  const nothingThisMonth = (mpData.items || []).length === 0;

  return (
    <>
      {status}
      {mpData.stale && (
        <div className="p-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-xs text-amber-200">
          Manga Passion ist gerade nicht erreichbar – angezeigt werden die zuletzt gespeicherten Daten dieses Monats.
        </div>
      )}
      {mpData.truncated && !mpData.stale && (
        <div className="p-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-xs text-amber-200">
          Manga Passion hat nicht alle Einträge dieses Monats geliefert – die Liste kann unvollständig sein.
        </div>
      )}

      {view === 'empty' && (
        <div className="glass-panel p-10 rounded-2xl border border-slate-800/80 text-center">
          <div className="w-16 h-16 rounded-2xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center mx-auto mb-4 text-sky-400">
            <Calendar className="w-8 h-8" />
          </div>
          <h3 className="text-base font-bold text-white mb-1">Keine Neuerscheinungen für diese Auswahl</h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto mb-5 leading-relaxed">
            {nothingThisMonth
              ? `Für ${monthLabel} sind bei Manga Passion keine Neuerscheinungen eingetragen. Probiere einen anderen Monat.`
              : `Für ${monthLabel} wurden mit den aktiven Filtern keine Bände gefunden. Probiere einen anderen Monat oder setze die Filter zurück.`}
          </p>
          {filtersActive && !nothingThisMonth && (
            <button type="button" onClick={onResetFilters} className="btn-primary text-xs px-4 py-2">
              Filter zurücksetzen
            </button>
          )}
        </div>
      )}

      {view === 'list' && (
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
                        ({formatCount(group.items.length, 'Band', 'Bände')})
                      </span>
                    </h3>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3.5 sm:gap-4">
                {group.items.map(item => {
                  const isOwned = volumeStatusGroup(item.user_volume_status) === 'owned';
                  const actions = mpCardActions(item.user_volume_status);
                  const busy = importingMpIds.has(item.id);

                  return (
                    <div
                      key={item.id}
                      className={`glass-card rounded-2xl p-3.5 border transition-all flex flex-col justify-between group relative ${cardTone(item)}`}
                    >
                      <div>
                        <div className="flex items-center justify-between gap-1.5 mb-2.5">
                          <StatusBadge item={item} />
                          {item.is_digital && (
                            <span className="bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-[9px] font-bold px-1.5 py-0.5 rounded-md">
                              eBook
                            </span>
                          )}
                        </div>

                        <div className="flex gap-3">
                          <div className="shrink-0 relative overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-md">
                            <CoverImage
                              src={item.cover_image}
                              className="w-16 h-24 sm:w-18 sm:h-26 object-cover group-hover:scale-105 transition-transform duration-300"
                              fallback={COVER_FALLBACK}
                            />
                          </div>

                          <div className="flex-1 min-w-0">
                            {item.in_collection && item.user_manga_id && item.match_kind !== 'prefix' ? (
                              <Link
                                to={`/manga/${item.user_manga_id}`}
                                className="text-xs sm:text-sm font-bold text-white hover:text-sky-300 truncate block transition-colors leading-snug"
                                title={`${item.title} (In deiner Sammlung ansehen)`}
                              >
                                {item.title}
                              </Link>
                            ) : (
                              <span className="text-xs sm:text-sm font-bold text-white truncate block leading-snug" title={item.title}>
                                {item.title}
                              </span>
                            )}

                            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                              <span className="bg-sky-500/20 text-sky-300 border border-sky-500/30 text-xs font-bold px-2 py-0.5 rounded-lg font-mono">
                                {getVolumeDisplayTitle(item)}
                              </span>
                            </div>

                            <p className="text-[11px] text-slate-400 mt-1.5 truncate flex items-center gap-1">
                              <BuildingComplex className="w-3 h-3 text-brand-400 shrink-0" />
                              <span className="truncate">{item.publisher}</span>
                            </p>

                            <p className="text-[11px] text-slate-300 mt-1 flex items-center gap-1 font-mono">
                              <Calendar className="w-3 h-3 text-sky-400 shrink-0" />
                              <span>{item.date ? formatReleaseDate(item.date) : 'Datum offen'}</span>
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="mt-3 pt-3 border-t border-slate-800/80 flex items-center justify-between gap-2">
                        <div className="font-mono">
                          {item.price > 0 ? (
                            <span className="text-sm font-extrabold text-emerald-400">
                              {formatEuro(item.price)}
                            </span>
                          ) : (
                            <span className="text-xs text-slate-400">Preis unbekannt</span>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5">
                          {isOwned ? (
                            <Link
                              to={`/manga/${item.user_manga_id}`}
                              className="p-1 px-2.5 rounded-xl bg-emerald-500/20 text-emerald-300 text-xs font-semibold flex items-center gap-1 hover:bg-emerald-500/30 transition-colors"
                            >
                              <span>Im Besitz</span> <span aria-hidden="true">↗</span>
                            </Link>
                          ) : (
                            <>
                              {canEdit && actions.preorder && (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => onImport(item, 'Vorbestellt')}
                                  className="bg-sky-600/20 hover:bg-sky-700 text-sky-300 hover:text-white border border-sky-500/40 hover:border-sky-500 py-1 px-2.5 rounded-xl text-xs font-semibold flex items-center gap-1 transition-all active:scale-95 shadow-sm"
                                  title="Diesen Band als vorbestellt in deine Sammlung übernehmen"
                                >
                                  {busy ? (
                                    <RefreshCw className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <Package className="w-3 h-3 text-sky-400" />
                                  )}
                                  <span>Vorbestellen</span>
                                </button>
                              )}
                              {canEdit && actions.cart && (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => onImport(item, 'Fehlt')}
                                  className="bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 py-1 px-2 rounded-xl text-xs font-medium flex items-center gap-1 transition-all active:scale-95"
                                  title="Diesen Band auf die Einkaufsliste setzen"
                                  aria-label="Auf die Einkaufsliste setzen"
                                >
                                  <ShoppingCart className="w-3 h-3 text-slate-400" />
                                </button>
                              )}
                              {item.in_collection && item.user_manga_id && (
                                <Link
                                  to={`/manga/${item.user_manga_id}`}
                                  className="p-1 px-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white text-xs transition-colors"
                                  title={item.match_kind === 'prefix' ? 'Zur ähnlichen Reihe in deiner Sammlung' : 'Zu den Manga-Details'}
                                  aria-label={item.match_kind === 'prefix' ? 'Zur ähnlichen Reihe in deiner Sammlung' : 'Zu den Manga-Details'}
                                >
                                  <span aria-hidden="true">↗</span>
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
