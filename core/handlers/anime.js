// Anime tab (reports/spec-anime-tab.md C3): shared list, progress per user, search and refresh over the gateway
// (core/anime/gateway.js), adaptations of a series and the CSV export.
const { qstr } = require('../lib/query');
const { HttpError, badRequest, notFound, conflict } = require('../errors');
const { resolveTargetUser } = require('../lib/access');
const { zonedToday } = require('../radar');
const { escapeCell } = require('../csvExchange');
const gateway = require('../anime/gateway');
const store = require('../anime/store');
const { SourceError } = require('../anime/request');

const PROGRESS_STATUSES = ['Geplant', 'Schaue', 'Gesehen', 'Pausiert', 'Abgebrochen'];
const MAX_TITLE = 200;
const MAX_NOTES = 4000;
const MAX_EPISODES = 100000;

const nowMs = (ctx) => ctx.now().getTime();
const sqlNow = (ctx) => ctx.now().toISOString().replace('T', ' ').slice(0, 19);

function today(ctx) {
    const d = zonedToday(ctx.now(), ctx.config && ctx.config.appTimeZone);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseId(raw, label = 'ID') {
    const text = String(raw ?? '').trim();
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < 1) throw badRequest(`Ungültige ${label}`);
    return Number(text);
}

/** Optional positive integer id from a body (null/undefined -> null). */
function optionalId(value, label) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'number' && typeof value !== 'string') throw badRequest(`Ungültige ${label}`);
    return parseId(value, label);
}

function cleanTitle(value, { required = false } = {}) {
    if (value === undefined) {
        if (required) throw badRequest('Titel ist erforderlich (1 bis 200 Zeichen)');
        return undefined;
    }
    if (typeof value !== 'string' || !value.trim() || value.trim().length > MAX_TITLE) throw badRequest('Titel ist erforderlich (1 bis 200 Zeichen)');
    return value.trim();
}

function cleanOptionalText(value, label, max) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'string') throw badRequest(`Ungültiger Wert für ${label}`);
    const text = value.trim();
    if (text.length > max) throw badRequest(`${label} ist zu lang (höchstens ${max} Zeichen)`);
    return text || null;
}

function cleanEpisodes(value) {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    const n = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN);
    if (!Number.isInteger(n) || n < 0 || n > MAX_EPISODES) throw badRequest('Folgenzahl muss eine ganze Zahl ab 0 sein');
    return n;
}

function mangaRef(ctx, mangaId) {
    if (mangaId === null) return null;
    const manga = ctx.db.prepare('SELECT id, title FROM mangas WHERE id = ?').get(mangaId);
    if (!manga) throw notFound('Reihe');
    return manga;
}

const loadRow = (ctx, id) => {
    const row = ctx.db.prepare('SELECT * FROM animes WHERE id = ?').get(id);
    if (!row) throw notFound('Anime');
    return row;
};

/** Every user's progress of one entry, with usernames. */
const progressRows = (ctx, animeId) => ctx.db.prepare(`
    SELECT p.*, u.username FROM anime_progress p JOIN users u ON u.id = p.user_id
    WHERE p.anime_id = ? ORDER BY u.username COLLATE NOCASE
`).all(animeId);

/** The detail answer of GET /anime/:id (also returned by POST, PUT and refresh). */
function detailOf(ctx, id) {
    const row = loadRow(ctx, id);
    const entry = store.entryOf(row, nowMs(ctx));
    const relations = store.parseJson(row.relations, []);
    const byAni = ctx.db.prepare('SELECT id FROM animes WHERE anilist_id = ?');
    const byMal = ctx.db.prepare('SELECT id FROM animes WHERE mal_id = ?');
    const progress = progressRows(ctx, id);
    const mine = progress.find((p) => p.user_id === (ctx.user && ctx.user.id));
    return {
        ...entry,
        description: row.description,
        relations: relations.map((r) => ({
            ...r,
            in_collection_id: (r.anilist_id && byAni.get(r.anilist_id)?.id) || (r.mal_id && byMal.get(r.mal_id)?.id) || null
        })),
        manga: row.manga_id ? ctx.db.prepare('SELECT id, title FROM mangas WHERE id = ?').get(row.manga_id) || null : null,
        my_progress: store.progressOf(mine),
        progress: progress.map((p) => ({ ...store.progressOf(p), username: p.username }))
    };
}

