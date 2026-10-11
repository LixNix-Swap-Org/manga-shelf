import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search, Tv, X, Plus, Check, KeyRound } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import useTabList from '../../hooks/useTabList';
import CoverImage from '../common/CoverImage';
import { isAbortError } from '../../utils/api';
import { compareNatural } from '../../utils/search';
import { ALL_FILTER, ANIME_KINDS, formatLabel, kindFilterLabel, kindLabel, readSetting, writeSetting } from '../../utils/animeHelpers';
import { t, tn } from '../../i18n/index.js';

// i18n
const TABS = [['search', 'Suche'], ['manual', 'Manuell']];
const TAB_KEYS = TABS.map(([key]) => key);
const SOURCE_NAMES = { anilist: 'AniList', jikan: 'MyAnimeList', mal: 'MyAnimeList', tmdb: 'TMDB' };
// i18n
const TMDB_CHIP = 'TMDB (Filme & Serien)';
export const SEARCH_SOURCES = ['anilist', 'mal', 'tmdb'];
const chipLabel = (name) => (name === 'tmdb' ? t(TMDB_CHIP) : SOURCE_NAMES[name]);
const KIND_SOURCES = { [ALL_FILTER]: SEARCH_SOURCES, anime: ['anilist', 'mal'], tv: ['tmdb'], movie: ['tmdb'] };
export const SEARCH_KINDS = [ALL_FILTER, ...ANIME_KINDS];
export const SOURCES_KEY = 'mangashelf_anime_sources';
export const SEARCH_KIND_KEY = 'mangashelf_anime_search_kind';
const OPEN_ACCOUNT_EVENT = 'mangashelf:open-account';

/** Key of a search hit: tmdb:<kind>:<id> for TMDb, else the AniList id or mal-<id>. */
export const hitKey = (hit) => (hit.tmdb_id ? `tmdb:${hit.tmdb_kind}:${hit.tmdb_id}` : hit.anilist_id || `mal-${hit.mal_id}`);

/**
 * "Gerade ohne MyAnimeList, TMDB" for the asked sources (`sources` ∩ the kind's sources ∩ sources_available) that are
 * missing from sources_used; the saved-result line when nothing answered; else null.
 */
export function sourcesNote(result, { sources, kind = ALL_FILTER } = {}) {
  if (!result || result.adaptations) return null;
  const used = new Set((result.sources_used || []).map((s) => (s === 'jikan' ? 'mal' : s)));
  if (result.partial && !used.size) return t('Gespeichertes Suchergebnis (Quellen gerade nicht erreichbar)');
  const wanted = Array.isArray(sources) && sources.length ? sources : SEARCH_SOURCES;
  const available = Array.isArray(result.sources_available) ? result.sources_available : ['anilist', 'mal'];
  const missing = SEARCH_SOURCES.filter((name) => wanted.includes(name) && (KIND_SOURCES[kind] || SEARCH_SOURCES).includes(name)
    && available.includes(name) && !used.has(name));
  return missing.length ? t('Gerade ohne {sources}', { sources: missing.map((name) => SOURCE_NAMES[name]).join(', ') }) : null;
}

/** State of a source chip from GET /api/anime/sources: 'on', 'disabled' (no key) or 'hidden'. */
export function sourceChipState(sources, name, { animeOnly = false } = {}) {
  if (animeOnly && name === 'tmdb') return 'hidden';
  const row = sources ? sources[name] : null;
  if (!row) return name === 'tmdb' ? 'hidden' : 'on';
  if (row.enabled === false) return 'hidden';
  return row.available === false ? 'disabled' : 'on';
}

function readStoredSources() {
  try {
    const list = JSON.parse(readSetting(SOURCES_KEY, 'null'));
    return Array.isArray(list) ? SEARCH_SOURCES.filter((name) => list.includes(name)) : SEARCH_SOURCES;
  } catch (_) {
    return SEARCH_SOURCES;
  }
}

