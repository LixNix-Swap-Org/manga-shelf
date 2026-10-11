import { ANIME_CACHE_KEY, ANIME_META_KEY } from './storageKeys';
import { compareNatural, createSearch } from './search';
import { formatRelative, formatTime } from './format';
import { OFFLINE_SYNCED_EVENT, getClearGeneration } from './offlineStore';
import links from '../../../core/watch/links.js';
import episodeMarks from '../../../core/anime/episodes.js';
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

export const ANIME_KINDS = ['anime', 'tv', 'movie'];
export const KIND_FILTER_KEY = 'mangashelf_anime_kind';
export const LANGUAGE_FILTER_KEY = 'mangashelf_anime_language';
// i18n
const KIND_LABELS = { anime: 'Anime', tv: 'Serie', movie: 'Film' };
// i18n
const KIND_FILTER_LABELS = { [ALL_FILTER]: 'Alle', anime: 'Anime', tv: 'Serien', movie: 'Filme' };
export const KIND_FILTERS = [ALL_FILTER, ...ANIME_KINDS];

/** The kind of an entry or hit; a missing kind means anime. */
export const kindOf = (anime) => (ANIME_KINDS.includes(anime?.kind) ? anime.kind : 'anime');
export const isAnimeKind = (anime) => kindOf(anime) === 'anime';
export const kindLabel = (kind) => (KIND_LABELS[kind] ? t(KIND_LABELS[kind]) : null);
export const kindFilterLabel = (filter) => (KIND_FILTER_LABELS[filter] ? t(KIND_FILTER_LABELS[filter]) : filter);

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

/** Episodes aired so far of a show without an episode count (from a confirmed next airing), else null. Display only. */
export const airedEpisodes = (anime) => (anime?.episodes > 0 ? null
  : (anime?.next_airing && !anime.next_airing.estimated && anime.next_airing.episode > 1 ? anime.next_airing.episode - 1 : null));

/** True while "Gesehen" is locked: an anime that airs or is not out yet, a TV show while an unaired episode is counted. */
export function stillAiring(anime) {
  const kind = kindOf(anime);
  if (kind === 'tv') return Boolean(anime.next_airing && anime.episodes > 0 && anime.next_airing.episode <= anime.episodes);
  return kind === 'anime' && (anime?.status === 'RELEASING' || anime?.status === 'NOT_YET_RELEASED');
}

/** Season and episode of an absolute counter for a TV show with seasons ({ season, episode }); null for 0 or without seasons. */
export function seasonEpisode(anime, watched) {
  const n = Number(watched) || 0;
  const seasons = Array.isArray(anime?.seasons) ? anime.seasons : [];
  if (kindOf(anime) !== 'tv' || n <= 0 || !seasons.length) return null;
  let before = 0;
  for (const s of seasons) {
    const count = Number(s.episode_count) || 0;
    if (before + count >= n) return { season: s.season_number, episode: n - before };
    before += count;
  }
  const last = seasons[seasons.length - 1];
  return { season: last.season_number, episode: n - (before - (Number(last.episode_count) || 0)) };
}

/** 'S2E3' for a TV show with seasons, else null. */
export function seasonEpisodeText(anime, watched) {
  const at = seasonEpisode(anime, watched);
  return at ? `S${at.season}E${at.episode}` : null;
}

/** '7 / 12', '12 / 1180+' with only the aired episodes known, '7 / ?' while the episode count is unknown. */
export function progressText(watched, total, aired = null) {
  return `${Number(watched) || 0} / ${total > 0 ? total : aired > 0 ? `${aired}+` : '?'}`;
}

/** 0..100 for the progress bar (against the aired episodes without a total); null without either. */
export function progressPercent(watched, total, aired = null) {
  const of = total > 0 ? total : aired > 0 ? aired : null;
  if (of === null) return null;
  return Math.max(0, Math.min(100, Math.round(((Number(watched) || 0) / of) * 100)));
}

/** True when +1 makes no sense: the counter reached a known episode count. */
export function plusOneDisabled(progress, total) {
  return total > 0 && (progress?.episodes_watched || 0) >= total;
}

