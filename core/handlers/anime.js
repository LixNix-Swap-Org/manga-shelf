// Anime tab: shared list, progress per user, search and refresh over the gateway
// (core/anime/gateway.js), adaptations of a series, the CSV export, shared streaming links and the AniList list sync.
const { qstr } = require('../lib/query');
const { HttpError, msg, msgList, badRequest, forbidden, notFound, conflict } = require('../errors');
const access = require('../lib/access');
const { resolveTargetUser } = access;
const { escapeCell } = require('../csvExchange');
const gateway = require('../anime/gateway');
const store = require('../anime/store');
const listSync = require('../anime/listSync');
const { writeProgress, readProgress, sqlNow, PROGRESS_STATUSES } = require('../anime/progress');
const { SourceError } = require('../anime/request');
const episodeMarks = require('../anime/episodes');
const community = require('../anime/community');
const { settings } = require('../anime/settings');
const links = require('../watch/links');
const { seasonLinkOf, seasonServiceOf, MAX_SEASON } = require('../watch/crunchyroll');
const syncState = require('../watch/syncState');
const { titleScore, isTmdbAnime, yearOf, tmdbTwinScore } = require('../anime/normalize');
const { isLanguageCode } = require('../lib/language');
const { uiLocale, readProfile } = require('../lib/locales');

const MAX_TITLE = 200;
const MAX_NOTES = 4000;
const MAX_EPISODES = 100000;
const SEARCH_SOURCE_NAMES = gateway.SEARCH_SOURCES;
const SEARCH_KINDS = ['anime', 'tv', 'movie', 'all'];
const KINDS = ['anime', 'tv', 'movie'];
const TMDB_KINDS = ['movie', 'tv'];
const TMDB_LABEL = 'TMDB';
const OWN_RATING_FIELDS = ['score', 'episode_scores', 'rating_visibility', 'public_comment'];
const SEASON_FORMATS = ['TV', 'TV_SHORT', 'ONA'];
const BRIDGE_FORMATS = ['MOVIE', 'OVA', 'SPECIAL'];
const OPPOSITE = { SEQUEL: 'PREQUEL', PREQUEL: 'SEQUEL' };
const CHAIN_HOPS = 40; // steps of the stored chain per direction, seasons and films alike (gateway.seasonChainOf likewise)

const nowMs = (ctx) => ctx.now().getTime();

// texts of the id and text checks, one per field (no German label as a msg() parameter)
const ID_ERRORS = {
    id: 'Ungültige ID',
    anilist_id: 'Ungültige AniList-ID',
    mal_id: 'Ungültige MAL-ID',
    tmdb_id: 'Ungültige TMDB-ID',
    manga_id: 'Ungültige Reihen-ID'
};
const TEXT_TYPE_ERRORS = {
    title_de: 'Ungültiger Wert für Deutscher Titel',
    notes: 'Ungültiger Wert für Notiz',
    public_comment: 'Ungültiger Wert für Kommentar'
};
const TEXT_LENGTH_ERRORS = {
    title_de: 'Deutscher Titel ist zu lang (höchstens {max} Zeichen)',
    notes: 'Notiz ist zu lang (höchstens {max} Zeichen)',
    public_comment: 'Kommentar ist zu lang (höchstens {max} Zeichen)'
};

function parseId(raw, field = 'id') {
    const text = String(raw ?? '').trim();
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < 1) throw badRequest(ID_ERRORS[field]);
    return Number(text);
}

/** Optional positive integer id from a body (null/undefined -> null). */
function optionalId(value, field) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'number' && typeof value !== 'string') throw badRequest(ID_ERRORS[field]);
    return parseId(value, field);
}

function cleanTitle(value, { required = false } = {}) {
    if (value === undefined) {
        if (required) throw badRequest('Titel ist erforderlich (1 bis 200 Zeichen)');
        return undefined;
    }
    if (typeof value !== 'string' || !value.trim() || value.trim().length > MAX_TITLE) throw badRequest('Titel ist erforderlich (1 bis 200 Zeichen)');
    return value.trim();
}

function cleanOptionalText(value, field, max) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'string') throw badRequest(TEXT_TYPE_ERRORS[field]);
    const text = value.trim();
    if (text.length > max) throw badRequest(msg(TEXT_LENGTH_ERRORS[field], { max }));
    return text || null;
}

function cleanEpisodes(value) {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    const n = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN);
    if (!Number.isInteger(n) || n < 0 || n > MAX_EPISODES) throw badRequest('Folgenzahl muss eine ganze Zahl ab 0 sein');
    return n;
}

/** { id, title } of a series in a shelf the caller can see, else null (a link into a foreign shelf stays invisible). */
function visibleManga(ctx, mangaId) {
    const manga = ctx.db.prepare('SELECT id, title, shelf_id FROM mangas WHERE id = ?').get(mangaId);
    return manga && access.accessibleShelfIds(ctx).includes(manga.shelf_id) ? { id: manga.id, title: manga.title } : null;
}

/** Ids of the linked series in shelves the caller can see, for the list (like visibleManga). */
function visibleMangaIds(ctx) {
    const scope = access.inShelves('shelf_id', access.accessibleShelfIds(ctx));
    return new Set(ctx.db.prepare(`SELECT id FROM mangas WHERE id IN (SELECT manga_id FROM animes WHERE manga_id IS NOT NULL) AND ${scope.sql}`)
        .all(...scope.params).map((r) => r.id));
}

