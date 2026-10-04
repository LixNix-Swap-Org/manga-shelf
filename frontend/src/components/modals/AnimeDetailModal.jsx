import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, ExternalLink, Minus, Plus, RefreshCw, Trash, Tv, X } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import useLatestRequest from '../../hooks/useLatestRequest';
import CoverImage from '../common/CoverImage';
import { langFor } from '../common/lang';
import { isAbortError } from '../../utils/api';
import { notify } from '../../utils/notify';
import { compareNatural } from '../../utils/search';
import {
  PROGRESS_STATUSES, displayTitle, formatLabel, airingStatusLabel, relationLabel, progressText, countdownText, staleText, shortDescription
} from '../../utils/animeHelpers';

const REFRESH_LOCK_MS = 60 * 1000;
const lastRefresh = new Map();

function MetaRow({ label, children }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div className="flex gap-2 text-xs">
      <dt className="text-slate-400 w-24 shrink-0">{label}</dt>
      <dd className="text-slate-200 min-w-0">{children}</dd>
    </div>
  );
}

/** Own progress: counter, status, score and note, saved together. */
function OwnProgress({ anime, progress, onSave, onRemove, busy }) {
  const ids = useId();
  const [episodes, setEpisodes] = useState(progress?.episodes_watched ?? 0);
  const [status, setStatus] = useState(progress?.status || 'Geplant');
  const [score, setScore] = useState(progress?.score ? String(progress.score) : '');
  const [notes, setNotes] = useState(progress?.notes || '');
  useEffect(() => {
    setEpisodes(progress?.episodes_watched ?? 0);
    setStatus(progress?.status || 'Geplant');
    setScore(progress?.score ? String(progress.score) : '');
    setNotes(progress?.notes || '');
  }, [progress]);
  const max = anime.episodes > 0 ? anime.episodes : undefined;
  const clamp = (n) => Math.max(0, max ? Math.min(max, n) : n);
  const save = (e) => {
    e.preventDefault();
    const change = {};
    if (episodes !== (progress?.episodes_watched ?? 0)) change.episodes_watched = Number(episodes) || 0;
    if (status !== (progress?.status || null)) change.status = status;
    if ((score ? Number(score) : null) !== (progress?.score ?? null)) change.score = score ? Number(score) : null;
    if ((notes.trim() || null) !== (progress?.notes ?? null)) change.notes = notes.trim() || null;
    if (!progress && !Object.keys(change).length) change.status = status;
    onSave(change);
  };
  return (
    <form onSubmit={save} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={`${ids}-ep`} className="block text-[11px] text-slate-400 mb-1">Gesehene Folgen{max ? ` (von ${max})` : ''}</label>
          <div className="flex items-center gap-1">
            <button type="button" className="btn-secondary p-2" aria-label="Eine Folge weniger" onClick={() => setEpisodes((n) => clamp(Number(n) - 1))}><Minus className="w-3.5 h-3.5" aria-hidden="true" /></button>
            <input id={`${ids}-ep`} type="number" min="0" max={max} inputMode="numeric" className="input-field text-base sm:text-sm w-20 text-center" value={episodes}
              onChange={(e) => setEpisodes(e.target.value === '' ? '' : clamp(parseInt(e.target.value, 10) || 0))} />
            <button type="button" className="btn-secondary p-2" aria-label="Eine Folge mehr" onClick={() => setEpisodes((n) => clamp(Number(n) + 1))}><Plus className="w-3.5 h-3.5" aria-hidden="true" /></button>
          </div>
        </div>
        <div>
          <label htmlFor={`${ids}-status`} className="block text-[11px] text-slate-400 mb-1">Status</label>
          <select id={`${ids}-status`} className="input-field text-base sm:text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
            {PROGRESS_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${ids}-score`} className="block text-[11px] text-slate-400 mb-1">Bewertung</label>
          <select id={`${ids}-score`} className="input-field text-base sm:text-sm" value={score} onChange={(e) => setScore(e.target.value)}>
            <option value="">–</option>
            {Array.from({ length: 10 }, (_, i) => String(10 - i)).map((v) => <option key={v} value={v}>{v} / 10</option>)}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor={`${ids}-notes`} className="block text-[11px] text-slate-400 mb-1">Meine Notiz</label>
        <textarea id={`${ids}-notes`} rows={2} maxLength={4000} className="input-field text-base sm:text-sm" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <div className="flex flex-wrap gap-2 justify-end">
        {progress && <button type="button" className="btn-secondary text-xs" onClick={onRemove} disabled={busy}>Von meiner Liste entfernen</button>}
        <button type="submit" className="btn-primary text-xs" disabled={busy}>Fortschritt speichern</button>
      </div>
    </form>
  );
}

/**
 * Detail of one anime: banner, metadata, description, relations (add or open), everybody's progress, my progress,
 * link to a series, refresh (60 s lock) and delete. `fallback` is the list entry (offline it is all there is).
 */
export default function AnimeDetailModal({
  isOpen, animeId, fallback, onClose, canEdit, mangas = [], fetchDetail, updateProgress, removeFromMyList, update, refresh, remove, onAdd, onOpenAnime
}) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [titleDe, setTitleDe] = useState('');
  const [refreshLeft, setRefreshLeft] = useState(0);
  const begin = useLatestRequest();
  const hasFallback = useRef(Boolean(fallback));
  hasFallback.current = Boolean(fallback);
  const titleId = useId();
  const dialogRef = useDialogA11y(isOpen, { onClose });

  const load = useCallback(async () => {
    if (!animeId) return;
    const { signal, isCurrent } = begin();
    setError('');
    try {
      const data = await fetchDetail(animeId, { signal });
      if (isCurrent()) setDetail(data);
    } catch (err) {
      if (!isCurrent() || isAbortError(err)) return;
      setError(hasFallback.current ? '' : (err.message || 'Anime konnte nicht geladen werden'));
    }
  }, [animeId, begin, fetchDetail]);

  useEffect(() => {
    if (!isOpen) return;
    setDetail(null);
    setExpanded(false);
    load();
  }, [isOpen, load]);

  const anime = detail || fallback;
  useEffect(() => { setTitleDe(anime?.title_de || ''); }, [anime?.title_de]);

  useEffect(() => {
    if (!isOpen || !animeId) return undefined;
    const tick = () => setRefreshLeft(Math.max(0, Math.ceil(((lastRefresh.get(animeId) || 0) + REFRESH_LOCK_MS - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [isOpen, animeId]);

  if (!isOpen) return null;

  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      notify.error(err);
    } finally {
      setBusy(false);
    }
  };

  const saveProgress = (change) => run(async () => {
    const saved = await updateProgress(animeId, change);
    if (saved) {
      notify.success('Fortschritt gespeichert');
      await load();
    }
  });

  const doRefresh = () => run(async () => {
    lastRefresh.set(animeId, Date.now());
    setRefreshLeft(60);
    const fresh = await refresh(animeId);
    setDetail(fresh);
    notify.success(fresh.refreshed === false ? 'Bei den Quellen nicht mehr gefunden, der gespeicherte Stand bleibt' : 'Aktualisiert');
  });

  const doDelete = () => {
    if (!confirm(`„${displayTitle(anime)}“ für alle löschen? Der Fortschritt aller Benutzer geht verloren.`)) return;
    run(async () => {
      await remove(animeId);
      notify.success('Anime gelöscht');
      onClose();
    });
  };

  const saveLink = (value) => run(async () => setDetail(await update(animeId, { manga_id: value ? Number(value) : null })));
  const saveTitle = (e) => {
    e.preventDefault();
    run(async () => setDetail(await update(animeId, { title_de: titleDe.trim() || null })));
  };

  const description = shortDescription(anime?.description);
  const stale = anime ? staleText(anime) : null;
  const countdown = anime ? countdownText(anime.next_airing) : null;
  const sortedMangas = [...mangas].sort((a, b) => compareNatural(a.title, b.title));
  const relations = (anime?.relations || []).filter((r) => r.kind === 'ANIME');

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      className="outline-none dialog-overlay z-50 bg-black/80 backdrop-blur-sm animate-fade-in"
    >
      <div className="dialog-box glass-panel max-w-3xl rounded-2xl sm:rounded-3xl border border-slate-700/80 shadow-2xl overflow-hidden">
        <div className="relative h-28 sm:h-40 bg-slate-900">
          {anime?.banner_image && <CoverImage src={anime.banner_image} className="w-full h-full object-cover opacity-70" />}
          <button type="button" onClick={onClose} aria-label="Schließen" className="hit-44 absolute top-3 right-3 bg-slate-950/70 text-slate-200 hover:text-white p-1.5 rounded-lg">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>
        <div className="p-5 sm:p-7 -mt-14 sm:-mt-20 relative">
          {!anime && !error && <p className="text-sm text-slate-400" role="status">Wird geladen…</p>}
          {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
          {anime && (
            <>
              <div className="flex gap-4 items-end">
                <div className="w-24 sm:w-32 aspect-[2/3] rounded-xl overflow-hidden border border-slate-700 bg-slate-950 shrink-0 shadow-xl">
                  <CoverImage src={anime.cover_image} className="w-full h-full object-cover" fallback={<Tv className="w-8 h-8 m-auto mt-10 text-slate-500" aria-hidden="true" />} />
                </div>
                <div className="min-w-0 pb-1">
                  <h2 id={titleId} lang={langFor(displayTitle(anime)) || 'de'} className="text-xl sm:text-2xl font-extrabold text-white leading-tight break-words hyphens-auto [overflow-wrap:anywhere]">{displayTitle(anime)}</h2>
                  {anime.title_romaji && anime.title_romaji !== displayTitle(anime) && <p className="text-sm text-slate-400">{anime.title_romaji}</p>}
                  {anime.title_native && <p className="text-xs text-slate-400">{anime.title_native}</p>}
                </div>
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <dl className="space-y-1.5">
                  <MetaRow label="Format">{[formatLabel(anime.format), anime.season_year].filter(Boolean).join(' · ') || null}</MetaRow>
                  <MetaRow label="Status">{airingStatusLabel(anime.status)}</MetaRow>
                  <MetaRow label="Folgen">{anime.episodes ? `${anime.episodes}${anime.duration ? ` à ${anime.duration} Min.` : ''}` : null}</MetaRow>
                  <MetaRow label="Nächste Folge">{countdown ? `${countdown}${anime.next_airing?.estimated ? ' (geschätzt)' : ''}` : null}</MetaRow>
                  <MetaRow label="Studio">{(anime.studios || []).join(', ') || null}</MetaRow>
                  <MetaRow label="Genres">{(anime.genres || []).join(', ') || null}</MetaRow>
                  <MetaRow label="Wertung">{anime.score ? `${anime.score} / 100` : null}</MetaRow>
                  <MetaRow label="Reihe">
                    {anime.manga ? <Link to={`/manga/${anime.manga.id}`} className="text-brand-300 hover:text-brand-200 inline-flex items-center gap-1"><BookOpen className="w-3.5 h-3.5" aria-hidden="true" />{anime.manga.title}</Link> : null}
                  </MetaRow>
                </dl>
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    {anime.urls?.anilist && <a href={anime.urls.anilist} target="_blank" rel="noreferrer noopener" className="btn-secondary text-xs inline-flex items-center gap-1">AniList <ExternalLink className="w-3 h-3" aria-hidden="true" /></a>}
                    {anime.urls?.mal && <a href={anime.urls.mal} target="_blank" rel="noreferrer noopener" className="btn-secondary text-xs inline-flex items-center gap-1">MyAnimeList <ExternalLink className="w-3 h-3" aria-hidden="true" /></a>}
                  </div>
                  {stale && <p className="text-[11px] text-slate-400">{stale}</p>}
                  {canEdit && !anime.manual && (
                    <button type="button" className="btn-secondary text-xs inline-flex items-center gap-1" onClick={doRefresh} disabled={busy || refreshLeft > 0}>
                      <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> {refreshLeft > 0 ? `Aktualisieren (${refreshLeft} s)` : 'Aktualisieren'}
                    </button>
                  )}
                </div>
              </div>

              {description.text && (
                <div className="mt-4">
                  <p className="text-sm text-slate-300 whitespace-pre-line break-words">{expanded ? anime.description : description.text}</p>
                  {description.cut && <button type="button" className="text-xs text-brand-300 mt-1" onClick={() => setExpanded((v) => !v)}>{expanded ? 'Weniger anzeigen' : 'Mehr anzeigen'}</button>}
                </div>
              )}

              {canEdit && (
                <section className="mt-5 border-t border-slate-800 pt-4" aria-label="Mein Fortschritt">
                  <h3 className="text-sm font-bold text-white mb-2">Mein Fortschritt</h3>
                  <OwnProgress anime={anime} progress={anime.my_progress} onSave={saveProgress} busy={busy}
                    onRemove={() => run(async () => { await removeFromMyList(animeId); await load(); })} />
                </section>
              )}

              {(anime.progress || anime.progress_users || []).length > 0 && (
                <section className="mt-5 border-t border-slate-800 pt-4">
                  <h3 className="text-sm font-bold text-white mb-2">Fortschritt aller</h3>
                  <ul className="space-y-1">
                    {(anime.progress || anime.progress_users).map((p) => (
                      <li key={p.user_id} className="text-xs text-slate-300 flex gap-2">
                        <span className="font-semibold text-slate-100 w-28 truncate">{p.username}</span>
                        <span>{p.status}</span>
                        <span className="font-mono">{progressText(p.episodes_watched, anime.episodes)}</span>
                        {p.score ? <span>{p.score}/10</span> : null}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {relations.length > 0 && (
                <section className="mt-5 border-t border-slate-800 pt-4">
                  <h3 className="text-sm font-bold text-white mb-2">Verwandte Anime</h3>
                  <ul className="space-y-1.5">
                    {relations.map((r) => (
                      <li key={`${r.relation}-${r.anilist_id || r.mal_id}`} className="flex items-center gap-2 text-xs">
                        <span className="text-slate-400 w-32 shrink-0">{relationLabel(r.relation)}</span>
                        <span className="text-slate-200 min-w-0 flex-1 truncate">{r.title}{r.season_year ? ` (${r.season_year})` : ''}</span>
                        {r.in_collection_id ? (
                          <button type="button" className="btn-secondary text-[11px] py-1 px-2" onClick={() => onOpenAnime(r.in_collection_id)}>Öffnen</button>
                        ) : canEdit && (r.anilist_id || r.mal_id) ? (
                          <button type="button" className="btn-secondary text-[11px] py-1 px-2" disabled={busy}
                            onClick={() => run(async () => { await onAdd({ anilist_id: r.anilist_id || undefined, mal_id: r.mal_id || undefined }); notify.success(`„${r.title}“ hinzugefügt`); await load(); })}>
                            Hinzufügen
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {canEdit && (
                <section className="mt-5 border-t border-slate-800 pt-4 grid gap-3 sm:grid-cols-2">
                  <form onSubmit={saveTitle}>
                    <label htmlFor={`${titleId}-de`} className="block text-[11px] text-slate-400 mb-1">Deutscher Titel</label>
                    <div className="flex gap-2">
                      <input id={`${titleId}-de`} className="input-field text-base sm:text-sm" maxLength={200} value={titleDe} onChange={(e) => setTitleDe(e.target.value)} />
                      <button type="submit" className="btn-secondary text-xs" disabled={busy}>Speichern</button>
                    </div>
                  </form>
                  <div>
                    <label htmlFor={`${titleId}-manga`} className="block text-[11px] text-slate-400 mb-1">Verknüpfte Reihe</label>
                    <select id={`${titleId}-manga`} className="input-field text-base sm:text-sm" value={anime.manga_id || ''} disabled={busy} onChange={(e) => saveLink(e.target.value)}>
                      <option value="">Keine Verknüpfung</option>
                      {sortedMangas.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
                    </select>
                  </div>
                  <div className="sm:col-span-2 flex justify-end">
                    <button type="button" className="btn-secondary text-xs text-red-300 inline-flex items-center gap-1" onClick={doDelete} disabled={busy}>
                      <Trash className="w-3.5 h-3.5" aria-hidden="true" /> Für alle löschen
                    </button>
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
