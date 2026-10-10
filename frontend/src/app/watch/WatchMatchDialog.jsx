import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { History, Search, X } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import api, { TIMEOUTS } from '../../utils/api';
import { notify } from '../../utils/notify';
import { compareNatural } from '../../utils/search';
import { displayTitle, formatYearLine } from '../../utils/animeHelpers';
import { aboveTotalText } from '../../utils/shareIntake';
import { langFor } from '../../components/common/lang';
import crunchyroll from '../../../../core/watch/crunchyroll.js';
import { syncNow } from './crunchyrollSync';
import {
  SERVICE, WATCH_SYNC_EVENT, watchBridge, useWatchUnmatched, resolveUnmatched, skipUnmatched, unmatchedKey
} from './watchState';
import { t } from '../../i18n/index.js';

const MAX_CANDIDATES = 5;
const MAX_EXTERNAL = 3;
const SURE_SCORE = 0.9;
// the server takes one history per user every 30 s
const THROTTLE_RETRY_MS = 31000;

const seasonOfItem = (u) => Number(u?.season) || 1;
const externalKey = (c) => `ext:${c.anilist_id}`;

/** The list candidates (at most 5) and the AniList ones not in the list yet (at most 3) of an unmatched series. */
export function splitCandidates(item) {
  const all = Array.isArray(item?.candidates) ? item.candidates.filter((c) => c && typeof c === 'object') : [];
  return {
    list: all.filter((c) => c.kind !== 'external' && c.id !== null && c.id !== undefined).slice(0, MAX_CANDIDATES),
    external: all.filter((c) => c.kind === 'external' && Number.isInteger(c.anilist_id) && c.anilist_id > 0).slice(0, MAX_EXTERNAL)
  };
}

/** The season a candidate's titles name (the server sends it; older answers: read from the title). */
export const seasonOfCandidate = (c) => (Number.isInteger(c?.season) ? c.season : crunchyroll.seasonFromTitles([c?.title]));

/** 'Frieren (Staffel 2)'; season 1 only named when `withSeason` (the candidates include other seasons). */
export const seriesLabel = (u, withSeason = false) => (seasonOfItem(u) > 1 || withSeason ? t('{title} (Staffel {season})', { title: u.series_title, season: seasonOfItem(u) }) : u.series_title);

/**
 * The candidate the dialog may preselect: only a sure title hit of the same season (one Enter must never link a season
 * to another season's entry). The entry the server matched itself ('episode_above_total') counts as sure.
 */
export function preselectedCandidate(item, candidates) {
  const first = candidates[0];
  if (!first || item.reason === 'declined') return null;
  if (item.reason === 'episode_above_total') return first;
  return Number(first.score) >= SURE_SCORE && seasonOfCandidate(first) === seasonOfItem(item) ? first : null;
}

/**
 * Sends the confirmation: POST /anime/:id/watched with `remember`, so the next sync maps the series by itself. Resolves
 * { ok: true } or { aboveTotal: total|null } or { error }.
 */
const rememberOf = (item) => {
  const remember = { service: SERVICE, external_id: item.external_id };
  if (Number.isInteger(Number(item.season)) && Number(item.season) >= 1) remember.season = Number(item.season);
  return remember;
};

export async function confirmMatch(item, animeId, { complete = false, post = api.post } = {}) {
  const body = { episode: Number(item.episodes_watched ?? item.episode), remember: rememberOf(item) };
  if (complete) body.complete = true;
  try {
    await post(`/api/anime/${animeId}/watched`, body, { fallback: t('Zuordnung konnte nicht gespeichert werden') });
    return { ok: true };
  } catch (err) {
    if (err?.code === 'EPISODE_ABOVE_TOTAL') return { aboveTotal: Number(err.data?.episodes) || null };
    return { error: err?.message || t('Zuordnung konnte nicht gespeichert werden') };
  }
}