async function search(ctx, { query }) {
    const q = (qstr(query.q) || '').trim();
    if (q.length < 2 || q.length > 100) throw badRequest('Suchbegriff muss 2 bis 100 Zeichen lang sein');
    const limit = Math.min(20, Math.max(1, parseInt(qstr(query.limit), 10) || 10));
    const result = await gateway.searchAnime(ctx, q, { limit });
    const byAni = ctx.db.prepare('SELECT id FROM animes WHERE anilist_id = ?');
    const byMal = ctx.db.prepare('SELECT id FROM animes WHERE mal_id = ?');
    return {
        body: {
            ...result,
            results: result.results.map((meta) => ({
                ...meta,
                in_collection_id: (meta.anilist_id && byAni.get(meta.anilist_id)?.id) || (meta.mal_id && byMal.get(meta.mal_id)?.id) || null
            }))
        }
    };
}

function sources(ctx) {
    return { body: gateway.sourcesState(ctx) };
}

/** The shared list with the caller's progress and everybody's progress in short; stale entries are refreshed in the background. */
function list(ctx) {
    const rows = ctx.db.prepare('SELECT * FROM animes ORDER BY title COLLATE NOCASE, id').all();
    const progress = ctx.db.prepare(`
        SELECT p.anime_id, p.user_id, p.status, p.episodes_watched, p.score, p.notes, p.started_at, p.finished_at, p.updated_at, u.username
        FROM anime_progress p JOIN users u ON u.id = p.user_id
        ORDER BY u.username COLLATE NOCASE
    `).all();
    const byAnime = new Map();
    for (const p of progress) {
        if (!byAnime.has(p.anime_id)) byAnime.set(p.anime_id, []);
        byAnime.get(p.anime_id).push(p);
    }
    const now = nowMs(ctx);
    const userId = ctx.user ? ctx.user.id : null;
    let queued = 0;
    const body = rows.map((row) => {
        const entry = store.entryOf(row, now);
        if (entry.stale && queued < 50 && gateway.scheduleRefresh(ctx, row.id)) queued++;
        const all = byAnime.get(row.id) || [];
        const mine = all.find((p) => p.user_id === userId);
        return {
            ...entry,
            my_progress: store.progressOf(mine),
            progress_users: all.map((p) => ({ user_id: p.user_id, username: p.username, status: p.status, episodes_watched: p.episodes_watched }))
        };
    });
    return { body };
}

function detail(ctx, { params }) {
    const id = parseId(params.id);
    const row = loadRow(ctx, id);
    if (store.isStale(row, nowMs(ctx))) gateway.scheduleRefresh(ctx, id);
    return { body: detailOf(ctx, id) };
}

function duplicateOf(ctx, anilistId, malId) {
    if (anilistId) {
        const row = ctx.db.prepare('SELECT id FROM animes WHERE anilist_id = ?').get(anilistId);
        if (row) return row.id;
    }
    if (malId) {
        const row = ctx.db.prepare('SELECT id FROM animes WHERE mal_id = ?').get(malId);
        if (row) return row.id;
    }
    return null;
}

const ALREADY_THERE = 'Dieser Anime ist schon in der Liste';

/** From a search hit (anilist_id and/or mal_id, fetched interactively) or a manual entry (title, episodes). */
async function create(ctx, { body }) {
    const anilistId = optionalId(body.anilist_id, 'AniList-ID');
    const malId = optionalId(body.mal_id, 'MAL-ID');
    const mangaId = optionalId(body.manga_id, 'Reihen-ID');
    if (mangaId !== null) mangaRef(ctx, mangaId);
    const existing = duplicateOf(ctx, anilistId, malId);
    if (existing) throw conflict(ALREADY_THERE, 'DUPLICATE', { id: existing });

    if (!anilistId && !malId) {
        const title = cleanTitle(body.title, { required: true });
        const episodes = cleanEpisodes(body.episodes);
        const result = ctx.db.prepare(`
            INSERT INTO animes (title, episodes, manga_id, notes, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        `).run(title, episodes ?? null, mangaId, cleanOptionalText(body.notes, 'Notiz', MAX_NOTES) ?? null, ctx.user.id, sqlNow(ctx));
        return { status: 201, body: detailOf(ctx, Number(result.lastInsertRowid)) };
    }

    let meta;
    try {
        meta = await gateway.getAnime(ctx, { anilist_id: anilistId, mal_id: malId }, { priority: 'interactive' });
    } catch (err) {
        if (err instanceof SourceError) {
            throw new HttpError(503, 'AniList und MyAnimeList sind gerade nicht erreichbar. Bitte später erneut versuchen.', 'SOURCES_UNAVAILABLE');
        }
        throw err;
    }
    if (!meta) throw notFound('Anime bei AniList/MyAnimeList');
    const images = await store.freshImages(ctx, meta);
    const title = cleanTitle(body.title);
    const id = ctx.db.transaction(() => {
        const again = duplicateOf(ctx, meta.anilist_id, meta.mal_id);
        if (again) return { duplicate: again };
        return { id: store.insertFromMeta(ctx, meta, images, { manga_id: mangaId, title }) };
    });
    if (id.duplicate) throw conflict(ALREADY_THERE, 'DUPLICATE', { id: id.duplicate });
    gateway.scheduleIdResolution(ctx, id.id);
    return { status: 201, body: detailOf(ctx, id.id) };
}

