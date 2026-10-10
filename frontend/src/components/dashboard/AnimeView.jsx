import { lazy, Suspense, useCallback, useMemo, useState, useEffect } from 'react';
import { ClipboardPaste, History, KeyRound, Plus, RefreshCw, Search, Tv, X } from 'lucide-react';
import AnimeCard from './AnimeCard';
import { formatCount, formatRelative } from '../../utils/format';
import { WATCH_BUILD, useWatchUnmatched } from '../../app/watch/watchState';
import {
  ALL_FILTER, ANIME_FILTERS, ANIME_SORTS, NO_STATUS, filterAnime, filterCounts, slowHintAllowed, markSlowHint, listSyncKeyError
} from '../../utils/animeHelpers';
import { t } from '../../i18n/index.js';
import { animeProgressLabel } from '../../utils/enumLabels.js';

// apps only: other builds drop the Crunchyroll match dialog and the unmatched store
const WatchMatchDialog = WATCH_BUILD ? lazy(() => import('../../app/watch/WatchMatchDialog')) : null;
const NO_UNMATCHED = [];
const useUnmatched = WATCH_BUILD ? useWatchUnmatched : () => NO_UNMATCHED;

// filter chips: the neutral pseudo-ids of animeHelpers get their label, real values are progress statuses
// i18n
const FILTER_LABELS = { [ALL_FILTER]: 'Alle', [NO_STATUS]: 'Ohne Status' };
const filterLabel = (f) => (Object.prototype.hasOwnProperty.call(FILTER_LABELS, f) ? t(FILTER_LABELS[f]) : animeProgressLabel(f));

// i18n
export const PLATFORM_LABELS = { macos: 'Mac', windows: 'Windows', linux: 'Linux', ios: 'iPhone/iPad', android: 'Android' };

/** 'Crunchyroll-Verlauf zuletzt übernommen vor 5 Min. (Mac)'; null without a last run. */
export function watchLastText(watch, now = Date.now()) {
  const at = watch?.last_at ? formatRelative(watch.last_at, now) : null;
  if (!at) return null;
  const platform = Object.prototype.hasOwnProperty.call(PLATFORM_LABELS, watch.last_platform) ? t(PLATFORM_LABELS[watch.last_platform]) : null;
  return platform
    ? t('Crunchyroll-Verlauf zuletzt übernommen {relative} ({platform})', { relative: at, platform })
    : t('Crunchyroll-Verlauf zuletzt übernommen {relative}', { relative: at });
}

/** Offline / unreachable note above the cached list, with the age of the copy when known. */
function cachedListText(offline, age) {
  if (offline) {
    return age
      ? t('Offline: gespeicherte Liste ({age}), Änderungen erst wieder mit Verbindung.', { age })
      : t('Offline: gespeicherte Liste, Änderungen erst wieder mit Verbindung.');
  }
  return age
    ? t('Server nicht erreichbar: gespeicherte Liste ({age}), Änderungen erst wieder mit Verbindung.', { age })
    : t('Server nicht erreichbar: gespeicherte Liste, Änderungen erst wieder mit Verbindung.');
}