function mangaRef(ctx, mangaId) {
    if (mangaId === null) return null;
    const manga = ctx.db.prepare('SELECT id, title, shelf_id FROM mangas WHERE id = ?').get(mangaId);
    if (!manga || !access.accessibleShelfIds(ctx).includes(manga.shelf_id)) throw notFound('Reihe');
    return { id: manga.id, title: manga.title };
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

/**
 * The main line of an entry as seasons: the TV prequel/sequel chain, followed through the entries that are in the
 * collection (their stored relations), so nothing is asked from a source. A neighbour that is not in the collection
 * is listed but ends the walk. Returns [] when the entry has no TV neighbour; otherwise the seasons in order with
 * { in_collection_id, anilist_id, mal_id, title, season_year, episodes, my_status, current }.
 */
function seasonChain(ctx, row, relations) {
    const byAni = ctx.db.prepare('SELECT * FROM animes WHERE anilist_id = ?');
    const byMal = ctx.db.prepare('SELECT * FROM animes WHERE mal_id = ?');
    const status = ctx.db.prepare('SELECT status FROM anime_progress WHERE anime_id = ? AND user_id = ?');
    const mineOf = (id) => (id && ctx.user && (status.get(id, ctx.user.id) || {}).status) || null;
    const found = (r) => (r.anilist_id && byAni.get(r.anilist_id)) || (r.mal_id && byMal.get(r.mal_id)) || null;
    const nodeOf = (r, entry) => ({
        in_collection_id: entry ? entry.id : null,
        anilist_id: r.anilist_id || null,
        mal_id: r.mal_id || null,
        title: (entry && (entry.title_de || entry.title)) || r.title,
        season_year: (entry && entry.season_year) || r.season_year || null,
        episodes: (entry && entry.episodes) || r.episodes || null,
        my_status: mineOf(entry && entry.id),
        current: false
    });
    const stepOf = (rels, type) => {
        const list = (rels || []).filter((x) => x && x.kind === 'ANIME' && x.relation === type);
        return list.find((x) => SEASON_FORMATS.includes(x.format)) || list.find((x) => BRIDGE_FORMATS.includes(x.format)) || null;
    };
    const walk = (start, type) => {
        const out = [];
        const seen = new Set([start.id]);
        let rels = relations;
        for (let i = 0; i < CHAIN_HOPS; i += 1) {
            let r = stepOf(rels, type);
            if (!r) break;
            let entry = found(r);
            if (!entry && !SEASON_FORMATS.includes(r.format)) { // a film/OVA outside the collection: the entry after it names it
                const via = store.relatedEntry(ctx, r.anilist_id, OPPOSITE[type]);
                if (!via || seen.has(via.entry.id)) break;
                ({ entry } = via);
                r = via;
            }
            if (SEASON_FORMATS.includes(r.format)) out.push(nodeOf(r, entry));
            if (!entry || seen.has(entry.id)) break;
            seen.add(entry.id);
            rels = store.parseJson(entry.relations, []);
        }
        return out;
    };
    const after = walk(row, 'SEQUEL');
    const before = walk(row, 'PREQUEL').reverse();
    if (!after.length && !before.length) return [];
    const self = { in_collection_id: row.id, anilist_id: row.anilist_id || null, mal_id: row.mal_id || null, title: row.title_de || row.title,
        season_year: row.season_year || null, episodes: row.episodes || null, my_status: mineOf(row.id), current: true };
    return [...before, self, ...after];
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
    const myStatus = ctx.db.prepare('SELECT status FROM anime_progress WHERE anime_id = ? AND user_id = ?');
    const manga = row.manga_id ? visibleManga(ctx, row.manga_id) : null;
    const linkedElsewhere = Boolean(row.manga_id && !manga && ctx.db.prepare('SELECT id FROM mangas WHERE id = ?').get(row.manga_id));
    return {
        ...entry,
        manga_id: manga ? manga.id : null,
        ...(linkedElsewhere ? { manga_linked_elsewhere: true } : {}),
        ...store.linksOf(row),
        watch: store.watchOf(row, mine, rememberedLinks(ctx, id).get(id)),
        description: row.description,
        relations: relations.map((r) => ({
            ...r,
            in_collection_id: (r.anilist_id && byAni.get(r.anilist_id)?.id) || (r.mal_id && byMal.get(r.mal_id)?.id) || null
        })).map((r) => ({
            ...r,
            my_status: (r.in_collection_id && ctx.user && (myStatus.get(r.in_collection_id, ctx.user.id) || {}).status) || null
        })),
        season_chain: seasonChain(ctx, row, relations),
        manga,
        my_progress: store.progressOf(mine),
        // a resume link is where one user stopped watching, notes are private and a rating follows its visibility;
        // an anonymous rating still counts in `community` but carries no name here
        progress: progress.map((p) => (p === mine
            ? { ...store.progressOf(p), username: p.username }
            : { ...community.othersView(store.progressOf(p), p), username: p.username })),
        community: { ...community.summarize(progress), episodes: community.episodeCommunity(progress) }
    };
}

function searchSources(raw) {
    const text = (qstr(raw) || '').trim();
    if (!text) return undefined;
    const names = [...new Set(text.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean))];
    if (!names.length) return undefined;
    if (names.some((name) => !SEARCH_SOURCE_NAMES.includes(name))) {
        throw badRequest(msg('Unbekannte Quelle (erlaubt: {allowed})', { allowed: SEARCH_SOURCE_NAMES.join(', ') }), 'BAD_REQUEST');
    }
    return names;
}

function searchKind(raw) {
    const kind = (qstr(raw) || '').trim().toLowerCase();
    if (!kind) return 'all';
    if (!SEARCH_KINDS.includes(kind)) throw badRequest(msg('Unbekannte Art (erlaubt: {allowed})', { allowed: SEARCH_KINDS.join(', ') }), 'BAD_REQUEST');
    return kind;
}

const searchLanguage = (ctx, raw) => uiLocale(qstr(raw)) || (ctx.user ? uiLocale(readProfile(ctx.db, ctx.user.id).locale) : null) || 'de';

function collectionMatcher(ctx) {
    const byAni = ctx.db.prepare('SELECT id FROM animes WHERE anilist_id = ?');
    const byMal = ctx.db.prepare('SELECT id FROM animes WHERE mal_id = ?');
    const byTmdb = ctx.db.prepare('SELECT id FROM animes WHERE tmdb_kind = ? AND tmdb_id = ?');
    let animeRows = null;
    const titleTwin = (meta) => {
        const year = yearOf(meta);
        if (!year) return null;
        if (!animeRows) {
            animeRows = ctx.db.prepare("SELECT id, title, title_de, title_romaji, title_english, title_native, season_year, start_date FROM animes WHERE kind = 'anime'").all();
        }
        const twin = animeRows.find((row) => yearOf(row) === year
            && tmdbTwinScore(meta, [row.title, row.title_de, row.title_romaji, row.title_english, row.title_native].filter(Boolean)) >= 0.9);
        return twin ? twin.id : null;
    };
    return (meta) => (meta.anilist_id && byAni.get(meta.anilist_id)?.id)
        || (meta.mal_id && byMal.get(meta.mal_id)?.id)
        || (meta.tmdb_id && byTmdb.get(meta.tmdb_kind, meta.tmdb_id)?.id)
        || (meta.folded_tmdb && byTmdb.get(meta.folded_tmdb.tmdb_kind, meta.folded_tmdb.tmdb_id)?.id)
        || (isTmdbAnime(meta) && titleTwin(meta))
        || null;
}