function update(ctx, { params, body }) {
    const id = parseId(params.id);
    const row = loadRow(ctx, id);
    const columns = {};
    const title = cleanTitle(body.title);
    if (title !== undefined) columns.title = title;
    const titleDe = cleanOptionalText(body.title_de, 'Deutscher Titel', MAX_TITLE);
    if (titleDe !== undefined) columns.title_de = titleDe;
    const notes = cleanOptionalText(body.notes, 'Notiz', MAX_NOTES);
    if (notes !== undefined) columns.notes = notes;
    if (body.manga_id !== undefined) {
        const mangaId = optionalId(body.manga_id, 'Reihen-ID');
        mangaRef(ctx, mangaId);
        columns.manga_id = mangaId;
    }
    if (body.episodes !== undefined) {
        if (row.anilist_id || row.mal_id) throw badRequest('Die Folgenzahl kommt von AniList/MyAnimeList und lässt sich nur bei manuellen Einträgen ändern');
        columns.episodes = cleanEpisodes(body.episodes);
    }
    if (!Object.keys(columns).length) throw badRequest('Keine Änderungen angegeben');
    columns.updated_at = sqlNow(ctx);
    columns.updated_by = ctx.user.id;
    store.updateRow(ctx, id, columns);
    return { body: detailOf(ctx, id) };
}

function parseScore(value) {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    const n = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw badRequest('Bewertung muss eine ganze Zahl von 1 bis 10 sein');
    return n;
}

/**
 * Own progress (admins may pass user_id). The counter is clamped to a known episode count; reaching it means
 * "Gesehen" (finished today), "Gesehen" fills the counter, the first episode sets started_at, and a counter above 0
 * moves "Geplant" to "Schaue".
 */
function updateProgress(ctx, { params, body }) {
    const id = parseId(params.id);
    const userId = resolveTargetUser(ctx, body.user_id);
    if (body.status !== undefined && !PROGRESS_STATUSES.includes(body.status)) {
        throw badRequest(`Ungültiger Status (erlaubt: ${PROGRESS_STATUSES.join(', ')})`);
    }
    let watched;
    if (body.episodes_watched !== undefined) {
        const v = body.episodes_watched;
        watched = typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN);
        if (!Number.isInteger(watched) || watched < 0 || watched > MAX_EPISODES) throw badRequest('Gesehene Folgen müssen eine ganze Zahl ab 0 sein');
    }
    const score = parseScore(body.score);
    const notes = cleanOptionalText(body.notes, 'Notiz', MAX_NOTES);
    const day = today(ctx);
    const saved = ctx.db.transaction(() => {
        const anime = loadRow(ctx, id);
        const current = ctx.db.prepare('SELECT * FROM anime_progress WHERE anime_id = ? AND user_id = ?').get(id, userId)
            || { status: 'Geplant', episodes_watched: 0, score: null, notes: null, started_at: null, finished_at: null };
        const total = anime.episodes > 0 ? anime.episodes : null;
        let status = body.status ?? current.status;
        let episodes = watched ?? current.episodes_watched;
        if (total !== null && episodes > total) episodes = total;
        if (body.status === 'Gesehen' && total !== null) episodes = total;
        if (watched !== undefined && total !== null && episodes >= total && body.status === undefined) status = 'Gesehen';
        if (watched !== undefined && body.status === undefined && status === 'Geplant' && episodes > 0) status = 'Schaue';
        const startedAt = current.started_at || (episodes > 0 ? day : null);
        const finishedAt = status === 'Gesehen' ? (current.status === 'Gesehen' && current.finished_at ? current.finished_at : day) : current.finished_at;
        ctx.db.prepare(`
            INSERT INTO anime_progress (anime_id, user_id, status, episodes_watched, score, notes, started_at, finished_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (anime_id, user_id) DO UPDATE SET status = excluded.status, episodes_watched = excluded.episodes_watched,
                score = excluded.score, notes = excluded.notes, started_at = excluded.started_at, finished_at = excluded.finished_at,
                updated_at = excluded.updated_at
        `).run(id, userId, status, episodes, score === undefined ? current.score : score, notes === undefined ? current.notes : notes,
            startedAt, finishedAt, sqlNow(ctx));
        return ctx.db.prepare('SELECT * FROM anime_progress WHERE anime_id = ? AND user_id = ?').get(id, userId);
    });
    return { body: store.progressOf(saved) };
}

