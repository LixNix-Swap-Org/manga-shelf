import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search, Tv, X, Plus, Check } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import useTabList from '../../hooks/useTabList';
import CoverImage from '../common/CoverImage';
import { isAbortError } from '../../utils/api';
import { compareNatural } from '../../utils/search';
import { formatLabel } from '../../utils/animeHelpers';

const TABS = [['search', 'Suche'], ['manual', 'Manuell']];
const TAB_KEYS = TABS.map(([key]) => key);
const SOURCE_NAMES = { anilist: 'AniList', jikan: 'MyAnimeList', mal: 'MyAnimeList' };

/** "nur AniList" when one source did not answer; null when both did. */
export function sourcesNote(result) {
  if (!result) return null;
  const used = [...new Set((result.sources_used || []).map((s) => SOURCE_NAMES[s] || s))];
  if (result.partial && used.length === 1) return `Gerade nur ${used[0]} erreichbar`;
  if (result.partial && !used.length) return 'Gespeichertes Suchergebnis (Quellen gerade nicht erreichbar)';
  return null;
}

/**
 * Add an anime: search AniList/MyAnimeList over the server (on the button, not while typing) and take a hit, or a
 * manual entry with title and episodes. Optional link to a series of the collection (prefilled from ?add=<id>).
 */
