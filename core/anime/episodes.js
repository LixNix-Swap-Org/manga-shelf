// Per-episode marks of one user's progress (anime_progress.watched_episodes). NULL means the plain counter: episodes
// 1..episodes_watched count as watched. A JSON array lists the watched episode numbers when they are not just 1..n.
// episodes_watched always equals the number of watched episodes (stats, CSV, "x / y"); AniList gets the unbroken run from
// episode 1 (watermark). More than MAX_MARKS marks are never stored: such a row falls back to the plain counter up to its
// highest watched episode. Pure functions, shared by core/anime/progress.js and the frontend (utils/animeHelpers.js).

const MAX_MARKS = 5000;

const range = (from, to) => {
    const out = [];
    for (let n = from; n <= to; n++) out.push(n);
    return out;
};

/** Sorted, unique whole numbers from 1 (up to `total` when it is known). */
function cleanMarks(list, total = null) {
    const seen = {};
    const out = [];
    for (const value of Array.isArray(list) ? list : []) {
        if (!Number.isInteger(value) || value < 1) continue;
        if (total > 0 && value > total) continue;
        if (seen[value]) continue;
        seen[value] = true;
        out.push(value);
    }
    return out.sort((a, b) => a - b);
}

/** The stored column as an array, or null for the plain counter (also for anything unreadable). */
function parseMarks(stored) {
    if (stored === null || stored === undefined || stored === '') return null;
    if (Array.isArray(stored)) return cleanMarks(stored);
    try {
        const list = JSON.parse(stored);
        return Array.isArray(list) ? cleanMarks(list) : null;
    } catch (_) {
        return null;
    }
}

const countOf = (progress) => (progress ? Math.max(0, Number(progress.episodes_watched) || 0) : 0);
const marksIn = (progress) => (progress ? parseMarks(progress.watched_episodes) : null);

/** The watched episodes of a progress row or answer: its marks, else 1..episodes_watched (at most MAX_MARKS of them). */
function marksOf(progress) {
    const marks = marksIn(progress);
    if (marks) return marks;
    return range(1, Math.min(countOf(progress), MAX_MARKS));
}

/** True when the marks are exactly 1..n (then nothing needs to be stored). */
function isPlain(marks) {
    return marks.every((n, i) => n === i + 1);
}

/** The column value for a list of marks: null for 1..n, else the JSON array. */
function storedMarks(marks) {
    if (!marks || isPlain(marks)) return null;
    return JSON.stringify(marks);
}

/** Marks with exactly `count` entries: the lowest unwatched episodes are added, the highest marks dropped. */
function fitMarks(marks, count) {
    const out = marks.slice();
    if (out.length > count) return out.slice(0, Math.max(0, count));
    const have = {};
    for (const n of out) have[n] = true;
    for (let n = 1; out.length < count && out.length < MAX_MARKS; n++) {
        if (!have[n]) out.push(n);
    }
    return out.sort((a, b) => a - b);
}

/** The first episode not marked as watched. */
function nextUnwatched(marks) {
    let n = 1;
    for (const m of marks) {
        if (m > n) break;
        if (m === n) n++;
    }
    return n;
}

/** True when episode `n` counts as watched: one of the marks, else 1..episodes_watched. */
function isWatched(progress, n) {
    if (!Number.isInteger(n) || n < 1 || !progress) return false;
    const stored = progress.watched_episodes;
    const marks = Array.isArray(stored) ? stored : marksIn(progress);
    return marks ? marks.includes(n) : n <= countOf(progress);
}

/** The first episode not watched: the first gap in the marks, else episodes_watched + 1. */
function firstUnwatched(progress) {
    const marks = marksIn(progress);
    return marks ? nextUnwatched(marks) : countOf(progress) + 1;
}

/** The last episode of the unbroken run from episode 1 (what AniList calls progress); 0 when episode 1 is not watched. */
const watermark = (progress) => firstUnwatched(progress) - 1;

/** The highest watched episode, 0 without any. */
function lastWatched(progress) {
    const marks = marksIn(progress);
    if (!marks) return countOf(progress);
    return marks.length ? marks[marks.length - 1] : 0;
}

/**
 * { episodes_watched, watched_episodes } for sorted, unique marks: 1..n becomes the plain counter (null), more than
 * MAX_MARKS the plain counter up to the highest mark (never below `floor`).
 */
function fromMarks(marks, floor = 0) {
    if (marks.length > MAX_MARKS) return { episodes_watched: Math.max(floor, marks[marks.length - 1]), watched_episodes: null };
    return { episodes_watched: marks.length, watched_episodes: isPlain(marks) ? null : marks };
}

/** The progress after marking `list` as watched as { episodes_watched, watched_episodes }; never removes an episode. */
function withEpisodes(progress, list, total = null) {
    const count = countOf(progress);
    const marks = marksIn(progress);
    const fresh = cleanMarks(list, total).filter((n) => (marks ? !marks.includes(n) : n > count));
    if (!fresh.length) return { episodes_watched: marks ? marks.length : count, watched_episodes: marks && !isPlain(marks) ? marks : null };
    if (marks) return fromMarks(cleanMarks(marks.concat(fresh)), count);
    if (count + fresh.length > MAX_MARKS) return { episodes_watched: Math.max(count, fresh[fresh.length - 1]), watched_episodes: null };
    return fromMarks(range(1, count).concat(fresh));
}

