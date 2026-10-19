import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BookOpen, ExternalLink, ListOrdered, Minus, Play, Plus, RefreshCw, Sparkles, Star, Trash, Tv, X } from 'lucide-react';
import useDialogA11y, { afterDialogEntriesDropped, dialogEntryOnTop } from '../../hooks/useDialogA11y';
import useLatestRequest from '../../hooks/useLatestRequest';
import useAccountDefaults from '../../hooks/useAccountDefaults';
import CoverImage from '../common/CoverImage';
import { langFor } from '../common/lang';
import { openLinkOutside } from '../../app/openExternal';
import api, { isAbortError } from '../../utils/api';
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
import episodeMarks from '../../../../core/anime/episodes.js';
import ConfirmDialog from './ConfirmDialog';
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

const MAX_PUBLIC_COMMENT = 500;

/** Whether a stored progress carries a rating (a score or an episode score), as core/anime/progress.js counts it. */
const isRated = (progress) => Boolean(progress)
  && ((progress.score !== null && progress.score !== undefined) || Object.keys(episodeMarks.parseScores(progress.episode_scores)).length > 0);

/**
 * The form values of a stored progress. The visibility shown is the stored one once the progress is rated; before the
 * first rating it is the account default, which the server gives a first rating sent without a visibility.
 */
const formValues = (progress, defaultVisibility) => ({
  episodes: progress?.episodes_watched ?? 0,
  status: progress?.status || 'Geplant', // i18n-ignore: stored value
  score: progress?.score ? String(progress.score) : '',
  notes: progress?.notes || '',
  audio: progress?.audio_language || '',
  visibility: (isRated(progress) ? progress.rating_visibility : defaultVisibility || progress?.rating_visibility) || 'public',
  comment: progress?.public_comment || '',
  subtitle: progress?.subtitle_language || ''
});

/**
 * Whether anybody else is in this entry: another account's progress, or community ratings beyond the own one. Without
 * them (a single account) the visibility, the comment and the community block stay hidden.
 */
function sharedWithOthers(anime) {
  const rows = anime.progress || anime.progress_users || [];
  const mine = anime.my_progress;
  const others = mine?.user_id !== undefined && mine?.user_id !== null
    ? rows.filter((p) => p.user_id !== mine.user_id).length
    : rows.length - (mine ? 1 : 0);
  const ownCounted = mine?.score && mine.rating_visibility !== 'private' ? 1 : 0;
  return others > 0 || (anime.community?.count || 0) > ownCounted;
}

/**
 * Own progress: counter, status, score, watched languages and note, saved together; with other accounts (`sharing`)
 * also who sees the rating and a comment on it. A new stored progress (a grid tap, a reload) only replaces the fields
 * whose stored value changed, so an unsaved note or score survives it; a visibility picked meanwhile survives too.
 * A first rating goes out with the shown visibility; `visibilityRef` gets `{ id, value }` of it for the episode grid
 * (null while the shown value is only a guess: account default unknown, nothing picked, nothing rated).
 */
