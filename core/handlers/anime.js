// Anime tab: shared list, progress per user, search and refresh over the gateway
// (core/anime/gateway.js), adaptations of a series, the CSV export, shared streaming links and the AniList list sync.
const { qstr } = require('../lib/query');
const { HttpError, badRequest, notFound, conflict } = require('../errors');
const { resolveTargetUser } = require('../lib/access');
const { escapeCell } = require('../csvExchange');
const gateway = require('../anime/gateway');
const store = require('../anime/store');
const listSync = require('../anime/listSync');
const { writeProgress, readProgress, sqlNow, PROGRESS_STATUSES } = require('../anime/progress');
const { SourceError } = require('../anime/request');
const links = require('../watch/links');
const { seasonLinkOf, MAX_SEASON } = require('../watch/crunchyroll');
const { titleScore } = require('../anime/normalize');

const MAX_TITLE = 200;
const MAX_NOTES = 4000;
const MAX_EPISODES = 100000;

const nowMs = (ctx) => ctx.now().getTime();

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

const SERIES_SERVICE = links.SERVICES[0].id;

/** Remembered series links of one service by anime id. */
function rememberedLinks(ctx, animeId = null) {
    const rows = animeId === null
        ? ctx.db.prepare('SELECT anime_id, url FROM anime_links WHERE service = ?').all(SERIES_SERVICE)
        : ctx.db.prepare('SELECT anime_id, url FROM anime_links WHERE service = ? AND anime_id = ?').all(SERIES_SERVICE, animeId);
    return new Map(rows.map((r) => [r.anime_id, r.url]));
}

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
        ...store.linksOf(row),
        watch: store.watchOf(row, mine, rememberedLinks(ctx, id).get(id)),
        description: row.description,
        relations: relations.map((r) => ({
            ...r,
            in_collection_id: (r.anilist_id && byAni.get(r.anilist_id)?.id) || (r.mal_id && byMal.get(r.mal_id)?.id) || null
        })),
        manga: row.manga_id ? ctx.db.prepare('SELECT id, title FROM mangas WHERE id = ?').get(row.manga_id) || null : null,
        my_progress: store.progressOf(mine),
        // a resume link is where one user stopped watching; the others only see the counter
        progress: progress.map((p) => (p === mine
            ? { ...store.progressOf(p), username: p.username }
            : { ...store.progressOf(p), resume_url: null, resume_episode: null, username: p.username }))
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
        SELECT p.anime_id, p.user_id, p.status, p.episodes_watched, p.score, p.notes, p.started_at, p.finished_at, p.updated_at,
               p.resume_url, p.resume_episode, u.username
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
    const remembered = rememberedLinks(ctx);
    let queued = 0;
    const body = rows.map((row) => {
        const entry = store.entryOf(row, now);
        if (entry.stale && queued < 50 && gateway.scheduleRefresh(ctx, row.id)) queued++;
        const all = byAnime.get(row.id) || [];
        const mine = all.find((p) => p.user_id === userId);
        return {
            ...entry,
            watch: store.watchOf(row, mine, remembered.get(row.id)),
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
 * Own progress (admins may pass user_id), by the rule of core/anime/progress.js; may lower the counter. The caller's own
 * change goes to their AniList list when the sync is on.
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
    const saved = ctx.db.transaction(() => {
        loadRow(ctx, id);
        return writeProgress(ctx, id, userId, { status: body.status, episodes_watched: watched, score, notes });
    });
    listSync.schedulePush(ctx, userId, id);
    return { body: store.progressOf(saved) };
}

function cleanEpisode(value) {
    const n = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN);
    if (!Number.isInteger(n) || n < 1 || n > MAX_EPISODES) throw badRequest('Folge muss eine ganze Zahl ab 1 sein');
    return n;
}

const unsupportedLink = () => new HttpError(400, 'Das ist kein Crunchyroll-Link.', 'UNSUPPORTED_LINK');

function cleanRemember(value) {
    if (value === undefined || value === null) return null;
    const service = value && typeof value === 'object' ? links.findService(value.service) : null;
    const externalId = service && typeof value.external_id === 'string' ? value.external_id.trim() : '';
    const season = value && value.season !== undefined && value.season !== null ? value.season : null;
    if (!service || !/^[A-Za-z0-9_-]{1,100}$/.test(externalId)) throw badRequest('Ungültige Verknüpfung (remember)');
    if (season !== null && !(Number.isInteger(season) && season >= 1 && season <= MAX_SEASON)) throw badRequest('Ungültige Staffel (remember)');
    return { service, externalId: externalId.toUpperCase(), season };
}

/**
 * Links one season of a streaming series to this entry only (the history sync maps by it); the user's choice moves that
 * season from another entry. The entry keeps its links to other seasons (long-running shows span several).
 */
function rememberSeason(ctx, animeId, remember) {
    const link = seasonLinkOf(remember.service.id, remember.externalId, remember.season);
    ctx.db.prepare('DELETE FROM anime_links WHERE service = ? AND external_id = ? AND anime_id <> ?').run(link.service, link.external_id, animeId);
    ctx.db.prepare(`
        INSERT INTO anime_links (anime_id, service, external_id, url) VALUES (?, ?, ?, NULL)
        ON CONFLICT (anime_id, service) DO UPDATE SET external_id = excluded.external_id, url = NULL
    `).run(animeId, link.service, link.external_id);
}

const episodeAboveTotal = (episode, total) => badRequest(
    `Folge ${episode} gibt es bei diesem Eintrag nicht (er hat nur ${total === 1 ? 'eine Folge' : `${total} Folgen`}).`, 'EPISODE_ABOVE_TOTAL', { episodes: total }
);

/**
 * "Folge N gesehen" from a shared link, always for the caller: the counter never goes down, the canonical episode link
 * becomes the resume link, `remember` stores the series link of the entry in the same transaction. An episode above a
 * known total needs `complete: true` (later seasons are often numbered on from the first one). Answers the progress
 * before the write as `previous` (null without a row), so the undo never depends on the client's copy of the list.
 */
function markWatched(ctx, { params, body }) {
    const id = parseId(params.id);
    const episode = cleanEpisode(body.episode);
    let url = null;
    if (body.url !== undefined && body.url !== null && body.url !== '') {
        const link = typeof body.url === 'string' ? links.linkOf(body.url.trim()) : null;
        if (!link || (link.kind !== 'episode' && link.kind !== 'legacy')) throw unsupportedLink();
        url = link.url;
    }
    const remember = cleanRemember(body.remember);
    const complete = body.complete === true;
    const userId = ctx.user.id;
    const { saved, previous, total } = ctx.db.transaction(() => {
        const anime = loadRow(ctx, id);
        if (anime.episodes > 0 && episode > anime.episodes && !complete) throw episodeAboveTotal(episode, anime.episodes);
        const before = readProgress(ctx, id, userId) || null;
        const change = url ? { episodes_watched: episode, resume_url: url, resume_episode: episode } : { episodes_watched: episode };
        const row = writeProgress(ctx, id, userId, change, { monotonic: true });
        if (remember) {
            ctx.db.prepare(`
                INSERT INTO anime_links (anime_id, service, external_id, url) VALUES (?, ?, ?, ?)
                ON CONFLICT (anime_id, service) DO UPDATE SET external_id = excluded.external_id, url = excluded.url
            `).run(id, remember.service.id, remember.externalId, remember.service.seriesUrl(remember.externalId));
            if (remember.season) rememberSeason(ctx, id, remember);
        }
        return { saved: row, previous: before, total: anime.episodes ?? null };
    });
    listSync.schedulePush(ctx, userId, id);
    return { body: { anime_id: id, progress: store.progressOf(saved), previous: store.progressOf(previous), entry_episodes: total } };
}

const PAGE_TIMEOUT_MS = 6000;
const MAX_SHARE_TEXT = 4000;
const MAX_CANDIDATES = 5;

/** Among entries sharing a link: the one the caller is watching, else the one whose episode range fits, else none. */
function preferred(entries, episode) {
    const watching = entries.filter((e) => e.my_status === 'Schaue');
    if (watching.length === 1) return watching[0];
    const pool = watching.length ? watching : entries;
    const fitting = episode ? pool.filter((e) => e.episodes && episode <= e.episodes && (e.my_episodes || 0) < episode) : [];
    return fitting.length === 1 ? fitting[0] : null;
}

/** The caller's view of the shared list for matching: [{ id, title, titles, episodes, my_status, my_episodes, external_links }]. */
function matchRows(ctx) {
    return ctx.db.prepare(`
        SELECT a.id, a.title, a.title_de, a.title_romaji, a.title_english, a.title_native, a.episodes, a.external_links,
               p.status AS my_status, p.episodes_watched AS my_episodes
        FROM animes a LEFT JOIN anime_progress p ON p.anime_id = a.id AND p.user_id = ?
        ORDER BY a.title COLLATE NOCASE, a.id
    `).all(ctx.user.id);
}

const candidateOf = (row, score) => ({
    id: row.id, title: row.title, score: Math.round(score * 100) / 100, episodes: row.episodes,
    my_status: row.my_status || null, my_episodes: row.my_status ? row.my_episodes : null
});

/** The matched entry with the caller's progress: { id, title, episodes, my_status, my_episodes } or null. */
function matchedEntry(ctx, animeId) {
    if (!animeId) return null;
    const row = ctx.db.prepare(`
        SELECT a.id, a.title, a.episodes, p.status AS my_status, p.episodes_watched AS my_episodes
        FROM animes a LEFT JOIN anime_progress p ON p.anime_id = a.id AND p.user_id = ? WHERE a.id = ?
    `).get(ctx.user.id, animeId);
    return row ? { id: row.id, title: row.title, episodes: row.episodes, my_status: row.my_status || null, my_episodes: row.my_status ? row.my_episodes : null } : null;
}

/** Path of an allowlisted link without locale prefix and trailing slash, lower case; null for any other URL. */
function servicePath(url) {
    if (typeof url !== 'string' || !links.isAllowedUrl(url)) return null;
    return new URL(url).pathname.toLowerCase().replace(/\/+$/, '').replace(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/[^/])/, '');
}

