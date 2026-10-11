import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, ExternalLink, Minus, Play, Plus, RefreshCw, Star, Trash, Tv, X } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import useLatestRequest from '../../hooks/useLatestRequest';
import CoverImage from '../common/CoverImage';
import { langFor } from '../common/lang';
import { openLinkOutside } from '../../app/openExternal';
import { isAbortError } from '../../utils/api';
import { notify } from '../../utils/notify';
import { compareNatural } from '../../utils/search';
import {
  PROGRESS_STATUSES, displayTitle, formatLabel, airingStatusLabel, relationLabel, progressText, countdownText, staleText, shortDescription,
  continueTarget, airedEpisodes, stillAiring, kindOf, kindLabel, seasonEpisodeText, ANIME_KINDS, watchedEpisodesOf, episodeSections,
  episodeGridCount, episodeScoresOf, averageEpisodeScore
} from '../../utils/animeHelpers';
import { formatNumber } from '../../utils/format';
import { animeProgressLabel } from '../../utils/enumLabels';
import { EDITION_LANGUAGES, languageName, withCurrent } from '../../utils/editions';
import { t, tn } from '../../i18n/index.js';

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

function WatchLanguageSelect({ id, label, value, onChange }) {
  return (
    <div>
      <label htmlFor={id} className="block text-[11px] text-slate-400 mb-1">{label}</label>
      <select id={id} className="input-field text-base sm:text-sm" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('Keine Angabe')}</option>
        {withCurrent(EDITION_LANGUAGES, value).map((code) => <option key={code} value={code}>{languageName(code)}</option>)}
      </select>
    </div>
  );
}