function OwnProgress({ anime, progress, onSave, onRemove, busy, onDirtyChange, defaultVisibility = null, sharing = false, visibilityRef }) {
  const ids = useId();
  const seeded = useRef(null);
  if (seeded.current === null) seeded.current = formValues(progress, defaultVisibility);
  const [episodes, setEpisodes] = useState(seeded.current.episodes);
  const [status, setStatus] = useState(seeded.current.status);
  const [score, setScore] = useState(seeded.current.score);
  const [notes, setNotes] = useState(seeded.current.notes);
  const [audio, setAudio] = useState(seeded.current.audio);
  const [subtitle, setSubtitle] = useState(seeded.current.subtitle);
  const [visibility, setVisibility] = useState(seeded.current.visibility);
  const [comment, setComment] = useState(seeded.current.comment);
  useEffect(() => {
    const next = formValues(progress, defaultVisibility);
    const last = seeded.current;
    const setters = { episodes: setEpisodes, status: setStatus, score: setScore, notes: setNotes, audio: setAudio, subtitle: setSubtitle, comment: setComment };
    for (const [field, set] of Object.entries(setters)) if (next[field] !== last[field]) set(next[field]);
    if (next.visibility !== last.visibility) setVisibility((shown) => (shown === last.visibility ? next.visibility : shown));
    seeded.current = next;
  }, [progress, defaultVisibility]);

  const currentInitial = formValues(progress, defaultVisibility);
  const isDirty = Boolean(
    (episodes !== '' && Number(episodes) !== currentInitial.episodes) ||
    status !== currentInitial.status ||
    (score ? String(score) : '') !== currentInitial.score ||
    (notes.trim() || '') !== currentInitial.notes.trim() ||
    (audio || '') !== currentInitial.audio ||
    (subtitle || '') !== currentInitial.subtitle ||
    visibility !== currentInitial.visibility ||
    comment.trim() !== currentInitial.comment.trim()
  );
  const visibilityKnown = sharing && (Boolean(defaultVisibility) || isRated(progress) || visibility !== currentInitial.visibility);
  if (visibilityRef) visibilityRef.current = visibilityKnown ? { id: anime.id, value: visibility } : null;

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);
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
    if (sharing) {
      // a first rating carries the shown value, so the server never puts another default on it than the one shown
      const firstRating = !isRated(progress) && change.score !== undefined && change.score !== null;
      if (visibilityKnown && (firstRating || visibility !== (progress?.rating_visibility ?? null))) change.rating_visibility = visibility;
      if ((comment.trim() || null) !== (progress?.public_comment ?? null)) change.public_comment = comment.trim() || null;
    }
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
      {sharing && (
        <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)] items-start">
          <div>
            <label htmlFor={`${ids}-visibility`} className="block text-[11px] text-slate-400 mb-1">{t('Meine Bewertung sehen')}</label>
            <select id={`${ids}-visibility`} className="input-field text-base sm:text-sm" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
              <option value="public">{t('Alle mit Namen')}</option>
              <option value="anonymous">{t('Alle anonym')}</option>
              <option value="private">{t('Nur ich')}</option>
            </select>
          </div>
          <div>
            <label htmlFor={`${ids}-comment`} className="block text-[11px] text-slate-400 mb-1">{t('Kommentar zur Bewertung')}</label>
            <textarea id={`${ids}-comment`} rows={2} maxLength={MAX_PUBLIC_COMMENT} className="input-field text-base sm:text-sm" value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
        </div>
      )}
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

const EXTRA_FORMATS = ['MOVIE', 'SPECIAL', 'OVA', 'MUSIC'];

const sectionOf = (sections, episode) => Math.max(0, sections.findIndex((s) => episode >= s.from && episode <= s.to));

/**
 * Single episodes as toggles (aria-pressed). Taps are collected for a moment and saved as one set of watched episodes and
 * episode ratings of this grid's entry (onSave(id, { watched_episodes, episode_scores })); saves run one after another,
 * closing the dialog saves at once. The taps stay on screen until no save waits or runs any more, then `onSettled(id)`
 * reloads the dialog once; a failed save drops them together with the saves still queued. `onPendingChange(busy)` tells
 * whether a save waits or runs. "Folgen bewerten" switches the taps to rating: the 1..10 picker opens above the cells,
 * an episode gets a score and counts as watched with it; unmarking an episode drops its rating.
 */