const dayNumber = (date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;

/**
 * 'Folge 8 · heute 16:15', 'Folge 8 · morgen', 'Folge 8 · in 3 Tagen' by calendar days (like the release radar);
 * null without a date or for a past one. `estimated` adds nothing here (the card shows its own badge). A TV show
 * (`kind` 'tv') airs by date only: no clock time, and it counts as today until the day is over.
 */
export function countdownText(nextAiring, now = new Date(), kind = 'anime') {
  if (!nextAiring || !nextAiring.at) return null;
  const at = new Date(nextAiring.at * 1000);
  if (Number.isNaN(at.getTime())) return null;
  const dateOnly = kind === 'tv';
  if (dateOnly ? dayNumber(at) < dayNumber(now) : at.getTime() < now.getTime() - 60 * 60 * 1000) return null;
  const days = dayNumber(at) - dayNumber(now);
  const today = dateOnly ? t('heute') : t('heute {time}', { time: formatTime(at) });
  const when = days <= 0 ? today : days === 1 ? t('morgen') : tn('in {n} Tag', 'in {n} Tagen', days);
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
  anime?.mal_id ? 'MAL' : null,
  anime?.tmdb_id ? 'TMDB' : null
].filter(Boolean);

/** The watched language of my progress (ISO code) or null. */
export const audioLanguageOf = (anime) => anime?.my_progress?.audio_language || null;

/** The watched languages present in the list, sorted. */
export const audioLanguagesOf = (list) => [...new Set((list || []).map(audioLanguageOf).filter(Boolean))].sort();

/** True when the list holds a TV show or a film. */
export const hasOtherKinds = (list) => (list || []).some((anime) => !isAnimeKind(anime));

/** A stored per-device value, `fallback` when missing, unreadable or refused by `valid`. */
export function readSetting(key, fallback, valid = () => true) {
  try {
    const value = localStorage.getItem(key);
    return value !== null && valid(value) ? value : fallback;
  } catch (_) {
    return fallback;
  }
}

export function writeSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_) { /* storage unavailable */ }
}

const searchIndex = createSearch((anime) => ({
  primary: [anime.title, anime.title_de, anime.title_english, anime.title_romaji, anime.title_native],
  secondary: [...(anime.studios || []), ...(anime.genres || []), anime.notes]
}));

/** Entries of one kind and one watched language ('all' for each lets everything through). */
export function filterKindLanguage(list, { kind = ALL_FILTER, language = ALL_FILTER } = {}) {
  return (list || []).filter((anime) => (kind === ALL_FILTER || kindOf(anime) === kind)
    && (language === ALL_FILTER || audioLanguageOf(anime) === language));
}

/** Counts per kind for the kind chips. */
export function kindCounts(list) {
  const counts = Object.fromEntries(KIND_FILTERS.map((f) => [f, 0]));
  for (const anime of list || []) {
    counts[ALL_FILTER]++;
    counts[kindOf(anime)]++;
  }
  return counts;
}

