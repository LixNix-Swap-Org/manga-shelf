import { ANIME_CACHE_KEY, ANIME_META_KEY } from './storageKeys';
import { compareNatural, createSearch } from './search';
import { formatRelative, formatTime } from './format';
import { OFFLINE_SYNCED_EVENT, getClearGeneration } from './offlineStore';
import links from '../../../core/watch/links.js';
import { t, tn } from '../i18n/index.js';

// i18n
export const PROGRESS_STATUSES = ['Geplant', 'Schaue', 'Gesehen', 'Pausiert', 'Abgebrochen'];
// filter chips: the pseudo-values are neutral ids, the others stored progress statuses; the label is the view's job
export const ALL_FILTER = 'all';
export const NO_STATUS = 'none';
// i18n-ignore: the old German ids, still accepted
const LEGACY_FILTERS = { Alle: ALL_FILTER, 'Ohne Status': NO_STATUS };
// i18n-ignore: filter ids and stored progress values; the view shows them through its labels
export const ANIME_FILTERS = [ALL_FILTER, 'Schaue', 'Geplant', 'Gesehen', 'Pausiert', 'Abgebrochen', NO_STATUS];
/** A filter value with the old German pseudo-values ('Alle', 'Ohne Status') mapped to their neutral ids. */
export const normalizeAnimeFilter = (filter) => (Object.prototype.hasOwnProperty.call(LEGACY_FILTERS, filter) ? LEGACY_FILTERS[filter] : filter);
// i18n
export const ANIME_SORTS = [
  { id: 'title', label: 'Titel' },
  { id: 'score', label: 'Bewertung' },
  { id: 'next', label: 'Nächste Folge' },
  { id: 'updated', label: 'Zuletzt geändert' }
];

export { ANIME_CACHE_KEY, ANIME_META_KEY };

// i18n
const FORMAT_LABELS = {
  TV: 'TV', TV_SHORT: 'TV (kurz)', MOVIE: 'Film', OVA: 'OVA', ONA: 'ONA', SPECIAL: 'Special', MUSIC: 'Musik', UNKNOWN: 'Sonstiges'
};
// i18n
const STATUS_LABELS = {
  FINISHED: 'Abgeschlossen', RELEASING: 'Läuft', NOT_YET_RELEASED: 'Angekündigt', CANCELLED: 'Abgebrochen', HIATUS: 'Pausiert'
};
// i18n
const RELATION_LABELS = {
  SEQUEL: 'Fortsetzung', PREQUEL: 'Vorgeschichte', ADAPTATION: 'Adaption', SOURCE: 'Vorlage', SIDE_STORY: 'Nebengeschichte',
  SPIN_OFF: 'Spin-off', SUMMARY: 'Zusammenfassung', ALTERNATIVE: 'Alternative Fassung', CHARACTER: 'Figuren', PARENT: 'Hauptgeschichte',
  COMPILATION: 'Zusammenschnitt', CONTAINS: 'Enthält', OTHER: 'Sonstiges'
};

export const formatLabel = (format) => (FORMAT_LABELS[format] ? t(FORMAT_LABELS[format]) : format || null);
export const airingStatusLabel = (status) => (STATUS_LABELS[status] ? t(STATUS_LABELS[status]) : null);
export const relationLabel = (relation) => (RELATION_LABELS[relation] ? t(RELATION_LABELS[relation]) : relation);

/** German title first, then the display title. */
export const displayTitle = (anime) => (anime?.title_de || anime?.title || '').trim() || t('Ohne Titel');

/** 'TV · 2023' */
export const formatYearLine = (anime) => [formatLabel(anime?.format), anime?.season_year].filter(Boolean).join(' · ');

/** '7 / 12', '7 / ?' while the episode count is unknown. */
export function progressText(watched, total) {
  return `${Number(watched) || 0} / ${total > 0 ? total : '?'}`;
}