/** 'Anlegen: {title}': creates the AniList entry with the watched episode; an entry that exists already gets the episode. */
export async function createMatch(item, candidate, { complete = false, post = api.post } = {}) {
  const watched = { episode: Number(item.episodes_watched ?? item.episode), remember: rememberOf(item) };
  if (complete) watched.complete = true;
  try {
    const detail = await post('/api/anime', { anilist_id: candidate.anilist_id, watched }, { timeout: TIMEOUTS.lookup, fallback: t('Anime konnte nicht hinzugefügt werden') });
    return { ok: true, animeId: detail?.id ?? null };
  } catch (err) {
    if (err?.status === 409 && err.data?.id) {
      const result = await confirmMatch(item, err.data.id, { complete, post });
      return result.ok ? { ok: true, animeId: err.data.id } : result;
    }
    if (err?.code === 'EPISODE_ABOVE_TOTAL') return { aboveTotal: Number(err.data?.episodes) || null };
    return { error: err?.message || t('Anime konnte nicht hinzugefügt werden') };
  }
}

/** One forced sync after the dialog (again once after the limit, `retryIn` seconds, when the last sync was just before). */
export function syncAfterMatch(bridge, { sync = syncNow, wait } = {}) {
  return sync({ bridge })
    .then((result) => {
      if (result?.reason === 'throttled' || result?.reason === 'too_soon') {
        const delay = wait ?? (Number.isInteger(result.retryIn) && result.retryIn > 0 ? result.retryIn * 1000 : THROTTLE_RETRY_MS);
        setTimeout(() => { sync({ bridge }).catch(() => {}); }, delay);
      }
      return result;
    })
    .catch(() => null);
}

