import { memo, useLayoutEffect, useRef } from 'react';
import { BookOpen, Globe, Plus, RefreshCw, Trash, TriangleAlert, X } from 'lucide-react';
import MangaCard from './MangaCard';
import MangaRow from './MangaRow';
import useProgressiveList from '../../hooks/useProgressiveList';
import { formatCount, formatNumber, formatRelative } from '../../utils/format';
import { isWishedSeries, priorityBadgeClass, wishLabel } from '../../utils/priority';
import { viewSessionEnding } from '../../utils/viewState';
import { t } from '../../i18n/index.js';

export { seriesSummary } from './MangaCard';

// Visible on touch screens; on hover-capable screens only on hover or keyboard focus, and never clickable while hidden.
export const GRID_DELETE_BUTTON_CLASS =
  'hit-44 absolute top-9 left-2 z-10 bg-red-950/90 hover:bg-red-900 text-red-300 p-1.5 rounded-lg border border-red-700/50 transition-all shadow-lg hover:scale-105 ' +
  '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto ' +
  'group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400';

const ROW_CLASS = 'hover:bg-slate-850/60 transition-colors group';
const GRID_CLASS = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 min-[1800px]:grid-cols-8 gap-4 sm:gap-5 lg:gap-6 animate-fade-in';

/** "Wunsch" on the card of a wished series (no volume owned, so the read badge never takes this corner). */
function WishBadge({ manga }) {
  return (
    <span className="absolute top-9 right-2 z-10 pointer-events-none rounded-md bg-slate-950/90" title={wishLabel(manga)}>
      <span className={`block text-[10px] font-bold px-1.5 py-0.5 rounded-md border shadow-sm ${priorityBadgeClass(manga.wish_priority)}`}>
        {t('Wunsch')}<span className="sr-only">: {wishLabel(manga)}</span>
      </span>
    </span>
  );
}
// the card frame (author buttons inside it, next to the link); content-visibility skips layout and paint of
// off-screen cards
export const CARD_WRAPPER_CLASS =
  'group relative flex flex-col glass-card rounded-2xl border border-slate-800 hover:shadow-2xl hover:shadow-brand-500/10 hover:-translate-y-1.5 ' +
  '[content-visibility:auto] [contain-intrinsic-block-size:auto_360px]';

export const PAGE_SIZE = { grid: 60, list: 100 };
export const SHELF_COUNT_KEY = 'mangashelf_shelf_count';
export const SHELF_SCROLL_KEY = 'mangashelf_shelf_scroll';
const STALE_AFTER_MS = 60 * 60 * 1000;

/** Restores the shelf's scroll position once the list is on screen and records it until the shelf unmounts. */
export function useShelfScroll(ready) {
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    let y = 0;
    try { y = Number(window.sessionStorage.getItem(SHELF_SCROLL_KEY)) || 0; } catch (_) { /* storage unavailable */ }
    if (y > 0) window.scrollTo(0, y);
  }, [ready]);

  // stored in the layout cleanup: it runs before the shelf leaves the DOM, so the clamped scroll of a shorter next
  // page is never recorded
  useLayoutEffect(() => {
    let y = window.scrollY;
    const onScroll = () => { y = window.scrollY; };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (viewSessionEnding()) return;
      try { window.sessionStorage.setItem(SHELF_SCROLL_KEY, String(Math.round(y))); } catch (_) { /* storage unavailable */ }
    };
  }, []);
}

/**
 * The sections of the rendered part of a grouped list: groups cut to the first `shown` series, empty ones dropped;
 * `count` is the size of the whole group. Without grouping (one unlabeled group) the result is [].
 */
export function visibleSections(groups, shown) {
  if (!Array.isArray(groups) || groups.length === 0 || (groups.length === 1 && !groups[0].label)) return [];
  const out = [];
  let left = shown;
  for (const g of groups) {
    if (left <= 0) break;
    const items = g.items.slice(0, left);
    left -= items.length;
    if (items.length > 0) out.push({ key: g.key, label: g.label, count: g.items.length, items });
  }
  return out;
}

