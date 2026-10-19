// AnimeMeta: the one shape both sources are normalised to, plus the freshness
// rules, the merge by MAL id and the broadcast estimate for sources without an airing schedule.
const { titleKey } = require('../mangaPassion/classify');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const STATUSES = ['FINISHED', 'RELEASING', 'NOT_YET_RELEASED', 'CANCELLED', 'HIATUS'];
const FORMATS = ['TV', 'TV_SHORT', 'MOVIE', 'OVA', 'ONA', 'SPECIAL', 'MUSIC'];
const URL_KEYS = ['anilist', 'mal', 'tmdb', 'imdb'];

/** ä→a, ö→o, ü→u, ß→ss and every other accent or macron on a Latin letter (ū→u; AniList's search does not match them, TMDb spells "Shippūden"). Kana and kanji keep their marks. */
function foldUmlauts(text) {
    return String(text ?? '')
        .replace(/[äÄ]/g, (c) => (c === 'ä' ? 'a' : 'A'))
        .replace(/[öÖ]/g, (c) => (c === 'ö' ? 'o' : 'O'))
        .replace(/[üÜ]/g, (c) => (c === 'ü' ? 'u' : 'U'))
        .replace(/ß/g, 'ss')
        .normalize('NFD')
        .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
        .normalize('NFC');
}

const searchKey = (text) => titleKey(foldUmlauts(text));

/** 0..1: how well one of `titles` matches the query (same idea as the Manga Passion title keys). */
const titleScore = (query, titles) => keyScore(searchKey(query), titles.map(searchKey));

/** titleScore on keys made once by searchKey (matching many items against the same rows). */
function keyScore(q, keys) {
    if (!q) return 0;
    const qWords = new Set(q.split(' '));
    let best = 0;
    for (const t of keys) {
        if (!t) continue;
        let score;
        if (t === q || t.replace(/ /g, '') === q.replace(/ /g, '')) score = 1;
        else if (t.startsWith(q)) score = 0.9;
        else if (t.includes(q)) score = 0.8;
        else {
            const words = t.split(' ');
            const shared = words.filter((w) => qWords.has(w)).length;
            score = shared ? (0.7 * shared) / (words.length + qWords.size - shared) : 0;
        }
        if (score > best) best = score;
    }
    return best;
}

const allTitles = (meta) => [meta.title?.english, meta.title?.romaji, meta.title?.native, meta.title?.preferred, ...(meta.synonyms || [])].filter(Boolean);