function removeProgress(ctx, { params, body }) {
    const id = parseId(params.id);
    loadRow(ctx, id);
    const userId = resolveTargetUser(ctx, body && body.user_id);
    const removed = ctx.db.prepare('DELETE FROM anime_progress WHERE anime_id = ? AND user_id = ?').run(id, userId).changes > 0;
    return { body: { success: true, removed } };
}

async function refresh(ctx, { params }) {
    const id = parseId(params.id);
    const row = loadRow(ctx, id);
    if (!row.anilist_id && !row.mal_id) throw badRequest('Manuelle Einträge ohne AniList-/MAL-ID lassen sich nicht aktualisieren');
    const found = await gateway.manualRefresh(ctx, id);
    return { body: { ...detailOf(ctx, id), refreshed: found } };
}

function remove(ctx, { params }) {
    const id = parseId(params.id);
    const changes = ctx.db.prepare('DELETE FROM animes WHERE id = ?').run(id).changes;
    if (!changes) throw notFound('Anime');
    return { body: { success: true } };
}

async function adaptations(ctx, { params }) {
    const id = parseId(params.id);
    const manga = ctx.db.prepare('SELECT id, title, alt_title FROM mangas WHERE id = ?').get(id);
    if (!manga) throw notFound('Reihe');
    return { body: await gateway.adaptationsOf(ctx, manga) };
}

const CSV_COLUMNS = [
    ['title', 'Titel'], ['title_de', 'Deutscher Titel'], ['anilist_id', 'AniList-ID'], ['mal_id', 'MAL-ID'], ['format', 'Format'],
    ['episodes', 'Folgen'], ['status', 'Status'], ['season_year', 'Jahr'], ['studios', 'Studios'], ['genres', 'Genres'],
    ['my_status', 'Mein Status'], ['my_episodes', 'Gesehene Folgen'], ['my_score', 'Bewertung'], ['notes', 'Notizen']
];

/** Semicolon CSV with BOM and the formula guard of the collection export; progress columns are the caller's. */
function exportCsv(ctx) {
    const rows = ctx.db.prepare(`
        SELECT a.*, p.status AS my_status, p.episodes_watched AS my_episodes, p.score AS my_score,
               TRIM(COALESCE(a.notes, '') || CASE WHEN p.notes IS NOT NULL AND a.notes IS NOT NULL THEN char(10) ELSE '' END || COALESCE(p.notes, '')) AS all_notes
        FROM animes a LEFT JOIN anime_progress p ON p.anime_id = a.id AND p.user_id = ?
        ORDER BY a.title COLLATE NOCASE, a.id
    `).all(ctx.user.id);
    const lines = [CSV_COLUMNS.map((c) => c[1]).join(';')];
    for (const row of rows) {
        const values = { ...row, notes: row.all_notes || null };
        lines.push(CSV_COLUMNS.map(([key]) => escapeCell(values[key])).join(';'));
    }
    return {
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="manga-shelf-anime-${ctx.now().toISOString().slice(0, 10)}.csv"`
        },
        body: '﻿' + lines.join('\r\n') + '\r\n'
    };
}

module.exports = {
    search, sources, list, detail, create, update, updateProgress, removeProgress, refresh, remove, adaptations, exportCsv,
    PROGRESS_STATUSES
};