/** The hint lines from GET /api/anime/sources: paused source, own key active or refused, slow shared pool, paused list sync. */
function SourceHints({ sources, listSync, onOpenAccount }) {
  const [slowHint, setSlowHint] = useState(false);
  const own = sources?.credential?.anilist === 'own';
  const slow = Boolean(sources?.slow_recently) && !own;
  useEffect(() => {
    if (slow && slowHintAllowed()) {
      setSlowHint(true);
      markSlowHint();
    }
  }, [slow]);
  const syncError = listSync?.last_error || null;
  if (!sources && !syncError) return null;
  const down = (s) => s && s.enabled && (s.paused_until || s.circuit === 'open');
  const lines = [];
  if (sources && down(sources.anilist) && !down(sources.mal)) lines.push({ key: 'ani', text: t('AniList gerade nicht erreichbar, nur MyAnimeList') });
  if (sources && down(sources.mal) && !down(sources.anilist)) lines.push({ key: 'mal', text: t('MyAnimeList gerade nicht erreichbar, nur AniList') });
  if (sources && down(sources.mal) && down(sources.anilist)) lines.push({ key: 'both', text: t('AniList und MyAnimeList gerade nicht erreichbar – die Liste zeigt den gespeicherten Stand') });
  return (
    <div className="space-y-1.5 mb-4" aria-live="polite">
      {lines.map((l) => (
        <p key={l.key} className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">{/* i18n-ignore: translated when the lines are built */}{l.text}</p>
      ))}
      {own && <p className="text-xs text-emerald-300 flex items-center gap-1.5"><KeyRound className="w-3.5 h-3.5" aria-hidden="true" /> {t('Suche läuft über deinen AniList-Zugang')}</p>}
      {(sources?.anilist?.key_disabled || sources?.mal?.key_disabled) && (
        <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-xl px-3 py-2">
          {t('Dein API-Schlüssel wurde vom Anbieter abgelehnt und ist pausiert.')}{' '}
          {onOpenAccount && <button type="button" className="underline font-semibold" onClick={onOpenAccount}>{t('Schlüssel prüfen')}</button>}
        </p>
      )}
      {syncError && listSyncKeyError(syncError) && (
        <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-xl px-3 py-2">
          {t('AniList-Abgleich pausiert: {error}', { error: syncError })}{' '}
          {onOpenAccount && <button type="button" className="underline font-semibold" onClick={onOpenAccount}>{t('Schlüssel prüfen')}</button>}
        </p>
      )}
      {syncError && !listSyncKeyError(syncError) && (
        <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">{t('AniList-Abgleich: {error}', { error: syncError })}</p>
      )}
      {slowHint && (
        <p className="text-xs text-sky-200 bg-sky-500/10 border border-sky-500/30 rounded-xl px-3 py-2 flex flex-wrap items-center gap-2">
          <span>{t('Suche ist gerade langsam: mit eigenem AniList-Token bekommst du ein eigenes Limit —')}</span>
          {onOpenAccount && <button type="button" className="underline font-semibold" onClick={onOpenAccount}>{t('einrichten')}</button>}
          <button
            type="button"
            className="ml-auto text-slate-400 hover:text-white"
            onClick={() => { markSlowHint({ forever: true }); setSlowHint(false); }}
            aria-label={t('Hinweis nicht mehr anzeigen')}
            title={t('Nicht mehr anzeigen')}
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * Anime tab: toolbar (search in the list, filter by my status, sort), the grid of AnimeCard and the source hints.
 * Visitors and offline users only read.
 */
export default function AnimeView({
  list, loaded, loading, error, fromCache, cacheAt, sources, listSync, canEdit, user, onAdd, onPasteLink, onOpen, onPlusOne, onStatusChange, onRetry,
  onOpenAccount, onRefresh, watchLast, onSearchAnime
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState(ANIME_FILTERS[0]);
  const [sort, setSort] = useState('title');
  const counts = useMemo(() => filterCounts(list), [list]);
  const shown = useMemo(() => filterAnime(list, { search, filter, sort }), [list, search, filter, sort]);
  const offline = Boolean(user?.offline);
  // apps only: series of the Crunchyroll history the server could not map (always empty elsewhere)
  const unmatched = useUnmatched();
  const [matching, setMatching] = useState(false);
  const closeMatching = useCallback(() => setMatching(false), []);
  const canMatch = canEdit && !offline && !fromCache;
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };
  const lastWatch = canEdit ? watchLastText(watchLast) : null;

  return (
    <section aria-labelledby="anime-view-heading" className="pb-6">
      <div className="flex flex-col lg:flex-row lg:items-center gap-3 mb-4">
        <h2 id="anime-view-heading" className="text-lg font-bold text-white flex items-center gap-2 shrink-0">
          <Tv className="w-5 h-5 text-fuchsia-400" aria-hidden="true" /> {t('Anime')}
        </h2>
        <div className="flex items-center gap-2 bg-slate-950/80 border border-slate-700/80 rounded-xl px-3 py-2 flex-1 min-w-0 focus-within:ring-2 focus-within:ring-brand-400">
          <Search className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
          <input
            id="anime-list-search"
            type="search"
            aria-label={t('Anime-Liste durchsuchen')}
            placeholder={t('In der Anime-Liste suchen...')}
            className="w-full min-w-0 bg-transparent border-0 p-0 text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-0 text-base sm:text-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <label htmlFor="anime-sort" className="sr-only sm:not-sr-only text-xs text-slate-400 whitespace-nowrap">{t('Sortierung')}</label>
          <select id="anime-sort" className="input-field text-base sm:text-xs py-1.5 min-w-0 flex-1 sm:flex-initial sm:w-auto" value={sort} onChange={(e) => setSort(e.target.value)}>
            {ANIME_SORTS.map((s) => <option key={s.id} value={s.id}>{t(s.label)}</option>)}
          </select>
          {!offline && onRefresh && (
            <button
              id="btn-anime-refresh"
              type="button"
              onClick={refresh}
              title={t('Aktualisieren')}
              aria-disabled={refreshing || undefined}
              className="hit-44 btn-secondary text-xs py-2 px-2.5 sm:px-3 flex items-center gap-1.5 whitespace-nowrap shrink-0 aria-disabled:opacity-60"
            >
              <RefreshCw className={`w-4 h-4${refreshing ? ' animate-spin' : ''}`} aria-hidden="true" /> <span className="sr-only sm:not-sr-only">{t('Aktualisieren')}</span>
            </button>
          )}
          {canEdit && !offline && onPasteLink && (
            <button
              id="btn-anime-paste-link"
              type="button"
              onClick={() => onPasteLink()}
              title={t('Link einfügen')}
              className="hit-44 btn-secondary text-xs py-2 px-2.5 sm:px-3 flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <ClipboardPaste className="w-4 h-4" aria-hidden="true" /> <span className="sr-only sm:not-sr-only">{t('Link einfügen')}</span>
            </button>
          )}
          {canEdit && !offline && (
            <button id="btn-add-anime" type="button" onClick={() => onAdd()} className="btn-primary text-xs py-2 px-3 flex items-center gap-1.5 whitespace-nowrap shrink-0">
              <Plus className="w-4 h-4" aria-hidden="true" /> {t('Anime hinzufügen')}
            </button>
          )}
        </div>
      </div>

      <div role="group" aria-label={t('Nach meinem Status filtern')} className="flex gap-1.5 overflow-x-auto pb-1 mb-4">
        {ANIME_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={`text-xs px-3 py-1.5 rounded-full border whitespace-nowrap shrink-0 ${filter === f ? 'bg-brand-600/30 border-brand-500/60 text-white' : 'border-slate-700 text-slate-300 hover:text-white'}`}
          >
            {filterLabel(f)} <span className="font-mono text-slate-400">{counts[f] || 0}</span>
          </button>
        ))}
      </div>

      <span className="sr-only" aria-live="polite" data-testid="anime-refresh-status">{refreshing ? t('Gleiche ab…') : ''}</span>
      {!offline && <SourceHints sources={sources} listSync={listSync} onOpenAccount={onOpenAccount} />}
      {lastWatch && <p className="text-[11px] text-slate-400 mb-4 flex items-center gap-1.5" data-testid="watch-last"><History className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> {lastWatch}</p>}
      {WATCH_BUILD && canMatch && unmatched.length > 0 && (
        <p className="text-xs text-sky-200 bg-sky-500/10 border border-sky-500/30 rounded-xl px-3 py-2 mb-4 flex items-start gap-2" data-testid="watch-unmatched">
          <History className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
          <span>
            {t('{count} aus deinem Crunchyroll-Verlauf noch nicht zugeordnet', { count: formatCount(unmatched.length, 'Serie', 'Serien') })}{' '}
            <button type="button" id="btn-watch-match" className="hit-44 underline font-semibold" onClick={() => setMatching(true)}>{t('Zuordnen')}</button>
          </span>
        </p>
      )}
      {WatchMatchDialog && matching && canMatch && (
        <Suspense fallback={null}>
          <WatchMatchDialog list={list} onClose={closeMatching} onSearch={onSearchAnime} />
        </Suspense>
      )}
      {(offline || fromCache) && (
        <p className="text-xs text-amber-300 mb-4" role="status">
          {cachedListText(offline, cacheAt ? formatRelative(cacheAt) : null)}
        </p>
      )}
      {error && !fromCache && (
        <div role="alert" className="text-sm text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-xl px-3 py-2 mb-4 flex items-center gap-3">
          <span>{error}</span>
          <button type="button" onClick={onRetry} className="btn-secondary text-xs py-1 px-2 flex items-center gap-1"><RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> {t('Erneut versuchen')}</button>
        </div>
      )}

      {loading && !list.length && <p className="text-sm text-slate-400" role="status">{t('Anime-Liste wird geladen…')}</p>}

      {loaded && !list.length && !loading && !error && (
        <div id="anime-empty" className="text-center py-16 px-6 border border-dashed border-slate-700 rounded-3xl">
          <Tv className="w-10 h-10 mx-auto text-slate-500 mb-3" aria-hidden="true" />
          <p className="text-slate-200 font-semibold">{t('Noch keine Anime in der Liste')}</p>
          <p className="text-sm text-slate-400 mt-1">
            {canEdit && !offline ? t('Über „Anime hinzufügen“ bei AniList oder MyAnimeList suchen oder einen Eintrag von Hand anlegen.') : t('Ein Bearbeiter kann Anime hinzufügen.')}
          </p>
        </div>
      )}

      {list.length > 0 && !shown.length && <p className="text-sm text-slate-400">{t('Keine Treffer für diese Auswahl.')}</p>}

      {shown.length > 0 && (
        <div id="anime-grid" className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-6 gap-3 sm:gap-4">
          {shown.map((anime) => (
            <AnimeCard
              key={anime.id}
              anime={anime}
              canEdit={canEdit && !offline && !fromCache}
              userId={user?.id}
              onOpen={onOpen}
              onPlusOne={onPlusOne}
              onStatusChange={onStatusChange}
            />
          ))}
        </div>
      )}
    </section>
  );
}
