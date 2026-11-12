// Own progress of an anime: counter, status, rating, languages, note and who sees the rating (split from AnimeDetailModal.jsx).
import { useEffect, useId, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { PROGRESS_STATUSES, airedEpisodes, stillAiring, kindOf, seasonEpisodeText } from '../../../utils/animeHelpers';
import { animeProgressLabel } from '../../../utils/enumLabels';
import { EDITION_LANGUAGES, languageName, withCurrent } from '../../../utils/editions';
import episodeMarks from '../../../../../core/anime/episodes.js';
import { t, tn } from '../../../i18n/index.js';

export function WatchLanguageSelect({ id, label, value, onChange }) {
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

export const MAX_PUBLIC_COMMENT = 500;

/** Whether a stored progress carries a rating (a score or an episode score), as core/anime/progress.js counts it. */
export const isRated = (progress) => Boolean(progress)
  && ((progress.score !== null && progress.score !== undefined) || Object.keys(episodeMarks.parseScores(progress.episode_scores)).length > 0);

/**
 * The form values of a stored progress. The visibility shown is the stored one once the progress is rated; before the
 * first rating it is the account default, which the server gives a first rating sent without a visibility.
 */
export const formValues = (progress, defaultVisibility) => ({
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
 * them (a single account) the visibility, the comment and the community block stay hidden; the own visibility does not
 * count (the server stores the account default on every new row), only an own comment keeps them so it can be edited.
 */
export function sharedWithOthers(anime) {
  const rows = anime.progress || anime.progress_users || [];
  const mine = anime.my_progress;
  const others = mine?.user_id !== undefined && mine?.user_id !== null
    ? rows.filter((p) => p.user_id !== mine.user_id).length
    : rows.length - (mine ? 1 : 0);
  const ownCounted = mine?.score && mine.rating_visibility !== 'private' ? 1 : 0;
  return others > 0 || (anime.community?.count || 0) > ownCounted || Boolean(mine?.public_comment);
}

/**
 * Own progress: counter, status, score, watched languages and note, saved together; with other accounts (`sharing`)
 * also who sees the rating and a comment on it. A new stored progress (a grid tap, a reload) only replaces the fields
 * whose stored value changed, so an unsaved note or score survives it; a visibility picked meanwhile survives too.
 * A first rating goes out with the shown visibility; `visibilityRef` gets `{ id, value }` of it for the episode grid
 * (null while the shown value is only a guess: account default unknown, nothing picked, nothing rated).
 */
export function OwnProgress({ anime, progress, onSave, onRemove, busy, onDirtyChange, defaultVisibility = null, sharing = false, visibilityRef }) {
  const ids = useId();
  const seeded = useRef(null);
  if (seeded.current === null) seeded.current = formValues(progress, defaultVisibility);
  const [episodes, setEpisodes] = useState(seeded.current.episodes);
  const [capped, setCapped] = useState(false);
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
    setCapped(false);
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
            <button type="button" className="btn-secondary p-2" aria-label={t('Eine Folge weniger')} onClick={() => { setCapped(false); setEpisodes((n) => clamp(Number(n) - 1)); }}><Minus className="w-3.5 h-3.5" aria-hidden="true" /></button>
            <input id={`${ids}-ep`} type="number" min="0" max={max} inputMode="numeric" className="input-field text-base sm:text-sm w-20 text-center" value={episodes}
              aria-describedby={capped ? `${ids}-ep-capped` : undefined}
              onChange={(e) => {
                const n = e.target.value === '' ? '' : parseInt(e.target.value, 10) || 0;
                // a number above the episode count is cut to it, and the hint says so (same rule as the chapter field)
                setCapped(Boolean(max) && n !== '' && n > max);
                setEpisodes(n === '' ? '' : clamp(n));
              }} />
            <button type="button" className="btn-secondary p-2" aria-label={t('Eine Folge mehr')} onClick={() => setEpisodes((n) => clamp(Number(n) + 1))}><Plus className="w-3.5 h-3.5" aria-hidden="true" /></button>
            {episodeAt && <span className="text-xs font-mono text-slate-300 ml-1">{episodeAt}</span>}
          </div>
          {capped && <p id={`${ids}-ep-capped`} role="status" className="text-[11px] text-amber-300 mt-1">{tn('Dieser Eintrag hat {n} Folge – mehr geht nicht.', 'Dieser Eintrag hat {n} Folgen – mehr geht nicht.', max)}</p>}
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
