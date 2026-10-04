// The animes table: snapshot from AnimeMeta, cover download into the uploads (only when the source URL changed) and
// the answer shapes of the list and the detail.
const { fetchImage } = require('../lib/imageCheck');
const { nextCheckAt, preferredTitle } = require('./normalize');

const parseJson = (text, fallback) => {
    if (!text) return fallback;
    try { return JSON.parse(text); } catch (_) { return fallback; }
};
const splitList = (text) => (text ? String(text).split(',').map((s) => s.trim()).filter(Boolean) : []);
const joinList = (list) => (Array.isArray(list) && list.length ? list.join(', ') : null);

/** Snapshot columns of an AnimeMeta (not title/notes/manga_id, which belong to the user). */
function snapshotColumns(meta, nowMs) {
    const next = meta.next_airing;
    return {
        title_romaji: meta.title.romaji,
        title_english: meta.title.english,
        title_native: meta.title.native,
        format: meta.format,
        episodes: meta.episodes,
        duration: meta.duration,
        status: meta.status,
        season: meta.season,
        season_year: meta.season_year,
        start_date: meta.start_date,
        end_date: meta.end_date,
        studios: joinList(meta.studios),
        genres: joinList(meta.genres),
        score: meta.score,
        description: meta.description,
        next_airing_episode: next ? next.episode : null,
        next_airing_at: next ? next.at : null,
        next_airing_estimated: next && meta.next_airing_estimated ? 1 : 0,
        relations: JSON.stringify(meta.relations || []),
        urls: JSON.stringify(meta.urls || {}),
        meta_source: meta.source,
        meta_fetched_at: nowMs,
        next_check_at: nextCheckAt(meta, nowMs)
    };
}

/** Downloads an image into the uploads; resolves with '/uploads/<name>' or null (the caller keeps the remote URL). */
async function downloadImage(ctx, url) {
    if (!url) return null;
    try {
        const image = await fetchImage(ctx, url);
        const name = ctx.randomId() + image.ext;
        await ctx.files.write(name, image.buffer, { image: image.ext });
        return ctx.files.url(name);
    } catch (err) {
        ctx.log.child('anime').warn(`Cover download failed (${url}):`, err && err.message);
        return null;
    }
}

/**
 * Local copies of cover and banner when their source URL is new: { cover_image, cover_source, banner_image,
 * banner_source } with only the changed ones set. Network only, no database.
 */
async function freshImages(ctx, meta, row = null) {
    const out = {};
    for (const [field, url] of [['cover', meta.cover_url], ['banner', meta.banner_url]]) {
        if (!url || (row && row[`${field}_source`] === url && row[`${field}_image`])) continue;
        const local = await downloadImage(ctx, url);
        out[`${field}_image`] = local || url;
        out[`${field}_source`] = url;
    }
    return out;
}

function updateRow(ctx, id, columns) {
    const keys = Object.keys(columns);
    if (!keys.length) return;
    ctx.db.prepare(`UPDATE animes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => columns[k]), id);
}

// a partial snapshot (AniList id batches) never clears what the full answer stored
const KEEP_WHEN_EMPTY = ['description', 'relations', 'title_english', 'studios', 'genres'];
const emptyColumn = (value) => value === null || value === undefined || value === '' || value === '[]';

/**
 * Writes a fresh snapshot (synchronous, call it after the network part). The display title follows the source only
 * while the user has not changed it; ids are added when missing and not taken by another entry. `partial`: the meta
 * comes from a background batch, so empty description, relations, English title, studios and genres keep the stored
 * values.
 */
function applySnapshot(ctx, id, meta, images = {}, { partial = false } = {}) {
    const row = ctx.db.prepare('SELECT * FROM animes WHERE id = ?').get(id);
    if (!row) return false;
    const nowMs = ctx.now().getTime();
    const columns = { ...snapshotColumns(meta, nowMs), ...images };
    if (partial) {
        for (const key of KEEP_WHEN_EMPTY) if (emptyColumn(columns[key]) && !emptyColumn(row[key])) delete columns[key];
    }
    const autoTitle = preferredTitle({ english: row.title_english, romaji: row.title_romaji, native: row.title_native });
    const nextTitle = preferredTitle({
        english: 'title_english' in columns ? columns.title_english : row.title_english,
        romaji: columns.title_romaji,
        native: columns.title_native
    });
    if (!autoTitle || row.title === autoTitle) columns.title = nextTitle || row.title;
    for (const key of ['anilist_id', 'mal_id']) {
        if (row[key] || !meta[key]) continue;
        if (!ctx.db.prepare(`SELECT 1 FROM animes WHERE ${key} = ? AND id != ?`).get(meta[key], id)) columns[key] = meta[key];
    }
    updateRow(ctx, id, columns);
    return true;
}

function insertFromMeta(ctx, meta, images, { manga_id = null, title = null } = {}) {
    const nowMs = ctx.now().getTime();
    const columns = {
        ...snapshotColumns(meta, nowMs),
        ...images,
        anilist_id: meta.anilist_id,
        mal_id: meta.mal_id,
        title: title || meta.title.preferred || 'Ohne Titel',
        manga_id,
        updated_by: ctx.user ? ctx.user.id : null,
        updated_at: new Date(nowMs).toISOString().replace('T', ' ').slice(0, 19)
    };
    if (!images.cover_image && meta.cover_url) columns.cover_image = meta.cover_url;
    if (!images.banner_image && meta.banner_url) columns.banner_image = meta.banner_url;
    const keys = Object.keys(columns);
    const result = ctx.db.prepare(`INSERT INTO animes (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => columns[k]));
    return Number(result.lastInsertRowid);
}

const isStale = (row, nowMs) => Boolean((row.anilist_id || row.mal_id) && row.next_check_at && row.next_check_at <= nowMs);

/** Shape of an entry in GET /anime (detail adds description, relations and progress). */
function entryOf(row, nowMs) {
    return {
        id: row.id,
        anilist_id: row.anilist_id,
        mal_id: row.mal_id,
        title: row.title,
        title_de: row.title_de,
        title_romaji: row.title_romaji,
        title_english: row.title_english,
        title_native: row.title_native,
        format: row.format,
        episodes: row.episodes,
        duration: row.duration,
        status: row.status,
        season: row.season,
        season_year: row.season_year,
        start_date: row.start_date,
        end_date: row.end_date,
        studios: splitList(row.studios),
        genres: splitList(row.genres),
        score: row.score,
        cover_image: row.cover_image,
        banner_image: row.banner_image,
        next_airing: row.next_airing_at ? { episode: row.next_airing_episode, at: row.next_airing_at, estimated: Boolean(row.next_airing_estimated) } : null,
        manga_id: row.manga_id,
        urls: parseJson(row.urls, {}),
        notes: row.notes,
        manual: !row.anilist_id && !row.mal_id,
        meta_source: row.meta_source,
        meta_fetched_at: row.meta_fetched_at,
        stale: isStale(row, nowMs),
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

const progressOf = (row) => (row ? {
    user_id: row.user_id,
    status: row.status,
    episodes_watched: row.episodes_watched,
    score: row.score,
    notes: row.notes,
    started_at: row.started_at,
    finished_at: row.finished_at,
    updated_at: row.updated_at
} : null);

module.exports = {
    snapshotColumns, downloadImage, freshImages, applySnapshot, insertFromMeta, updateRow, entryOf, progressOf, isStale, parseJson, splitList, joinList
};
