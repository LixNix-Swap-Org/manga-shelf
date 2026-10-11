// The one progress rule of the anime tab: PUT progress, "Folge gesehen" from a shared link and the AniList pull all
// write through writeProgress, so clamping, automatic status and dates never differ between them.
const { zonedToday } = require('../radar');
const episodeMarks = require('./episodes');

const PROGRESS_STATUSES = ['Geplant', 'Schaue', 'Gesehen', 'Pausiert', 'Abgebrochen'];

const sqlNow = (ctx) => ctx.now().toISOString().replace('T', ' ').slice(0, 19);

function today(ctx) {
    const d = zonedToday(ctx.now(), ctx.config && ctx.config.appTimeZone);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const readProgress = (ctx, animeId, userId) => ctx.db.prepare('SELECT * FROM anime_progress WHERE anime_id = ? AND user_id = ?').get(animeId, userId);

// Writes one user's progress in the caller's transaction; returns the stored row, or null without the entry. Clamped to the
// episode count (reaching it means "Gesehen", above 0 "Geplant" becomes "Schaue"); `monotonic` never lowers it, a rise moves
// "Pausiert"/"Abgebrochen" to "Schaue". A counter change without a new resume_url drops the resume link.
// `watched_episodes` (array) sets the single watched episodes and with them the counter; `null` drops them back to the plain
// counter. A monotonic counter (link, history sync, AniList) adds 1..N to existing marks; any other counter change fills the
// lowest unwatched episodes or drops the highest marks (core/anime/episodes.js).
function writeProgress(ctx, animeId, userId, change, { monotonic = false } = {}) {
    const anime = ctx.db.prepare('SELECT id, episodes FROM animes WHERE id = ?').get(animeId);
    if (!anime) return null;
    const stored = readProgress(ctx, animeId, userId);
    const current = stored
        || { status: 'Geplant', episodes_watched: 0, score: null, notes: null, started_at: null, finished_at: null, resume_url: null, resume_episode: null,
            audio_language: null, subtitle_language: null, watched_episodes: null };
    const total = anime.episodes > 0 ? anime.episodes : null;
    const currentMarks = episodeMarks.parseMarks(current.watched_episodes);
    let watched = change.episodes_watched;
    let marks = null;
    if (Array.isArray(change.watched_episodes)) {
        marks = episodeMarks.cleanMarks(change.watched_episodes, total);
        watched = marks.length;
    } else if (monotonic && watched !== undefined && currentMarks) {
        marks = episodeMarks.throughEpisode(currentMarks, total !== null ? Math.min(watched, total) : watched);
        watched = marks.length;
    }
    if (monotonic && watched !== undefined && watched < current.episodes_watched) {
        watched = undefined;
        marks = null;
    }
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
    const marked = change.watched_episodes === null ? null : (marks || currentMarks);
    const marksColumn = marked ? episodeMarks.storedMarks(episodeMarks.fitMarks(episodeMarks.cleanMarks(marked, total), episodes)) : null;
    const audio = change.audio_language === undefined ? current.audio_language ?? null : change.audio_language;
    const subtitle = change.subtitle_language === undefined ? current.subtitle_language ?? null : change.subtitle_language;
    ctx.db.prepare(`
        INSERT INTO anime_progress (anime_id, user_id, status, episodes_watched, score, notes, started_at, finished_at, updated_at, resume_url, resume_episode,
            audio_language, subtitle_language, watched_episodes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (anime_id, user_id) DO UPDATE SET status = excluded.status, episodes_watched = excluded.episodes_watched,
            score = excluded.score, notes = excluded.notes, started_at = excluded.started_at, finished_at = excluded.finished_at,
            updated_at = excluded.updated_at, resume_url = excluded.resume_url, resume_episode = excluded.resume_episode,
            audio_language = excluded.audio_language, subtitle_language = excluded.subtitle_language,
            watched_episodes = excluded.watched_episodes
    `).run(animeId, userId, status, episodes, change.score === undefined ? current.score : change.score,
        change.notes === undefined ? current.notes : change.notes, startedAt, finishedAt, sqlNow(ctx), resumeUrl, resumeEpisode, audio, subtitle, marksColumn);
    return readProgress(ctx, animeId, userId);
}

/** writeProgress in its own transaction. */
function saveProgress(ctx, animeId, userId, change, options = {}) {
    return ctx.db.transaction(() => writeProgress(ctx, animeId, userId, change, options));
}

module.exports = { writeProgress, saveProgress, readProgress, today, sqlNow, PROGRESS_STATUSES };
