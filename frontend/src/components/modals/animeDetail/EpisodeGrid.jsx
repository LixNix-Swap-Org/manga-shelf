// Single episodes of an anime as toggles, with seasons and episode ratings (split from AnimeDetailModal.jsx).
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Star } from 'lucide-react';
import { kindOf, watchedEpisodesOf, episodeSections, episodeGridCount, episodeScoresOf, averageEpisodeScore } from '../../../utils/animeHelpers';
import { formatNumber } from '../../../utils/format';
import { t, tn } from '../../../i18n/index.js';

export const SAVE_DELAY_MS = 600;

// music videos (an opening as its own AniList entry) are no film or special: they stay with the related anime
export const EXTRA_FORMATS = ['MOVIE', 'SPECIAL', 'OVA'];

export const sectionOf = (sections, episode) => Math.max(0, sections.findIndex((s) => episode >= s.from && episode <= s.to));

export const NOT_TRUNCATED = { before: false, after: false };

/**
 * The label of each season of the line: "Staffel N" along the main line, "Nebenlinie" for a season of a side line (a
 * second sequel at a fork, `branch`), and only "Staffel" while earlier seasons are not loaded yet (the number would be
 * wrong). Returns [{ season, label }].
 */
export function chainSeasonLabels(seasons, earlierMissing) {
  let n = 0;
  return seasons.map((season) => {
    if (season.branch) return { season, label: t('Nebenlinie') };
    n += 1;
    return { season, label: earlierMissing ? t('Staffel') : t('Staffel {n}', { n }) };
  });
}

/**
 * The grid's seasons for an entry nobody set seasons for: a long run (more than 100 episodes in the grid, the known count
 * or, for a running show without one, the aired episodes; the plain blocks of 100 say little there) asks the TMDb
 * suggestion (the server keeps the answer) and uses its seasons for display only, nothing is stored. Without a TMDb
 * key, a match or an answer the grid keeps its blocks. Returns [{ start, name }] or null.
 */
export function useAutoSeasons(anime, loadSuggestion) {
  const id = anime?.id;
  const needs = Boolean(loadSuggestion && id && episodeGridCount(anime, []) > 100 && !(anime.custom_seasons?.length) && !(kindOf(anime) === 'tv' && anime.seasons?.length));
  const [found, setFound] = useState(null);
  useEffect(() => {
    if (!needs) return undefined;
    let alive = true;
    Promise.resolve(loadSuggestion(id)).then((res) => {
      const seasons = Array.isArray(res?.seasons) && res.seasons.length > 1 ? res.seasons.map((s) => ({ start: s.start, name: s.name || null })) : null;
      if (alive) setFound({ id, seasons });
    }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one request per entry, the callback changes on every render
  }, [id, needs]);
  return needs && found?.id === id ? found.seasons : null;
}

/**
 * Single episodes as toggles (aria-pressed). Taps are collected for a moment and saved as one set of watched episodes and
 * episode ratings of this grid's entry (onSave(id, { watched_episodes, episode_scores })); saves run one after another,
 * closing the dialog saves at once. The taps stay on screen until no save waits or runs any more, then `onSettled(id)`
 * reloads the dialog once; a failed save drops them together with the saves still queued. `onPendingChange(busy)` tells
 * whether a save waits or runs. "Folgen bewerten" switches the taps to rating: the 1..10 picker opens above the cells,
 * an episode gets a score and counts as watched with it; unmarking an episode drops its rating.
 */
export function EpisodeGrid({ anime, progress, onSave, onSettled, onPendingChange, disabled }) {
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
    const range = { from: s.from, to: s.to };
    if (s.name && s.season !== null) return t('Staffel {season} · {name} · Folgen {from}–{to}', { season: s.season, name: s.name, ...range });
    if (s.name) return t('{name} · Folgen {from}–{to}', { name: s.name, ...range });
    if (s.season !== null) return t('Staffel {season} · Folgen {from}–{to}', { season: s.season, ...range });
    return t('Folgen {from}–{to}', range);
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