async function search(ctx, { query }) {
    const q = (qstr(query.q) || '').trim();
    if (q.length < 2 || q.length > 100) throw badRequest('Suchbegriff muss 2 bis 100 Zeichen lang sein');
    const limit = Math.min(20, Math.max(1, parseInt(qstr(query.limit), 10) || 10));
    const sources = searchSources(query.sources);
    const kind = searchKind(query.kind);
    const result = await gateway.searchAnime(ctx, q, { limit, sources, kind, language: searchLanguage(ctx, query.language) });
    const inCollection = collectionMatcher(ctx);
    return {
        body: {
            ...result,
            results: result.results.map((meta) => ({ ...meta, in_collection_id: inCollection(meta) }))
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
               p.resume_url, p.resume_episode, p.audio_language, p.subtitle_language, p.watched_episodes, p.episode_scores, p.rating_visibility, p.public_comment, u.username
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
    const communities = community.communityByAnime(progress);
    const remembered = rememberedLinks(ctx);
    const visibleLinks = visibleMangaIds(ctx);
    const allLinkedMangaIds = new Set(ctx.db.prepare('SELECT id FROM mangas WHERE id IN (SELECT manga_id FROM animes WHERE manga_id IS NOT NULL)').all().map((r) => r.id));
    let queued = 0;
    const body = rows.map((row) => {
        const entry = store.entryOf(row, now);
        if (entry.stale && queued < 50 && gateway.scheduleRefresh(ctx, row.id)) queued++;
        const all = byAnime.get(row.id) || [];
        const mine = all.find((p) => p.user_id === userId);
        const visibleLink = visibleLinks.has(entry.manga_id);
        const linkedElsewhere = Boolean(entry.manga_id && !visibleLink && allLinkedMangaIds.has(entry.manga_id));
        return {
            ...entry,
            manga_id: visibleLink ? entry.manga_id : null,
            ...(linkedElsewhere ? { manga_linked_elsewhere: true } : {}),
            watch: store.watchOf(row, mine, remembered.get(row.id)),
            my_progress: store.progressOf(mine),
            community: communities.get(row.id) || { average: null, count: 0, watchers: 0 },
            progress_users: all.map((p) => ({ user_id: p.user_id, username: p.username, status: p.status, episodes_watched: p.episodes_watched }))
        };
    });
    return { body };
}

function detail(ctx, { params }) {
    const id = parseId(params.id);
    const row = loadRow(ctx, id);
    if (store.isStale(row, nowMs(ctx))) gateway.scheduleRefresh(ctx, id);
    gateway.scheduleOwnTmdbRefresh(ctx, row);
    return { body: detailOf(ctx, id) };
}

/** GET /anime/:id/ratings – the community ratings of an entry as the caller may see them. */
function ratings(ctx, { params }) {
    const id = parseId(params.id);
    loadRow(ctx, id);
    const rows = progressRows(ctx, id);
    const viewer = ctx.user ? ctx.user.id : null;
    return { body: { anime_id: id, ...community.ratingsOf(rows, viewer), episodes: community.episodeCommunity(rows) } };
}

function duplicateOf(ctx, anilistId, malId, tmdbRef = null) {
    if (tmdbRef && tmdbRef.tmdb_id) {
        const row = ctx.db.prepare('SELECT id FROM animes WHERE tmdb_kind = ? AND tmdb_id = ?').get(tmdbRef.tmdb_kind, tmdbRef.tmdb_id);
        if (row) return row.id;
    }
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
const ENTRY_ALREADY_THERE = 'Dieser Eintrag ist schon in der Liste';
const WATCHED_PUSH_MS = 60 * 1000;

/** AniList/MyAnimeList or TMDb data of a new entry, fetched interactively: { meta, images }. */
async function prepareExternal(ctx, ref) {
    let meta;
    try {
        meta = await gateway.getAnime(ctx, ref, { priority: 'interactive' });
    } catch (err) {
        if (err instanceof SourceError) {
            if (ref.tmdb_id) throw new HttpError(503, msg('{source} ist gerade nicht erreichbar. Bitte später erneut versuchen.', { source: TMDB_LABEL }), 'SOURCES_UNAVAILABLE');
            throw new HttpError(503, 'AniList und MyAnimeList sind gerade nicht erreichbar. Bitte später erneut versuchen.', 'SOURCES_UNAVAILABLE');
        }
        throw err;
    }
    if (!meta) {
        if (ref.tmdb_id) throw notFound('Eintrag bei TMDB');
        throw notFound('Anime bei AniList/MyAnimeList');
    }
    return { meta, images: await store.freshImages(ctx, meta) };
}

/** Inserts a prepared entry with the adder's 'Geplant' row (synchronous, schedules nothing): { id, created }. */
function insertPrepared(ctx, prepared) {
    const { meta } = prepared;
    const existing = duplicateOf(ctx, meta.anilist_id, meta.mal_id, meta.tmdb_id ? meta : null);
    if (existing) return { id: existing, created: false };
    const id = store.insertFromMeta(ctx, meta, prepared.images || {}, { manga_id: prepared.manga_id ?? null, title: prepared.title ?? null });
    writeProgress(ctx, id, ctx.user.id, { status: 'Geplant' });
    return { id, created: true };
}

function cleanKind(value) {
    if (value === undefined || value === null || value === '') return undefined;
    if (!KINDS.includes(value)) throw badRequest(msg('Unbekannte Art (erlaubt: {allowed})', { allowed: KINDS.join(', ') }));
    return value;
}

function tmdbRefOf(body, anilistId, malId) {
    const tmdbId = optionalId(body.tmdb_id, 'tmdb_id');
    const kindGiven = body.tmdb_kind !== undefined && body.tmdb_kind !== null && body.tmdb_kind !== '';
    if (tmdbId === null && !kindGiven) return null;
    if (tmdbId === null || !TMDB_KINDS.includes(body.tmdb_kind)) throw badRequest(msg('Ungültige TMDB-Art (erlaubt: {allowed})', { allowed: TMDB_KINDS.join(', ') }));
    if (anilistId || malId) throw badRequest('Eine TMDB-ID lässt sich nicht mit einer AniList- oder MAL-ID kombinieren');
    return { tmdb_id: tmdbId, tmdb_kind: body.tmdb_kind };
}

/** From a search hit (anilist_id and/or mal_id, or tmdb_id with tmdb_kind, fetched interactively) or a manual entry (title, episodes, kind). */
async function create(ctx, { body }) {
    const anilistId = optionalId(body.anilist_id, 'anilist_id');
    const malId = optionalId(body.mal_id, 'mal_id');
    const tmdbRef = tmdbRefOf(body, anilistId, malId);
    const mangaId = optionalId(body.manga_id, 'manga_id');
    if (mangaId !== null) mangaRef(ctx, mangaId);
    const watched = body.watched === undefined || body.watched === null ? null : readWatched(body.watched);
    const existing = duplicateOf(ctx, anilistId, malId, tmdbRef);
    if (existing) {
        if (tmdbRef) throw conflict(ENTRY_ALREADY_THERE, 'DUPLICATE', { id: existing });
        throw conflict(ALREADY_THERE, 'DUPLICATE', { id: existing });
    }
    const userId = ctx.user.id;

    let created;
    if (!anilistId && !malId && !tmdbRef) {
        const title = cleanTitle(body.title, { required: true });
        const episodes = cleanEpisodes(body.episodes);
        const kind = cleanKind(body.kind) || 'anime';
        const insert = ctx.db.prepare(`
            INSERT INTO animes (title, episodes, manga_id, notes, kind, updated_by, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const notes = cleanOptionalText(body.notes, 'notes', MAX_NOTES) ?? null;
        created = ctx.db.transaction(() => {
            const id = Number(insert.run(title, episodes ?? null, mangaId, notes, kind, userId, sqlNow(ctx), sqlNow(ctx)).lastInsertRowid);
            writeProgress(ctx, id, userId, { status: 'Geplant' });
            return { id, watched: watched ? applyWatched(ctx, id, userId, watched) : null };
        });
    } else {
        const prepared = await prepareExternal(ctx, tmdbRef || { anilist_id: anilistId, mal_id: malId });
        const title = cleanTitle(body.title);
        created = ctx.db.transaction(() => {
            const inserted = insertPrepared(ctx, { ...prepared, manga_id: mangaId, title });
            if (!inserted.created) return { duplicate: inserted.id };
            return { id: inserted.id, watched: watched ? applyWatched(ctx, inserted.id, userId, watched) : null };
        });
        if (created.duplicate) {
            if (tmdbRef) throw conflict(ENTRY_ALREADY_THERE, 'DUPLICATE', { id: created.duplicate });
            throw conflict(ALREADY_THERE, 'DUPLICATE', { id: created.duplicate });
        }
    }
    listSync.schedulePush(ctx, userId, created.id, watched ? { delayMs: WATCHED_PUSH_MS } : undefined);
    if (anilistId || malId) gateway.scheduleIdResolution(ctx, created.id);
    const detail = detailOf(ctx, created.id);
    if (!created.watched) return { status: 201, body: detail };
    const done = created.watched;
    return { status: 201, body: { ...detail, watched: { progress: store.progressOf(done.saved), previous: null, entry_episodes: done.total } } };
}

function update(ctx, { params, body }) {
    const id = parseId(params.id);
    const row = loadRow(ctx, id);
    const columns = {};
    const title = cleanTitle(body.title);
    if (title !== undefined) columns.title = title;
    const titleDe = cleanOptionalText(body.title_de, 'title_de', MAX_TITLE);
    if (titleDe !== undefined) columns.title_de = titleDe;
    const notes = cleanOptionalText(body.notes, 'notes', MAX_NOTES);
    if (notes !== undefined) columns.notes = notes;
    if (body.manga_id !== undefined) {
        if (row.manga_id && !visibleManga(ctx, row.manga_id) && ctx.db.prepare('SELECT id FROM mangas WHERE id = ?').get(row.manga_id)) {
            throw notFound('Reihe');
        }
        const mangaId = optionalId(body.manga_id, 'manga_id');
        mangaRef(ctx, mangaId);
        columns.manga_id = mangaId;
    }
    const sourced = Boolean(row.anilist_id || row.mal_id || row.tmdb_id);
    if (body.episodes !== undefined) {
        if (sourced) throw badRequest('Die Folgenzahl kommt von der Quelle und lässt sich nur bei manuellen Einträgen ändern');
        columns.episodes = cleanEpisodes(body.episodes);
    }
    if (body.kind !== undefined) {
        if (sourced) throw badRequest('Die Art kommt von der Quelle und lässt sich nur bei manuellen Einträgen ändern');
        const kind = cleanKind(body.kind);
        if (!kind) throw badRequest(msg('Unbekannte Art (erlaubt: {allowed})', { allowed: KINDS.join(', ') }));
        columns.kind = kind;
    }
    if (body.custom_seasons !== undefined) {
        const seasons = parseCustomSeasons(body.custom_seasons, columns.episodes !== undefined ? columns.episodes : row.episodes);
        columns.custom_seasons = seasons ? JSON.stringify(seasons) : null;
    }
    if (body.tags !== undefined) {
        const tags = parseTags(body.tags);
        columns.tags = tags.length ? JSON.stringify(tags) : null;
    } else if (body.tags_add !== undefined || body.tags_remove !== undefined) {
        const tags = changeTags(store.parseJson(row.tags, []), body.tags_add, body.tags_remove);
        columns.tags = tags.length ? JSON.stringify(tags) : null;
    }
    if (!Object.keys(columns).length) throw badRequest('Keine Änderungen angegeben');
    columns.updated_at = sqlNow(ctx);
    columns.updated_by = ctx.user.id;
    store.updateRow(ctx, id, columns);
    return { body: detailOf(ctx, id) };
}

const MAX_TAGS = 20;
const MAX_TAG = 30;

/** tags of PUT /anime/:id: null or [] clears them, else a list of at most 20 short names (duplicates in any case are dropped). */
function parseTags(value) {
    if (value === null) return [];
    if (!Array.isArray(value) || value.length > MAX_TAGS) throw badRequest(msg('Tags müssen eine Liste mit höchstens {max} Namen sein', { max: MAX_TAGS }));
    const seen = new Set();
    const tags = [];
    for (const raw of value) {
        const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
        if (!name || name.length > MAX_TAG) throw badRequest(msg('Ein Tag hat 1 bis {max} Zeichen', { max: MAX_TAG }));
        if (!seen.has(name.toLowerCase())) { seen.add(name.toLowerCase()); tags.push(name); }
    }
    return tags;
}

/**
 * tags_add / tags_remove of PUT /anime/:id: applied to the stored tags instead of replacing them, so two people adding a tag
 * to the same entry at once both keep theirs. Names as in `tags` (removal ignores case); more than 20 afterwards is 400.
 */
function changeTags(stored, add, remove) {
    const added = add === undefined ? [] : parseTags(add);
    const removed = new Set((remove === undefined ? [] : parseTags(remove)).map((name) => name.toLowerCase()));
    const tags = stored.filter((name) => !removed.has(name.toLowerCase()));
    for (const name of added) {
        if (!tags.some((t) => t.toLowerCase() === name.toLowerCase())) tags.push(name);
    }
    if (tags.length > MAX_TAGS) throw badRequest(msg('Tags müssen eine Liste mit höchstens {max} Namen sein', { max: MAX_TAGS }));
    return tags;
}

const seasonsError = () => badRequest(msg('Staffeln müssen bei Folge 1 beginnen und aufsteigende Startfolgen mit Namen bis {max_name} Zeichen haben (höchstens {max})',
    { max: episodeMarks.MAX_SEASONS, max_name: episodeMarks.MAX_SEASON_NAME }));

/** custom_seasons of PUT /anime/:id: null or [] clears them, else [{ start, name }] starting at episode 1, ascending. */
function parseCustomSeasons(value, episodes) {
    if (value === null) return null;
    if (!Array.isArray(value) || value.length > episodeMarks.MAX_SEASONS) throw seasonsError();
    if (!value.length) return null;
    let last = 0;
    for (const item of value) {
        const ok = item && typeof item === 'object' && Number.isInteger(item.start) && item.start > last && item.start <= MAX_EPISODES
            && (item.name === undefined || item.name === null || (typeof item.name === 'string' && item.name.trim().length <= episodeMarks.MAX_SEASON_NAME));
        if (!ok || (last === 0 && item.start !== 1)) throw seasonsError();
        last = item.start;
    }
    if (episodes > 0 && last > episodes) throw episodeAboveTotal(last, episodes);
    return episodeMarks.cleanSeasons(value);
}

/** GET /anime/:id/season-suggestion: the TMDb seasons of the entry (or of its TMDb twin) as [{ start, name, episodes }]. */
async function seasonSuggestion(ctx, { params, query }) {
    const id = parseId(params.id);
    const row = loadRow(ctx, id);
    if (row.kind === 'movie') return { body: { seasons: [], reason: 'not_found' } };
    try {
        return { body: await gateway.tmdbSeasons(ctx, row, { language: searchLanguage(ctx, query.language) }) };
    } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        throw new HttpError(503, msg('{source} ist gerade nicht erreichbar. Bitte später erneut versuchen.', { source: TMDB_LABEL }), 'SOURCES_UNAVAILABLE');
    }
}

function cleanLanguage(value) {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    const code = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!isLanguageCode(code)) throw badRequest('Ungültiger Sprachcode (zwei Buchstaben, z. B. de)', 'LANGUAGE_INVALID');
    return code;
}

function stillAiring(anime) {
    const kind = anime.kind || 'anime';
    if (kind === 'tv') return anime.next_airing_episode !== null && anime.episodes !== null && anime.next_airing_episode <= anime.episodes;
    return kind === 'anime' && (anime.status === 'RELEASING' || anime.status === 'NOT_YET_RELEASED');
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
 * change goes to their AniList list when the sync is on. A rating, its visibility and the comment are only ever the
 * user's own (403 with another user_id), and the answer for another user shows the row as othersView does.
 */
function updateProgress(ctx, { params, body }) {
    const id = parseId(params.id);
    const userId = resolveTargetUser(ctx, body.user_id);
    const forOther = Number(userId) !== Number(ctx.user.id);
    if (forOther && OWN_RATING_FIELDS.some((field) => body[field] !== undefined)) {
        throw forbidden('Bewertung, Sichtbarkeit und Kommentar kann nur der Benutzer selbst ändern');
    }
    if (body.status !== undefined && !PROGRESS_STATUSES.includes(body.status)) {
        throw badRequest(msg('Ungültiger Status (erlaubt: {allowed})', { allowed: msgList(PROGRESS_STATUSES) }));
    }
    let watched;
    if (body.episodes_watched !== undefined) {
        const v = body.episodes_watched;
        watched = typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN);
        if (!Number.isInteger(watched) || watched < 0 || watched > MAX_EPISODES) throw badRequest('Gesehene Folgen müssen eine ganze Zahl ab 0 sein');
    }
    const marks = parseWatchedEpisodes(body.watched_episodes);
    const score = parseScore(body.score);
    const episodeScores = parseEpisodeScores(body.episode_scores);
    const notes = cleanOptionalText(body.notes, 'notes', MAX_NOTES);
    const audio = cleanLanguage(body.audio_language);
    const subtitle = cleanLanguage(body.subtitle_language);
    const visibility = community.parseVisibility(body.rating_visibility);
    if (visibility === null) throw badRequest('Ungültige Sichtbarkeit (public, anonymous oder private)');
    const publicComment = body.public_comment === undefined ? undefined : cleanOptionalText(body.public_comment, 'public_comment', community.MAX_COMMENT);
    const saved = ctx.db.transaction(() => {
        const anime = loadRow(ctx, id);
        if (body.status === 'Gesehen' && body.restore !== true && stillAiring(anime)) {
            throw badRequest(msg('Läuft noch – „Gesehen“ geht erst nach der letzten Folge; nimm „Schaue“'), 'STILL_AIRING');
        }
        if (body.restore === true) syncState.liftDeclines(ctx, userId, declineKeys(ctx, userId, id));
        if (marks && anime.episodes > 0) {
            const above = marks.find((n) => n > anime.episodes);
            if (above !== undefined) throw episodeAboveTotal(above, anime.episodes);
        }
        if (episodeScores && anime.episodes > 0) {
            const above = Object.keys(episodeScores).map(Number).find((n) => n > anime.episodes);
            if (above !== undefined) throw episodeAboveTotal(above, anime.episodes);
        }
        return writeProgress(ctx, id, userId, {
            status: body.status, episodes_watched: marks ? undefined : watched, watched_episodes: marks, episode_scores: episodeScores, score, notes, audio_language: audio, subtitle_language: subtitle,
            rating_visibility: visibility, public_comment: publicComment
        });
    });
    listSync.schedulePush(ctx, userId, id);
    const progress = store.progressOf(saved);
    return { body: forOther ? community.othersView(progress, saved) : progress };
}

/** `watched_episodes` of PUT progress: undefined (unchanged), null (back to the plain counter) or the watched episode numbers. */
function parseWatchedEpisodes(value) {
    if (value === undefined || value === null) return value;
    if (!Array.isArray(value) || value.length > episodeMarks.MAX_MARKS
        || !value.every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_EPISODES)) {
        throw badRequest(msg('Gesehene Folgen müssen eine Liste ganzer Zahlen ab 1 sein (höchstens {max})', { max: episodeMarks.MAX_MARKS }));
    }
    return episodeMarks.cleanMarks(value);
}

/** `episode_scores` of PUT progress: undefined (unchanged), null (no ratings) or an object episode number -> whole score 1..10. */
function parseEpisodeScores(value) {
    if (value === undefined || value === null) return value;
    const invalid = () => badRequest(msg('Folgen-Bewertungen müssen Folgennummern ab 1 mit ganzen Zahlen von 1 bis 10 sein (höchstens {max})', { max: episodeMarks.MAX_MARKS }));
    if (typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const keys = Object.keys(value);
    if (keys.length > episodeMarks.MAX_MARKS) throw invalid();
    for (const key of keys) {
        const episode = episodeMarks.EPISODE_KEY.test(key) ? Number(key) : NaN;
        const score = value[key];
        if (!Number.isInteger(episode) || episode < 1 || episode > MAX_EPISODES || !Number.isInteger(score) || score < 1 || score > 10) throw invalid();
    }
    return episodeMarks.cleanScores(value);
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
    total === 1
        ? msg('Folge {episode} gibt es bei diesem Eintrag nicht (er hat nur eine Folge).', { episode, total })
        : msg('Folge {episode} gibt es bei diesem Eintrag nicht (er hat nur {total} Folgen).', { episode, total }),
    'EPISODE_ABOVE_TOTAL', { episodes: total }
);

function readWatched(body) {
    const value = body && typeof body === 'object' ? body : {};
    const episode = cleanEpisode(value.episode);
    let url = null;
    if (value.url !== undefined && value.url !== null && value.url !== '') {
        const link = typeof value.url === 'string' ? links.linkOf(value.url.trim()) : null;
        if (!link || (link.kind !== 'episode' && link.kind !== 'legacy')) throw unsupportedLink();
        url = link.url;
    }
    return { episode, url, remember: cleanRemember(value.remember), complete: value.complete === true };
}

/**
 * "Folge N gesehen" in the caller's transaction (never lower, resume link, remembered links): { saved, previous, total }.
 * A plain row reads it as "watched up to N"; a row with single marks gets episode N added (an episode past the total with
 * `complete` still means the whole entry).
 */
function applyWatched(ctx, id, userId, { episode, url, remember, complete }) {
    const anime = loadRow(ctx, id);
    const above = anime.episodes > 0 && episode > anime.episodes;
    if (above && !complete) throw episodeAboveTotal(episode, anime.episodes);
    const before = readProgress(ctx, id, userId) || null;
    const single = !above && Boolean(before && episodeMarks.parseMarks(before.watched_episodes));
    const change = single ? { add_episodes: [episode] } : { episodes_watched: episode };
    if (url) Object.assign(change, { resume_url: url, resume_episode: episode });
    const row = writeProgress(ctx, id, userId, change, { monotonic: true });
    if (remember) {
        ctx.db.prepare(`
            INSERT INTO anime_links (anime_id, service, external_id, url) VALUES (?, ?, ?, ?)
            ON CONFLICT (anime_id, service) DO UPDATE SET external_id = excluded.external_id, url = excluded.url
        `).run(id, remember.service.id, remember.externalId, remember.service.seriesUrl(remember.externalId));
        if (remember.season) {
            rememberSeason(ctx, id, remember);
            syncState.liftDeclines(ctx, userId, [seasonLinkOf(remember.service.id, remember.externalId, remember.season).external_id]);
        }
    }
    return { saved: row, previous: before, total: anime.episodes ?? null };
}

// "Folge N gesehen" from a shared link, always for the caller: the counter never goes down, the episode link becomes the resume
// link, `remember` stores the series link in the same transaction. An episode above a known total needs `complete: true`.
// Answers the progress before the write as `previous` (null without a row), so the undo never depends on the client's list copy.
function markWatched(ctx, { params, body }) {
    const id = parseId(params.id);
    const watched = readWatched(body);
    const userId = ctx.user.id;
    const { saved, previous, total } = ctx.db.transaction(() => applyWatched(ctx, id, userId, watched));
    listSync.schedulePush(ctx, userId, id);
    return { body: { anime_id: id, progress: store.progressOf(saved), previous: store.progressOf(previous), entry_episodes: total } };
}

function declineKeys(ctx, userId, animeId) {
    const prefix = seasonServiceOf(SERIES_SERVICE, '');
    const linked = ctx.db.prepare('SELECT external_id FROM anime_links WHERE anime_id = ? AND substr(service, 1, ?) = ?')
        .all(animeId, prefix.length, prefix).map((r) => r.external_id);
    return [...new Set([...syncState.keysFor(syncState.readWatchState(ctx, userId), animeId), ...linked])];
}

const PAGE_TIMEOUT_MS = 6000;
const MAX_SHARE_TEXT = 4000;
const MAX_CANDIDATES = 5;
const LOOKUP_FORMATS = ['TV', 'TV_SHORT', 'ONA', 'OVA'];
const STRONG_SCORE = 0.9;
const MAX_HITS = 5;
const SUGGEST_BUDGET_MS = 6000;
const LOOKUP_TIMEOUT_MS = 8000;

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
        WHERE a.kind = 'anime'
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

/** AniList hits of a series lookup: allowed formats, a title score of at least 0.9 against a term, the best 5: [{ meta, score }]. */
function strongHits(lists, terms) {
    const best = new Map();
    for (const metas of lists) {
        for (const meta of metas || []) {
            if (!meta || !meta.anilist_id || !LOOKUP_FORMATS.includes(meta.format)) continue;
            const t = meta.title || {};
            const titles = [t.romaji, t.english, t.preferred, ...(meta.synonyms || [])].filter(Boolean);
            const score = Math.max(0, ...terms.map((term) => titleScore(term, titles)));
            if (score < STRONG_SCORE) continue;
            const known = best.get(meta.anilist_id);
            if (!known || score > known.score) best.set(meta.anilist_id, { meta, score });
        }
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, MAX_HITS);
}

const namesSeries = (meta, seriesId) => {
    const needle = `/series/${String(seriesId).toLowerCase()}`;
    return (meta.external_links || []).some((l) => {
        const path = l ? servicePath(l.url) : null;
        return path !== null && (path === needle || path.startsWith(`${needle}/`));
    });
};

async function suggestionFor(ctx, seriesId, terms) {
    const userId = ctx.user.id;
    const phase = syncState.startPhase(ctx, SUGGEST_BUDGET_MS);
    const options = { userId, timeoutMs: LOOKUP_TIMEOUT_MS, signal: phase.signal, beforeRequest: syncState.lookupGate(ctx, userId, phase) };
    try {
        const hits = strongHits(await gateway.spareSearch(ctx, terms, options), terms);
        if (!hits.length) return null;
        const named = (await gateway.spareDetail(ctx, hits.map((h) => h.meta.anilist_id), options)).filter((meta) => namesSeries(meta, seriesId));
        if (named.length !== 1) return null;
        const [meta] = named;
        const seasons = (meta.relations || []).filter((r) => (r.relation === 'PREQUEL' || r.relation === 'SEQUEL') && SEASON_FORMATS.includes(r.format));
        if (seasons.length) return null;
        return { anilist_id: meta.anilist_id, title: meta.title.preferred || meta.title.romaji || null, episodes: meta.episodes ?? null, format: meta.format || null };
    } catch (err) {
        ctx.log.child('anime').debug('Link suggestion failed:', err && err.message);
        return null;
    } finally {
        phase.end();
    }
}

// What a shared streaming link points at: service, series, episode and the caller's entry. Read-only. The page is only fetched
// (host allowlist, no redirects) when link and share text leave episode or series open; any page failure means "unknown"
// (page_checked false).
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
    let pageTried = false;
    const readPage = async () => {
        pageTried = true;
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
    };
    if ((link.kind !== 'series' && !episode) || !seriesTitle) {
        await ctx.limit('lookup');
        await readPage();
    }
    const matchNow = () => matchAnime(ctx, { service, seriesId, seriesSlug: link.seriesSlug, seriesTitle, episode });
    let found = matchNow();
    let suggestion = null;
    if (!found.anime_id && settings(ctx).anilist && !gateway.poolDown(ctx, 'anilist')) {
        if (!seriesId && !pageTried && ctx.limit('lookup', { soft: true }) !== false) {
            await readPage();
            if (seriesId) found = matchNow();
        }
        if (!found.anime_id && seriesId) {
            const slug = link.kind === 'series' ? link.slug : link.kind === 'legacy' ? link.seriesSlug : null;
            const terms = [...new Set([seriesTitle, slug ? links.titleFromSlug(slug) : null].filter(Boolean))];
            if (terms.length) suggestion = await suggestionFor(ctx, seriesId, terms);
        }
    }
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
            page_checked: pageChecked,
            ...(suggestion ? { suggestion } : {})
        }
    };
}

const watchState = (ctx) => syncState.watchOf(syncState.readWatchState(ctx, ctx.user.id));

function syncStateOf(ctx) {
    return { body: { anilist: listSync.stateOf(ctx, ctx.user.id), watch: watchState(ctx) } };
}

async function syncUpdate(ctx, { body }) {
    const anilist = body && body.anilist;
    const watch = body && body.watch;
    const anilistValid = anilist && typeof anilist === 'object' && typeof anilist.enabled === 'boolean';
    if ((anilist === undefined && watch === undefined) || (anilist !== undefined && !anilistValid)) {
        throw badRequest('Erwartet: { anilist: { enabled: true|false } }');
    }
    if (watch !== undefined && (!watch || typeof watch !== 'object' || typeof watch.auto_add !== 'boolean')) {
        throw badRequest('Erwartet: { watch: { auto_add: true|false } }');
    }
    const userId = ctx.user.id;
    if (watch !== undefined) {
        ctx.db.transaction(() => {
            const state = syncState.readWatchState(ctx, userId);
            state.auto_add = watch.auto_add;
            syncState.writeWatchState(ctx, userId, state);
        });
    }
    const result = anilist !== undefined ? await listSync.setEnabled(ctx, userId, anilist.enabled) : listSync.stateOf(ctx, userId);
    return { body: { anilist: result, watch: watchState(ctx) } };
}

async function syncRun(ctx, { body }) {
    const result = await listSync.run(ctx, ctx.user.id, { priority: 'interactive', auto: Boolean(body && body.auto === true) });
    return { body: { anilist: result, watch: watchState(ctx) } };
}

function removeProgress(ctx, { params, query, body }) {
    const id = parseId(params.id);
    loadRow(ctx, id);
    const userId = resolveTargetUser(ctx, body && body.user_id);
    const decline = qstr(query && query.decline) === '1';
    const removed = ctx.db.transaction(() => {
        const gone = ctx.db.prepare('DELETE FROM anime_progress WHERE anime_id = ? AND user_id = ?').run(id, userId).changes > 0;
        if (gone && decline) syncState.recordDecline(ctx, userId, declineKeys(ctx, userId, id));
        return gone;
    });
    return { body: { success: true, removed } };
}

async function refresh(ctx, { params }) {
    const id = parseId(params.id);
    const row = loadRow(ctx, id);
    if (!row.anilist_id && !row.mal_id && !row.tmdb_id) throw badRequest('Manuelle Einträge ohne AniList-/MAL-ID lassen sich nicht aktualisieren');
    const found = await gateway.manualRefresh(ctx, id);
    return { body: { ...detailOf(ctx, id), refreshed: found } };
}

function remove(ctx, { params }) {
    const id = parseId(params.id);
    const userId = ctx.user.id;
    ctx.db.transaction(() => {
        if (!ctx.db.prepare('SELECT id FROM animes WHERE id = ?').get(id)) throw notFound('Anime');
        syncState.recordDecline(ctx, userId, declineKeys(ctx, userId, id));
        const others = ctx.db.prepare('SELECT user_id FROM anime_sync WHERE service = ? AND user_id <> ?').all(syncState.SERVICE, userId);
        for (const { user_id: other } of others) {
            const state = syncState.readWatchState(ctx, other);
            syncState.recordDecline(ctx, other, state.added.filter((p) => p.anime_id === id).map((p) => p.key));
        }
        ctx.db.prepare('DELETE FROM animes WHERE id = ?').run(id);
    });
    return { body: { success: true } };
}

async function adaptations(ctx, { params }) {
    const id = parseId(params.id);
    const manga = ctx.db.prepare('SELECT id, title, alt_title, shelf_id FROM mangas WHERE id = ?').get(id);
    if (!manga || !access.accessibleShelfIds(ctx).includes(manga.shelf_id)) throw notFound('Reihe');
    return { body: await gateway.adaptationsOf(ctx, manga) };
}

/**
 * GET /anime/:id/season-chain: the TV main line of an AniList entry, followed live beyond the entries in the collection
 * (gateway.seasonChainOf); with AniList switched off the chain of the stored relations, without a request. `truncated`
 * ({ before, after }) names the directions the request cap ended early; the next call goes on from the cached steps.
 */
async function seasonChainLive(ctx, { params }) {
    const id = parseId(params.id);
    const row = loadRow(ctx, id);
    if ((row.kind || 'anime') !== 'anime' || !row.anilist_id) return { body: { seasons: [], truncated: { before: false, after: false } } };
    let chain;
    try {
        chain = await gateway.seasonChainOf(ctx, row.anilist_id, store.parseJson(row.relations, []));
    } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        throw new HttpError(503, 'AniList ist gerade nicht erreichbar. Bitte später erneut versuchen.', 'SOURCES_UNAVAILABLE');
    }
    const truncated = { before: !!(chain.truncated && chain.truncated.before), after: !!(chain.truncated && chain.truncated.after) };
    if (!chain.before.length && !chain.after.length) return { body: { seasons: [], truncated } };
    const byAni = ctx.db.prepare('SELECT * FROM animes WHERE anilist_id = ?');
    const byMal = ctx.db.prepare('SELECT * FROM animes WHERE mal_id = ?');
    const status = ctx.db.prepare('SELECT status FROM anime_progress WHERE anime_id = ? AND user_id = ?');
    const nodeOf = (n, current) => {
        const entry = current ? row : ((n.anilist_id && byAni.get(n.anilist_id)) || (n.mal_id && byMal.get(n.mal_id)) || null);
        return {
            in_collection_id: entry ? entry.id : null,
            anilist_id: n.anilist_id || null,
            mal_id: n.mal_id || null,
            title: (entry && (entry.title_de || entry.title)) || n.title,
            season_year: (entry && entry.season_year) || n.season_year || null,
            episodes: (entry && entry.episodes) || n.episodes || null,
            my_status: (entry && ctx.user && (status.get(entry.id, ctx.user.id) || {}).status) || null,
            current: !!current
        };
    };
    const self = { anilist_id: row.anilist_id, mal_id: row.mal_id, title: row.title, season_year: row.season_year, episodes: row.episodes };
    return { body: { seasons: [...chain.before.map((n) => nodeOf(n)), nodeOf(self, true), ...chain.after.map((n) => nodeOf(n))], truncated } };
}

const CSV_COLUMNS = [
    ['title', 'Titel'], ['title_de', 'Deutscher Titel'], ['anilist_id', 'AniList-ID'], ['mal_id', 'MAL-ID'], ['format', 'Format'],
    ['episodes', 'Folgen'], ['status', 'Status'], ['season_year', 'Jahr'], ['studios', 'Studios'], ['genres', 'Genres'],
    ['my_status', 'Mein Status'], ['my_episodes', 'Gesehene Folgen'], ['my_score', 'Bewertung'], ['notes', 'Notizen'],
    ['my_audio_language', 'Sprache (Ton)'], ['my_subtitle_language', 'Sprache (Untertitel)'], ['kind', 'Art']
];

/** Semicolon CSV with BOM and the formula guard of the collection export; progress columns are the caller's. */
function exportCsv(ctx) {
    const rows = ctx.db.prepare(`
        SELECT a.*, p.status AS my_status, p.episodes_watched AS my_episodes, p.score AS my_score,
               p.audio_language AS my_audio_language, p.subtitle_language AS my_subtitle_language,
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
    ratings,
    search, sources, list, detail, create, update, updateProgress, markWatched, resolveLink, syncState: syncStateOf, syncUpdate, syncRun,
    removeProgress, refresh, remove, adaptations, seasonSuggestion, seasonChainLive, exportCsv, PROGRESS_STATUSES, matchRows, candidateOf, preferred, servicePath, parseId,
    duplicateOf, collectionMatcher, insertPrepared, prepareExternal, applyWatched, strongHits, LOOKUP_FORMATS
};