/** Entry for a series id, an old-style series slug or a title: { anime_id, match, candidates }. */
function matchAnime(ctx, { service, seriesId, seriesSlug, seriesTitle, episode }) {
    const rows = matchRows(ctx);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const decideAmong = (found, match) => {
        const list = found.map((r) => candidateOf(r, 1));
        if (list.length === 1) return { anime_id: list[0].id, match, candidates: [] };
        const pick = preferred(list, episode);
        return { anime_id: pick ? pick.id : null, match: pick ? match : null, candidates: pick ? [pick, ...list.filter((c) => c !== pick)] : list };
    };
    if (seriesId) {
        const linked = ctx.db.prepare('SELECT anime_id FROM anime_links WHERE service = ? AND external_id = ? ORDER BY anime_id')
            .all(service.id, seriesId).map((r) => byId.get(r.anime_id)).filter(Boolean);
        if (linked.length) return decideAmong(linked, 'link');
    }
    // AniList lists Crunchyroll as /series/<id>/<slug> or, for older shows, as /<series-slug>
    const needle = seriesId ? `/series/${seriesId.toLowerCase()}` : null;
    const slugPath = seriesSlug ? `/${seriesSlug.toLowerCase()}` : null;
    if (needle || slugPath) {
        const listed = rows.filter((r) => store.parseJson(r.external_links, []).some((l) => {
            const path = l ? servicePath(l.url) : null;
            return path !== null && ((needle && (path === needle || path.startsWith(`${needle}/`))) || (slugPath && path === slugPath));
        }));
        if (listed.length) return decideAmong(listed, 'external_links');
    }
    if (!seriesTitle) return { anime_id: null, match: null, candidates: [] };
    const scored = rows
        .map((r) => ({ row: r, score: titleScore(seriesTitle, [r.title, r.title_de, r.title_romaji, r.title_english, r.title_native].filter(Boolean)) }))
        .filter((x) => x.score >= 0.5)
        .sort((a, b) => b.score - a.score || Number(Boolean(b.row.my_status)) - Number(Boolean(a.row.my_status)));
    const candidates = scored.slice(0, MAX_CANDIDATES).map((x) => candidateOf(x.row, x.score));
    // the caller's own entries first: a clear hit there wins over a better-sounding entry nobody watches
    for (const pool of [scored.filter((x) => x.row.my_status), scored]) {
        const high = pool.filter((x) => x.score >= 0.9).map((x) => candidateOf(x.row, x.score));
        const pick = high.length === 1 ? high[0] : preferred(high, episode);
        if (pick) return { anime_id: pick.id, match: 'title', candidates: high.length > 1 ? [pick, ...high.filter((c) => c !== pick)] : [] };
    }
    return { anime_id: null, match: null, candidates };
}

