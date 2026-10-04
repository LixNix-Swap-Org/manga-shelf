import { useMemo, useState, useEffect } from 'react';
import { KeyRound, Plus, RefreshCw, Search, Tv, X } from 'lucide-react';
import AnimeCard from './AnimeCard';
import { formatRelative } from '../../utils/format';
import {
  ANIME_FILTERS, ANIME_SORTS, filterAnime, filterCounts, slowHintAllowed, markSlowHint
} from '../../utils/animeHelpers';

/** The hint lines from GET /api/anime/sources: paused source, own key active or refused, slow shared pool. */
function SourceHints({ sources, onOpenAccount }) {
  const [slowHint, setSlowHint] = useState(false);
  const own = sources?.credential?.anilist === 'own';
  const slow = Boolean(sources?.slow_recently) && !own;
  useEffect(() => {
    if (slow && slowHintAllowed()) {
      setSlowHint(true);
      markSlowHint();
    }
  }, [slow]);
  if (!sources) return null;
  const down = (s) => s && s.enabled && (s.paused_until || s.circuit === 'open');
  const lines = [];
  if (down(sources.anilist) && !down(sources.mal)) lines.push({ key: 'ani', text: 'AniList gerade nicht erreichbar, nur MyAnimeList' });
  if (down(sources.mal) && !down(sources.anilist)) lines.push({ key: 'mal', text: 'MyAnimeList gerade nicht erreichbar, nur AniList' });
  if (down(sources.mal) && down(sources.anilist)) lines.push({ key: 'both', text: 'AniList und MyAnimeList gerade nicht erreichbar – die Liste zeigt den gespeicherten Stand' });
  return (
    <div className="space-y-1.5 mb-4" aria-live="polite">
      {lines.map((l) => (
        <p key={l.key} className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">{l.text}</p>
      ))}
      {own && <p className="text-xs text-emerald-300 flex items-center gap-1.5"><KeyRound className="w-3.5 h-3.5" aria-hidden="true" /> Suche läuft über deinen AniList-Zugang</p>}
      {(sources.anilist?.key_disabled || sources.mal?.key_disabled) && (
        <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-xl px-3 py-2">
          Dein API-Schlüssel wurde vom Anbieter abgelehnt und ist pausiert.{' '}
          {onOpenAccount && <button type="button" className="underline font-semibold" onClick={onOpenAccount}>Schlüssel prüfen</button>}
        </p>
      )}
      {slowHint && (
        <p className="text-xs text-sky-200 bg-sky-500/10 border border-sky-500/30 rounded-xl px-3 py-2 flex flex-wrap items-center gap-2">
          <span>Suche ist gerade langsam: mit eigenem AniList-Token bekommst du ein eigenes Limit —</span>
          {onOpenAccount && <button type="button" className="underline font-semibold" onClick={onOpenAccount}>einrichten</button>}
          <button
            type="button"
            className="ml-auto text-slate-400 hover:text-white"
            onClick={() => { markSlowHint({ forever: true }); setSlowHint(false); }}
            aria-label="Hinweis nicht mehr anzeigen"
            title="Nicht mehr anzeigen"
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
  list, loaded, loading, error, fromCache, cacheAt, sources, canEdit, user, onAdd, onOpen, onPlusOne, onStatusChange, onRetry, onOpenAccount
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('Alle');
  const [sort, setSort] = useState('title');
  const counts = useMemo(() => filterCounts(list), [list]);
  const shown = useMemo(() => filterAnime(list, { search, filter, sort }), [list, search, filter, sort]);
  const offline = Boolean(user?.offline);

  return (
    <section aria-labelledby="anime-view-heading" className="pb-6">
      <div className="flex flex-col lg:flex-row lg:items-center gap-3 mb-4">
        <h2 id="anime-view-heading" className="text-lg font-bold text-white flex items-center gap-2 shrink-0">
          <Tv className="w-5 h-5 text-fuchsia-400" aria-hidden="true" /> Anime
        </h2>
        <div className="flex items-center gap-2 bg-slate-950/80 border border-slate-700/80 rounded-xl px-3 py-2 flex-1 min-w-0 focus-within:ring-2 focus-within:ring-brand-400">
          <Search className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
          <input
            id="anime-list-search"
            type="search"
            aria-label="Anime-Liste durchsuchen"
            placeholder="In der Anime-Liste suchen..."
            className="w-full min-w-0 bg-transparent border-0 p-0 text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-0 text-base sm:text-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <label htmlFor="anime-sort" className="sr-only sm:not-sr-only text-xs text-slate-400 whitespace-nowrap">Sortierung</label>
          <select id="anime-sort" className="input-field text-base sm:text-xs py-1.5 min-w-0 flex-1 sm:flex-initial sm:w-auto" value={sort} onChange={(e) => setSort(e.target.value)}>
            {ANIME_SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          {canEdit && !offline && (
            <button id="btn-add-anime" type="button" onClick={() => onAdd()} className="btn-primary text-xs py-2 px-3 flex items-center gap-1.5 whitespace-nowrap shrink-0">
              <Plus className="w-4 h-4" aria-hidden="true" /> Anime hinzufügen
            </button>
          )}
        </div>
      </div>

      <div role="group" aria-label="Nach meinem Status filtern" className="flex gap-1.5 overflow-x-auto pb-1 mb-4">
        {ANIME_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={`text-xs px-3 py-1.5 rounded-full border whitespace-nowrap shrink-0 ${filter === f ? 'bg-brand-600/30 border-brand-500/60 text-white' : 'border-slate-700 text-slate-300 hover:text-white'}`}
          >
            {f} <span className="font-mono text-slate-400">{counts[f] || 0}</span>
          </button>
        ))}
      </div>

      {!offline && <SourceHints sources={sources} onOpenAccount={onOpenAccount} />}
      {(offline || fromCache) && (
        <p className="text-xs text-amber-300 mb-4" role="status">
          {offline ? 'Offline: ' : 'Server nicht erreichbar: '}gespeicherte Liste{cacheAt ? ` (${formatRelative(cacheAt)})` : ''}, Änderungen erst wieder mit Verbindung.
        </p>
      )}
      {error && !fromCache && (
        <div role="alert" className="text-sm text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-xl px-3 py-2 mb-4 flex items-center gap-3">
          <span>{error}</span>
          <button type="button" onClick={onRetry} className="btn-secondary text-xs py-1 px-2 flex items-center gap-1"><RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Erneut versuchen</button>
        </div>
      )}

      {loading && !list.length && <p className="text-sm text-slate-400" role="status">Anime-Liste wird geladen…</p>}

      {loaded && !list.length && !loading && !error && (
        <div id="anime-empty" className="text-center py-16 px-6 border border-dashed border-slate-700 rounded-3xl">
          <Tv className="w-10 h-10 mx-auto text-slate-500 mb-3" aria-hidden="true" />
          <p className="text-slate-200 font-semibold">Noch keine Anime in der Liste</p>
          <p className="text-sm text-slate-400 mt-1">
            {canEdit && !offline ? 'Über „Anime hinzufügen“ bei AniList oder MyAnimeList suchen oder einen Eintrag von Hand anlegen.' : 'Ein Bearbeiter kann Anime hinzufügen.'}
          </p>
        </div>
      )}

      {list.length > 0 && !shown.length && <p className="text-sm text-slate-400">Keine Treffer für diese Auswahl.</p>}

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