function MatchStep({ item, list, ids, titleId, onDone, onSkip, onSearch }) {
  const { list: candidates, external } = useMemo(() => splitCandidates(item), [item]);
  const preselected = preselectedCandidate(item, candidates);
  const [chosenId, setChosenId] = useState(preselected?.id ?? null);
  const [picking, setPicking] = useState(!candidates.length);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [refused, setRefused] = useState(item.reason === 'episode_above_total' && candidates[0] ? { animeId: candidates[0].id, total: candidates[0].episodes || null } : null);
  const others = useMemo(() => {
    const shown = new Set(candidates.map((c) => c.id));
    return list.filter((a) => !shown.has(a.id)).sort((a, b) => compareNatural(displayTitle(a), displayTitle(b)));
  }, [list, candidates]);

  const entryOf = (key) => list.find((a) => a.id === key) || null;
  const candidateOf = (key) => candidates.find((c) => c.id === key) || null;
  const externalOf = (key) => external.find((c) => externalKey(c) === key) || null;
  const entry = entryOf(chosenId);
  const candidate = candidateOf(chosenId);
  const created = externalOf(chosenId);
  const entryTitle = entry ? displayTitle(entry) : candidate?.title || '';
  const episode = Number(item.episodes_watched ?? item.episode) || 0;
  const above = refused && refused.animeId === chosenId ? refused : null;
  const series = seriesLabel(item, candidates.some((c) => seasonOfCandidate(c) > 1));
  const question = entryTitle ? t('Ist „{series}“ dein Eintrag „{entry}“?', { series, entry: entryTitle }) : t('Welcher Eintrag ist „{series}“?', { series });

  const choose = (id) => {
    setChosenId(id);
    setError('');
  };
  const save = async (key, complete = false) => {
    const target = externalOf(key);
    setSaving(true);
    setError('');
    const result = target ? await createMatch(item, target, { complete }) : await confirmMatch(item, key, { complete });
    setSaving(false);
    const known = entryOf(key);
    if (result.ok) onDone(item, target ? target.title : known ? displayTitle(known) : candidateOf(key)?.title || '');
    else if ('aboveTotal' in result) setRefused({ animeId: key, total: result.aboveTotal ?? (target || known || candidateOf(key))?.episodes ?? null });
    else setError(result.error);
  };
  const submit = (complete = false) => {
    if (!chosenId) {
      setError(t('Bitte einen Eintrag wählen.'));
      return;
    }
    save(chosenId, complete);
  };
  const searchOther = async () => {
    if (saving) return;
    setError('');
    let found;
    try {
      found = await onSearch(item.series_title || '');
    } catch (_) {
      return;
    }
    if (!found?.id) return;
    setChosenId(found.id);
    await save(found.id);
  };
  const radioRow = 'flex items-center gap-3 min-h-11 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-100 cursor-pointer has-[:checked]:border-brand-500/70';

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(Boolean(above)); }} className="space-y-4" noValidate data-busy={saving ? 'true' : undefined}>
      <p id={titleId} className="text-base font-semibold text-white leading-snug break-words [overflow-wrap:anywhere] pr-10">{question}</p>
      <p className="text-xs text-slate-400 -mt-2">{t('Crunchyroll: bis Folge {episode} gesehen', { episode })}</p>

      {(candidates.length > 1 || (candidates.length === 1 && (!preselected || external.length > 0))) && (
        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold text-slate-300 mb-1.5">{t('Welcher Eintrag?')}</legend>
          {candidates.map((c, i) => (
            <label key={c.id} className={radioRow}>
              <input
                type="radio"
                name={`${ids}-entry`}
                value={c.id}
                checked={chosenId === c.id}
                onChange={() => choose(c.id)}
                data-autofocus={!preselected && i === 0 ? true : undefined}
              />
              <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]" lang={langFor(c.title) || 'de'}>{c.title}</span>
            </label>
          ))}
        </fieldset>
      )}

      {external.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold text-slate-300 mb-1.5">{t('Noch nicht in der Liste')}</legend>
          {external.map((c) => (
            <label key={externalKey(c)} className={radioRow}>
              <input type="radio" name={`${ids}-entry`} value={externalKey(c)} checked={chosenId === externalKey(c)} onChange={() => choose(externalKey(c))} />
              <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]" lang={langFor(c.title) || 'de'}>{c.title}</span>
              {formatYearLine(c) && <span className="text-[11px] text-slate-400 shrink-0">{formatYearLine(c)}</span>}
            </label>
          ))}
        </fieldset>
      )}

      {picking ? (
        others.length > 0 ? (
          <div>
            <label htmlFor={`${ids}-other`} className="block text-[11px] text-slate-400 mb-1">{candidates.length ? t('Anderer Eintrag') : t('Eintrag aus der Liste')}</label>
            <select
              id={`${ids}-other`}
              className="input-field text-base sm:text-sm"
              data-autofocus={!candidates.length ? true : undefined}
              value={others.some((a) => a.id === chosenId) ? String(chosenId) : ''}
              onChange={(e) => choose(e.target.value ? Number(e.target.value) : candidates[0]?.id ?? null)}
            >
              <option value="">–</option>
              {others.map((a) => <option key={a.id} value={a.id}>{displayTitle(a)}</option>)}
            </select>
          </div>
        ) : (
          <p className="text-xs text-slate-400">{t('Diese Serie steht noch nicht in der Anime-Liste. Füge sie hinzu oder überspringe sie.')}</p>
        )
      ) : (
        <button type="button" className="hit-44 self-start text-xs text-brand-300 hover:text-brand-200 underline" onClick={() => setPicking(true)}>{t('Anderer Eintrag…')}</button>
      )}
      {onSearch && (
        <button type="button" className="hit-44 self-start text-xs text-brand-300 hover:text-brand-200 underline inline-flex items-center gap-1.5" onClick={searchOther} aria-disabled={saving || undefined}>
          <Search className="w-3.5 h-3.5" aria-hidden="true" /> {t('Anderen Anime suchen…')}
        </button>
      )}

      {above && (
        <p className="text-sm text-amber-300" aria-live="polite">
          {above.total ? aboveTotalText(episode, above.total) : t('Folge {episode} gibt es bei diesem Eintrag nicht.', { episode })}
        </p>
      )}
      {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}

      <div className="flex flex-wrap justify-end gap-2 [@media(pointer:coarse)]:gap-5 pt-1">
        <button type="button" className="hit-44 btn-secondary text-sm" onClick={() => onSkip(item)} disabled={saving}>{t('Überspringen')}</button>
        <button type="submit" className="hit-44 btn-primary text-sm" disabled={saving || !chosenId} data-autofocus={preselected ? true : undefined}>
          {saving ? t('Wird gespeichert…') : above ? t('Als komplett gesehen markieren') : created ? t('Anlegen: {title}', { title: created.title }) : t('Ja, zuordnen')}
        </button>
      </div>
    </form>
  );
}

