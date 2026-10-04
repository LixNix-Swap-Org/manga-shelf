// AniList adapter (GraphQL): search with aliases (several terms in one request), ids in batches of 50, relations,
// the manga search of the series lookup, the Viewer check of a personal token and the user's anime list (read and write).
const { requestJson, SourceError } = require('./request');
const { emptyMeta, fuzzyDate, cleanDescription, preferredTitle, FORMATS, STATUSES } = require('./normalize');
const { mapAniListMedia } = require('../anilist');

const API_URL = 'https://graphql.anilist.co/';
const LABEL = 'AniList';
const BATCH_SIZE = 50;

const MEDIA_FIELDS = `
    id idMal type format status episodes duration season seasonYear siteUrl
    startDate { year month day } endDate { year month day }
    title { romaji english native } synonyms
    coverImage { extraLarge large } bannerImage genres averageScore meanScore
    studios(isMain: true) { nodes { name } }
    nextAiringEpisode { episode airingAt }`;
const LINK_FIELDS = 'externalLinks { site url type } streamingEpisodes { title url site }';
const DETAIL_FIELDS = `${MEDIA_FIELDS}
    description(asHtml: false) ${LINK_FIELDS}
    relations { edges { relationType(version: 2) node { id idMal type format status episodes seasonYear title { romaji english native } coverImage { large } } } }`;
// the id batches of the background refresh carry the description and links too, so a sweep never empties them
const BATCH_FIELDS = `${MEDIA_FIELDS}
    description(asHtml: false) ${LINK_FIELDS}`;
const MANGA_FIELDS = `
    id idMal title { romaji english native } description(asHtml: false) coverImage { extraLarge large medium }
    bannerImage status volumes genres staff(perPage: 5) { edges { role node { name { full } } } }`;

function headers(credential, version) {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': `MangaShelf/${version || 'dev'}` };
    if (credential && credential.secret) h.Authorization = `Bearer ${credential.secret}`;
    return h;
}

async function post(ctx, query, variables, { credential, timeoutMs, signal } = {}) {
    const result = await requestJson(ctx, API_URL, {
        method: 'POST',
        headers: headers(credential, ctx.config && ctx.config.appVersion),
        body: JSON.stringify({ query, variables })
    }, { label: LABEL, timeoutMs, signal });
    return { data: result.json.data || {}, rate: result.rate };
}

function relationsOf(media) {
    const edges = media.relations && Array.isArray(media.relations.edges) ? media.relations.edges : [];
    return edges.filter((e) => e && e.node).map((e) => ({
        relation: e.relationType || 'OTHER',
        kind: e.node.type === 'MANGA' ? 'MANGA' : 'ANIME',
        anilist_id: e.node.id || null,
        mal_id: e.node.idMal || null,
        title: e.node.title ? preferredTitle(e.node.title) : null,
        format: e.node.format || null,
        status: e.node.status || null,
        episodes: e.node.episodes ?? null,
        season_year: e.node.seasonYear ?? null,
        cover_url: e.node.coverImage ? e.node.coverImage.large || null : null
    }));
}

