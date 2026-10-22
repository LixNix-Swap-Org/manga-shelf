// Pure helpers of the Anime-Radar tabs: calendar, "together", tags, spoiler guard and episode alerts. No React, no fetches.
import { displayTitle, kindOf, readSetting, writeSetting } from './animeHelpers';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PROJECTED_WEEKS = 3;
// i18n-ignore: stored anime status values
const FOLLOWED = ['Schaue', 'Geplant'];
const WEEKLY_FORMATS = ['TV', 'TV_SHORT', 'ONA'];

export const SPOILER_KEY = 'mangashelf_anime_spoiler_guard';
export const ALERTS_KEY = 'mangashelf_anime_alerts';
export const ALERTS_SEEN_KEY = 'mangashelf_anime_alerts_seen';

export const isFollowing = (anime) => FOLLOWED.includes(anime?.my_progress?.status);

/**
 * Airing times of one entry: the announced next episode and, for a running TV show, the following weekly episodes as
 * estimates, up to the known episode count. [{ anime, episode, at (ms), estimated }].
 */
export function airingsOf(anime) {
  const next = anime?.next_airing;
  if (!next || !next.at || kindOf(anime) === 'movie') return [];
  const total = anime.episodes > 0 ? anime.episodes : null;
  const weeks = WEEKLY_FORMATS.includes(anime.format) && !next.estimated ? PROJECTED_WEEKS : 0;
  const out = [];
  for (let i = 0; i <= weeks; i++) {
    const episode = Number.isInteger(next.episode) ? next.episode + i : null;
    if (total && episode && episode > total) break;
    out.push({ anime, episode, at: next.at * 1000 + i * WEEK_MS, estimated: i > 0 || Boolean(next.estimated) });
  }
  return out;
}

/** Monday 00:00 (local time) of the week of `date`, `offset` weeks later. */
export function weekStart(date = new Date(), offset = 0) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7);
  return d;
}

export const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** `count` days from `start`, each with its episodes sorted by time: [{ date, key, events }]. `mineOnly` leaves out entries I do not follow. */
export function calendarDays(list, start, count, { mineOnly = true, extra = [] } = {}) {
  const days = Array.from({ length: count }, (_, i) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return { date, key: dayKey(date), events: [] };
  });
  const byKey = new Map(days.map((d) => [d.key, d]));
  // aired episodes from the history win over the announced one of the same episode
  const known = new Set(extra.filter((event) => !event.finished).map((event) => `${event.anime.id}:${event.episode}`));
  (list || []).forEach((anime) => {
    if (mineOnly && !isFollowing(anime)) return;
    airingsOf(anime).forEach((event) => {
      if (known.has(`${anime.id}:${event.episode}`)) return;
      const day = byKey.get(dayKey(new Date(event.at)));
      if (day) day.events.push(event);
    });
  });
  extra.forEach((event) => {
    const day = byKey.get(dayKey(new Date(event.at)));
    if (day) day.events.push(event);
  });
  days.forEach((d) => d.events.sort((a, b) => a.at - b.at || displayTitle(a.anime).localeCompare(displayTitle(b.anime))));
  return days;
}

export const calendarWeek = (list, start, options) => calendarDays(list, start, 7, options);

/** The month `offset` months from `date`: the first day, and the Monday-based grid start with the number of weeks needed. */
export function monthGrid(date = new Date(), offset = 0) {
  const first = new Date(date.getFullYear(), date.getMonth() + offset, 1);
  const start = weekStart(first);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const weeks = Math.ceil(((last - start) / 86400000 + 1) / 7);
  return { first, start, weeks };
}

// i18n-ignore: stored anime status values
const ACTIVE = ['Schaue', 'Geplant', 'Pausiert'];

/**
 * Entries two or more people follow: who is how far, and the episode everybody has reached ("gemeinsam bis Folge N").
 * `ahead` names the people more than one episode in front of the slowest one (spoiler warning). Sorted by the number of people.
 */