/** 0..100 for the progress bar; null without a known episode count. */
export function progressPercent(watched, total) {
  if (!(total > 0)) return null;
  return Math.max(0, Math.min(100, Math.round(((Number(watched) || 0) / total) * 100)));
}

/** True when +1 makes no sense: watched, or the counter reached a known episode count. */
export function plusOneDisabled(progress, total) {
  if (progress?.status === 'Gesehen') return true;
  return total > 0 && (progress?.episodes_watched || 0) >= total;
}

const dayNumber = (date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;

/**
 * 'Folge 8 · heute 16:15', 'Folge 8 · morgen', 'Folge 8 · in 3 Tagen' by calendar days (like the release radar);
 * null without a date or for a past one. `estimated` adds nothing here (the card shows its own badge).
 */
export function countdownText(nextAiring, now = new Date()) {
  if (!nextAiring || !nextAiring.at) return null;
  const at = new Date(nextAiring.at * 1000);
  if (Number.isNaN(at.getTime()) || at.getTime() < now.getTime() - 60 * 60 * 1000) return null;
  const days = dayNumber(at) - dayNumber(now);
  const when = days <= 0 ? t('heute {time}', { time: formatTime(at) }) : days === 1 ? t('morgen') : tn('in {n} Tag', 'in {n} Tagen', days);
  return nextAiring.episode ? t('Folge {episode} · {when}', { episode: nextAiring.episode, when }) : t('Nächste Folge {when}', { when });
}

/** 'Stand: vor 3 Tagen' for a stale snapshot, else null. */
export function staleText(anime, now = Date.now()) {
  if (!anime?.stale || !anime.meta_fetched_at) return null;
  const age = formatRelative(anime.meta_fetched_at, now);
  return age ? t('Stand: {age}', { age }) : null;
}

/** Two letters per co-watcher (like the owner badges). */
export const initials = (name) => String(name || '?').slice(0, 2).toLowerCase();

export const sourceBadges = (anime) => [
  anime?.anilist_id ? 'AniList' : null,
  anime?.mal_id ? 'MAL' : null
].filter(Boolean);

const searchIndex = createSearch((anime) => ({
  primary: [anime.title, anime.title_de, anime.title_english, anime.title_romaji, anime.title_native],
  secondary: [...(anime.studios || []), ...(anime.genres || []), anime.notes]
}));

/** Filter (status of my progress), search and sort of the list; never mutates. */
export function filterAnime(list, { search = '', filter: rawFilter = ALL_FILTER, sort = 'title' } = {}) {
  const query = search.trim();
  const filter = normalizeAnimeFilter(rawFilter);
  let rows = (list || []).filter((anime) => {
    const mine = anime.my_progress?.status || null;
    if (filter === NO_STATUS && mine) return false;
    if (filter !== ALL_FILTER && filter !== NO_STATUS && mine !== filter) return false;
    return true;
  });
  if (query) rows = rows.filter((anime) => searchIndex.matches(anime, query));
  const byTitle = (a, b) => compareNatural(displayTitle(a), displayTitle(b));
  const sorted = [...rows];
  if (sort === 'score') {
    sorted.sort((a, b) => ((b.my_progress?.score ?? -1) - (a.my_progress?.score ?? -1)) || ((b.score ?? -1) - (a.score ?? -1)) || byTitle(a, b));
  } else if (sort === 'next') {
    const next = (a) => a.next_airing?.at || Infinity;
    sorted.sort((a, b) => (next(a) - next(b)) || byTitle(a, b));
  } else if (sort === 'updated') {
    const changed = (a) => Date.parse(String(a.my_progress?.updated_at || a.updated_at || a.created_at || '').replace(' ', 'T')) || 0;
    sorted.sort((a, b) => (changed(b) - changed(a)) || byTitle(a, b));
  } else {
    sorted.sort(byTitle);
  }
  return sorted;
}

/** Counts per filter for the filter chips. */
export function filterCounts(list) {
  const counts = Object.fromEntries(ANIME_FILTERS.map((f) => [f, 0]));
  for (const anime of list || []) {
    counts[ALL_FILTER]++;
    const mine = anime.my_progress?.status;
    if (mine && counts[mine] !== undefined) counts[mine]++;
    if (!mine) counts[NO_STATUS]++;
  }
  // the old German ids count too
  for (const [legacy, id] of Object.entries(LEGACY_FILTERS)) counts[legacy] = counts[id];
  return counts;
}

/** Applies a progress answer to an entry of the list (my_progress and my row in progress_users). */
export function withProgress(anime, progress, user) {
  if (!anime) return anime;
  const others = (anime.progress_users || []).filter((p) => p.user_id !== user?.id);
  const mine = progress ? [{ user_id: user?.id, username: user?.username, status: progress.status, episodes_watched: progress.episodes_watched }] : [];
  return { ...anime, my_progress: progress, progress_users: [...others, ...mine].sort((a, b) => compareNatural(a.username, b.username)) };
}

/**
 * The optimistic answer of a progress change, by the server's rules: counter clamped to a known episode count,
 * reaching it means "Gesehen", "Gesehen" fills the counter, a counter above 0 moves "Geplant" to "Schaue".
 */
export function predictProgress(current, change, total) {
  const base = current || { status: 'Geplant', episodes_watched: 0, score: null, notes: null };
  let status = change.status ?? base.status;
  let episodes = change.episodes_watched ?? base.episodes_watched ?? 0;
  if (total > 0 && episodes > total) episodes = total;
  if (change.status === 'Gesehen' && total > 0) episodes = total;
  if (change.episodes_watched !== undefined && change.status === undefined && total > 0 && episodes >= total) status = 'Gesehen';
  if (change.episodes_watched !== undefined && change.status === undefined && status === 'Geplant' && episodes > 0) status = 'Schaue';
  const next = {
    ...base,
    status,
    episodes_watched: episodes,
    score: change.score !== undefined ? change.score : base.score,
    notes: change.notes !== undefined ? change.notes : base.notes
  };
  // any other change of the counter makes the remembered "Weiter" page stale (the server clears it too)
  if (episodes !== (base.episodes_watched ?? 0)) {
    next.resume_url = null;
    next.resume_episode = null;
  }
  return next;
}

/**
 * The optimistic answer of "Ja, gesehen" (POST /anime/:id/watched): the counter never goes down, the shared page is
 * the new "Weiter" target, raising the counter moves Geplant/Pausiert/Abgebrochen to "Schaue".
 */
export function predictWatched(current, { episode, url = null }, total) {
  const base = current || { status: 'Geplant', episodes_watched: 0, score: null, notes: null };
  const had = base.episodes_watched || 0;
  let episodes = Math.max(had, Number(episode) || 0);
  if (total > 0 && episodes > total) episodes = total;
  let status = base.status;
  if (total > 0 && episodes >= total) status = 'Gesehen';
  else if (episodes > had && status !== 'Gesehen') status = 'Schaue';
  return { ...base, status, episodes_watched: episodes, resume_url: url, resume_episode: url ? Number(episode) || null : null };
}

const crunchyroll = () => links.SERVICES.find((s) => s.id === 'crunchyroll');

/**
 * Target of "Weiter auf Crunchyroll" by the core's chain (watch.next_url, then watch.series_url, then the search) or
 * null when there is nothing left to watch. The card passes `search: false`: a search alone is no reason for a button.
 */
export function continueTarget(anime, { search = true } = {}) {
  if (!anime) return null;
  const mine = anime.my_progress;
  if (mine?.status === 'Gesehen') return null;
  if (anime.episodes > 0 && (mine?.episodes_watched || 0) >= anime.episodes) return null;
  const watch = anime.watch || {};
  if (watch.next_url) return { url: watch.next_url, kind: 'episode', label: t('Weiter auf Crunchyroll') };
  if (watch.series_url) return { url: watch.series_url, kind: 'series', label: t('Weiter auf Crunchyroll') };
  if (!search) return null;
  const title = anime.title_english || anime.title_romaji || anime.title;
  const url = watch.search_url || (title ? crunchyroll()?.searchUrl(title) : null);
  return url ? { url, kind: 'search', label: t('Auf Crunchyroll suchen') } : null;
}

/** The stored list for the offline view (only for the same user and only when no logout happened since `generation`). */
export function readAnimeCache(userId) {
  try {
    const meta = JSON.parse(localStorage.getItem(ANIME_META_KEY) || 'null');
    if (!meta || meta.user_id !== userId) return null;
    const list = JSON.parse(localStorage.getItem(ANIME_CACHE_KEY) || 'null');
    return Array.isArray(list) ? { list, timestamp: meta.timestamp } : null;
  } catch (_) {
    return null;
  }
}

export function writeAnimeCache(list, userId, generation = getClearGeneration()) {
  if (generation !== getClearGeneration() || !userId) return null;
  try {
    const timestamp = new Date().toISOString();
    localStorage.setItem(ANIME_CACHE_KEY, JSON.stringify(list));
    localStorage.setItem(ANIME_META_KEY, JSON.stringify({ user_id: userId, timestamp }));
    return timestamp;
  } catch (_) {
    return null;
  }
}

export function clearAnimeCache() {
  try {
    localStorage.removeItem(ANIME_CACHE_KEY);
    localStorage.removeItem(ANIME_META_KEY);
  } catch (_) { /* storage unavailable */ }
}

// clearOfflineData() (logout, ended session, restore) announces itself with synced_at null: the anime copy goes too
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener(OFFLINE_SYNCED_EVENT, (event) => {
    if (event?.detail && event.detail.synced_at === null) clearAnimeCache();
  });
}