export default function AddAnimeModal({ isOpen, onClose, search, loadAdaptations, onAdd, onOpenExisting, mangas = [], initialMangaId = null }) {
  const [tab, setTab] = useState('search');
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(null);
  const [mangaId, setMangaId] = useState(initialMangaId ? String(initialMangaId) : '');
  const [manualTitle, setManualTitle] = useState('');
  const [manualEpisodes, setManualEpisodes] = useState('');
  const abortRef = useRef(null);
  const titleId = useId();
  const dialogRef = useDialogA11y(isOpen, { onClose });
  const { tabListProps, tabProps, panelProps } = useTabList({ tabs: TAB_KEYS, selected: tab, onSelect: (key) => { setTab(key); setError(''); } });

  const linkedManga = useMemo(() => mangas.find((m) => String(m.id) === String(initialMangaId)), [mangas, initialMangaId]);
  useEffect(() => {
    if (isOpen && linkedManga && !query) setQuery(linkedManga.alt_title || linkedManga.title || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nur beim Öffnen mit ?add=
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
      .catch((err) => { if (!isAbortError(err)) setError(`${err.message || 'Adaptionen konnten nicht geladen werden'} – die Suche geht trotzdem.`); })
      .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    return () => controller.abort();
  }, [isOpen, initialMangaId, loadAdaptations]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const sortedMangas = useMemo(() => [...mangas].sort((a, b) => compareNatural(a.title, b.title)), [mangas]);

  if (!isOpen) return null;

  const runSearch = async (e) => {
    e?.preventDefault();
    const q = query.trim();
    if (q.length < 2) {
      setError('Bitte mindestens 2 Zeichen eingeben.');
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSearching(true);
    setError('');
    try {
      const data = await search(q, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setResult(data);
    } catch (err) {
      if (isAbortError(err)) return;
      setResult(null);
      setError(err.message || 'Suche fehlgeschlagen');
    } finally {
      if (abortRef.current === controller) setSearching(false);
    }
  };

  const link = mangaId ? Number(mangaId) : null;

  const addHit = async (hit) => {
    const key = hit.anilist_id || `mal-${hit.mal_id}`;
    setAdding(key);
    setError('');
    try {
      await onAdd({ anilist_id: hit.anilist_id || undefined, mal_id: hit.mal_id || undefined, manga_id: link });
      onClose();
    } catch (err) {
      if (err?.status === 409 && err.data?.id && onOpenExisting) {
        onOpenExisting(err.data.id);
        onClose();
        return;
      }
      setError(err.message || 'Anime konnte nicht hinzugefügt werden');
    } finally {
      setAdding(null);
    }
  };

  const addManual = async (e) => {
    e.preventDefault();
    const title = manualTitle.trim();
    if (!title) {
      setError('Bitte einen Titel eingeben.');
      return;
    }
    const episodes = manualEpisodes.trim() === '' ? null : Number(manualEpisodes);
    if (episodes !== null && (!Number.isInteger(episodes) || episodes < 0)) {
      setError('Die Folgenzahl muss eine ganze Zahl ab 0 sein.');
      return;
    }
    setAdding('manual');
    setError('');
    try {
      await onAdd({ title, episodes, manga_id: link });
      onClose();
    } catch (err) {
      setError(err.message || 'Anime konnte nicht angelegt werden');
    } finally {
      setAdding(null);
    }
  };

  const note = sourcesNote(result);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      className="outline-none fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto animate-fade-in"
    >
      <div className="glass-panel w-full max-w-2xl rounded-2xl sm:rounded-3xl p-5 sm:p-7 border border-slate-700/80 shadow-2xl my-3 sm:my-8">
        <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800">
          <h2 id={titleId} className="text-xl font-bold text-white flex items-center gap-2">
            <Tv className="w-5 h-5 text-fuchsia-400" aria-hidden="true" /> Anime hinzufügen
          </h2>
          <button type="button" onClick={onClose} aria-label="Schließen" className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div {...tabListProps} aria-label="Art des Eintrags" className="flex gap-1 mb-4 bg-slate-900/80 border border-slate-800 p-1 rounded-xl w-fit">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              {...tabProps(id)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-lg ${tab === id ? 'bg-brand-700 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mb-4">
          <label htmlFor={`${titleId}-manga`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">Zu Reihe verknüpfen</label>
          <select id={`${titleId}-manga`} className="input-field text-base sm:text-sm" value={mangaId} onChange={(e) => setMangaId(e.target.value)}>
            <option value="">Keine Verknüpfung</option>
            {sortedMangas.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </select>
        </div>

        {error && <div role="alert" className="bg-red-500/15 border border-red-500/40 text-red-300 p-3 rounded-xl text-sm mb-3">{error}</div>}

        <div {...panelProps}>
          {tab === 'search' ? (
            <>
              <form onSubmit={runSearch} className="flex gap-2 mb-3">
                <label htmlFor={`${titleId}-q`} className="sr-only">Titel suchen</label>
                <input
                  id={`${titleId}-q`}
                  type="search"
                  autoFocus
                  className="input-field flex-1 text-base sm:text-sm"
                  placeholder="Titel (deutsch, englisch oder japanisch)"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button type="submit" className="btn-primary text-sm flex items-center gap-1.5" disabled={searching}>
                  <Search className="w-4 h-4" aria-hidden="true" /> {searching ? 'Suche…' : 'Suchen'}
                </button>
              </form>
              {note && <p className="text-xs text-amber-300 mb-2" role="status">{note}</p>}
              {result?.adaptations && result.results.length > 0 && <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">Anime-Adaptionen dieser Reihe</h3>}
              {result && !result.results.length && (
                <p className="text-sm text-slate-400" role="status">
                  {result.adaptations ? 'Keine Anime-Adaption gefunden. Suche oben nach einem anderen Titel oder lege einen Eintrag unter „Manuell“ an.' : 'Keine Treffer. Ein Eintrag lässt sich auch unter „Manuell“ anlegen.'}
                </p>
              )}
              {result && result.results.length > 0 && (
                <ul className="space-y-2 max-h-[50vh] overflow-y-auto pr-1" aria-label="Suchergebnisse">
                  {result.results.map((hit) => {
                    const key = hit.anilist_id || `mal-${hit.mal_id}`;
                    const name = typeof hit.title === 'string' ? hit.title : (hit.title?.preferred || hit.title?.romaji);
                    const romaji = typeof hit.title === 'string' ? null : hit.title?.romaji;
                    return (
                      <li key={key} className="flex gap-3 items-center bg-slate-900/70 border border-slate-800 rounded-xl p-2">
                        <div className="w-12 h-16 shrink-0 rounded-lg overflow-hidden bg-slate-950">
                          <CoverImage src={hit.cover_url} className="w-full h-full object-cover" fallback={<Tv className="w-5 h-5 m-auto mt-5 text-slate-500" aria-hidden="true" />} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-white truncate">{name}</p>
                          {romaji && romaji !== name && <p className="text-[11px] text-slate-400 truncate">{romaji}</p>}
                          <p className="text-[11px] text-slate-400">
                            {[formatLabel(hit.format), hit.season_year, hit.episodes ? `${hit.episodes} Folgen` : null].filter(Boolean).join(' · ')}
                          </p>
                          <p className="flex gap-1 mt-1">
                            {hit.anilist_id && <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30">AniList</span>}
                            {hit.mal_id && <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">MAL</span>}
                          </p>
                        </div>
                        {hit.in_collection_id ? (
                          <button type="button" className="btn-secondary text-xs flex items-center gap-1 shrink-0" onClick={() => { onOpenExisting?.(hit.in_collection_id); onClose(); }}>
                            <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" /> schon im Regal
                          </button>
                        ) : (
                          <button type="button" className="btn-primary text-xs flex items-center gap-1 shrink-0" disabled={adding !== null} onClick={() => addHit(hit)}>
                            <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {adding === key ? 'Wird angelegt…' : 'Hinzufügen'}
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
                <label htmlFor={`${titleId}-title`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">Titel</label>
                <input id={`${titleId}-title`} className="input-field text-base sm:text-sm" maxLength={200} value={manualTitle} onChange={(e) => setManualTitle(e.target.value)} autoFocus />
              </div>
              <div>
                <label htmlFor={`${titleId}-episodes`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">Folgen (optional)</label>
                <input id={`${titleId}-episodes`} type="number" min="0" inputMode="numeric" className="input-field text-base sm:text-sm w-32" value={manualEpisodes} onChange={(e) => setManualEpisodes(e.target.value)} />
              </div>
              <div className="flex justify-end">
                <button type="submit" className="btn-primary text-sm" disabled={adding !== null}>{adding === 'manual' ? 'Wird angelegt…' : 'Anlegen'}</button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
