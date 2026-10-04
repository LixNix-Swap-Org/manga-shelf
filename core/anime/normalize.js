// AnimeMeta: the one shape both sources are normalised to (reports/design-anime-sources.md §2.1), plus the freshness
// rules, the merge by MAL id and the broadcast estimate for sources without an airing schedule.
const { titleKey } = require('../mangaPassion/classify');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const STATUSES = ['FINISHED', 'RELEASING', 'NOT_YET_RELEASED', 'CANCELLED', 'HIATUS'];
const FORMATS = ['TV', 'TV_SHORT', 'MOVIE', 'OVA', 'ONA', 'SPECIAL', 'MUSIC'];

/** ä→a, ö→o, ü→u, ß→ss (AniList's search does not match umlauts). */
function foldUmlauts(text) {
    return String(text ?? '')
        .replace(/[äÄ]/g, (c) => (c === 'ä' ? 'a' : 'A'))
        .replace(/[öÖ]/g, (c) => (c === 'ö' ? 'o' : 'O'))
        .replace(/[üÜ]/g, (c) => (c === 'ü' ? 'u' : 'U'))
        .replace(/ß/g, 'ss');
}

const searchKey = (text) => titleKey(foldUmlauts(text));

/** 0..1: how well one of `titles` matches the query (same idea as the Manga Passion title keys). */
function titleScore(query, titles) {
    const q = searchKey(query);
    if (!q) return 0;
    const qWords = new Set(q.split(' '));
    let best = 0;
    for (const raw of titles) {
        const t = searchKey(raw);
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
    const text = raw
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
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
        urls: { anilist: pick(base.urls?.anilist, extra.urls?.anilist), mal: pick(base.urls?.mal, extra.urls?.mal) }
    };
    for (const key of ['format', 'episodes', 'duration', 'status', 'season', 'season_year', 'start_date', 'end_date', 'cover_url',
        'banner_url', 'genres', 'studios', 'score', 'description', 'relations']) {
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
function emptyMeta(fields) {
    return {
        mal_id: null, anilist_id: null,
        title: { romaji: null, english: null, native: null, preferred: null }, synonyms: [],
        format: null, episodes: null, duration: null, status: null, season: null, season_year: null, start_date: null, end_date: null,
        cover_url: null, banner_url: null, genres: [], studios: [], score: null, description: null,
        next_airing: null, next_airing_estimated: false, relations: [], urls: { anilist: null, mal: null },
        source: null, fetched_at: null,
        ...fields
    };
}

module.exports = {
    STATUSES, FORMATS, MINUTE, HOUR, DAY, foldUmlauts, searchKey, titleScore, rankByTitle, allTitles, fuzzyDate, isoDay,
    cleanDescription, preferredTitle, nextCheckAt, estimateNextAiring, zoneOffset, mergeMeta, mergeResults, emptyMeta
};