/**
 * The series of the Crunchyroll history the server could not map (watchState): one at a time, with the candidates,
 * 'Anderer Eintrag…' (whole list) and 'Überspringen' (remembered on this device). Lazy; mounted only while open.
 */
export default function WatchMatchDialog({ list = [], onClose, onSearch, bridge = watchBridge() }) {
  const ids = useId();
  const titleId = `${ids}-question`;
  const pending = useWatchUnmatched();
  const [total] = useState(pending.length);
  const item = pending[0] || null;
  const dialogRef = useDialogA11y(true, { onClose });
  const confirmed = useRef(0);

  // the confirmed series map through their new links now, so 'Weiter' gets the episode link of the history at once
  useEffect(() => () => {
    if (confirmed.current > 0) syncAfterMatch(bridge);
  }, [bridge]);

  useEffect(() => {
    if (!item) onClose();
  }, [item, onClose]);

  // the next series replaces the step: focus moves to its first control, not back to the page
  useEffect(() => {
    const node = dialogRef.current;
    if (!node || !item) return;
    if (node.contains(document.activeElement) && document.activeElement !== node) return;
    (node.querySelector('[data-autofocus]') || node).focus();
  }, [item, dialogRef]);

  if (!item) return null;

  const done = (matched, title) => {
    confirmed.current += 1;
    resolveUnmatched(bridge, matched);
    window.dispatchEvent(new CustomEvent(WATCH_SYNC_EVENT, { detail: { service: SERVICE, applied: 1, added: 0, changed: true, watch: null } }));
    notify.success(t('{title}: zugeordnet', { title: title || seriesLabel(matched) }));
    dialogRef.current?.focus();
  };
  const skip = (skipped) => {
    skipUnmatched(bridge, skipped);
    dialogRef.current?.focus();
  };
  const position = Math.max(1, total - pending.length + 1);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${ids}-title`}
      aria-describedby={titleId}
      tabIndex={-1}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      className="outline-none dialog-overlay z-50 bg-black/75 backdrop-blur-sm animate-fade-in"
    >
      <div className="dialog-box glass-panel max-w-md rounded-2xl sm:rounded-3xl p-5 sm:p-6 short:p-4 border border-slate-700/80 shadow-2xl relative" id="watch-match-dialog">
        <button type="button" onClick={onClose} aria-label={t('Schließen')} className="hit-44 absolute top-3 right-3 text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
        <h2 id={`${ids}-title`} className="text-lg font-bold text-white flex items-center gap-2 pr-10">
          <History className="w-5 h-5 text-fuchsia-400 short:hidden" aria-hidden="true" /> {t('Crunchyroll-Verlauf zuordnen')}
        </h2>
        {total > 1 && <p className="text-xs text-slate-400 mt-1 mb-3">{t('Serie {position} von {total}', { position: Math.min(position, total), total })}</p>}
        <div className={total > 1 ? '' : 'mt-3'}>
          <MatchStep key={unmatchedKey(item)} item={item} list={list} ids={ids} titleId={titleId} onDone={done} onSkip={skip} onSearch={onSearch} />
        </div>
      </div>
    </div>
  );
}
