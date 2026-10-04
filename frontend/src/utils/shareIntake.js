// A shared or pasted streaming link: detection over core/watch/links.js (the same table the server parses with), the
// resolve-link call and the clipboard read of "Link einfügen". The dialog flow lives in hooks/useShareIntake.js.
import links from '../../../core/watch/links.js';
import api, { TIMEOUTS } from './api';

export const SHARE_TEXTS = {
  visitor: 'Nur Bearbeiter können ihren Fortschritt speichern.',
  offline: 'Geteilte Links brauchen eine Verbindung zum Server.',
  notALink: 'Das ist kein Crunchyroll-Link.',
  failed: 'Der Link konnte nicht gelesen werden.'
};

const SENT_TEXT_LIMIT = 500;

/** Fired on window after "Jetzt abgleichen" with the run's result; the anime tab reloads when `changed`. */
export const ANIME_SYNC_EVENT = 'mangashelf:anime-sync';

/** The first supported streaming link in any of the strings (share text, share url), null without one. */
export function findStreamingLink(...parts) {
  const text = parts.filter((p) => typeof p === 'string' && p.trim()).join(' ');
  return text ? links.detectLink(text) : null;
}

export const serviceLabel = (id) => links.SERVICES.find((s) => s.id === id)?.label || 'Crunchyroll';

/** POST /api/anime/resolve-link; the text goes along for an episode number ("Folge 7") the URL does not carry. */
export function resolveSharedLink({ url, text }, { signal } = {}) {
  const body = { url };
  const rest = typeof text === 'string' ? text.trim().slice(0, SENT_TEXT_LIMIT) : '';
  if (rest) body.text = rest;
  return api.post('/api/anime/resolve-link', body, { signal, timeout: TIMEOUTS.lookup, fallback: SHARE_TEXTS.failed });
}

/** The error text for the dialog: an unsupported link gets its own sentence, anything else the server's message. */
export function resolveErrorText(err) {
  if (err?.status === 400 && err?.code === 'UNSUPPORTED_LINK') return SHARE_TEXTS.notALink;
  return err?.message || SHARE_TEXTS.failed;
}

/** What the server said about an entry of the answer: the matched `entry`, else the candidate with that id. */
export function knownEntry(answer, id) {
  if (!answer || !id) return null;
  if (answer.entry?.id === id) return answer.entry;
  return (answer.candidates || []).find((c) => c.id === id) || null;
}

/** The progress before a share for the dialog's hint: the server's view of the entry first, else the list entry. */
export function progressBefore(entry, known) {
  if (known) return known.my_status ? { status: known.my_status, episodes_watched: known.my_episodes || 0 } : null;
  if (entry) return entry.my_progress ? { status: entry.my_progress.status, episodes_watched: entry.my_progress.episodes_watched || 0 } : null;
  return null;
}

/** True when the save changed the progress (else only the "Weiter" link was remembered). */
export function savedRaised(saved) {
  const progress = saved?.progress;
  if (!progress) return false;
  const previous = saved.previous;
  return !previous || (progress.episodes_watched || 0) > (previous.episodes_watched || 0) || progress.status !== previous.status;
}

const capitalizeWords = (text) => text.replace(/(^|\s)(\p{Ll})/gu, (all, space, letter) => space + letter.toUpperCase());

/** The series title of an answer for display; a title read from the link's slug ('frieren') gets capital letters. */
export function displaySeriesTitle(answer, link) {
  const title = typeof answer?.series_title === 'string' ? answer.series_title.trim() : '';
  if (!title) return '';
  const slug = link?.kind === 'legacy' ? link.seriesSlug : link?.kind === 'series' ? link.slug : null;
  const fromSlug = slug ? links.titleFromSlug(slug) : null;
  return fromSlug && fromSlug === title ? capitalizeWords(title) : title;
}

export const aboveTotalText = (episode, total) => `Folge ${episode} liegt über den ${total} Folgen dieses Eintrags.`;

/** True when the shared episode raises the counter (else the dialog offers "Link merken"). */
export const raisesCounter = (before, episode) => Number(episode) > (before?.episodes_watched || 0);

/**
 * Clipboard text, read only inside the click of "Link einfügen"; '' when the API is missing or refused (plain-http
 * servers, Android WebView, a denied prompt): the dialog then shows the paste field.
 */
export async function readClipboardText(nav = globalThis.navigator) {
  try {
    const text = await nav?.clipboard?.readText?.();
    return typeof text === 'string' ? text : '';
  } catch (_) {
    return '';
  }
}