/** The marks after marking `list` as watched (the union; a plain row counts as 1..n), cleaned to `total`. */
function addEpisodes(progress, list, total = null) {
    const next = withEpisodes(progress, list, total);
    if (next.watched_episodes) return cleanMarks(next.watched_episodes, total);
    return range(1, total > 0 ? Math.min(next.episodes_watched, total) : next.episodes_watched);
}

/** The progress after "watched up to episode N" (1..N added, nothing removed) as { episodes_watched, watched_episodes }. */
function withThrough(progress, episode) {
    const through = Math.max(0, Number(episode) || 0);
    const count = countOf(progress);
    const marks = marksIn(progress);
    if (!marks) return { episodes_watched: Math.max(count, through), watched_episodes: null };
    const above = marks.filter((n) => n > through);
    if (through + above.length > MAX_MARKS) return { episodes_watched: Math.max(count, through, above.length ? above[above.length - 1] : 0), watched_episodes: null };
    return fromMarks(range(1, through).concat(above));
}

/**
 * The progress with exactly `count` watched episodes as { episodes_watched, watched_episodes }: the highest marks are
 * dropped or the lowest unwatched episodes added; above MAX_MARKS the plain counter (up to the highest mark).
 */
function withCount(progress, count) {
    const marks = marksIn(progress);
    if (!marks) return { episodes_watched: count, watched_episodes: null };
    if (marks.length >= count) return fromMarks(marks.slice(0, Math.max(0, count)));
    if (count > MAX_MARKS) return { episodes_watched: Math.max(count, marks.length ? marks[marks.length - 1] : 0), watched_episodes: null };
    return fromMarks(fitMarks(marks, count));
}

// Ratings of single episodes (anime_progress.episode_scores): a JSON object episode number -> score 1..10, NULL = none.
// A rated episode is a watched one: writeProgress marks the episodes a change rates and drops the ratings of episodes that
// are not watched after the change. Keys are canonical episode numbers ("7", never "07").

const EPISODE_KEY = /^(0|[1-9]\d*)$/;

/** Episode -> score with whole episodes from 1 (up to `total` when known) and whole scores 1..10; anything else is dropped. */
function cleanScores(scores, total = null) {
    const out = {};
    if (!scores || typeof scores !== 'object' || Array.isArray(scores)) return out;
    const keys = Object.keys(scores).filter((k) => EPISODE_KEY.test(k)).map(Number).sort((a, b) => a - b);
    for (const episode of keys) {
        const score = scores[episode];
        if (episode < 1 || (total > 0 && episode > total)) continue;
        if (!Number.isInteger(score) || score < 1 || score > 10) continue;
        out[episode] = score;
    }
    return out;
}

/** The stored column as an object (empty for NULL or anything unreadable). */
function parseScores(stored) {
    if (stored === null || stored === undefined || stored === '') return {};
    if (typeof stored === 'object') return cleanScores(stored);
    try {
        return cleanScores(JSON.parse(stored));
    } catch (_) {
        return {};
    }
}

/** The column value: null without a rating, else the JSON object. */
function storedScores(scores) {
    return scores && Object.keys(scores).length ? JSON.stringify(scores) : null;
}

// Seasons of an entry set by hand (animes.custom_seasons): [{ start, name }] with the absolute first episode of each season,
// shared by everybody. NULL means none: the grid then follows the TMDb seasons of a TV show, else blocks of 100 episodes.

const MAX_SEASONS = 200;
const MAX_SEASON_NAME = 80;

/** Seasons by start, the first one at episode 1, unique starts, names trimmed (empty = null). Anything invalid is dropped. */
function cleanSeasons(list) {
    const out = [];
    const seen = {};
    for (const item of Array.isArray(list) ? list : []) {
        if (!item || typeof item !== 'object') continue;
        const start = item.start;
        if (!Number.isInteger(start) || start < 1 || seen[start]) continue;
        seen[start] = true;
        const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, MAX_SEASON_NAME) : null;
        out.push({ start, name });
    }
    out.sort((a, b) => a.start - b.start);
    return out.length && out[0].start === 1 ? out.slice(0, MAX_SEASONS) : [];
}

/** The stored column as a list (empty for NULL or anything unreadable). */
function parseSeasons(stored) {
    if (stored === null || stored === undefined || stored === '') return [];
    if (Array.isArray(stored)) return cleanSeasons(stored);
    try {
        return cleanSeasons(JSON.parse(stored));
    } catch (_) {
        return [];
    }
}

/** TMDb seasons ([{ season_number, episode_count, name? }]) as starts: [{ start, name }]; seasons without episodes are skipped. */
function seasonsFromCounts(seasons) {
    const out = [];
    let start = 1;
    for (const s of Array.isArray(seasons) ? seasons : []) {
        const count = Number(s && s.episode_count) || 0;
        if (count <= 0) continue;
        const name = typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, MAX_SEASON_NAME) : null;
        out.push({ start, name, episodes: count, season_number: s.season_number ?? null });
        start += count;
    }
    return out;
}

module.exports = {
    MAX_MARKS, MAX_SEASONS, MAX_SEASON_NAME, EPISODE_KEY, cleanSeasons, parseSeasons, seasonsFromCounts, cleanScores, parseScores, storedScores, cleanMarks,
    parseMarks, marksOf, isPlain, storedMarks, fitMarks, nextUnwatched, isWatched, firstUnwatched, watermark, lastWatched, addEpisodes,
    fromMarks, withEpisodes, withThrough, withCount
};