const chipClass = (on) => `text-xs px-3 py-1.5 rounded-full border whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed ${on ? 'bg-brand-600/30 border-brand-500/60 text-white' : 'border-slate-700 text-slate-300 hover:text-white'}`;

// Add an anime, a TV show or a film: search AniList/MyAnimeList/TMDb via the server (on the button, not while typing) or
// enter title and episodes manually. Optional link to a series of the collection (prefilled from ?add=<id>). `initialQuery`
// (series title of a shared link) fills the search and runs it once. `animeOnly` (Crunchyroll share and match search)
// searches anime only and ignores the remembered chips.
export default function AddAnimeModal({
  isOpen, onClose, search, loadAdaptations, onAdd, onOpenExisting, mangas = [], initialMangaId = null, initialQuery = '', returnFocusRef,
  sources = null, loadSources, animeOnly = false
}) {
  const [tab, setTab] = useState('search');
  const [query, setQuery] = useState(initialQuery || '');
  const [result, setResult] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(null);
  const [mangaId, setMangaId] = useState(initialMangaId ? String(initialMangaId) : '');
  const [manualTitle, setManualTitle] = useState(initialQuery || '');
  const [manualEpisodes, setManualEpisodes] = useState('');
  const [manualKind, setManualKind] = useState('anime');
  const [picked, setPicked] = useState(() => (animeOnly ? SEARCH_SOURCES : readStoredSources()));
  const [kind, setKind] = useState(() => (animeOnly ? 'anime' : readSetting(SEARCH_KIND_KEY, ALL_FILTER, (v) => SEARCH_KINDS.includes(v))));
  const [asked, setAsked] = useState(null);
  const abortRef = useRef(null);
  const titleId = useId();
  const dialogRef = useDialogA11y(isOpen, { onClose, returnFocusRef });
  const { tabListProps, tabProps, panelProps } = useTabList({ tabs: TAB_KEYS, selected: tab, onSelect: (key) => { setTab(key); setError(''); } });

  const linkedManga = useMemo(() => mangas.find((m) => String(m.id) === String(initialMangaId)), [mangas, initialMangaId]);
  useEffect(() => {
    if (isOpen && linkedManga && !query) setQuery(linkedManga.alt_title || linkedManga.title || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on open with ?add=
  }, [isOpen, linkedManga]);

  // opened from a series ("Anime-Adaption"): its adaptations are the first suggestions
  useEffect(() => {
    if (!isOpen || !initialMangaId || !loadAdaptations) return undefined;
    const controller = new AbortController();
    setSearching(true);
    loadAdaptations(initialMangaId, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setResult({ results: data.results || [], sources_used: data.source ? [data.source] : [], partial: false, adaptations: true });
      })
      .catch((err) => { if (!isAbortError(err)) setError(t('{reason} – die Suche geht trotzdem.', { reason: err.message || t('Adaptionen konnten nicht geladen werden') })); })
      .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    return () => controller.abort();
  }, [isOpen, initialMangaId, loadAdaptations]);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (isOpen) loadSources?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once on open
  }, [isOpen]);
  useEffect(() => {
    if (isOpen && initialQuery && initialQuery.trim().length >= 2 && !initialMangaId) runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once on open with a prefilled title
  }, [isOpen]);

  const sortedMangas = useMemo(() => [...mangas].sort((a, b) => compareNatural(a.title, b.title)), [mangas]);

  if (!isOpen) return null;

  const chips = SEARCH_SOURCES.map((name) => ({ name, state: sourceChipState(sources, name, { animeOnly }) }));
  const usable = chips.filter((c) => c.state === 'on').map((c) => c.name);
  const tmdbAvailable = usable.includes('tmdb');
  const showKinds = !animeOnly && Boolean(sources?.tmdb?.enabled);
  const kindUsable = (k) => k === ALL_FILTER || k === 'anime' || tmdbAvailable;
  const activeKind = animeOnly ? 'anime' : (showKinds && kindUsable(kind) ? kind : ALL_FILTER);
  const activeSources = (list) => usable.filter((name) => list.includes(name));
  const keyHint = chips.some((c) => c.state === 'disabled') || (showKinds && !tmdbAvailable);

  const runSearch = async (e, { list = picked, kindChoice = activeKind } = {}) => {
    e?.preventDefault();
    const q = query.trim();
    if (q.length < 2) {
      setError(t('Bitte mindestens 2 Zeichen eingeben.'));
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSearching(true);
    setError('');
    const chosen = activeSources(list);
    const request = { sources: !sources && !animeOnly && chosen.length === usable.length ? [] : chosen, kind: kindChoice };
    try {
      const data = await search(q, { signal: controller.signal, ...request });
      if (controller.signal.aborted) return;
      setAsked(request);
      setResult(data);
    } catch (err) {
      if (isAbortError(err)) return;
      setResult(null);
      setError(err.message || t('Suche fehlgeschlagen'));
    } finally {
      if (abortRef.current === controller) setSearching(false);
    }
  };

  const searchAgain = (options) => {
    if (result && !result.adaptations && query.trim().length >= 2) runSearch(null, options);
  };

  const toggleSource = (name) => {
    const list = picked.includes(name) ? picked.filter((n) => n !== name) : SEARCH_SOURCES.filter((n) => n === name || picked.includes(n));
    setPicked(list);
    if (!animeOnly) writeSetting(SOURCES_KEY, JSON.stringify(list));
    searchAgain({ list });
  };

  const chooseKind = (next) => {
    setKind(next);
    writeSetting(SEARCH_KIND_KEY, next);
    searchAgain({ kindChoice: next });
  };

  const openKeys = () => {
    onClose();
    window.dispatchEvent(new CustomEvent(OPEN_ACCOUNT_EVENT, { detail: 'keys', cancelable: true }));
  };

  const link = mangaId ? Number(mangaId) : null;

  const addHit = async (hit) => {
    setAdding(hitKey(hit));
    setError('');
    try {
      if (hit.tmdb_id) {
        const title = typeof hit.title === 'string' ? hit.title : (hit.title?.english || hit.title?.preferred || hit.title?.native);
        await onAdd({ tmdb_id: hit.tmdb_id, tmdb_kind: hit.tmdb_kind, title, manga_id: link });
      } else {
        await onAdd({ anilist_id: hit.anilist_id || undefined, mal_id: hit.mal_id || undefined, manga_id: link });
      }
      onClose();
    } catch (err) {
      if (err?.status === 409 && err.data?.id && onOpenExisting) {
        onOpenExisting(err.data.id);
        onClose();
        return;
      }
      setError(err.message || t('Anime konnte nicht hinzugefügt werden'));
    } finally {
      setAdding(null);
    }
  };

  const addManual = async (e) => {
    e.preventDefault();
    const title = manualTitle.trim();
    if (!title) {
      setError(t('Bitte einen Titel eingeben.'));
      return;
    }
    const episodes = manualEpisodes.trim() === '' ? null : Number(manualEpisodes);
    if (episodes !== null && (!Number.isInteger(episodes) || episodes < 0)) {
      setError(t('Die Folgenzahl muss eine ganze Zahl ab 0 sein.'));
      return;
    }
    setAdding('manual');
    setError('');
    try {
      await onAdd({ title, episodes, kind: animeOnly ? 'anime' : manualKind, manga_id: link });
      onClose();
    } catch (err) {
      setError(err.message || t('Anime konnte nicht angelegt werden'));
    } finally {
      setAdding(null);
    }
  };

  const note = sourcesNote(result, asked || {});

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      className="outline-none dialog-overlay z-50 bg-black/75 backdrop-blur-sm animate-fade-in"
    >
      <div className="dialog-box glass-panel max-w-2xl rounded-2xl sm:rounded-3xl p-5 sm:p-7 short:p-4 border border-slate-700/80 shadow-2xl">
        <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800">
          <h2 id={titleId} className="text-xl font-bold text-white flex items-center gap-2">
            <Tv className="w-5 h-5 text-fuchsia-400" aria-hidden="true" /> {t('Anime hinzufügen')}
          </h2>
          <button type="button" onClick={onClose} aria-label={t('Schließen')} className="hit-44 shrink-0 text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div {...tabListProps} aria-label={t('Art des Eintrags')} className="flex gap-1 mb-4 bg-slate-900/80 border border-slate-800 p-1 rounded-xl w-fit">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              {...tabProps(id)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-lg ${tab === id ? 'bg-brand-700 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              {t(label)}
            </button>
          ))}
        </div>

        <div className="mb-4">
          <label htmlFor={`${titleId}-manga`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">{t('Zu Reihe verknüpfen')}</label>
          <select id={`${titleId}-manga`} className="input-field text-base sm:text-sm" value={mangaId} onChange={(e) => setMangaId(e.target.value)}>
            <option value="">{t('Keine Verknüpfung')}</option>
            {sortedMangas.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </select>
        </div>

        {error && <div role="alert" className="bg-red-500/15 border border-red-500/40 text-red-300 p-3 rounded-xl text-sm mb-3">{error}</div>}

        <div {...panelProps}>
          {tab === 'search' ? (
            <>
              <form onSubmit={runSearch} className="flex gap-2 mb-3">
                <label htmlFor={`${titleId}-q`} className="sr-only">{t('Titel suchen')}</label>
                <input
                  id={`${titleId}-q`}
                  type="search"
                  autoFocus
                  className="input-field flex-1 text-base sm:text-sm"
                  placeholder={t('Titel (deutsch, englisch oder japanisch)')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button type="submit" className="btn-primary text-sm flex items-center gap-1.5" disabled={searching}>
                  <Search className="w-4 h-4" aria-hidden="true" /> {searching ? t('Suche…') : t('Suchen')}
                </button>
              </form>
              <div className="flex flex-wrap items-center gap-1.5 mb-3">
                <div role="group" aria-label={t('Quellen')} className="flex flex-wrap gap-1.5">
                  {chips.filter((c) => c.state !== 'hidden').map((c) => (
                    <button
                      key={c.name}
                      type="button"
                      aria-pressed={c.state === 'on' && picked.includes(c.name)}
                      disabled={c.state === 'disabled'}
                      title={c.state === 'disabled' ? t('Schlüssel hinterlegen') : undefined}
                      onClick={() => toggleSource(c.name)}
                      className={chipClass(c.state === 'on' && picked.includes(c.name))}
                    >
                      {chipLabel(c.name)}
                    </button>
                  ))}
                </div>
                {showKinds && (
                  <div role="group" aria-label={t('Art')} className="flex flex-wrap gap-1.5">
                    {SEARCH_KINDS.map((k) => (
                      <button
                        key={k}
                        type="button"
                        aria-pressed={activeKind === k}
                        disabled={!kindUsable(k)}
                        title={kindUsable(k) ? undefined : t('Schlüssel hinterlegen')}
                        onClick={() => chooseKind(k)}
                        className={chipClass(activeKind === k)}
                      >
                        {kindFilterLabel(k)}
                      </button>
                    ))}
                  </div>
                )}
                {keyHint && (
                  <button type="button" onClick={openKeys} className="text-xs text-brand-300 hover:text-brand-200 underline inline-flex items-center gap-1">
                    <KeyRound className="w-3.5 h-3.5" aria-hidden="true" /> {t('Schlüssel hinterlegen')}
                  </button>
                )}
              </div>
              {note && <p className="text-xs text-amber-300 mb-2" role="status">{note}</p>}
              {result?.adaptations && result.results.length > 0 && <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">{t('Anime-Adaptionen dieser Reihe')}</h3>}
              {result && !result.results.length && (
                <p className="text-sm text-slate-400" role="status">
                  {result.adaptations ? t('Keine Anime-Adaption gefunden. Suche oben nach einem anderen Titel oder lege einen Eintrag unter „Manuell“ an.') : t('Keine Treffer. Ein Eintrag lässt sich auch unter „Manuell“ anlegen.')}
                </p>
              )}
              {result && result.results.length > 0 && (
                <ul className="space-y-2 max-h-[50vh] overflow-y-auto pr-1" aria-label={t('Suchergebnisse')}>
                  {result.results.map((hit) => {
                    const key = hitKey(hit);
                    const name = typeof hit.title === 'string' ? hit.title : (hit.title?.preferred || hit.title?.romaji || hit.title?.english || hit.title?.native);
                    const original = typeof hit.title === 'string' ? null : (hit.tmdb_id ? hit.title?.native : hit.title?.romaji);
                    const movie = hit.tmdb_kind === 'movie';
                    return (
                      <li key={key} className="flex gap-3 items-center bg-slate-900/70 border border-slate-800 rounded-xl p-2">
                        <div className="w-12 h-16 shrink-0 rounded-lg overflow-hidden bg-slate-950">
                          <CoverImage src={hit.cover_url} className="w-full h-full object-cover" fallback={<Tv className="w-5 h-5 m-auto mt-5 text-slate-500" aria-hidden="true" />} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-white truncate">{name}</p>
                          {original && original !== name && <p className="text-[11px] text-slate-400 truncate">{original}</p>}
                          <p className="text-[11px] text-slate-400">
                            {[formatLabel(hit.format), hit.season_year, hit.episodes && !movie ? tn('{n} Folgen', '{n} Folgen', hit.episodes, { n: hit.episodes }) : null].filter(Boolean).join(' · ')}
                          </p>
                          <p className="flex gap-1 mt-1">
                            {hit.anilist_id && <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30">AniList</span>}
                            {hit.mal_id && <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">MAL</span>}
                            {(hit.tmdb_id || (hit.also_on || []).includes('tmdb')) && <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300 border border-teal-500/30">TMDB</span>}
                          </p>
                          {hit.tmdb_id && <p className="text-[10px] text-slate-400 mt-0.5">{t('Daten: TMDB')}</p>}
                        </div>
                        {hit.in_collection_id ? (
                          <button type="button" className="btn-secondary text-xs flex items-center gap-1 shrink-0" onClick={() => { onOpenExisting?.(hit.in_collection_id); onClose(); }}>
                            <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" /> {t('schon im Regal')}
                          </button>
                        ) : (
                          <button type="button" className="btn-primary text-xs flex items-center gap-1 shrink-0" disabled={adding !== null} onClick={() => addHit(hit)}>
                            <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {adding === key ? t('Wird angelegt…') : t('Hinzufügen')}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          ) : (
            <form onSubmit={addManual} className="space-y-3">
              <div>
                <label htmlFor={`${titleId}-title`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">{t('Titel')}</label>
                <input id={`${titleId}-title`} className="input-field text-base sm:text-sm" maxLength={200} value={manualTitle} onChange={(e) => setManualTitle(e.target.value)} autoFocus />
              </div>
              {!animeOnly && (
                <div>
                  <label htmlFor={`${titleId}-kind`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">{t('Art')}</label>
                  <select id={`${titleId}-kind`} className="input-field text-base sm:text-sm w-40" value={manualKind} onChange={(e) => setManualKind(e.target.value)}>
                    {ANIME_KINDS.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label htmlFor={`${titleId}-episodes`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">{t('Folgen (optional)')}</label>
                <input id={`${titleId}-episodes`} type="number" min="0" inputMode="numeric" className="input-field text-base sm:text-sm w-32" value={manualEpisodes} onChange={(e) => setManualEpisodes(e.target.value)} />
              </div>
              <div className="flex justify-end">
                <button type="submit" className="btn-primary text-sm" disabled={adding !== null}>{adding === 'manual' ? t('Wird angelegt…') : t('Anlegen')}</button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
