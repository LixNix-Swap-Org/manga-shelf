import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { History, X } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import api from '../../utils/api';
import { notify } from '../../utils/notify';
import { compareNatural } from '../../utils/search';
import { displayTitle } from '../../utils/animeHelpers';
import { aboveTotalText } from '../../utils/shareIntake';
import { langFor } from '../../components/common/lang';
import crunchyroll from '../../../../core/watch/crunchyroll.js';
import { syncNow } from './crunchyrollSync';
import {
  SERVICE, WATCH_SYNC_EVENT, watchBridge, useWatchUnmatched, resolveUnmatched, skipUnmatched, unmatchedKey
} from './watchState';

const MAX_CANDIDATES = 5;
const SURE_SCORE = 0.9;
// the server takes one history per user every 30 s
const THROTTLE_RETRY_MS = 31000;

const seasonOfItem = (u) => Number(u?.season) || 1;

/** The season a candidate's titles name (the server sends it; older answers: read from the title). */
export const seasonOfCandidate = (c) => (Number.isInteger(c?.season) ? c.season : crunchyroll.seasonFromTitles([c?.title]));

/** 'Frieren (Staffel 2)'; season 1 only named when `withSeason` (the candidates include other seasons). */
export const seriesLabel = (u, withSeason = false) => (seasonOfItem(u) > 1 || withSeason ? `${u.series_title} (Staffel ${seasonOfItem(u)})` : u.series_title);

/**
 * The candidate the dialog may preselect: only a sure title hit of the same season (one Enter must never link a season
 * to another season's entry). The entry the server matched itself ('episode_above_total') counts as sure.
 */
export function preselectedCandidate(item, candidates) {
  const first = candidates[0];
  if (!first) return null;
  if (item.reason === 'episode_above_total') return first;
  return Number(first.score) >= SURE_SCORE && seasonOfCandidate(first) === seasonOfItem(item) ? first : null;
}

/**
 * Sends the confirmation: POST /anime/:id/watched with `remember`, so the next sync maps the series by itself. Resolves
 * { ok: true } or { aboveTotal: total|null } or { error }.
 */
export async function confirmMatch(item, animeId, { complete = false, post = api.post } = {}) {
  const remember = { service: SERVICE, external_id: item.external_id };
  if (Number.isInteger(Number(item.season)) && Number(item.season) >= 1) remember.season = Number(item.season);
  const body = { episode: Number(item.episodes_watched ?? item.episode), remember };
  if (complete) body.complete = true;
  try {
    await post(`/api/anime/${animeId}/watched`, body, { fallback: 'Zuordnung konnte nicht gespeichert werden' });
    return { ok: true };
  } catch (err) {
    if (err?.code === 'EPISODE_ABOVE_TOTAL') return { aboveTotal: Number(err.data?.episodes) || null };
    return { error: err?.message || 'Zuordnung konnte nicht gespeichert werden' };
  }
}

/** One forced sync after the dialog (again once after the server's limit when the sync on opening was just before). */
export function syncAfterMatch(bridge, { sync = syncNow, wait = THROTTLE_RETRY_MS } = {}) {
  return sync({ bridge })
    .then((result) => {
      if (result?.reason === 'throttled') setTimeout(() => { sync({ bridge }).catch(() => {}); }, wait);
      return result;
    })
    .catch(() => null);
}