function SectionHeading({ id, label, count, as: Tag = 'h3' }) {
  return (
    <Tag id={id} className="flex items-baseline gap-2 text-sm font-bold text-slate-200">
      <span className="truncate">{label}</span>
      <span className="text-[11px] font-mono font-semibold text-slate-400">{formatCount(count, 'Reihe', 'Reihen')}</span>
    </Tag>
  );
}

function ListProgress({ shown, total, onMore, sentinelRef }) {
  return (
    <div ref={sentinelRef} className="mt-6 flex flex-col items-center gap-2 text-xs text-slate-400">
      <p>{t('Zeige {shown} von {total}', { shown: formatNumber(shown), total: formatNumber(total) })}</p>
      <button type="button" onClick={onMore} className="btn-secondary text-xs py-1.5 px-3">
        {t('Weitere anzeigen')}
      </button>
    </div>
  );
}

function FreshnessNote({ refreshing, dataAt }) {
  let text = null;
  if (refreshing) text = t('aktualisiere…');
  else if (dataAt && Date.now() - dataAt > STALE_AFTER_MS) text = t('Stand: {time}', { time: formatRelative(dataAt) });
  return (
    <p role="status" className="h-4 -mt-5 mb-1 text-right text-[11px] leading-4 text-slate-400">
      {text}
    </p>
  );
}

function SearchOnlineButton({ extras }) {
  return (
    <button type="button" onClick={extras.onSearchOnline} className="btn-secondary text-sm inline-flex items-center gap-2">
      <Globe className="w-4 h-4" aria-hidden="true" /> {t('Online nach „{q}“ suchen', { q: extras.query })}
    </button>
  );
}

function OnlineRow({ extras }) {
  if (extras.renderSection) return extras.renderSection(false);
  if (!extras.onSearchOnline) return null;
  return (
    <div className="mt-8 flex justify-center">
      <SearchOnlineButton extras={extras} />
    </div>
  );
}

function EmptyState({ filtersActive, error, onRetry, isOffline, canEdit, handleOpenModal, resetFilters, searchExtras = null }) {
  let icon = <BookOpen className="w-8 h-8" />;
  let heading;
  let text;
  let body = null;
  let action = null;

  if (filtersActive) {
    const reset = (
      <button type="button" onClick={resetFilters} className="btn-secondary text-sm inline-flex items-center gap-2">
        <X className="w-4 h-4" /> {t('Filter & Suche zurücksetzen')}
      </button>
    );
    body = searchExtras?.renderSection ? searchExtras.renderSection(true) : null;
    heading = body ? t('Nicht in deiner Sammlung') : t('Keine Treffer gefunden');
    text = body ? null : t('Für die aktuellen Such- und Filtereinstellungen wurden keine passenden Mangas gefunden.');
    action = searchExtras ? (
      <div className="flex flex-wrap items-center justify-center gap-2">
        {!body && searchExtras.onSearchOnline && <SearchOnlineButton extras={searchExtras} />}
        {searchExtras.onCreateSeries && (
          <button type="button" onClick={searchExtras.onCreateSeries} className="btn-primary text-sm inline-flex items-center gap-2">
            <Plus className="w-4 h-4" aria-hidden="true" /> {t('Neue Reihe „{q}“ anlegen', { q: searchExtras.query })}
          </button>
        )}
        {reset}
      </div>
    ) : reset;
  } else if (error) {
    icon = <TriangleAlert className="w-8 h-8" />;
    heading = t('Sammlung konnte nicht geladen werden');
    text = error;
    action = onRetry && (
      <button type="button" onClick={onRetry} className="btn-secondary text-sm inline-flex items-center gap-2">
        <RefreshCw className="w-4 h-4" /> {t('Erneut versuchen')}
      </button>
    );
  } else if (isOffline) {
    heading = t('Keine Offline-Kopie vorhanden');
    text = t('Verbinde dich mit dem Server, um deine Sammlung zu laden.');
  } else if (canEdit) {
    heading = t('Deine Sammlung ist noch leer');
    text = t('Füge deinen ersten Manga hinzu, um Bände und deinen Fortschritt zu verfolgen.');
    action = (
      <button type="button" onClick={handleOpenModal} className="btn-primary text-sm inline-flex items-center gap-2">
        <Plus className="w-4 h-4" /> {t('Ersten Manga anlegen')}
      </button>
    );
  } else {
    heading = t('Noch keine Reihen vorhanden');
    text = t('Hier sind noch keine Reihen eingetragen. Ein Editor kann welche anlegen.');
  }

  return (
    <div className={`glass-panel p-8 sm:p-12 rounded-3xl text-center ${body ? 'max-w-3xl' : 'max-w-lg'} mx-auto my-12 border border-slate-800 animate-fade-in`}>
      <div className="w-16 h-16 rounded-2xl bg-brand-500/10 border border-brand-500/20 text-brand-400 flex items-center justify-center mx-auto mb-4">
        {icon}
      </div>
      <h2 className="text-lg font-bold text-white mb-2">{heading}</h2>
      {body ? <div className="mt-4 mb-6">{body}</div> : <p className={`text-sm text-slate-400 ${action ? 'mb-6' : ''}`}>{text}</p>}
      {action}
    </div>
  );
}