export const SLOW_HINT_KEY = 'mangashelf_anime_slow_hint';
/** True for a list sync error about the own AniList key (missing or refused); 'AniList ist gerade nicht erreichbar' passes. */
export const listSyncKeyError = (text) => /\b(?:Token|Schlüssel)\b/i.test(String(text || ''));

export const LIST_SYNC_KEY = 'mangashelf_anime_list_sync';
export const LIST_SYNC_INTERVAL_MS = 15 * 60 * 1000;

/** The AniList list sync of the tab runs at most every 15 minutes per user and browser session. */
export function listSyncDue(userId, now = Date.now()) {
  try {
    const last = Number(sessionStorage.getItem(`${LIST_SYNC_KEY}:${userId}`)) || 0;
    return now - last >= LIST_SYNC_INTERVAL_MS;
  } catch (_) {
    return true;
  }
}

export function markListSync(userId, now = Date.now()) {
  try {
    sessionStorage.setItem(`${LIST_SYNC_KEY}:${userId}`, String(now));
  } catch (_) { /* storage unavailable */ }
}

/** The "search is slow" hint shows once per session and can be switched off for good. */
export function slowHintAllowed() {
  try {
    if (localStorage.getItem(SLOW_HINT_KEY) === 'off') return false;
    return sessionStorage.getItem(SLOW_HINT_KEY) !== 'shown';
  } catch (_) {
    return false;
  }
}

export function markSlowHint({ forever = false } = {}) {
  try {
    sessionStorage.setItem(SLOW_HINT_KEY, 'shown');
    if (forever) localStorage.setItem(SLOW_HINT_KEY, 'off');
  } catch (_) { /* storage unavailable */ }
}

/** Description for the detail view: plain text, at most `max` characters when collapsed. */
export function shortDescription(text, max = 420) {
  let clean = String(text || '').replace(/<br\s*\/?>/gi, '\n');
  for (let previous = ''; clean !== previous;) {
    previous = clean;
    clean = clean.replace(/<[^>]*>/g, '');
  }
  clean = clean.trim();
  if (clean.length <= max) return { text: clean, cut: false };
  return { text: `${clean.slice(0, max).replace(/\s+\S*$/, '')} …`, cut: true };
}
