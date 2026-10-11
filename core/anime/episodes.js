// Per-episode marks of one user's progress (anime_progress.watched_episodes). NULL means the plain counter: episodes
// 1..episodes_watched count as watched. A JSON array lists the watched episode numbers when they are not just 1..n.
// episodes_watched always equals the number of marked episodes, so stats, +1 and the AniList push keep using the counter.
// Pure functions, shared by core/anime/progress.js and the frontend's optimistic progress (utils/animeHelpers.js).

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

/** The watched episodes of a progress row or answer: its marks, else 1..episodes_watched. */
function marksOf(progress) {
    if (!progress) return [];
    const marks = parseMarks(progress.watched_episodes);
    if (marks) return marks;
    const count = Number(progress.episodes_watched) || 0;
    return range(1, Math.min(count, MAX_MARKS));
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

/** Marks plus every episode from 1 to `episode` ("watched up to episode N" from a link, the history sync or AniList). */
function throughEpisode(marks, episode) {
    return cleanMarks(marks.concat(range(1, Math.min(Number(episode) || 0, MAX_MARKS))));
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

// Ratings of single episodes (anime_progress.episode_scores): a JSON object episode number -> score 1..10, NULL = none.
// Independent of the marks: rating an episode does not mark it, unmarking keeps the rating (the grid drops it itself).

/** Episode -> score with whole episodes from 1 (up to `total` when known) and whole scores 1..10; anything else is dropped. */
function cleanScores(scores, total = null) {
    const out = {};
    if (!scores || typeof scores !== 'object' || Array.isArray(scores)) return out;
    const keys = Object.keys(scores).filter((k) => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
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

module.exports = { MAX_MARKS, cleanScores, parseScores, storedScores, cleanMarks, parseMarks, marksOf, isPlain, storedMarks, fitMarks, throughEpisode, nextUnwatched };