function EpisodeGrid({ anime, progress, onSave, onSettled, onPendingChange, disabled }) {
  const ids = useId();
  const total = anime.episodes > 0 ? anime.episodes : null;
  const serverMarks = useMemo(() => watchedEpisodesOf(progress, total), [progress, total]);
  const serverScores = useMemo(() => episodeScoresOf(progress, total), [progress, total]);
  const [draft, setDraft] = useState(null);
  const marks = draft ? draft.marks : serverMarks;
  const scores = draft ? draft.scores : serverScores;
  const watched = useMemo(() => new Set(marks), [marks]);
  const count = episodeGridCount(anime, marks);
  const sections = useMemo(() => episodeSections(anime, count), [anime, count]);
  const [picked, setPicked] = useState(null);
  const [rating, setRating] = useState(false);
  const [ratingFor, setRatingFor] = useState(null);
  const panelRef = useRef(null);
  const returnTo = useRef(null);
  const firstOpen = useMemo(() => {
    for (let n = 1; n <= count; n++) if (!watched.has(n)) return n;
    return count;
  }, [count, watched]);
  useEffect(() => {
    setPicked((p) => (p === null || p < sections.length ? p : Math.max(0, sections.length - 1)));
  }, [sections]);
  const index = Math.min(picked ?? sectionOf(sections, firstOpen), sections.length - 1);
  const section = sections[index];

  const pending = useRef(null);
  const timer = useRef(null);
  const inFlight = useRef(0);
  const round = useRef(0);
  const chain = useRef(Promise.resolve());
  const mounted = useRef(false);
  const reported = useRef(false);
  const handlers = useRef(null);
  handlers.current = { onSave, onSettled, onPendingChange };

  const report = useCallback(() => {
    const busy = Boolean(timer.current || pending.current || inFlight.current);
    if (mounted.current && busy !== reported.current) {
      reported.current = busy;
      handlers.current.onPendingChange?.(busy);
    }
    return busy;
  }, []);
  // the taps of a failed save are gone: the grid shows the stored state, queued saves of the same burst are skipped
  const fail = useCallback(() => {
    round.current += 1;
    clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    if (mounted.current) setDraft(null);
  }, []);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    inFlight.current += 1;
    const own = round.current;
    chain.current = chain.current
      .then(() => (own === round.current ? handlers.current.onSave(next.id, next.change) : undefined))
      .then((saved) => { if (saved === null) fail(); }, fail)
      .finally(() => {
        inFlight.current -= 1;
        if (report() || !mounted.current) return;
        setDraft(null);
        handlers.current.onSettled?.(next.id);
      });
  }, [fail, report]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      flush();
      if (reported.current) handlers.current.onPendingChange?.(false);
      reported.current = false;
      mounted.current = false;
    };
  }, [flush]);

  // the picker takes the focus when it opens; a score or "Fertig" gives it back to the episode
  useEffect(() => {
    if (ratingFor !== null) {
      const panel = panelRef.current;
      (panel?.querySelector('[aria-pressed="true"]') || panel?.querySelector('button'))?.focus();
    } else if (returnTo.current !== null) {
      document.getElementById(`${ids}-ep-${returnTo.current}`)?.focus();
      returnTo.current = null;
    }
  }, [ratingFor, ids]);

  if (!section) return null;
  const change = (nextMarks, nextScores) => {
    setDraft({ marks: nextMarks, scores: nextScores });
    pending.current = { id: anime.id, change: { watched_episodes: nextMarks, episode_scores: nextScores } };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DELAY_MS);
    report();
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
    returnTo.current = n;
    setRatingFor(null);
  };
  const closePicker = () => {
    returnTo.current = ratingFor;
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
  const sectionLabel = (s) => {
    if (s.name) return t('{name} · Folgen {from}–{to}', { name: s.name, from: s.from, to: s.to });
    if (s.season !== null) return t('Staffel {season} · Folgen {from}–{to}', { season: s.season, from: s.from, to: s.to });
    return t('Folgen {from}–{to}', { from: s.from, to: s.to });
  };
  const episodeLabel = (n) => (section.relative
    ? t('Staffel {season}, Folge {episode}', { season: section.season, episode: n - section.start + 1 })
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
      {rating && ratingFor !== null && (
        <div ref={panelRef} id={`${ids}-rate`} role="group" aria-labelledby={`${ids}-rate-title`} className="rounded-xl border border-slate-700 bg-slate-900/80 p-3 space-y-2">
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
            <button type="button" className="btn-secondary text-xs" onClick={closePicker}>{t('Fertig')}</button>
          </div>
        </div>
      )}
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
                id={`${ids}-ep-${n}`}
                aria-pressed={on}
                aria-expanded={rating ? selected : undefined}
                aria-controls={selected ? `${ids}-rate` : undefined}
                aria-label={label}
                title={label}
                disabled={disabled}
                onClick={() => (rating ? setRatingFor(selected ? null : n) : toggle(n))}
                className={`relative w-full h-9 [@media(pointer:coarse)]:h-11 rounded-lg text-xs font-mono border transition-colors ${on
                  ? 'bg-brand-700 border-brand-500 text-white'
                  : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-slate-500'} ${selected ? 'ring-2 ring-amber-400' : ''}`}
              >
                {section.relative ? n - section.start + 1 : n}
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
    </div>
  );
}

/**
 * Rows of the season editor: the seasons set by hand, else the TMDb seasons a TV show already stores (no request; the
 * names stay empty), else one season from episode 1.
 */
function seasonRows(anime, custom) {
  const stored = kindOf(anime) === 'tv' && Array.isArray(anime.seasons) ? episodeMarks.seasonsFromCounts(anime.seasons) : [];
  const list = custom.length ? custom : stored.length ? stored : [{ start: 1, name: null }];
  return list.map((s) => ({ start: String(s.start), name: (s.name || '').slice(0, episodeMarks.MAX_SEASON_NAME) }));
}

/**
 * Seasons set by hand for everybody (PUT /anime/:id with custom_seasons): the first episode of each season and an optional
 * name. "Vorschlag von TMDB laden" fills the rows from TMDb (needs a TMDB key); nothing is stored before "Speichern".
 * A suggestion that arrives after "Abbrechen" is dropped; closing gives the focus back to "Staffeln bearbeiten".
 */