/**
 * What a shared streaming link points at: service, series, episode and the caller's entry. Read-only. The page is only
 * fetched (host allowlist, no redirects) when the link and the share text leave the episode or the series open; every
 * page failure means "unknown" (page_checked false).
 */
async function resolveLink(ctx, { body }) {
    const link = typeof body.url === 'string' ? links.detectLink(body.url.trim()) : null;
    if (!link) throw unsupportedLink();
    if (body.text !== undefined && body.text !== null && typeof body.text !== 'string') throw badRequest('Ungültiger Text');
    const text = typeof body.text === 'string' ? body.text.slice(0, MAX_SHARE_TEXT) : '';
    const service = links.findService(link.service);
    let episode = link.episodeHint;
    let episodeSource = episode ? 'slug' : null;
    if (!episode && text && link.kind !== 'series') {
        episode = links.episodeFromText(text);
        if (episode) episodeSource = 'text';
    }
    let seriesId = link.kind === 'series' ? link.id : null;
    let seriesTitle = link.kind === 'series' ? links.titleFromSlug(link.slug) : link.kind === 'legacy' ? links.titleFromSlug(link.seriesSlug) : null;
    if (!seriesTitle && text) seriesTitle = links.seriesTitleFromText(text);
    let pageChecked = false;
    if ((link.kind !== 'series' && !episode) || !seriesTitle) {
        await ctx.limit('lookup');
        try {
            const html = await ctx.http.fetchText(link.url, PAGE_TIMEOUT_MS, { quiet: true });
            const title = links.parseOgTitle(html);
            pageChecked = true;
            if (!episode && link.kind !== 'series' && title) {
                episode = links.episodeFromText(title);
                if (episode) episodeSource = 'page';
            }
            if (!seriesTitle && title) seriesTitle = links.seriesTitleFromText(title);
            if (!seriesId) seriesId = links.parseSeriesId(html);
        } catch (err) {
            ctx.log.child('anime').debug(`Page of ${link.url} not readable:`, err && err.message);
        }
    }
    const found = matchAnime(ctx, { service, seriesId, seriesSlug: link.seriesSlug, seriesTitle, episode });
    return {
        body: {
            service: link.service,
            kind: link.kind,
            external_id: link.id,
            series_id: seriesId,
            series_title: seriesTitle,
            episode: episode || null,
            episode_source: episode ? episodeSource : null,
            anime_id: found.anime_id,
            entry: matchedEntry(ctx, found.anime_id),
            match: found.match,
            candidates: found.candidates,
            url: link.url,
            page_checked: pageChecked
        }
    };
}

function syncState(ctx) {
    return { body: { anilist: listSync.stateOf(ctx, ctx.user.id) } };
}

async function syncUpdate(ctx, { body }) {
    const wanted = body && body.anilist;
    if (!wanted || typeof wanted !== 'object' || typeof wanted.enabled !== 'boolean') throw badRequest('Erwartet: { anilist: { enabled: true|false } }');
    return { body: { anilist: await listSync.setEnabled(ctx, ctx.user.id, wanted.enabled) } };
}

async function syncRun(ctx, { body }) {
    const result = await listSync.run(ctx, ctx.user.id, { priority: 'interactive', auto: Boolean(body && body.auto === true) });
    return { body: { anilist: result } };
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
    search, sources, list, detail, create, update, updateProgress, markWatched, resolveLink, syncState, syncUpdate, syncRun, removeProgress,
    refresh, remove, adaptations, exportCsv, PROGRESS_STATUSES, matchRows, candidateOf, preferred, servicePath
};