/** Results ordered by title similarity; ties keep the order of the source (its own relevance). */
function rankByTitle(query, metas) {
    return metas
        .map((meta, index) => ({ meta, index, score: titleScore(query, allTitles(meta)) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((r) => r.meta);
}

const pad2 = (n) => String(n).padStart(2, '0');

/** AniList FuzzyDate { year, month, day } -> 'JJJJ', 'JJJJ-MM' or 'JJJJ-MM-TT'; null without a year. */
function fuzzyDate(d) {
    if (!d || !d.year) return null;
    if (!d.month) return String(d.year);
    return d.day ? `${d.year}-${pad2(d.month)}-${pad2(d.day)}` : `${d.year}-${pad2(d.month)}`;
}

/** ISO timestamp ('2023-09-29T00:00:00+00:00') or date -> 'JJJJ-MM-TT'. */
const isoDay = (value) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);

/** Description without HTML (keeps paragraph breaks) and without the "(Source: …)" tail. */
function cleanDescription(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let html = raw.replace(/<br\s*\/?>/gi, '\n');
    let previous;
    do {
        previous = html;
        html = html.replace(/<[^>]*>/g, '');
    } while (html !== previous);
    const text = html
        .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\s*\[Written by MAL Rewrite\]\s*$/i, '')
        .trim();
    return text || null;
}

const preferredTitle = (title) => title.english || title.romaji || title.native || null;

/**
 * Next check of a stored snapshot (ms): finished 14 days, not yet released daily (and on the start day), releasing at
 * the next episode + 30 min (at most 24 h), releasing without a known date every 12 h.
 */
function nextCheckAt(meta, nowMs) {
    const status = meta && meta.status;
    if (status === 'FINISHED' || status === 'CANCELLED') return nowMs + 14 * DAY;
    if (status === 'NOT_YET_RELEASED') {
        let next = nowMs + DAY;
        const start = meta.start_date && /^\d{4}-\d{2}-\d{2}$/.test(meta.start_date) ? Date.parse(`${meta.start_date}T00:00:00Z`) : NaN;
        if (Number.isFinite(start) && start > nowMs && start < next) next = start;
        return next;
    }
    if (status === 'RELEASING' && meta.next_airing && meta.next_airing.at && !meta.next_airing_estimated) {
        const eventAt = meta.next_airing.at * 1000 + 30 * MINUTE;
        return Math.max(nowMs + 5 * MINUTE, Math.min(eventAt, nowMs + DAY));
    }
    if (status === 'RELEASING') return nowMs + 12 * HOUR;
    return nowMs + 3 * DAY;
}

const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

/** Offset of `timeZone` from UTC at `utcMs` in ms (Intl, so it works in the browser too); 0 for unknown zones. */
function zoneOffset(utcMs, timeZone) {
    try {
        const parts = {};
        const format = new Intl.DateTimeFormat('en-US', {
            timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
        for (const p of format.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
        const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
        return asUtc - Math.floor(utcMs / 1000) * 1000;
    } catch (_) {
        return 0;
    }
}

/**
 * Next weekly broadcast after `nowMs` from { day: 'Fridays' | 'friday', time: '23:00', timezone: 'Asia/Tokyo' } and the
 * first air date: { episode, at (unix seconds) } or null. The episode number counts the weeks since the start.
 */
function estimateNextAiring(broadcast, airedFrom, nowMs, episodes = null) {
    if (!broadcast) return null;
    const dayName = String(broadcast.day || broadcast.day_of_the_week || '').toLowerCase().replace(/s$/, '');
    const weekday = WEEKDAYS[dayName];
    const time = /^(\d{1,2}):(\d{2})/.exec(String(broadcast.time || broadcast.start_time || ''));
    if (weekday === undefined || !time) return null;
    const timeZone = broadcast.timezone || 'Asia/Tokyo';
    const offset = zoneOffset(nowMs, timeZone);
    const local = new Date(nowMs + offset);
    let candidate = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), Number(time[1]), Number(time[2])) - offset;
    candidate += ((weekday - local.getUTCDay() + 7) % 7) * DAY;
    if (candidate <= nowMs) candidate += WEEK;
    const start = airedFrom ? Date.parse(airedFrom) : NaN;
    let episode = null;
    if (Number.isFinite(start) && start <= candidate) episode = Math.floor((candidate - start + DAY) / WEEK) + 1;
    if (episode && episodes && episode > episodes) return null;
    return { episode, at: Math.floor(candidate / 1000) };
}

/** Fields of `extra` fill what `base` lacks; both ids are kept. `base` is the preferred source (AniList). */
function mergeMeta(base, extra) {
    if (!base) return extra || null;
    if (!extra) return base;
    const pick = (a, b) => (a === null || a === undefined || a === '' || (Array.isArray(a) && !a.length) ? b : a);
    const title = {
        romaji: pick(base.title.romaji, extra.title.romaji),
        english: pick(base.title.english, extra.title.english),
        native: pick(base.title.native, extra.title.native)
    };
    title.preferred = preferredTitle(title);
    const merged = {
        ...base,
        mal_id: pick(base.mal_id, extra.mal_id),
        anilist_id: pick(base.anilist_id, extra.anilist_id),
        title,
        synonyms: [...new Set([...(base.synonyms || []), ...(extra.synonyms || [])])],
        source: 'merged',
        urls: Object.fromEntries(URL_KEYS.map((key) => [key, pick(base.urls?.[key], extra.urls?.[key]) ?? null]))
    };
    for (const key of ['format', 'episodes', 'duration', 'status', 'season', 'season_year', 'start_date', 'end_date', 'cover_url',
        'banner_url', 'genres', 'studios', 'score', 'description', 'relations', 'external_links', 'streaming_episodes', 'kind', 'tmdb_id',
        'tmdb_kind', 'imdb_id', 'original_language', 'spoken_languages', 'seasons', 'tmdb_genre_ids']) {
        merged[key] = pick(base[key], extra[key]);
    }
    if (!base.next_airing && extra.next_airing) {
        merged.next_airing = extra.next_airing;
        merged.next_airing_estimated = extra.next_airing_estimated;
    }
    return merged;
}

/** Results of both sources joined by MAL id (AniList first); entries without a MAL id stay as they are. */
function mergeResults(primary, secondary) {
    const byMal = new Map();
    const out = [];
    for (const meta of primary) {
        out.push(meta);
        if (meta.mal_id) byMal.set(meta.mal_id, out.length - 1);
    }
    for (const meta of secondary) {
        const at = meta.mal_id ? byMal.get(meta.mal_id) : undefined;
        if (at === undefined) {
            out.push(meta);
            if (meta.mal_id) byMal.set(meta.mal_id, out.length - 1);
        } else {
            out[at] = mergeMeta(out[at], meta);
        }
    }
    return out;
}

/** Empty AnimeMeta with the given fields set (adapters fill it). */
function emptyMeta(fields = {}) {
    return {
        kind: 'anime', mal_id: null, anilist_id: null, tmdb_id: null, tmdb_kind: null, imdb_id: null,
        title: { romaji: null, english: null, native: null, preferred: null }, synonyms: [],
        format: null, episodes: null, duration: null, status: null, season: null, season_year: null, start_date: null, end_date: null,
        cover_url: null, banner_url: null, genres: [], studios: [], score: null, description: null,
        next_airing: null, next_airing_estimated: false, relations: [],
        external_links: [], streaming_episodes: [],
        original_language: null, spoken_languages: [], seasons: [], tmdb_genre_ids: [],
        source: null, fetched_at: null,
        ...fields,
        urls: { anilist: null, mal: null, tmdb: null, imdb: null, ...(fields.urls || {}) }
    };
}

const ANIMATION_GENRE = 16;

/** A TMDb hit that is an anime (Japanese, genre Animation). */
const isTmdbAnime = (meta) => Boolean(meta && meta.tmdb_id && meta.original_language === 'ja' && (meta.tmdb_genre_ids || []).includes(ANIMATION_GENRE));

/** Year of a meta or a stored row: season_year, else the year of start_date. */
function yearOf(meta) {
    if (meta && meta.season_year) return Number(meta.season_year);
    const start = meta && typeof meta.start_date === 'string' ? /^(\d{4})/.exec(meta.start_date) : null;
    return start ? Number(start[1]) : null;
}

/** Best titleScore of a TMDb hit's titles (localised and original) against `titles`. */
const tmdbTwinScore = (meta, titles) => Math.max(0, ...[meta.title?.english, meta.title?.native].filter(Boolean).map((t) => titleScore(t, titles)));

/** TMDb anime hits folded into the same-year AniList hit whose titles match at 0.9 or more: { metas, rest }. */
function foldTmdbHits(metas, tmdbMetas) {
    const out = metas.slice();
    const rest = [];
    for (const hit of tmdbMetas) {
        const year = yearOf(hit);
        let best = -1;
        let bestScore = 0;
        if (isTmdbAnime(hit) && year) {
            out.forEach((meta, i) => {
                if (!meta.anilist_id || yearOf(meta) !== year) return;
                const score = tmdbTwinScore(hit, allTitles(meta));
                if (score >= 0.9 && score > bestScore) {
                    best = i;
                    bestScore = score;
                }
            });
        }
        if (best < 0) {
            rest.push(hit);
            continue;
        }
        const target = out[best];
        out[best] = {
            ...target,
            also_on: [...new Set([...(target.also_on || []), 'tmdb'])],
            folded_tmdb: target.folded_tmdb || { tmdb_kind: hit.tmdb_kind, tmdb_id: hit.tmdb_id }
        };
    }
    return { metas: out, rest };
}

module.exports = {
    STATUSES, FORMATS, MINUTE, HOUR, DAY, foldUmlauts, searchKey, titleScore, keyScore, rankByTitle, allTitles, fuzzyDate, isoDay,
    cleanDescription, preferredTitle, nextCheckAt, estimateNextAiring, zoneOffset, mergeMeta, mergeResults, emptyMeta, isTmdbAnime, yearOf,
    tmdbTwinScore, foldTmdbHits
};