function MatchStep({ item, list, ids, titleId, onDone, onSkip }) {
  const candidates = (item.candidates || []).slice(0, MAX_CANDIDATES);
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

  const entry = list.find((a) => a.id === chosenId);
  const candidate = candidates.find((c) => c.id === chosenId);
  const entryTitle = entry ? displayTitle(entry) : candidate?.title || '';
  const episode = Number(item.episodes_watched ?? item.episode) || 0;
  const above = refused && refused.animeId === chosenId ? refused : null;
  const series = seriesLabel(item, candidates.some((c) => seasonOfCandidate(c) > 1));
  const question = entryTitle ? `Ist „${series}“ dein Eintrag „${entryTitle}“?` : `Welcher Eintrag ist „${series}“?`;

  const choose = (id) => {
    setChosenId(id);
    setError('');
  };
  const submit = async (complete = false) => {
    if (!chosenId) {
      setError('Bitte einen Eintrag wählen.');
      return;
    }
    setSaving(true);
    setError('');
    const result = await confirmMatch(item, chosenId, { complete });
    setSaving(false);
    if (result.ok) onDone(item, entryTitle);
    else if ('aboveTotal' in result) setRefused({ animeId: chosenId, total: result.aboveTotal ?? entry?.episodes ?? candidate?.episodes ?? null });
    else setError(result.error);
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(Boolean(above)); }} className="space-y-4" noValidate data-busy={saving ? 'true' : undefined}>
      <p id={titleId} className="text-base font-semibold text-white leading-snug break-words [overflow-wrap:anywhere] pr-10" lang="de">{question}</p>
      <p className="text-xs text-slate-400 -mt-2">Crunchyroll: bis Folge {episode} gesehen</p>

      {(candidates.length > 1 || (candidates.length === 1 && !preselected)) && (
        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold text-slate-300 mb-1.5">Welcher Eintrag?</legend>
          {candidates.map((c, i) => (
            <label key={c.id} className="flex items-center gap-3 min-h-11 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-100 cursor-pointer has-[:checked]:border-brand-500/70">
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

      {picking ? (
        others.length > 0 ? (
          <div>
            <label htmlFor={`${ids}-other`} className="block text-[11px] text-slate-400 mb-1">{candidates.length ? 'Anderer Eintrag' : 'Eintrag aus der Liste'}</label>
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
          <p className="text-xs text-slate-400">Diese Serie steht noch nicht in der Anime-Liste. Füge sie hinzu oder überspringe sie.</p>
        )
      ) : (
        <button type="button" className="hit-44 self-start text-xs text-brand-300 hover:text-brand-200 underline" onClick={() => setPicking(true)}>Anderer Eintrag…</button>
      )}

      {above && (
        <p className="text-sm text-amber-300" aria-live="polite">
          {above.total ? aboveTotalText(episode, above.total) : `Folge ${episode} gibt es bei diesem Eintrag nicht.`}
        </p>
      )}
      {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}

      <div className="flex flex-wrap justify-end gap-2 [@media(pointer:coarse)]:gap-5 pt-1">
        <button type="button" className="hit-44 btn-secondary text-sm" onClick={() => onSkip(item)} disabled={saving}>Überspringen</button>
        <button type="submit" className="hit-44 btn-primary text-sm" disabled={saving || !chosenId} data-autofocus={preselected ? true : undefined}>
          {saving ? 'Wird gespeichert…' : above ? 'Als komplett gesehen markieren' : 'Ja, zuordnen'}
        </button>
      </div>
    </form>
  );
}

/**
 * The series of the Crunchyroll history the server could not map (watchState): one at a time, with the candidates,
 * 'Anderer Eintrag…' (whole list) and 'Überspringen' (remembered on this device). Lazy; mounted only while open.
 */
export default function WatchMatchDialog({ list = [], onClose, bridge = watchBridge() }) {
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
    window.dispatchEvent(new CustomEvent(WATCH_SYNC_EVENT, { detail: { service: SERVICE, applied: 1, changed: true } }));
    notify.success(`${title || seriesLabel(matched)}: zugeordnet`);
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
        <button type="button" onClick={onClose} aria-label="Schließen" className="hit-44 absolute top-3 right-3 text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
        <h2 id={`${ids}-title`} className="text-lg font-bold text-white flex items-center gap-2 pr-10">
          <History className="w-5 h-5 text-fuchsia-400 short:hidden" aria-hidden="true" /> Crunchyroll-Verlauf zuordnen
        </h2>
        {total > 1 && <p className="text-xs text-slate-400 mt-1 mb-3">Serie {Math.min(position, total)} von {total}</p>}
        <div className={total > 1 ? '' : 'mt-3'}>
          <MatchStep key={unmatchedKey(item)} item={item} list={list} ids={ids} titleId={titleId} onDone={done} onSkip={skip} />
        </div>
      </div>
    </div>
  );
}
