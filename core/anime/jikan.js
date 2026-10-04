// Jikan v4 adapter (MyAnimeList without a key): search, entry by MAL id with relations, manga search and the
// relations of a manga. No batching, no rate headers; the next episode is estimated from the broadcast slot.
const { requestJson } = require('./request');
const { emptyMeta, isoDay, cleanDescription, preferredTitle, estimateNextAiring } = require('./normalize');

const BASE = 'https://api.jikan.moe/v4';
const LABEL = 'MyAnimeList (Jikan)';

const STATUS = { 'Finished Airing': 'FINISHED', 'Currently Airing': 'RELEASING', 'Not yet aired': 'NOT_YET_RELEASED' };
const FORMAT = { TV: 'TV', Movie: 'MOVIE', OVA: 'OVA', ONA: 'ONA', Special: 'SPECIAL', Music: 'MUSIC', 'TV Special': 'SPECIAL', CM: 'SPECIAL', PV: 'SPECIAL' };
const RELATION = {
    Sequel: 'SEQUEL', Prequel: 'PREQUEL', Adaptation: 'ADAPTATION', 'Side Story': 'SIDE_STORY', 'Side story': 'SIDE_STORY',
    'Parent Story': 'PARENT', 'Parent story': 'PARENT', Summary: 'SUMMARY', 'Alternative Version': 'ALTERNATIVE', 'Alternative version': 'ALTERNATIVE',
    'Alternative Setting': 'ALTERNATIVE', 'Alternative setting': 'ALTERNATIVE', 'Spin-Off': 'SPIN_OFF', 'Spin-off': 'SPIN_OFF', Character: 'CHARACTER',
    'Full Story': 'SOURCE', 'Full story': 'SOURCE', Other: 'OTHER'
};

const get = (ctx, path, options) => requestJson(ctx, BASE + path, {
    headers: { Accept: 'application/json', 'User-Agent': `MangaShelf/${(ctx.config && ctx.config.appVersion) || 'dev'}` }
}, { label: LABEL, ...options });

const minutesOf = (duration) => {
    const m = /(?:(\d+)\s*hr)?\s*(?:(\d+)\s*min)?/.exec(String(duration || ''));
    const total = (Number(m && m[1]) || 0) * 60 + (Number(m && m[2]) || 0);
    return total || null;
};

function relationsOf(entry) {
    const groups = Array.isArray(entry.relations) ? entry.relations : [];
    const out = [];
    for (const group of groups) {
        for (const item of Array.isArray(group.entry) ? group.entry : []) {
            out.push({
                relation: RELATION[group.relation] || 'OTHER',
                kind: item.type === 'manga' ? 'MANGA' : 'ANIME',
                anilist_id: null,
                mal_id: item.mal_id || null,
                title: item.name || null,
                format: null, status: null, episodes: null, season_year: null, cover_url: null
            });
        }
    }
    return out;
}

/** Jikan anime -> AnimeMeta. */
function normalize(entry, nowMs = Date.now()) {
    const titles = Array.isArray(entry.titles) ? entry.titles : [];
    const typed = (type) => (titles.find((t) => t && t.type === type) || {}).title || null;
    const title = {
        romaji: entry.title || typed('Default'),
        english: entry.title_english || typed('English'),
        native: entry.title_japanese || typed('Japanese')
    };
    title.preferred = preferredTitle(title);
    const status = STATUS[entry.status] || null;
    const episodes = Number.isInteger(entry.episodes) ? entry.episodes : null;
    const next = status === 'RELEASING' ? estimateNextAiring(entry.broadcast, entry.aired && entry.aired.from, nowMs, episodes) : null;
    const image = entry.images || {};
    const startDate = isoDay(entry.aired && entry.aired.from);
    return emptyMeta({
        mal_id: entry.mal_id || null,
        title,
        synonyms: [...(Array.isArray(entry.title_synonyms) ? entry.title_synonyms : []), ...titles.filter((t) => t && !['Default', 'English', 'Japanese'].includes(t.type)).map((t) => t.title)].filter(Boolean),
        format: FORMAT[entry.type] || (entry.type ? 'UNKNOWN' : null),
        episodes,
        duration: minutesOf(entry.duration),
        status,
        season: entry.season ? String(entry.season).toUpperCase() : null,
        season_year: entry.year ?? (startDate ? Number(startDate.slice(0, 4)) : null),
        start_date: startDate,
        end_date: isoDay(entry.aired && entry.aired.to),
        cover_url: (image.jpg && (image.jpg.large_image_url || image.jpg.image_url)) || (image.webp && image.webp.large_image_url) || null,
        genres: Array.isArray(entry.genres) ? entry.genres.map((g) => g && g.name).filter(Boolean) : [],
        studios: Array.isArray(entry.studios) ? entry.studios.map((s) => s && s.name).filter(Boolean) : [],
        score: typeof entry.score === 'number' ? Math.round(entry.score * 10) : null,
        description: cleanDescription(entry.synopsis),
        next_airing: next,
        next_airing_estimated: Boolean(next),
        relations: relationsOf(entry),
        urls: { anilist: null, mal: entry.url || (entry.mal_id ? `https://myanimelist.net/anime/${entry.mal_id}` : null) },
        source: 'jikan',
        fetched_at: nowMs
    });
}