/**
 * Loading / empty / grid / list states of the shelf; memoised, so pass stable callbacks. Long lists render in pages;
 * page count and scroll position survive a visit to a series (sessionStorage).
 */
function MangaCollectionGrid({
  canEdit,
  error,
  filtered,
  getStatusBadge,
  handleDeleteManga,
  handleOpenModal,
  isOffline,
  loading,
  refreshing = false,
  dataAt = null,
  onRetry,
  publisherFilter,
  search,
  setPublisherFilter,
  setSearch,
  setStatusFilter,
  sortBy = '',
  statusFilter,
  viewMode,
  groups = null,
  groupBy = 'none',
  collectFilter = 'ALL',
  setCollectFilter,
  authorFilter = '',
  setAuthorFilter,
  tagFilter = [],
  setTagFilter,
  languageFilter = 'ALL',
  setLanguageFilter,
  onAuthorClick,
  searchExtras = null
}) {
  const isList = viewMode === 'list';
  const { visible, total, shown, hasMore, showMore, sentinelRef } = useProgressiveList(filtered, {
    step: isList ? PAGE_SIZE.list : PAGE_SIZE.grid,
    resetKey: JSON.stringify([viewMode, statusFilter, publisherFilter, sortBy, search, collectFilter, authorFilter, groupBy]),
    storageKey: SHELF_COUNT_KEY
  });
  const sections = visibleSections(groups, visible.length);
  useShelfScroll(!loading && filtered.length > 0);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-slate-400 gap-3" role="status">
        <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" aria-hidden="true"></div>
        <p className="text-sm">{t('Lade Sammlung...')}</p>
      </div>
    );
  }

  const filtersActive = Boolean(search) || statusFilter !== 'ALL' || publisherFilter !== 'ALL' || collectFilter !== 'ALL' || Boolean(authorFilter)
    || (Array.isArray(tagFilter) && tagFilter.length > 0) || languageFilter !== 'ALL';
  const showErrorPanel = Boolean(error) && filtered.length === 0 && !filtersActive;
  const banner = error && !showErrorPanel ? (
    <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
      <span className="flex items-center gap-2 min-w-0">
        <TriangleAlert className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
        <span>{error}</span>
      </span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 font-semibold text-amber-300 hover:text-white">
          <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> {t('Erneut versuchen')}
        </button>
      )}
    </div>
  ) : null;

  if (filtered.length === 0) {
    return (
      <>
        {banner}
        <EmptyState
          filtersActive={filtersActive}
          error={showErrorPanel ? error : null}
          onRetry={onRetry}
          isOffline={isOffline}
          canEdit={canEdit}
          handleOpenModal={handleOpenModal}
          searchExtras={searchExtras}
          resetFilters={() => {
            setSearch('');
            setStatusFilter('ALL');
            setPublisherFilter('ALL');
            setCollectFilter?.('ALL');
            setAuthorFilter?.('');
            setTagFilter?.([]);
            setLanguageFilter?.('ALL');
          }}
        />
      </>
    );
  }

  const freshness = <FreshnessNote refreshing={refreshing} dataAt={dataAt} />;
  const progress = hasMore ? <ListProgress shown={shown} total={total} onMore={showMore} sentinelRef={sentinelRef} /> : null;
  const online = searchExtras ? <OnlineRow extras={searchExtras} /> : null;

  const renderRow = (manga) => (
    <MangaRow
      key={manga.id}
      className={ROW_CLASS}
      manga={manga}
      canEdit={canEdit}
      getStatusBadge={getStatusBadge}
      onDelete={handleDeleteManga}
      onAuthorClick={onAuthorClick}
    />
  );

  const renderCard = (manga) => (
    <div key={manga.id} className={CARD_WRAPPER_CLASS}>
      <MangaCard manga={manga} getStatusBadge={getStatusBadge} onAuthorClick={onAuthorClick} />
      {isWishedSeries(manga) && <WishBadge manga={manga} />}
      {canEdit && (
        <button
          type="button"
          onClick={(e) => handleDeleteManga(e, manga.id, manga.title)}
          className={GRID_DELETE_BUTTON_CLASS}
          title={t('Manga löschen')}
          aria-label={t('{title} löschen', { title: manga.title })}
        >
          <Trash className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );

  if (isList) {
    return (
      <>
        {banner}
        {freshness}
        <div className="glass-panel rounded-2xl border border-slate-800/80 overflow-hidden shadow-xl animate-fade-in">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950/60 text-slate-400 font-semibold uppercase tracking-wider text-[11px]">
                  <th scope="col" className="py-3 px-4 w-16">{t('Cover')}</th>
                  <th scope="col" className="py-3 px-4">{t('Titel & Autor')}</th>
                  <th scope="col" className="py-3 px-4 hidden sm:table-cell">{t('Verlag')}</th>
                  <th scope="col" className="py-3 px-4">{t('Status')}</th>
                  <th scope="col" className="py-3 px-4 whitespace-nowrap">{t('Bände / Fortschritt')}</th>
                  <th scope="col" className="py-3 px-4 text-right hidden md:table-cell">{t('Wert')}</th>
                  <th scope="col" className="py-3 px-4 text-right w-24">{t('Aktion')}</th>
                </tr>
              </thead>
              {sections.length === 0 ? (
                <tbody className="divide-y divide-slate-800/60">
                  {visible.map(renderRow)}
                </tbody>
              ) : sections.map(section => (
                <tbody key={section.key} className="divide-y divide-slate-800/60 border-t border-slate-800">
                  <tr className="bg-slate-950/40">
                    <th scope="colgroup" colSpan={7} className="py-2 px-4 text-left">
                      <SectionHeading label={section.label} count={section.count} as="span" />
                    </th>
                  </tr>
                  {section.items.map(renderRow)}
                </tbody>
              ))}
            </table>
          </div>
        </div>
        {progress}
        {online}
      </>
    );
  }

  return (
    <>
      {banner}
      {freshness}
      {sections.length === 0 ? (
        <div className={GRID_CLASS}>
          {visible.map(renderCard)}
        </div>
      ) : sections.map((section, i) => (
        <section key={section.key} aria-labelledby={`shelf-group-${i}`} className="mb-8 last:mb-0">
          <div className="mb-3 pb-2 border-b border-slate-800/80">
            <SectionHeading id={`shelf-group-${i}`} label={section.label} count={section.count} />
          </div>
          <div className={GRID_CLASS}>
            {section.items.map(renderCard)}
          </div>
        </section>
      ))}
      {progress}
      {online}
    </>
  );
}

export default memo(MangaCollectionGrid);