/** Own progress: counter, status, score, watched languages and note, saved together. */
function OwnProgress({ anime, progress, onSave, onRemove, busy }) {
  const ids = useId();
  const [episodes, setEpisodes] = useState(progress?.episodes_watched ?? 0);
  const [status, setStatus] = useState(progress?.status || 'Geplant'); // i18n-ignore: stored value
  const [score, setScore] = useState(progress?.score ? String(progress.score) : '');
  const [notes, setNotes] = useState(progress?.notes || '');
  const [audio, setAudio] = useState(progress?.audio_language || '');
  const [subtitle, setSubtitle] = useState(progress?.subtitle_language || '');
  useEffect(() => {
    setEpisodes(progress?.episodes_watched ?? 0);
    setStatus(progress?.status || 'Geplant'); // i18n-ignore: stored value
    setScore(progress?.score ? String(progress.score) : '');
    setNotes(progress?.notes || '');
    setAudio(progress?.audio_language || '');
    setSubtitle(progress?.subtitle_language || '');
  }, [progress]);
  const movie = kindOf(anime) === 'movie';
  const episodeAt = seasonEpisodeText(anime, Number(episodes) || 0);
  const max = anime.episodes > 0 ? anime.episodes : undefined;
  const aired = airedEpisodes(anime);
  const airing = stillAiring(anime);
  const clamp = (n) => Math.max(0, max ? Math.min(max, n) : n);
  const save = (e) => {
    e.preventDefault();
    const change = {};
    if (episodes !== (progress?.episodes_watched ?? 0)) change.episodes_watched = Number(episodes) || 0;
    if (status !== (progress?.status || 'Geplant')) change.status = status; // i18n-ignore: stored value
    if ((score ? Number(score) : null) !== (progress?.score ?? null)) change.score = score ? Number(score) : null;
    if ((notes.trim() || null) !== (progress?.notes ?? null)) change.notes = notes.trim() || null;
    if ((audio || null) !== (progress?.audio_language ?? null)) change.audio_language = audio || null;
    if ((subtitle || null) !== (progress?.subtitle_language ?? null)) change.subtitle_language = subtitle || null;
    if (!progress && !Object.keys(change).length) change.status = status;
    onSave(change);
  };
  return (
    <form onSubmit={save} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        {!movie && <div>
          <label htmlFor={`${ids}-ep`} className="block text-[11px] text-slate-400 mb-1">{max ? t('Gesehene Folgen (von {max})', { max }) : aired ? t('Gesehene Folgen (bisher {aired} ausgestrahlt)', { aired }) : t('Gesehene Folgen')}</label>
          <div className="flex items-center gap-1">
            <button type="button" className="btn-secondary p-2" aria-label={t('Eine Folge weniger')} onClick={() => setEpisodes((n) => clamp(Number(n) - 1))}><Minus className="w-3.5 h-3.5" aria-hidden="true" /></button>
            <input id={`${ids}-ep`} type="number" min="0" max={max} inputMode="numeric" className="input-field text-base sm:text-sm w-20 text-center" value={episodes}
              onChange={(e) => setEpisodes(e.target.value === '' ? '' : clamp(parseInt(e.target.value, 10) || 0))} />
            <button type="button" className="btn-secondary p-2" aria-label={t('Eine Folge mehr')} onClick={() => setEpisodes((n) => clamp(Number(n) + 1))}><Plus className="w-3.5 h-3.5" aria-hidden="true" /></button>
            {episodeAt && <span className="text-xs font-mono text-slate-300 ml-1">{episodeAt}</span>}
          </div>
        </div>}
        <div>
          <label htmlFor={`${ids}-status`} className="block text-[11px] text-slate-400 mb-1">{t('Status')}</label>
          <select id={`${ids}-status`} className="input-field text-base sm:text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
            {PROGRESS_STATUSES.map((s) => {
              const locked = airing && s === 'Gesehen';
              return <option key={s} value={s} disabled={locked} title={locked ? t('Läuft noch') : undefined}>{animeProgressLabel(s)}</option>;
            })}
          </select>
        </div>
        <div>
          <label htmlFor={`${ids}-score`} className="block text-[11px] text-slate-400 mb-1">{t('Bewertung')}</label>
          <select id={`${ids}-score`} className="input-field text-base sm:text-sm" value={score} onChange={(e) => setScore(e.target.value)}>
            <option value="">–</option>
            {Array.from({ length: 10 }, (_, i) => String(10 - i)).map((v) => <option key={v} value={v}>{v} / 10</option>)}
          </select>
        </div>
        <WatchLanguageSelect id={`${ids}-audio`} label={t('Gesehen auf')} value={audio} onChange={setAudio} />
        <WatchLanguageSelect id={`${ids}-subtitle`} label={t('Untertitel')} value={subtitle} onChange={setSubtitle} />
      </div>
      <div>
        <label htmlFor={`${ids}-notes`} className="block text-[11px] text-slate-400 mb-1">{t('Meine Notiz')}</label>
        <textarea id={`${ids}-notes`} rows={2} maxLength={4000} className="input-field text-base sm:text-sm" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <div className="flex flex-wrap gap-2 justify-end">
        {progress && <button type="button" className="btn-secondary text-xs" onClick={onRemove} disabled={busy}>{t('Von meiner Liste entfernen')}</button>}
        <button type="submit" className="btn-primary text-xs" disabled={busy}>{t('Fortschritt speichern')}</button>
      </div>
    </form>
  );
}

const SAVE_DELAY_MS = 600;

const sectionOf = (sections, episode) => Math.max(0, sections.findIndex((s) => episode >= s.from && episode <= s.to));

/**
 * Single episodes as toggles (aria-pressed). Taps are collected for a moment and saved as one set of watched episodes and
 * episode ratings (PUT progress with watched_episodes and episode_scores); saves run one after another, closing the
 * dialog saves at once. "Folgen bewerten" switches the taps to rating: an episode gets 1..10 and counts as watched with it;
 * unmarking an episode drops its rating.
 */
