// MyAnimeList API v2 adapter (X-MAL-CLIENT-ID): used instead of Jikan when a personal or instance client id exists.
const { requestJson } = require('./request');
const { emptyMeta, cleanDescription, preferredTitle, estimateNextAiring } = require('./normalize');

const BASE = 'https://api.myanimelist.net/v2';
const LABEL = 'MyAnimeList';
const FIELDS = 'id,title,main_picture,alternative_titles,start_date,end_date,synopsis,mean,media_type,status,num_episodes,start_season,broadcast,average_episode_duration,studios,genres';
const DETAIL_FIELDS = `${FIELDS},related_anime,related_manga`;

const STATUS = { finished_airing: 'FINISHED', currently_airing: 'RELEASING', not_yet_aired: 'NOT_YET_RELEASED' };
const FORMAT = { tv: 'TV', movie: 'MOVIE', ova: 'OVA', ona: 'ONA', special: 'SPECIAL', music: 'MUSIC', tv_special: 'SPECIAL', cm: 'SPECIAL', pv: 'SPECIAL' };

const get = (ctx, path, credential, options) => requestJson(ctx, BASE + path, {
    headers: { Accept: 'application/json', 'X-MAL-CLIENT-ID': credential.secret, 'User-Agent': `MangaShelf/${(ctx.config && ctx.config.appVersion) || 'dev'}` }
}, { label: LABEL, ...options });

const relationOf = (type) => {
    const t = String(type || '').toUpperCase();
    return t === 'ALTERNATIVE_VERSION' || t === 'ALTERNATIVE_SETTING' ? 'ALTERNATIVE' : t === 'PARENT_STORY' ? 'PARENT' : t === 'FULL_STORY' ? 'SOURCE' : (t || 'OTHER');
};

/** MAL API anime node -> AnimeMeta. */
function normalize(node, nowMs = Date.now()) {
    const alt = node.alternative_titles || {};
    const title = { romaji: node.title || null, english: alt.en || null, native: alt.ja || null };
    title.preferred = preferredTitle(title);
    const status = STATUS[node.status] || null;
    const episodes = node.num_episodes > 0 ? node.num_episodes : null;
    const broadcast = node.broadcast ? { day: node.broadcast.day_of_the_week, time: node.broadcast.start_time, timezone: 'Asia/Tokyo' } : null;
    const next = status === 'RELEASING' ? estimateNextAiring(broadcast, node.start_date, nowMs, episodes) : null;
    const relations = [
        ...(Array.isArray(node.related_anime) ? node.related_anime : []).map((r) => ({ r, kind: 'ANIME' })),
        ...(Array.isArray(node.related_manga) ? node.related_manga : []).map((r) => ({ r, kind: 'MANGA' }))
    ].filter(({ r }) => r && r.node).map(({ r, kind }) => ({
        relation: relationOf(r.relation_type),
        kind,
        anilist_id: null,
        mal_id: r.node.id || null,
        title: r.node.title || null,
        format: null, status: null, episodes: null, season_year: null,
        cover_url: r.node.main_picture ? r.node.main_picture.large || r.node.main_picture.medium || null : null
    }));
    return emptyMeta({
        mal_id: node.id || null,
        title,
        synonyms: Array.isArray(alt.synonyms) ? alt.synonyms.filter(Boolean) : [],
        format: FORMAT[node.media_type] || (node.media_type ? 'UNKNOWN' : null),
        episodes,
        duration: node.average_episode_duration ? Math.round(node.average_episode_duration / 60) : null,
        status,
        season: node.start_season && node.start_season.season ? String(node.start_season.season).toUpperCase() : null,
        season_year: (node.start_season && node.start_season.year) || (node.start_date ? Number(String(node.start_date).slice(0, 4)) : null),
        start_date: node.start_date || null,
        end_date: node.end_date || null,
        cover_url: node.main_picture ? node.main_picture.large || node.main_picture.medium || null : null,
        genres: Array.isArray(node.genres) ? node.genres.map((g) => g && g.name).filter(Boolean) : [],
        studios: Array.isArray(node.studios) ? node.studios.map((s) => s && s.name).filter(Boolean) : [],
        score: typeof node.mean === 'number' ? Math.round(node.mean * 10) : null,
        description: cleanDescription(node.synopsis),
        next_airing: next,
        next_airing_estimated: Boolean(next),
        relations,
        urls: { anilist: null, mal: node.id ? `https://myanimelist.net/anime/${node.id}` : null },
        source: 'mal',
        fetched_at: nowMs
    });
}

async function search(ctx, term, { limit = 8, credential, timeoutMs, signal } = {}) {
    const { json } = await get(ctx, `/anime?q=${encodeURIComponent(term)}&limit=${limit}&fields=${FIELDS}`, credential, { timeoutMs, signal });
    const nowMs = ctx.now().getTime();
    return { metas: (Array.isArray(json.data) ? json.data : []).map((d) => d && d.node).filter(Boolean).map((n) => normalize(n, nowMs)), rate: null };
}

async function byMalId(ctx, malId, { credential, timeoutMs, signal } = {}) {
    try {
        const { json } = await get(ctx, `/anime/${Number(malId)}?fields=${DETAIL_FIELDS}`, credential, { timeoutMs, signal });
        return { meta: json && json.id ? normalize(json, ctx.now().getTime()) : null, rate: null };
    } catch (err) {
        if (err.kind === 'notfound') return { meta: null, rate: null };
        throw err;
    }
}

/** Check of a client id; resolves on 200, rejects with a SourceError (auth for a refused id). */
async function check(ctx, clientId, { timeoutMs, signal } = {}) {
    await get(ctx, '/anime?q=frieren&limit=1', { secret: clientId }, { timeoutMs, signal });
    return { label: `Client-ID …${String(clientId).slice(-4)}` };
}

module.exports = { search, byMalId, check, normalize, BASE, LABEL };