function SeasonEditor({ anime, onSave, loadSuggestion, disabled }) {
  const ids = useId();
  const custom = useMemo(() => (Array.isArray(anime.custom_seasons) ? anime.custom_seasons : []), [anime.custom_seasons]);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const openRef = useRef(null);
  const focusNext = useRef(null);
  const total = anime.episodes > 0 ? anime.episodes : null;
  const maxName = episodeMarks.MAX_SEASON_NAME;

  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    (target === 'open' ? openRef.current : document.getElementById(target))?.focus();
  }, [rows]);

  if (!rows) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {custom.length > 0 && <p className="text-xs text-slate-300">{tn('{n} eigene Staffel', '{n} eigene Staffeln', custom.length)}</p>}
        <button ref={openRef} type="button" className="btn-secondary text-xs inline-flex items-center gap-1" disabled={disabled}
          onClick={() => { focusNext.current = `${ids}-name-0`; setRows(seasonRows(anime, custom)); setError(''); setNote(''); }}>
          <ListOrdered className="w-3.5 h-3.5" aria-hidden="true" /> {t('Staffeln bearbeiten')}
        </button>
      </div>
    );
  }

  const setRow = (i, field, value) => setRows((list) => list.map((r, j) => (j === i ? { ...r, [field]: value } : r)));
  const addRow = () => setRows((list) => {
    const last = Number(list[list.length - 1]?.start) || 0;
    return [...list, { start: String(last + 1), name: '' }];
  });
  const removeRow = (i) => {
    focusNext.current = `${ids}-name-${i - 1}`;
    setRows((list) => list.filter((_, j) => j !== i));
  };
  const close = () => {
    request.current += 1;
    focusNext.current = 'open';
    setRows(null);
    setError('');
    setNote('');
    setLoading(false);
  };
  const suggest = async () => {
    request.current += 1;
    const own = request.current;
    setLoading(true);
    setError('');
    setNote('');
    try {
      const answer = await loadSuggestion();
      if (own !== request.current) return;
      if (answer?.seasons?.length) {
        setRows(answer.seasons.map((s) => ({ start: String(s.start), name: (s.name || '').slice(0, maxName) })));
        setNote(tn('{n} Staffel von TMDB übernommen. Prüfen und speichern.', '{n} Staffeln von TMDB übernommen. Prüfen und speichern.', answer.seasons.length));
      } else if (answer?.reason === 'no_key') {
        setNote(t('Für den Vorschlag braucht es einen TMDB-Schlüssel (Konto & Sprache → API-Schlüssel).'));
      } else {
        setNote(t('TMDB kennt für diesen Eintrag keine Staffeln.'));
      }
    } catch (err) {
      if (own === request.current && !isAbortError(err)) setError(err.message);
    } finally {
      if (own === request.current) setLoading(false);
    }
  };
  const save = async (e) => {
    e.preventDefault();
    const list = rows.map((r) => ({ start: Number(r.start), name: r.name.trim() || null }));
    let last = 0;
    for (const [i, s] of list.entries()) {
      const bad = !Number.isInteger(s.start) || s.start < 1 || (i === 0 && s.start !== 1) || s.start <= last || (total && s.start > total);
      if (bad) {
        setError(total
          ? t('Jede Staffel muss nach der vorigen beginnen, die erste bei Folge 1 und keine nach Folge {total}.', { total })
          : t('Jede Staffel muss nach der vorigen beginnen, die erste bei Folge 1.'));
        return;
      }
      last = s.start;
    }
    try {
      await onSave(list.length > 1 || list[0].name ? list : null);
      close();
    } catch (err) {
      setError(err.message);
    }
  };
  const clear = async () => {
    try {
      await onSave(null);
      close();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <form onSubmit={save} noValidate className="rounded-xl border border-slate-700 bg-slate-900/80 p-3 space-y-3" aria-labelledby={`${ids}-title`}>
      <div>
        <h4 id={`${ids}-title`} className="text-xs font-semibold text-slate-100">{t('Staffeln bearbeiten')}</h4>
        <p className="text-[11px] text-slate-400">{t('Lege fest, bei welcher Folge jede Staffel beginnt. Die Staffeln gelten für alle.')}</p>
      </div>
      <ol className="space-y-2">
        {rows.map((r, i) => (
          <li key={i} className="flex flex-wrap items-end gap-2">
            <span className="text-xs text-slate-300 w-full sm:w-auto sm:min-w-[5.5rem] sm:pb-2">{t('Staffel {season}', { season: i + 1 })}</span>
            <div className="w-24">
              <label htmlFor={`${ids}-start-${i}`} className="block text-[11px] text-slate-400 mb-1">{t('Ab Folge')}</label>
              <input id={`${ids}-start-${i}`} type="number" inputMode="numeric" min={1} max={total || undefined} className="input-field text-base sm:text-sm"
                value={r.start} readOnly={i === 0} disabled={disabled} onChange={(e) => setRow(i, 'start', e.target.value)} />
            </div>
            <div className="flex-1 min-w-[8rem]">
              <label htmlFor={`${ids}-name-${i}`} className="block text-[11px] text-slate-400 mb-1">{t('Name (optional)')}</label>
              <input id={`${ids}-name-${i}`} type="text" maxLength={maxName} className="input-field text-base sm:text-sm" value={r.name} disabled={disabled}
                onChange={(e) => setRow(i, 'name', e.target.value)} />
            </div>
            {i > 0 && (
              <button type="button" className="btn-secondary p-2.5 hit-44 shrink-0" disabled={disabled}
                aria-label={t('Staffel {season} entfernen', { season: i + 1 })} title={t('Staffel {season} entfernen', { season: i + 1 })} onClick={() => removeRow(i)}>
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ol>
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {note && <p role="status" className="text-xs text-slate-300">{note}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary text-xs inline-flex items-center gap-1" disabled={disabled} onClick={addRow}>
          <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('Staffel hinzufügen')}
        </button>
        <button type="button" className="btn-secondary text-xs inline-flex items-center gap-1" disabled={disabled || loading} aria-busy={loading} onClick={suggest}>
          <Sparkles className="w-3.5 h-3.5" aria-hidden="true" /> {loading ? t('Lädt…') : t('Vorschlag von TMDB laden')}
        </button>
      </div>
      <div className="flex flex-wrap gap-2 justify-end">
        {custom.length > 0 && <button type="button" className="btn-secondary text-xs text-red-300" disabled={disabled} onClick={clear}>{t('Eigene Staffeln entfernen')}</button>}
        <button type="button" className="btn-secondary text-xs" onClick={close}>{t('Abbrechen')}</button>
        <button type="submit" className="btn-primary text-xs" disabled={disabled}>{t('Staffeln speichern')}</button>
      </div>
    </form>
  );
}

/** Named community ratings of one entry as the caller may see them (anonymous ones without a name). */
function CommunityRatings({ animeId, version }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    if (!animeId) return undefined;
    const controller = new AbortController();
    api.get(`/api/anime/${animeId}/ratings`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setRows(Array.isArray(data?.ratings) ? data.ratings : []); })
      .catch(() => { if (!controller.signal.aborted) setRows([]); });
    return () => controller.abort();
  }, [animeId, version]);
  const shown = rows.filter((r) => r.score || r.comment);
  if (!shown.length) return null;
  return (
    <ul className="space-y-1 mb-3" aria-label={t('Bewertungen')}>
      {shown.map((r, i) => (
        <li key={r.user_id || `anon-${i}`} className="text-xs text-slate-300">
          <span className="font-semibold text-slate-100">{r.username || t('Anonym')}</span>
          {r.own && <span className="text-slate-400"> ({t('du')})</span>}
          {r.score ? <span> {r.score}/10</span> : null}
          {r.visibility === 'private' && <span className="text-slate-400"> · {t('privat')}</span>}
          {r.comment && <span className="block text-slate-400 break-words">„{r.comment}“</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Detail of one anime: banner, metadata, description, relations (add or open), everybody's progress, my progress,
 * link to a series, refresh (60 s lock) and delete. `fallback` is the list entry (offline it is all there is).
 * `defaultVisibility` (the account's default for new ratings) is read from GET /api/auth/me when not passed.
 * Closing, "Öffnen" on a related anime and the series link ask before unsaved input is dropped.
 */
export default function AnimeDetailModal({
  isOpen, animeId, fallback, onClose, canEdit, mangas = [], fetchDetail, updateProgress, removeFromMyList, update, seasonSuggestion, refresh, remove, onAdd,
  onOpenAnime, defaultVisibility
}) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [gridBusy, setGridBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [titleDe, setTitleDe] = useState('');
  const [refreshLeft, setRefreshLeft] = useState(0);
  const [progressDirty, setProgressDirty] = useState(false);
  const [progressSaving, setProgressSaving] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [discardThen, setDiscardThen] = useState(null);
  const begin = useLatestRequest();
  const navigate = useNavigate();
  const hasFallback = useRef(Boolean(fallback));
  hasFallback.current = Boolean(fallback);
  const titleId = useId();

  const anime = detail || fallback;
  const sharing = Boolean(anime) && sharedWithOthers(anime);
  const account = useAccountDefaults({ enabled: Boolean(isOpen && canEdit && sharing && defaultVisibility === undefined) });
  const accountVisibility = defaultVisibility === undefined ? account.animeVisibility : defaultVisibility;
  const isTitleDirty = Boolean(anime && titleDe.trim() !== (anime.title_de || '').trim());
  // input that a running save already sends is not lost by closing
  const isDirty = (progressDirty && !progressSaving) || isTitleDirty;

  // `afterQuestion` takes the place of `proceed` when the discard question was asked and answered with yes
  const unlessDiscarding = useCallback((proceed, afterQuestion = proceed) => {
    if (isDirty) {
      setDiscardThen(() => afterQuestion);
      return;
    }
    proceed();
  }, [isDirty]);
  const requestClose = useCallback(() => unlessDiscarding(onClose), [unlessDiscarding, onClose]);

  const dialogRef = useDialogA11y(isOpen, { onClose: requestClose });
  const latest = useRef(null);
  const shownVisibility = useRef(null);

  // a reload that a save, removal or add asks for after "Öffnen" switched the entry leaves the new entry alone
  const load = useCallback(async () => {
    if (!animeId || latest.current?.animeId !== animeId) return;
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
  latest.current = { animeId, load, progress: anime?.my_progress ?? null };

  useEffect(() => {
    if (!isOpen) return;
    setDetail(null);
    setExpanded(false);
    load();
  }, [isOpen, load]);

  useEffect(() => { setTitleDe(anime?.title_de || ''); }, [anime?.title_de]);

  // the live main line (AniList, beyond the entries in the collection); the detail's own season_chain is the fallback
  const [liveChain, setLiveChain] = useState(null);
  const chainId = isOpen && anime?.anilist_id && (anime.kind || 'anime') === 'anime' ? animeId : null;
  useEffect(() => { setLiveChain(null); }, [chainId]);
  useEffect(() => {
    if (!chainId) return undefined;
    const controller = new AbortController();
    api.get(`/api/anime/${chainId}/season-chain`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted && Array.isArray(data?.seasons)) setLiveChain(data.seasons); })
      .catch(() => {});
    return () => controller.abort();
  }, [chainId, detail]);

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

  const saveProgress = (change) => {
    setProgressSaving(true);
    return run(async () => {
      const saved = await updateProgress(animeId, change);
      if (saved) {
        notify.success(t('Fortschritt gespeichert'));
        await load();
      }
    }).finally(() => setProgressSaving(false));
  };

  // the series page takes the place of the dialog's history entry, so Back does not land on the closed dialog; after
  // the discard question it waits until the question's own entry is gone
  const followLink = (e, to) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    const go = () => navigate(to, { replace: dialogEntryOnTop() });
    unlessDiscarding(go, () => afterDialogEntriesDropped(go));
  };

  const doRefresh = () => run(async () => {
    lastRefresh.set(animeId, Date.now());
    setRefreshLeft(60);
    const fresh = await refresh(animeId);
    setDetail(fresh);
    notify.success(fresh.refreshed === false ? t('Bei den Quellen nicht mehr gefunden, der gespeicherte Stand bleibt') : t('Aktualisiert'));
  });

  const doDelete = () => {
    setDeleteConfirmOpen(true);
  };

  const confirmDelete = () => {
    setDeleteConfirmOpen(false);
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
            ...(prev.watched_episodes !== undefined ? { watched_episodes: prev.watched_episodes } : {}),
            ...(prev.episode_scores !== undefined ? { episode_scores: prev.episode_scores } : {}),
            // the restored rating keeps who saw it and its comment (a new row would get the account default)
            ...(prev.rating_visibility ? { rating_visibility: prev.rating_visibility } : {}),
            ...(prev.public_comment !== undefined ? { public_comment: prev.public_comment } : {}), restore: true
          });
          if (saved && latest.current?.animeId === id) latest.current.load();
        }
      }
    });
  });

  // a save of the episode grid, bound to the grid's entry: no toast; the dialog takes the answer (counter and status
  // follow at once) only while it still shows that entry. A first rating takes the visibility the form shows.
  const saveEpisodes = async (id, change) => {
    const shown = shownVisibility.current;
    const firstRating = shown?.id === id && latest.current?.animeId === id && !isRated(latest.current.progress)
      && Object.keys(change.episode_scores || {}).length > 0;
    const saved = await updateProgress(id, firstRating ? { ...change, rating_visibility: shown.value } : change);
    if (saved && latest.current?.animeId === id) setDetail((d) => (d && d.id === id ? { ...d, my_progress: saved } : d));
    return saved;
  };
  // the grid's saves are done: one reload, so "Weiter" and "Fortschritt aller" follow
  const episodesSettled = (id) => {
    if (latest.current?.animeId === id) latest.current.load();
  };

  const saveLink = (value) => run(async () => setDetail(await update(animeId, { manga_id: value ? Number(value) : null })));
  const saveKind = (value) => run(async () => setDetail(await update(animeId, { kind: value })));
  // the season editor shows its own errors: no toast, the busy flag only
  const saveSeasons = async (customSeasons) => {
    setBusy(true);
    try {
      setDetail(await update(animeId, { custom_seasons: customSeasons }));
      notify.success(customSeasons ? t('Staffeln gespeichert') : t('Eigene Staffeln entfernt'));
    } finally {
      setBusy(false);
    }
  };
  const loadSeasonSuggestion = () => seasonSuggestion(animeId);
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
  const animeRelations = (anime?.relations || []).filter((r) => r.kind === 'ANIME');
  // films, specials and OVAs sit apart from the main line; they never touch the episode count
  const chainSeasons = liveChain && liveChain.length > (anime.season_chain || []).length ? liveChain : (anime.season_chain || []);
  const extras = animeRelations.filter((r) => EXTRA_FORMATS.includes(r.format));
  const relations = animeRelations.filter((r) => !EXTRA_FORMATS.includes(r.format));
  const next = continueTarget(anime);
  const aired = anime ? airedEpisodes(anime) : null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onClick={(e) => { if (e.target === e.currentTarget) requestClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') requestClose(); }}
      className="outline-none dialog-overlay z-50 bg-black/80 backdrop-blur-sm animate-fade-in"
    >
      <div className="dialog-box glass-panel max-w-3xl rounded-2xl sm:rounded-3xl border border-slate-700/80 shadow-2xl overflow-hidden">
        <div className="relative h-28 sm:h-40 bg-slate-900">
          {anime?.banner_image && <CoverImage src={anime.banner_image} className="w-full h-full object-cover opacity-70" />}
          <button type="button" onClick={requestClose} aria-label={t('Schließen')} className="hit-44 absolute top-3 right-3 bg-slate-950/70 text-slate-200 hover:text-white p-1.5 rounded-lg">
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
                      {anime.manga ? <Link to={`/manga/${anime.manga.id}`} onClick={(e) => followLink(e, `/manga/${anime.manga.id}`)} className="text-brand-300 hover:text-brand-200 inline-flex items-center gap-1"><BookOpen className="w-3.5 h-3.5" aria-hidden="true" />{anime.manga.title}</Link> : null}
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
                  <OwnProgress key={anime.id} anime={anime} progress={anime.my_progress} onSave={saveProgress} busy={busy || gridBusy}
                    onRemove={onRemove} onDirtyChange={setProgressDirty} defaultVisibility={accountVisibility} sharing={sharing} visibilityRef={shownVisibility} />
                </section>
              )}

              {canEdit && kind !== 'movie' && !(anime.format === 'MOVIE' && !(anime.episodes > 1)) && (
                <section className="mt-5 border-t border-slate-800 pt-4" aria-labelledby={`${titleId}-episodes`}>
                  <h3 id={`${titleId}-episodes`} className="text-sm font-bold text-white mb-2">{t('Einzelne Folgen')}</h3>
                  {seasonSuggestion && (
                    <div className="mb-3">
                      <SeasonEditor key={anime.id} anime={anime} onSave={saveSeasons} loadSuggestion={loadSeasonSuggestion} disabled={busy} />
                    </div>
                  )}
                  <EpisodeGrid key={anime.id} anime={anime} progress={anime.my_progress} onSave={saveEpisodes} onSettled={episodesSettled}
                    onPendingChange={setGridBusy} disabled={busy} />
                </section>
              )}

              {(anime.progress || anime.progress_users || []).length > 0 && (
                <section className="mt-5 border-t border-slate-800 pt-4">
                  <h3 className="text-sm font-bold text-white mb-2">{t('Fortschritt aller')}</h3>
                  {sharing && anime.community?.count > 0 && (
                    <p className="text-xs text-slate-300 mb-2">{tn('Community: Ø {average} / 10 aus {count} Bewertung', 'Community: Ø {average} / 10 aus {count} Bewertungen', anime.community.count, { count: anime.community.count, average: formatNumber(anime.community.average, 1) })}</p>
                  )}
                  {sharing && (
                    <CommunityRatings animeId={anime.id}
                      version={`${anime.community?.count || 0}:${anime.my_progress?.score || 0}:${anime.my_progress?.rating_visibility || ''}:${anime.my_progress?.public_comment || ''}`} />
                  )}
                  <ul className="space-y-1">
                    {(anime.progress || anime.progress_users).map((p) => (
                      <li key={p.user_id} className="text-xs text-slate-300 flex gap-2">
                        <span className="font-semibold text-slate-100 w-28 truncate">{p.username}</span>
                        <span>{animeProgressLabel(p.status)}</span>
                        {kind !== 'movie' && <span className="font-mono">{seasonEpisodeText(anime, p.episodes_watched) || progressText(p.episodes_watched, anime.episodes, aired)}</span>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {chainSeasons.length > 1 && (
                <section className="mt-5 border-t border-slate-800 pt-4" aria-labelledby={`${titleId}-chain`}>
                  <h3 id={`${titleId}-chain`} className="text-sm font-bold text-white mb-2">{t('Staffeln')}</h3>
                  <ol className="space-y-1.5">
                    {chainSeasons.map((c, i) => (
                      <li key={`${c.anilist_id || c.mal_id || c.in_collection_id}`} className="flex items-center gap-2 text-xs" aria-current={c.current ? 'true' : undefined}>
                        <span className="text-slate-400 w-32 shrink-0">{t('Staffel {n}', { n: i + 1 })}</span>
                        <span className={`min-w-0 flex-1 truncate ${c.current ? 'text-white font-semibold' : 'text-slate-200'}`}>
                          {c.title}{c.season_year ? ` (${c.season_year})` : ''}
                          {c.my_status ? <span className="ml-2 text-slate-400">{animeProgressLabel(c.my_status)}</span> : null}
                        </span>
                        {c.current ? null : c.in_collection_id ? (
                          <button type="button" className="btn-secondary text-[11px] py-1 px-2" onClick={() => unlessDiscarding(() => onOpenAnime(c.in_collection_id))}>{t('Öffnen')}</button>
                        ) : canEdit && (c.anilist_id || c.mal_id) ? (
                          <button type="button" className="btn-secondary text-[11px] py-1 px-2" disabled={busy}
                            onClick={() => run(async () => { await onAdd({ anilist_id: c.anilist_id || undefined, mal_id: c.mal_id || undefined }); notify.success(t('„{title}“ hinzugefügt', { title: c.title })); await load(); })}>
                            {t('Hinzufügen')}
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              {[[extras, t('Filme & Specials')], [relations, t('Verwandte Anime')]].map(([list, heading]) => list.length > 0 && (
                <section key={heading} className="mt-5 border-t border-slate-800 pt-4">
                  <h3 className="text-sm font-bold text-white mb-2">{heading}</h3>
                  <ul className="space-y-1.5">
                    {list.map((r) => (
                      <li key={`${r.relation}-${r.anilist_id || r.mal_id}`} className="flex items-center gap-2 text-xs">
                        <span className="text-slate-400 w-32 shrink-0">{relationLabel(r.relation)}</span>
                        <span className="text-slate-200 min-w-0 flex-1 truncate">{r.title}{r.season_year ? ` (${r.season_year})` : ''}{r.my_status ? <span className="ml-2 text-slate-400">{animeProgressLabel(r.my_status)}</span> : null}</span>
                        {r.in_collection_id ? (
                          <button type="button" className="btn-secondary text-[11px] py-1 px-2" onClick={() => unlessDiscarding(() => onOpenAnime(r.in_collection_id))}>{t('Öffnen')}</button>
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
              ))}

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
      <ConfirmDialog
        isOpen={deleteConfirmOpen}
        title={t('Für alle löschen')}
        message={t('„{title}“ für alle löschen? Der Fortschritt aller Benutzer geht verloren.', { title: displayTitle(anime) })}
        confirmLabel={t('Löschen')}
        cancelLabel={t('Abbrechen')}
        busy={busy}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteConfirmOpen(false)}
      />
      <ConfirmDialog
        isOpen={discardThen !== null}
        title={t('Ungespeicherte Änderungen verwerfen?')}
        message={t('Deine Eingaben wurden noch nicht gespeichert und gehen verloren.')}
        confirmLabel={t('Verwerfen')}
        cancelLabel={t('Abbrechen')}
        isDanger
        onConfirm={() => {
          const proceed = discardThen;
          setDiscardThen(null);
          proceed?.();
        }}
        onCancel={() => setDiscardThen(null)}
      />
    </div>
  );
}