function EpisodeGrid({ anime, progress, onSave, disabled }) {
  const ids = useId();
  const serverMarks = useMemo(() => watchedEpisodesOf(progress), [progress]);
  const serverScores = useMemo(() => episodeScoresOf(progress), [progress]);
  const [draft, setDraft] = useState(null);
  const marks = draft ? draft.marks : serverMarks;
  const scores = draft ? draft.scores : serverScores;
  const watched = useMemo(() => new Set(marks), [marks]);
  const count = episodeGridCount(anime, marks);
  const sections = useMemo(() => episodeSections(anime, count), [anime, count]);
  const [picked, setPicked] = useState(null);
  const [rating, setRating] = useState(false);
  const [ratingFor, setRatingFor] = useState(null);
  const firstOpen = useMemo(() => {
    for (let n = 1; n <= count; n++) if (!watched.has(n)) return n;
    return count;
  }, [count, watched]);
  const index = Math.min(picked ?? sectionOf(sections, firstOpen), sections.length - 1);
  const section = sections[index];
  const pending = useRef(null);
  const timer = useRef(null);
  const chain = useRef(Promise.resolve());
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    chain.current = chain.current
      .then(() => saveRef.current(next))
      .catch(() => {})
      .finally(() => { if (!pending.current && !timer.current) setDraft(null); });
  }, []);
  useEffect(() => () => flush(), [flush]);

  if (!section) return null;
  const change = (nextMarks, nextScores) => {
    setDraft({ marks: nextMarks, scores: nextScores });
    pending.current = { watched_episodes: nextMarks, episode_scores: nextScores };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DELAY_MS);
  };
  const sorted = (set) => [...set].sort((a, b) => a - b);
  const toggle = (n) => {
    const set = new Set(marks);
    const nextScores = { ...scores };
    if (set.has(n)) {
      set.delete(n);
      delete nextScores[n];
    } else set.add(n);
    change(sorted(set), nextScores);
  };
  const rate = (n, value) => {
    const set = new Set(marks);
    const nextScores = { ...scores };
    if (value === null) delete nextScores[n];
    else {
      nextScores[n] = value;
      set.add(n);
    }
    change(sorted(set), nextScores);
    setRatingFor(null);
  };
  const numbers = [];
  for (let n = section.from; n <= section.to; n++) numbers.push(n);
  const allWatched = numbers.every((n) => watched.has(n));
  const toggleSection = () => {
    const set = new Set(marks);
    const nextScores = { ...scores };
    for (const n of numbers) {
      if (allWatched) {
        set.delete(n);
        delete nextScores[n];
      } else set.add(n);
    }
    change(sorted(set), nextScores);
  };
  const sectionLabel = (s) => (s.season !== null
    ? t('Staffel {season} · Folgen {from}–{to}', { season: s.season, from: s.from, to: s.to })
    : t('Folgen {from}–{to}', { from: s.from, to: s.to }));
  const episodeLabel = (n) => (section.season !== null
    ? t('Staffel {season}, Folge {episode}', { season: section.season, episode: n - section.from + 1 })
    : t('Folge {n}', { n }));
  const cellLabel = (n) => (scores[n] ? t('{episode}, Bewertung {score} von 10', { episode: episodeLabel(n), score: scores[n] }) : episodeLabel(n));
  const rated = Object.keys(scores).length;
  const average = averageEpisodeScore(scores);

  return (
    <div className="space-y-2">
      <p id={`${ids}-hint`} className="text-[11px] text-slate-400">
        {rating ? t('Tippe eine Folge an, um sie zu bewerten.') : t('Tippe eine Folge an, um sie als gesehen zu markieren oder die Markierung zu entfernen.')}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        {sections.length > 1 && (
          <div>
            <label htmlFor={`${ids}-section`} className="block text-[11px] text-slate-400 mb-1">{t('Abschnitt')}</label>
            <select id={`${ids}-section`} className="input-field text-base sm:text-sm" value={index} onChange={(e) => { setPicked(Number(e.target.value)); setRatingFor(null); }}>
              {sections.map((s, i) => <option key={s.from} value={i}>{sectionLabel(s)}</option>)}
            </select>
          </div>
        )}
        <button type="button" className="btn-secondary text-xs" onClick={toggleSection} disabled={disabled}>
          {allWatched ? t('Abschnitt zurücksetzen') : t('Alle im Abschnitt gesehen')}
        </button>
        <button type="button" aria-pressed={rating} onClick={() => { setRating((v) => !v); setRatingFor(null); }} disabled={disabled}
          className={`btn-secondary text-xs inline-flex items-center gap-1 ${rating ? 'ring-1 ring-amber-400 text-amber-200' : ''}`}>
          <Star className="w-3.5 h-3.5" aria-hidden="true" /> {t('Folgen bewerten')}
        </button>
      </div>
      {average !== null && (
        <p className="text-xs text-slate-300">{tn('Ø {avg} aus {n} bewerteten Folge', 'Ø {avg} aus {n} bewerteten Folgen', rated, { avg: formatNumber(average, 1) })}</p>
      )}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(2.5rem,1fr))] gap-1.5 pt-1" aria-label={sectionLabel(section)} aria-describedby={`${ids}-hint`}>
        {numbers.map((n) => {
          const on = watched.has(n);
          const label = cellLabel(n);
          const selected = rating && ratingFor === n;
          return (
            <li key={n}>
              <button
                type="button"
                aria-pressed={rating ? undefined : on}
                aria-expanded={rating ? selected : undefined}
                aria-controls={rating ? `${ids}-rate` : undefined}
                aria-label={label}
                title={label}
                disabled={disabled}
                onClick={() => (rating ? setRatingFor(selected ? null : n) : toggle(n))}
                className={`relative w-full h-9 [@media(pointer:coarse)]:h-11 rounded-lg text-xs font-mono border transition-colors ${on
                  ? 'bg-brand-700 border-brand-500 text-white'
                  : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-slate-500'} ${selected ? 'ring-2 ring-amber-400' : ''}`}
              >
                {section.season !== null ? n - section.from + 1 : n}
                {scores[n] && (
                  <span aria-hidden="true" className="absolute -top-1.5 -right-1 min-w-[1rem] px-0.5 rounded bg-amber-400 text-slate-950 text-[10px] font-bold leading-4 font-sans">
                    {scores[n]}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {rating && ratingFor !== null && (
        <div id={`${ids}-rate`} role="group" aria-labelledby={`${ids}-rate-title`} className="rounded-xl border border-slate-700 bg-slate-900/80 p-3 space-y-2">
          <p id={`${ids}-rate-title`} className="text-xs font-semibold text-slate-100">{t('{episode} bewerten', { episode: episodeLabel(ratingFor) })}</p>
          <div className="grid grid-cols-5 sm:grid-cols-10 gap-1.5">
            {Array.from({ length: 10 }, (_, i) => i + 1).map((v) => (
              <button key={v} type="button" aria-pressed={scores[ratingFor] === v} disabled={disabled} onClick={() => rate(ratingFor, v)}
                className={`h-9 [@media(pointer:coarse)]:h-11 rounded-lg text-sm font-bold border transition-colors ${scores[ratingFor] === v
                  ? 'bg-amber-400 border-amber-300 text-slate-950'
                  : 'bg-slate-950 border-slate-700 text-slate-200 hover:border-amber-400'}`}>
                {v}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 justify-end">
            {scores[ratingFor] && <button type="button" className="btn-secondary text-xs" disabled={disabled} onClick={() => rate(ratingFor, null)}>{t('Bewertung entfernen')}</button>}
            <button type="button" className="btn-secondary text-xs" onClick={() => setRatingFor(null)}>{t('Fertig')}</button>
          </div>
        </div>
      )}
    </div>
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
  const latest = useRef(null);

  const load = useCallback(async () => {
    if (!animeId) return;
    const { signal, isCurrent } = begin();
    setError('');
    try {
      const data = await fetchDetail(animeId, { signal });
      if (isCurrent()) setDetail(data);
    } catch (err) {
      if (!isCurrent() || isAbortError(err)) return;
      setError(hasFallback.current ? '' : (err.message || t('Anime konnte nicht geladen werden')));
    }
  }, [animeId, begin, fetchDetail]);
  latest.current = { animeId, load };

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
      notify.success(t('Fortschritt gespeichert'));
      await load();
    }
  });

  const doRefresh = () => run(async () => {
    lastRefresh.set(animeId, Date.now());
    setRefreshLeft(60);
    const fresh = await refresh(animeId);
    setDetail(fresh);
    notify.success(fresh.refreshed === false ? t('Bei den Quellen nicht mehr gefunden, der gespeicherte Stand bleibt') : t('Aktualisiert'));
  });

  const doDelete = () => {
    if (!confirm(t('„{title}“ für alle löschen? Der Fortschritt aller Benutzer geht verloren.', { title: displayTitle(anime) }))) return;
    run(async () => {
      await remove(animeId);
      notify.success(t('Anime gelöscht'));
      onClose();
    });
  };

  const onRemove = () => run(async () => {
    const id = animeId;
    const prev = anime.my_progress;
    const removed = await removeFromMyList(id, { decline: true });
    await load();
    if (!removed || !prev) return;
    notify.success(t('Von deiner Liste entfernt'), {
      action: {
        label: t('Rückgängig'),
        onClick: async () => {
          const saved = await updateProgress(id, {
            status: prev.status, episodes_watched: prev.episodes_watched, score: prev.score, notes: prev.notes,
            audio_language: prev.audio_language ?? null, subtitle_language: prev.subtitle_language ?? null,
            ...(prev.watched_episodes !== undefined ? { watched_episodes: prev.watched_episodes } : {}), restore: true
          });
          if (saved && latest.current?.animeId === id) latest.current.load();
        }
      }
    });
  });

  // a tap in the episode grid: no toast, the dialog reloads its detail so the counter and status follow
  const saveEpisodes = async (change) => {
    const saved = await updateProgress(animeId, change);
    if (saved && latest.current?.animeId === animeId) await latest.current.load();
  };

  const saveLink = (value) => run(async () => setDetail(await update(animeId, { manga_id: value ? Number(value) : null })));
  const saveKind = (value) => run(async () => setDetail(await update(animeId, { kind: value })));
  const saveTitle = (e) => {
    e.preventDefault();
    run(async () => setDetail(await update(animeId, { title_de: titleDe.trim() || null })));
  };

  const description = shortDescription(anime?.description);
  const stale = anime ? staleText(anime) : null;
  const kind = anime ? kindOf(anime) : 'anime';
  const countdown = anime ? countdownText(anime.next_airing, undefined, kind) : null;
  const seasons = Array.isArray(anime?.seasons) ? anime.seasons : [];
  const sortedMangas = [...mangas].sort((a, b) => compareNatural(a.title, b.title));
  const relations = (anime?.relations || []).filter((r) => r.kind === 'ANIME');
  const next = continueTarget(anime);
  const aired = anime ? airedEpisodes(anime) : null;

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
          <button type="button" onClick={onClose} aria-label={t('Schließen')} className="hit-44 absolute top-3 right-3 bg-slate-950/70 text-slate-200 hover:text-white p-1.5 rounded-lg">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>
        <div className="p-5 sm:p-7 -mt-14 sm:-mt-20 relative">
          {!anime && !error && <p className="text-sm text-slate-400" role="status">{t('Wird geladen…')}</p>}
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
                <div className="space-y-1.5">
                  <dl className="space-y-1.5">
                    <MetaRow label={t('Art')}>{kindLabel(kind)}</MetaRow>
                    <MetaRow label={t('Format')}>{[formatLabel(anime.format), anime.season_year].filter(Boolean).join(' · ') || null}</MetaRow>
                    <MetaRow label={t('Status')}>{airingStatusLabel(anime.status)}</MetaRow>
                    {kind === 'anime' || (kind === 'tv' && !seasons.length) ? (
                      <MetaRow label={t('Folgen')}>{anime.episodes ? (anime.duration ? t('{episodes} à {duration} Min.', { episodes: anime.episodes, duration: anime.duration }) : `${anime.episodes}`) : null}</MetaRow>
                    ) : null}
                    <MetaRow label={t('Nächste Folge')}>{countdown ? (anime.next_airing?.estimated ? t('{countdown} (geschätzt)', { countdown }) : `${countdown}`) : null}</MetaRow>
                    <MetaRow label={t('Studio')}>{(anime.studios || []).join(', ') || null}</MetaRow>
                    <MetaRow label={t('Genres')}>{(anime.genres || []).join(', ') || null}</MetaRow>
                    <MetaRow label={t('Wertung')}>{anime.score ? `${anime.score} / 100` : null}</MetaRow>
                    <MetaRow label={t('Reihe')}>
                      {anime.manga ? <Link to={`/manga/${anime.manga.id}`} className="text-brand-300 hover:text-brand-200 inline-flex items-center gap-1"><BookOpen className="w-3.5 h-3.5" aria-hidden="true" />{anime.manga.title}</Link> : null}
                    </MetaRow>
                  </dl>
                  {kind === 'tv' && seasons.length > 0 && <p className="text-xs text-slate-200">{t('Staffeln: {n} · Folgen: {m}', { n: seasons.length, m: anime.episodes || 0 })}</p>}
                  {kind === 'movie' && anime.duration ? <p className="text-xs text-slate-200">{t('Laufzeit: {n} Min.', { n: anime.duration })}</p> : null}
                </div>
                <div className="space-y-2">
                  {next && ( // i18n-ignore: continueTarget() returns the label translated
                    <a
                      id="anime-continue-link"
                      href={next.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      onClick={(e) => openLinkOutside(e, { preferApp: true })}
                      aria-label={`${next.label}: ${displayTitle(anime)}`}
                      className="btn-primary text-xs inline-flex items-center gap-1.5"
                    >
                      <Play className="w-3.5 h-3.5" aria-hidden="true" /> {next.label}
                    </a>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {anime.urls?.anilist && <a href={anime.urls.anilist} target="_blank" rel="noreferrer noopener" className="btn-secondary text-xs inline-flex items-center gap-1">AniList <ExternalLink className="w-3 h-3" aria-hidden="true" /></a>}
                    {anime.urls?.mal && <a href={anime.urls.mal} target="_blank" rel="noreferrer noopener" className="btn-secondary text-xs inline-flex items-center gap-1">MyAnimeList <ExternalLink className="w-3 h-3" aria-hidden="true" /></a>}
                    {anime.urls?.imdb && <a href={anime.urls.imdb} target="_blank" rel="noreferrer noopener" className="btn-secondary text-xs inline-flex items-center gap-1">IMDb <ExternalLink className="w-3 h-3" aria-hidden="true" /></a>}
                    {anime.urls?.tmdb && <a href={anime.urls.tmdb} target="_blank" rel="noreferrer noopener" className="btn-secondary text-xs inline-flex items-center gap-1">TMDB <ExternalLink className="w-3 h-3" aria-hidden="true" /></a>}
                  </div>
                  {stale && <p className="text-[11px] text-slate-400">{stale}</p>}
                  {canEdit && !anime.manual && (
                    <button type="button" className="btn-secondary text-xs inline-flex items-center gap-1" onClick={doRefresh} disabled={busy || refreshLeft > 0}>
                      <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> {refreshLeft > 0 ? t('Aktualisieren ({refreshLeft} s)', { refreshLeft }) : t('Aktualisieren')}
                    </button>
                  )}
                </div>
              </div>

              {description.text && (
                <div className="mt-4">
                  <p className="text-sm text-slate-300 whitespace-pre-line break-words">{expanded ? anime.description : description.text}</p>
                  {description.cut && <button type="button" className="text-xs text-brand-300 mt-1" onClick={() => setExpanded((v) => !v)}>{expanded ? t('Weniger anzeigen') : t('Mehr anzeigen')}</button>}
                </div>
              )}

              {canEdit && (
                <section className="mt-5 border-t border-slate-800 pt-4" aria-label={t('Mein Fortschritt')}>
                  <h3 className="text-sm font-bold text-white mb-2">{t('Mein Fortschritt')}</h3>
                  <OwnProgress anime={anime} progress={anime.my_progress} onSave={saveProgress} busy={busy}
                    onRemove={onRemove} />
                </section>
              )}

              {canEdit && kind !== 'movie' && (
                <section className="mt-5 border-t border-slate-800 pt-4" aria-labelledby={`${titleId}-episodes`}>
                  <h3 id={`${titleId}-episodes`} className="text-sm font-bold text-white mb-2">{t('Einzelne Folgen')}</h3>
                  <EpisodeGrid key={anime.id} anime={anime} progress={anime.my_progress} onSave={saveEpisodes} disabled={busy} />
                </section>
              )}

              {(anime.progress || anime.progress_users || []).length > 0 && (
                <section className="mt-5 border-t border-slate-800 pt-4">
                  <h3 className="text-sm font-bold text-white mb-2">{t('Fortschritt aller')}</h3>
                  <ul className="space-y-1">
                    {(anime.progress || anime.progress_users).map((p) => (
                      <li key={p.user_id} className="text-xs text-slate-300 flex gap-2">
                        <span className="font-semibold text-slate-100 w-28 truncate">{p.username}</span>
                        <span>{animeProgressLabel(p.status)}</span>
                        {kind !== 'movie' && <span className="font-mono">{seasonEpisodeText(anime, p.episodes_watched) || progressText(p.episodes_watched, anime.episodes, aired)}</span>}
                        {p.score ? <span>{p.score}/10</span> : null}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {relations.length > 0 && (
                <section className="mt-5 border-t border-slate-800 pt-4">
                  <h3 className="text-sm font-bold text-white mb-2">{t('Verwandte Anime')}</h3>
                  <ul className="space-y-1.5">
                    {relations.map((r) => (
                      <li key={`${r.relation}-${r.anilist_id || r.mal_id}`} className="flex items-center gap-2 text-xs">
                        <span className="text-slate-400 w-32 shrink-0">{relationLabel(r.relation)}</span>
                        <span className="text-slate-200 min-w-0 flex-1 truncate">{r.title}{r.season_year ? ` (${r.season_year})` : ''}</span>
                        {r.in_collection_id ? (
                          <button type="button" className="btn-secondary text-[11px] py-1 px-2" onClick={() => onOpenAnime(r.in_collection_id)}>{t('Öffnen')}</button>
                        ) : canEdit && (r.anilist_id || r.mal_id) ? (
                          <button type="button" className="btn-secondary text-[11px] py-1 px-2" disabled={busy}
                            onClick={() => run(async () => { await onAdd({ anilist_id: r.anilist_id || undefined, mal_id: r.mal_id || undefined }); notify.success(t('„{title}“ hinzugefügt', { title: r.title })); await load(); })}>
                            {t('Hinzufügen')}
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
                    <label htmlFor={`${titleId}-de`} className="block text-[11px] text-slate-400 mb-1">{t('Deutscher Titel')}</label>
                    <div className="flex gap-2">
                      <input id={`${titleId}-de`} className="input-field text-base sm:text-sm" maxLength={200} value={titleDe} onChange={(e) => setTitleDe(e.target.value)} />
                      <button type="submit" className="btn-secondary text-xs" disabled={busy}>{t('Speichern')}</button>
                    </div>
                  </form>
                  <div>
                    <label htmlFor={`${titleId}-manga`} className="block text-[11px] text-slate-400 mb-1">{t('Verknüpfte Reihe')}</label>
                    <select id={`${titleId}-manga`} className="input-field text-base sm:text-sm" value={anime.manga_id || ''} disabled={busy} onChange={(e) => saveLink(e.target.value)}>
                      <option value="">{t('Keine Verknüpfung')}</option>
                      {sortedMangas.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
                    </select>
                  </div>
                  {anime.manual && (
                    <div>
                      <label htmlFor={`${titleId}-kind`} className="block text-[11px] text-slate-400 mb-1">{t('Art')}</label>
                      <select id={`${titleId}-kind`} className="input-field text-base sm:text-sm" value={kind} disabled={busy} onChange={(e) => saveKind(e.target.value)}>
                        {ANIME_KINDS.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
                      </select>
                    </div>
                  )}
                  <div className="sm:col-span-2 flex justify-end">
                    <button type="button" className="btn-secondary text-xs text-red-300 inline-flex items-center gap-1" onClick={doDelete} disabled={busy}>
                      <Trash className="w-3.5 h-3.5" aria-hidden="true" /> {t('Für alle löschen')}
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
