// The one progress rule of the anime tab: PUT progress, "Folge gesehen" from a shared link, the history sync and the AniList
// pull all write through writeProgress, so clamping, automatic status and dates never differ between them.
const { zonedToday } = require('../radar');
const episodeMarks = require('./episodes');

const PROGRESS_STATUSES = ['Geplant', 'Schaue', 'Gesehen', 'Pausiert', 'Abgebrochen'];

const sqlNow = (ctx) => ctx.now().toISOString().replace('T', ' ').slice(0, 19);

function today(ctx) {
    const d = zonedToday(ctx.now(), ctx.config && ctx.config.appTimeZone);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const readProgress = (ctx, animeId, userId) => ctx.db.prepare('SELECT * FROM anime_progress WHERE anime_id = ? AND user_id = ?').get(animeId, userId);

/**
 * The watched episodes after a change as { now, next }: `now` the stored ones ({ episodes_watched, watched_episodes }, the
 * plain counter when the change sends `watched_episodes: null`), `next` the new ones or null when the change leaves them
 * alone. Order: the change's own marks or counter, then the episodes it rates, then a lowered counter.
 */
function watchedAfter(current, change, total, monotonic) {
    const now = change.watched_episodes === null
        ? { episodes_watched: current.episodes_watched, watched_episodes: null }
        : { episodes_watched: current.episodes_watched, watched_episodes: episodeMarks.parseMarks(current.watched_episodes) };
    const counter = change.episodes_watched === undefined ? undefined : (total !== null ? Math.min(change.episodes_watched, total) : change.episodes_watched);
    let next = null;
    let lowered = null;
    if (Array.isArray(change.watched_episodes)) {
        next = episodeMarks.fromMarks(episodeMarks.cleanMarks(change.watched_episodes, total));
    } else if (Array.isArray(change.add_episodes)) {
        const fresh = episodeMarks.cleanMarks(change.add_episodes, total).filter((n) => !episodeMarks.isWatched(now, n));
        if (fresh.length) next = episodeMarks.withEpisodes(now, fresh, total);
    } else if (counter !== undefined && monotonic && now.watched_episodes) {
        if (episodeMarks.watermark(now) < counter) next = episodeMarks.withThrough(now, counter);
    } else if (counter !== undefined && monotonic) {
        if (change.episodes_watched >= now.episodes_watched) next = { episodes_watched: change.episodes_watched, watched_episodes: null };
    } else if (counter !== undefined) {
        if (counter < now.episodes_watched) lowered = counter;
        else next = episodeMarks.withCount(now, counter);
    }
    const rated = change.episode_scores ? Object.keys(episodeMarks.cleanScores(change.episode_scores, total)).map(Number) : [];
    const unwatched = rated.filter((n) => !episodeMarks.isWatched(next || now, n));
    if (unwatched.length) next = episodeMarks.withEpisodes(next || now, unwatched, total);
    if (lowered !== null) next = episodeMarks.withCount(next || now, lowered);
    return { now, next };
}

// Writes one user's progress in the caller's transaction; returns the stored row, or null without the entry. Clamped to the
// episode count (reaching it means "Gesehen", above 0 "Geplant" becomes "Schaue"); `monotonic` never lowers it, a rise moves
// "Pausiert"/"Abgebrochen" to "Schaue". A counter change without a new resume_url drops the resume link.
// Watched episodes (core/anime/episodes.js): `watched_episodes` (array) sets them and with them the counter, `null` goes back
// to the plain counter; `add_episodes` (array) marks more episodes and never removes one (shared link and history sync on a
// row with marks); a monotonic counter means "watched up to N" and adds 1..N to the marks; any other counter change fills the
// lowest unwatched episodes or drops the highest marks. A rated episode is a watched one: the episodes `episode_scores` rates
// are marked (a lowered counter in the same change still wins), and ratings of episodes not watched afterwards are dropped.
// `episode_scores` (object episode -> 1..10) replaces the ratings, `null` removes them; above a known episode count dropped.
function writeProgress(ctx, animeId, userId, change, { monotonic = false } = {}) {
    const anime = ctx.db.prepare('SELECT id, episodes FROM animes WHERE id = ?').get(animeId);
    if (!anime) return null;
    const stored = readProgress(ctx, animeId, userId);
    const current = stored
        || { status: 'Geplant', episodes_watched: 0, score: null, notes: null, started_at: null, finished_at: null, resume_url: null, resume_episode: null,
            audio_language: null, subtitle_language: null, watched_episodes: null, episode_scores: null };
    const total = anime.episodes > 0 ? anime.episodes : null;
    const { now, next } = watchedAfter(current, change, total, monotonic);
    const watched = next ? next.episodes_watched : undefined;
    const day = today(ctx);
    let status = change.status ?? current.status;
    let episodes = watched ?? current.episodes_watched;
    if (total !== null && episodes > total) episodes = total;
    if (change.status === 'Gesehen' && total !== null) episodes = total;
    if (watched !== undefined && total !== null && episodes >= total && change.status === undefined) status = 'Gesehen';
    if (watched !== undefined && change.status === undefined && status === 'Geplant' && episodes > 0) status = 'Schaue';
    if (monotonic && change.status === undefined && episodes > current.episodes_watched && (status === 'Pausiert' || status === 'Abgebrochen')) status = 'Schaue';
    if (status === 'Geplant' && episodes > 0) {
        if (!monotonic && change.status === 'Geplant' && watched === undefined) episodes = 0;
        else status = 'Schaue';
    }
    if (watched !== undefined && change.status === undefined && status === 'Gesehen' && (total === null || episodes < total)) status = 'Schaue';
    const marks = episodeMarks.parseMarks((next || now).watched_episodes);
    const final = episodeMarks.withCount({ episodes_watched: episodes, watched_episodes: marks && episodeMarks.cleanMarks(marks, total) }, episodes);
    episodes = final.episodes_watched;
    const startedAt = status === 'Geplant' ? null : (current.started_at || (episodes > 0 ? day : null));
    const finishedAt = status === 'Gesehen' ? (current.status === 'Gesehen' && current.finished_at ? current.finished_at : day) : null;
    let resumeUrl = current.resume_url ?? null;
    let resumeEpisode = current.resume_episode ?? null;
    // a lower shared episode (monotonic) leaves the counter and with it the resume link alone
    if (change.resume_url !== undefined && (watched !== undefined || change.episodes_watched === undefined)) {
        resumeUrl = change.resume_url;
        resumeEpisode = change.resume_url ? (change.resume_episode ?? watched ?? null) : null;
    } else if (episodes !== current.episodes_watched) {
        resumeUrl = null;
        resumeEpisode = null;
    }
    const scores = episodeMarks.cleanScores(change.episode_scores === undefined ? episodeMarks.parseScores(current.episode_scores) : (change.episode_scores || {}), total);
    for (const key of Object.keys(scores)) if (!episodeMarks.isWatched(final, Number(key))) delete scores[key];
    const marksColumn = episodeMarks.storedMarks(final.watched_episodes);
    const scoresColumn = episodeMarks.storedScores(scores);
    const audio = change.audio_language === undefined ? current.audio_language ?? null : change.audio_language;
    const subtitle = change.subtitle_language === undefined ? current.subtitle_language ?? null : change.subtitle_language;
    ctx.db.prepare(`
        INSERT INTO anime_progress (anime_id, user_id, status, episodes_watched, score, notes, started_at, finished_at, updated_at, resume_url, resume_episode,
            audio_language, subtitle_language, watched_episodes, episode_scores)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (anime_id, user_id) DO UPDATE SET status = excluded.status, episodes_watched = excluded.episodes_watched,
            score = excluded.score, notes = excluded.notes, started_at = excluded.started_at, finished_at = excluded.finished_at,
            updated_at = excluded.updated_at, resume_url = excluded.resume_url, resume_episode = excluded.resume_episode,
            audio_language = excluded.audio_language, subtitle_language = excluded.subtitle_language,
            watched_episodes = excluded.watched_episodes, episode_scores = excluded.episode_scores
    `).run(animeId, userId, status, episodes, change.score === undefined ? current.score : change.score,
        change.notes === undefined ? current.notes : change.notes, startedAt, finishedAt, sqlNow(ctx), resumeUrl, resumeEpisode, audio, subtitle, marksColumn, scoresColumn);
    return readProgress(ctx, animeId, userId);
}

/** writeProgress in its own transaction. */
function saveProgress(ctx, animeId, userId, change, options = {}) {
    return ctx.db.transaction(() => writeProgress(ctx, animeId, userId, change, options));
}

module.exports = { writeProgress, saveProgress, readProgress, today, sqlNow, PROGRESS_STATUSES };