/** Filter (kind, watched language, status of my progress), search and sort of the list; never mutates. */
export function filterAnime(list, { search = '', filter: rawFilter = ALL_FILTER, sort = 'title', kind = ALL_FILTER, language = ALL_FILTER } = {}) {
  const query = search.trim();
  const filter = normalizeAnimeFilter(rawFilter);
  let rows = filterKindLanguage(list, { kind, language }).filter((anime) => {
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
 * reaching it means "Gesehen", "Gesehen" fills the counter, a counter above 0 moves "Geplant" to "Schaue", choosing
 * "Geplant" alone resets the counter, a counter below the total (or with none) moves "Gesehen" back to "Schaue".
 * `watched_episodes` (single episodes) sets the counter to their number; a counter change fills the first gaps or drops
 * the highest marks (core/anime/episodes.js, like the server).
 */
export function predictProgress(current, change, total) {
  const base = current || { status: 'Geplant', episodes_watched: 0, score: null, notes: null };
  const known = total > 0 ? total : null;
  const marks = Array.isArray(change.watched_episodes) ? episodeMarks.cleanMarks(change.watched_episodes, known) : null;
  const watched = marks ? marks.length : change.episodes_watched;
  let status = change.status ?? base.status;
  let episodes = watched ?? base.episodes_watched ?? 0;
  if (total > 0 && episodes > total) episodes = total;
  if (change.status === 'Gesehen' && total > 0) episodes = total;
  if (watched !== undefined && change.status === undefined && total > 0 && episodes >= total) status = 'Gesehen';
  if (watched !== undefined && change.status === undefined && status === 'Geplant' && episodes > 0) status = 'Schaue';
  if (status === 'Geplant' && episodes > 0) {
    if (change.status === 'Geplant' && watched === undefined) episodes = 0;
    else status = 'Schaue';
  }
  if (watched !== undefined && change.status === undefined && status === 'Gesehen' && (!(total > 0) || episodes < total)) status = 'Schaue';
  const next = {
    ...base,
    status,
    episodes_watched: episodes,
    score: change.score !== undefined ? change.score : base.score,
    notes: change.notes !== undefined ? change.notes : base.notes
  };
  if (change.audio_language !== undefined) next.audio_language = change.audio_language;
  if (change.subtitle_language !== undefined) next.subtitle_language = change.subtitle_language;
  const marked = change.watched_episodes === null ? null : (marks || episodeMarks.parseMarks(base.watched_episodes));
  const fitted = marked ? episodeMarks.fitMarks(episodeMarks.cleanMarks(marked, known), episodes) : null;
  next.watched_episodes = fitted && !episodeMarks.isPlain(fitted) ? fitted : null;
  if (status !== 'Gesehen') next.finished_at = null;
  if (status === 'Geplant') next.started_at = null;
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

/** The watched episodes of a progress answer: its single marks, else 1..episodes_watched. */
export const watchedEpisodesOf = (progress) => episodeMarks.marksOf(progress);

/**
 * Sections of the episode grid: the seasons of a TV show (absolute numbers), else blocks of 100. `count` is the number of
 * episodes to show; each section is { from, to, season }.
 */
export function episodeSections(anime, count, size = 100) {
  const seasons = Array.isArray(anime?.seasons) ? anime.seasons : [];
  const out = [];
  if (kindOf(anime) === 'tv' && seasons.length) {
    let before = 0;
    for (const s of seasons) {
      const n = Number(s.episode_count) || 0;
      if (n > 0 && before < count) out.push({ from: before + 1, to: Math.min(before + n, count), season: s.season_number });
      before += n;
    }
    if (before < count) out.push({ from: before + 1, to: count, season: null });
    return out;
  }
  for (let from = 1; from <= count; from += size) out.push({ from, to: Math.min(from + size - 1, count), season: null });
  return out;
}

/** How many episodes the grid shows: the known count, else the aired ones, else one past the highest watched. */
export function episodeGridCount(anime, marks) {
  if (anime?.episodes > 0) return anime.episodes;
  const highest = marks.length ? marks[marks.length - 1] : 0;
  return Math.max(airedEpisodes(anime) || 0, highest + 1);
}

const crunchyroll = () => links.SERVICES.find((s) => s.id === 'crunchyroll');

/**
 * Target of "Weiter auf Crunchyroll" by the core's chain (watch.next_url, then watch.series_url, then the search) or
 * null when there is nothing left to watch. The card passes `search: false`: a search alone is no reason for a button.
 */
export function continueTarget(anime, { search = true } = {}) {
  if (!anime || !isAnimeKind(anime)) return null;
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

const watchOf = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);

/** The stored list for the offline view (only for the same user and only when no logout happened since `generation`). */
export function readAnimeCache(userId) {
  try {
    const meta = JSON.parse(localStorage.getItem(ANIME_META_KEY) || 'null');
    if (!meta || meta.user_id !== userId) return null;
    const list = JSON.parse(localStorage.getItem(ANIME_CACHE_KEY) || 'null');
    return Array.isArray(list) ? { list, timestamp: meta.timestamp, watch: watchOf(meta.watch) } : null;
  } catch (_) {
    return null;
  }
}

/** Stores the list; the stored `watch` stays unless a new one is given, and `list` null only sets `watch` beside the stored list. */
export function writeAnimeCache(list, userId, generation = getClearGeneration(), { watch } = {}) {
  if (generation !== getClearGeneration() || !userId) return null;
  try {
    const meta = JSON.parse(localStorage.getItem(ANIME_META_KEY) || 'null');
    const own = meta && meta.user_id === userId ? meta : null;
    const nextWatch = watch === undefined ? watchOf(own?.watch) : watchOf(watch);
    if (list === null) {
      if (!own || !Array.isArray(JSON.parse(localStorage.getItem(ANIME_CACHE_KEY) || 'null'))) return null;
      localStorage.setItem(ANIME_META_KEY, JSON.stringify({ user_id: userId, timestamp: own.timestamp, ...(nextWatch ? { watch: nextWatch } : {}) }));
      return own.timestamp;
    }
    const timestamp = new Date().toISOString();
    localStorage.setItem(ANIME_CACHE_KEY, JSON.stringify(list));
    localStorage.setItem(ANIME_META_KEY, JSON.stringify({ user_id: userId, timestamp, ...(nextWatch ? { watch: nextWatch } : {}) }));
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