export function togetherRows(list) {
  const rows = [];
  (list || []).forEach((anime) => {
    const people = (anime.progress_users || []).filter((p) => ACTIVE.includes(p.status) || p.status === 'Gesehen');
    if (people.length < 2) return;
    const episodesOf = (p) => (p.status === 'Gesehen' && anime.episodes > 0 ? anime.episodes : p.episodes_watched || 0);
    const counts = people.map(episodesOf);
    const reached = Math.min(...counts);
    const furthest = Math.max(...counts);
    const ahead = furthest - reached > 1 ? people.filter((p) => episodesOf(p) === furthest).map((p) => p.username) : [];
    rows.push({
      anime, people: people.map((p) => ({ ...p, episodes: episodesOf(p) })), reached, furthest, ahead,
      finished: people.every((p) => p.status === 'Gesehen')
    });
  });
  rows.sort((a, b) => Number(a.finished) - Number(b.finished) || b.people.length - a.people.length || displayTitle(a.anime).localeCompare(displayTitle(b.anime)));
  return rows;
}

/** Tags of the whole list with their counts, most used first: [{ name, count }]. */
export function tagCounts(list) {
  const counts = new Map();
  (list || []).forEach((anime) => (anime.tags || []).forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1)));
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Spoiler guard on this device (off by default). */
export const readSpoilerGuard = () => readSetting(SPOILER_KEY, 'off', (v) => v === 'on' || v === 'off') === 'on';
export const writeSpoilerGuard = (on) => writeSetting(SPOILER_KEY, on ? 'on' : 'off');

/**
 * The description of an entry stays hidden while the guard is on and I have not started it; the ratings of others stay hidden until
 * I finished the entry or rated it myself.
 */
export function spoilerState(anime, guard) {
  const mine = anime?.my_progress || {};
  const started = (mine.episodes_watched || 0) > 0 || mine.status === 'Gesehen';
  const done = mine.status === 'Gesehen' || (mine.score != null);
  return { hideDescription: guard && !started, hideOthers: guard && !done };
}

export const alertsEnabled = () => readSetting(ALERTS_KEY, 'off', (v) => v === 'on' || v === 'off') === 'on';
export const setAlertsEnabled = (on) => writeSetting(ALERTS_KEY, on ? 'on' : 'off');

/** Episodes of followed entries that aired within the last day and were not announced yet: [{ anime, episode, at, key }]. */
export function dueAlerts(list, now, seen = []) {
  const due = [];
  const known = new Set(seen);
  (list || []).forEach((anime) => {
    if (!isFollowing(anime)) return;
    const next = anime.next_airing;
    if (!next || !next.at || next.estimated || !(next.episode > 0)) return;
    const at = next.at * 1000;
    const key = `${anime.id}:${next.episode}`;
    if (at <= now.getTime() && at > now.getTime() - 24 * 60 * 60 * 1000 && !known.has(key)) due.push({ anime, episode: next.episode, at, key });
  });
  return due.sort((a, b) => a.at - b.at);
}

export function readSeenAlerts() {
  try { const v = JSON.parse(window.localStorage.getItem(ALERTS_SEEN_KEY) || '[]'); return Array.isArray(v) ? v.slice(-200) : []; } catch (_) { return []; }
}
export function writeSeenAlerts(keys) {
  try { window.localStorage.setItem(ALERTS_SEEN_KEY, JSON.stringify(keys.slice(-200))); } catch (_) { /* storage unavailable */ }
}

/** Monthly bars: the largest value scales to 100 (at least 1 so empty series draw nothing). */
export const barPercent = (value, max) => (max > 0 ? Math.round((value / max) * 100) : 0);

/** The history answer (GET /api/anime/history) as calendar events of entries that are in the list: aired episodes and finished days. */
export function historyEvents(history, list) {
  const byId = new Map((list || []).map((anime) => [anime.id, anime]));
  const events = [];
  (history?.airings || []).forEach((a) => {
    const anime = byId.get(a.anime_id);
    if (anime) events.push({ anime, episode: a.episode, at: a.at * 1000, estimated: false, past: true });
  });
  (history?.finished || []).forEach((f) => {
    const anime = byId.get(f.anime_id);
    const [y, m, d] = String(f.date).split('-').map(Number);
    if (anime && y) events.push({ anime, episode: null, at: new Date(y, m - 1, d, 12).getTime(), finished: true, past: true });
  });
  return events;
}

/** True for an aired episode that I have watched (the counter reached it). */
export const watchedEpisode = (event) => Boolean(event.episode) && (event.anime.my_progress?.episodes_watched || 0) >= event.episode;