async function search(ctx, term, { limit = 8, timeoutMs, signal } = {}) {
    const { json } = await get(ctx, `/anime?q=${encodeURIComponent(term)}&limit=${limit}&sfw=true`, { timeoutMs, signal });
    const nowMs = ctx.now().getTime();
    return { metas: (Array.isArray(json.data) ? json.data : []).filter(Boolean).map((e) => normalize(e, nowMs)), rate: null };
}

async function byMalId(ctx, malId, { timeoutMs, signal } = {}) {
    try {
        const { json } = await get(ctx, `/anime/${Number(malId)}/full`, { timeoutMs, signal });
        return { meta: json.data ? normalize(json.data, ctx.now().getTime()) : null, rate: null };
    } catch (err) {
        if (err.kind === 'notfound') return { meta: null, rate: null };
        throw err;
    }
}

/** Manga search in the series-lookup shape (id 'mal_<id>', source 'mal'). */
async function searchManga(ctx, term, { limit = 5, timeoutMs, signal } = {}) {
    const { json } = await get(ctx, `/manga?q=${encodeURIComponent(term)}&limit=${limit}&sfw=true`, { timeoutMs, signal });
    return (Array.isArray(json.data) ? json.data : []).filter((m) => m && m.title).map(mangaLookupResult);
}

function mangaLookupResult(m) {
    const status = m.status === 'Finished' ? 'Abgeschlossen' : m.status === 'On Hiatus' ? 'Pausiert' : m.status === 'Discontinued' ? 'Abgebrochen' : 'Laufend';
    const author = Array.isArray(m.authors) && m.authors[0] ? m.authors[0].name : null;
    return {
        id: 'mal_' + m.mal_id,
        manga_passion_id: null,
        source: 'mal',
        source_label: '🌐 MyAnimeList',
        title: m.title_english || m.title,
        alt_title: m.title_japanese || m.title,
        author,
        publisher: null,
        description: cleanDescription(m.synopsis),
        cover_image: (m.images && m.images.jpg && (m.images.jpg.large_image_url || m.images.jpg.image_url)) || null,
        banner_image: null,
        tags: Array.isArray(m.genres) ? m.genres.map((g) => g.name).join(', ') : null,
        total_volumes: m.volumes || null,
        status
    };
}

/** Anime adaptations of a manga (first search hit): [{ relation: 'ADAPTATION', kind: 'ANIME', mal_id, title }]. */
async function adaptations(ctx, title, { timeoutMs, signal } = {}) {
    const { json } = await get(ctx, `/manga?q=${encodeURIComponent(title)}&limit=1`, { timeoutMs, signal });
    const hit = Array.isArray(json.data) ? json.data[0] : null;
    if (!hit) return { candidates: [] };
    const rel = await get(ctx, `/manga/${hit.mal_id}/relations`, { timeoutMs, signal });
    return { candidates: [{ title: { romaji: hit.title, english: hit.title_english, native: hit.title_japanese }, synonyms: [], relations: relationsOf({ relations: rel.json.data }) }] };
}

module.exports = { search, byMalId, searchManga, adaptations, normalize, mangaLookupResult, BASE, LABEL };