const https = (url) => String(url).replace(/^http:\/\//i, 'https://');

/** externalLinks (https only) and streamingEpisodes (http upgraded, episode number from "Episode N - …"). */
function linksOf(media) {
    const external = Array.isArray(media.externalLinks) ? media.externalLinks : [];
    const streaming = Array.isArray(media.streamingEpisodes) ? media.streamingEpisodes : [];
    return {
        external_links: external
            .filter((l) => l && typeof l.url === 'string' && /^https?:\/\//i.test(l.url))
            .map((l) => ({ site: l.site || null, url: https(l.url), type: l.type || null })),
        streaming_episodes: streaming
            .filter((e) => e && typeof e.url === 'string' && /^https?:\/\//i.test(e.url))
            .map((e) => {
                const m = /^\s*Episode\s+(\d{1,4})\b/i.exec(e.title || '');
                return { title: e.title || null, url: https(e.url), site: e.site || null, episode: m ? Number(m[1]) : null };
            })
    };
}

/** AniList Media -> AnimeMeta. */
function normalize(media, nowMs = Date.now()) {
    const title = { romaji: media.title?.romaji || null, english: media.title?.english || null, native: media.title?.native || null };
    title.preferred = preferredTitle(title);
    const next = media.nextAiringEpisode && media.nextAiringEpisode.airingAt
        ? { episode: media.nextAiringEpisode.episode ?? null, at: media.nextAiringEpisode.airingAt }
        : null;
    return emptyMeta({
        anilist_id: media.id || null,
        mal_id: media.idMal || null,
        title,
        synonyms: Array.isArray(media.synonyms) ? media.synonyms.filter(Boolean) : [],
        format: FORMATS.includes(media.format) ? media.format : (media.format ? 'UNKNOWN' : null),
        episodes: Number.isInteger(media.episodes) ? media.episodes : null,
        duration: Number.isInteger(media.duration) ? media.duration : null,
        status: STATUSES.includes(media.status) ? media.status : null,
        season: media.season || null,
        season_year: media.seasonYear ?? (media.startDate && media.startDate.year) ?? null,
        start_date: fuzzyDate(media.startDate),
        end_date: fuzzyDate(media.endDate),
        cover_url: media.coverImage ? media.coverImage.extraLarge || media.coverImage.large || null : null,
        banner_url: media.bannerImage || null,
        genres: Array.isArray(media.genres) ? media.genres : [],
        studios: media.studios && Array.isArray(media.studios.nodes) ? media.studios.nodes.map((n) => n && n.name).filter(Boolean) : [],
        score: media.averageScore ?? media.meanScore ?? null,
        description: cleanDescription(media.description),
        next_airing: next,
        next_airing_estimated: false,
        relations: relationsOf(media),
        ...linksOf(media),
        urls: { anilist: media.siteUrl || (media.id ? `https://anilist.co/anime/${media.id}` : null), mal: media.idMal ? `https://myanimelist.net/anime/${media.idMal}` : null },
        source: 'anilist',
        fetched_at: nowMs
    });
}

/**
 * Several search terms in one request (Page, then aliases s1, s2, …): { metas: [[…], […]], rate }. `type` ANIME or MANGA; MANGA
 * gives the series-lookup shape (mapAniListMedia) instead of AnimeMeta.
 */
async function search(ctx, terms, { type = 'ANIME', perPage = 8, credential, timeoutMs, signal } = {}) {
    const fields = type === 'MANGA' ? MANGA_FIELDS : MEDIA_FIELDS;
    const adult = type === 'ANIME' ? ', isAdult: false' : '';
    const vars = terms.map((_, i) => `$s${i}: String`).join(', ');
    // the first term without alias: a single search is a plain Page query
    const alias = (i) => (i === 0 ? 'Page' : `s${i}`);
    const pages = terms.map((_, i) => `${i === 0 ? '' : `${alias(i)}: `}Page(page: 1, perPage: ${perPage}) { media(search: $s${i}, type: ${type}, sort: SEARCH_MATCH${adult}) { ${fields} } }`).join('\n');
    const query = `query (${vars}) {\n${pages}\n}`;
    const variables = Object.fromEntries(terms.map((t, i) => [`s${i}`, t]));
    const { data, rate } = await post(ctx, query, variables, { credential, timeoutMs, signal });
    const nowMs = ctx.now().getTime();
    const metas = terms.map((_, i) => {
        const page = data[alias(i)];
        const list = page && Array.isArray(page.media) ? page.media.filter((m) => m && m.title) : [];
        return type === 'MANGA' ? list.map((m) => ({ ...mapAniListMedia(m), mal_id: m.idMal || null })) : list.map((m) => normalize(m, nowMs));
    });
    return { metas, rate };
}

/** One entry with relations and description, by AniList id or MAL id. null when AniList does not know it. */
async function byId(ctx, { anilist_id, mal_id }, { credential, timeoutMs, signal } = {}) {
    const arg = anilist_id ? 'id: $id' : 'idMal: $id, type: ANIME';
    const query = `query ($id: Int) { Media(${arg}) { ${DETAIL_FIELDS} } }`;
    try {
        const { data, rate } = await post(ctx, query, { id: Number(anilist_id || mal_id) }, { credential, timeoutMs, signal });
        return { meta: data.Media ? normalize(data.Media, ctx.now().getTime()) : null, rate };
    } catch (err) {
        if (err.kind === 'notfound') return { meta: null, rate: null };
        throw err;
    }
}

/** Up to 50 ids per request (id_in or idMal_in): { metas, rate }; ids AniList does not know are missing. */
async function byIds(ctx, { anilist = [], mal = [] }, { credential, timeoutMs, signal } = {}) {
    const useMal = !anilist.length;
    const ids = (useMal ? mal : anilist).slice(0, BATCH_SIZE).map(Number);
    if (!ids.length) return { metas: [], rate: null };
    const filter = useMal ? 'idMal_in: $ids, type: ANIME' : 'id_in: $ids';
    const query = `query ($ids: [Int]) { Page(page: 1, perPage: ${BATCH_SIZE}) { media(${filter}) { ${BATCH_FIELDS} } } }`;
    const { data, rate } = await post(ctx, query, { ids }, { credential, timeoutMs, signal });
    const nowMs = ctx.now().getTime();
    const list = data.Page && Array.isArray(data.Page.media) ? data.Page.media.filter(Boolean) : [];
    return { metas: list.map((m) => normalize(m, nowMs)), rate };
}

/** Anime adaptations of a manga found by title: [{ relation, kind, anilist_id, mal_id, title, … }] and the manga hit. */
async function adaptations(ctx, title, { credential, timeoutMs, signal } = {}) {
    const query = `query ($s: String) { Page(page: 1, perPage: 3) { media(search: $s, type: MANGA, sort: SEARCH_MATCH) {
        id idMal title { romaji english native } synonyms
        relations { edges { relationType(version: 2) node { id idMal type format status episodes seasonYear title { romaji english native } coverImage { large } } } }
    } } }`;
    const { data, rate } = await post(ctx, query, { s: title }, { credential, timeoutMs, signal });
    const list = data.Page && Array.isArray(data.Page.media) ? data.Page.media.filter(Boolean) : [];
    return { candidates: list.map((m) => ({ title: m.title, synonyms: m.synonyms || [], relations: relationsOf(m) })), rate };
}

/** Viewer of a personal token: { id, name }; rejects with a SourceError (auth for a refused token). */
async function viewer(ctx, secret, { timeoutMs, signal } = {}) {
    const { data } = await post(ctx, 'query { Viewer { id name } }', {}, { credential: { secret }, timeoutMs, signal });
    if (!data.Viewer) throw new SourceError('auth', 'AniList lehnt den Token ab', { status: 401 });
    return { id: data.Viewer.id, name: data.Viewer.name };
}

const listEntryOf = (e) => ({
    mediaId: e.mediaId,
    status: e.status || null,
    progress: Number.isInteger(e.progress) ? e.progress : 0,
    updatedAt: Number.isInteger(e.updatedAt) ? e.updatedAt : null
});

/** The anime list of an AniList user: { entries: [{ mediaId, status, progress, updatedAt (unix s) }], rate }. */
async function listCollection(ctx, userId, { credential, timeoutMs, signal } = {}) {
    const query = 'query ($u: Int) { MediaListCollection(userId: $u, type: ANIME) { lists { entries { mediaId status progress updatedAt } } } }';
    const { data, rate } = await post(ctx, query, { u: Number(userId) }, { credential, timeoutMs, signal });
    const lists = data.MediaListCollection && Array.isArray(data.MediaListCollection.lists) ? data.MediaListCollection.lists : [];
    const seen = new Set();
    const entries = [];
    for (const list of lists) {
        for (const e of (list && Array.isArray(list.entries) ? list.entries : [])) {
            // custom lists repeat entries of the status lists
            if (!e || !Number.isInteger(e.mediaId) || seen.has(e.mediaId)) continue;
            seen.add(e.mediaId);
            entries.push(listEntryOf(e));
        }
    }
    return { entries, rate };
}

/** One list entry of an AniList user: { entry: { status, progress, updatedAt } | null, rate }. */
async function listEntry(ctx, userId, mediaId, { credential, timeoutMs, signal } = {}) {
    const query = 'query ($u: Int, $m: Int) { MediaList(userId: $u, mediaId: $m) { mediaId status progress updatedAt } }';
    try {
        const { data, rate } = await post(ctx, query, { u: Number(userId), m: Number(mediaId) }, { credential, timeoutMs, signal });
        return { entry: data.MediaList ? listEntryOf({ mediaId: Number(mediaId), ...data.MediaList }) : null, rate };
    } catch (err) {
        if (err.kind === 'notfound') return { entry: null, rate: null };
        throw err;
    }
}

/** Creates or updates the token owner's list entry: { entry, rate }. */
async function saveListEntry(ctx, { mediaId, progress, status }, { credential, timeoutMs, signal } = {}) {
    const query = 'mutation ($m: Int, $p: Int, $s: MediaListStatus) { SaveMediaListEntry(mediaId: $m, progress: $p, status: $s) { id mediaId status progress updatedAt } }';
    const { data, rate } = await post(ctx, query, { m: Number(mediaId), p: progress, s: status }, { credential, timeoutMs, signal });
    const saved = data.SaveMediaListEntry;
    return { entry: saved ? listEntryOf({ mediaId: Number(mediaId), ...saved }) : null, rate };
}

module.exports = { search, byId, byIds, adaptations, viewer, listCollection, listEntry, saveListEntry, normalize, BATCH_SIZE, API_URL, LABEL };
