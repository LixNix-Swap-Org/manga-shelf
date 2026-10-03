// Monthly release calendar of Manga Passion: fetching (with cache) and matching against the user's collection.
const { normalizePublisher } = require('../utils/publishers');
const log = require('../utils/logger').child('mp-releases');
const { API_BASE, HEADERS, fetchWithTimeout, readCache, writeCache } = require('./mangaPassion/client');

const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const PAGE_SIZE = 100;
// Many releases share a day. Ordering by date alone is not stable across pages (the same entry can appear on two pages and
// another on none: 272 of 280 entries seen), so the id breaks the ties.
const MAX_PAGES = 5;

/** API volume -> calendar entry. */
function mapRelease(v) {
    const rawTitle = v.edition?.title || '';
    const isDigital = Boolean(v.edition?.digital || rawTitle.includes('(eBook)'));
    const cleanTitle = rawTitle.replace(/\s*\(eBook\)/i, '').trim();
    const rawPub = v.edition?.publishers?.[0]?.name ? normalizePublisher(v.edition.publishers[0].name) : 'Unbekannt';

    return {
        id: v.id,
        edition_id: v.edition?.id || null,
        title: cleanTitle,
        raw_title: rawTitle,
        volume_number: v.numberDisplay || (v.number !== null && v.number !== undefined ? String(v.number) : 'Special'),
        publisher: rawPub,
        date: v.date ? v.date.slice(0, 10) : null,
        year: v.year,
        month: v.month,
        day: v.day,
        price: v.price ? Math.round(v.price) / 100 : null,
        cover_image: v.cover || null,
        pages: v.pages || null,
        is_digital: isDigital,
        format: v.format ?? 0
    };
}

/**
 * All pages of one month. `complete` is false when a later page failed: the entries are usable, but must not be cached
 * as if they were the whole month. A failing first page throws.
 */
async function fetchReleasePages(year, month) {
    const baseUrl = `${API_BASE}/volumes?year=${year}&month=${month}&itemsPerPage=${PAGE_SIZE}&order[date]=asc&order[id]=asc`;
    let allVolumes = [];
    let complete = true;

    for (let page = 1; page <= MAX_PAGES; page++) {
        try {
            const response = await fetchWithTimeout(`${baseUrl}&page=${page}`, { headers: HEADERS });
            if (!response.ok) {
                if (page === 1) throw new Error(`Manga Passion API Fehler (Status ${response.status})`);
                complete = false;
                break;
            }
            const data = await response.json();
            const members = data['hydra:member'] || (Array.isArray(data) ? data : []);
            if (members.length === 0) break;

            allVolumes = allVolumes.concat(members);
            const totalItems = data['hydra:totalItems'] || allVolumes.length;
            if (allVolumes.length >= totalItems || members.length < PAGE_SIZE) break;
        } catch (fetchErr) {
            log.warn(`Error on page ${page}:`, fetchErr.message);
            if (allVolumes.length === 0) throw fetchErr;
            complete = false;
            break;
        }
    }
    // defensive: never show an entry twice even if the API repeats it
    const unique = [...new Map(allVolumes.map(v => [v.id, v])).values()];
    return { items: unique.map(mapRelease), complete };
}

/**
 * Calendar entries of a month: from the 12-hour cache, else from the API. Only complete answers are cached; when the
 * API is unreachable the last cached month (any age) is served and `stale` is true.
 */
async function getMonthlyReleases(year, month, forceRefresh = false) {
    const cacheKey = `mp_releases_${year}_${month}`;

    if (!forceRefresh) {
        const cached = readCache(cacheKey, CACHE_TTL_MS);
        if (Array.isArray(cached)) return { items: cached, stale: false };
    }

    try {
        const { items, complete } = await fetchReleasePages(year, month);
        if (complete) writeCache(cacheKey, items);
        return { items, stale: false };
    } catch (err) {
        const old = readCache(cacheKey, Infinity);
        if (Array.isArray(old)) {
            log.warn(`Serving stale releases for ${year}-${month}:`, err.message);
            return { items: old, stale: true };
        }
        throw err;
    }
}

const cleanStr = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Marks which calendar entries belong to a series (and volume) of the user's collection. */
function enrichReleases(rawItems, userMangas, userVolumes) {
    const mangaMap = new Map();
    userMangas.forEach(m => {
        mangaMap.set(cleanStr(m.title), m);
        if (m.alt_title) mangaMap.set(cleanStr(m.alt_title), m);
    });

    const matchSeries = (title) => {
        const norm = cleanStr(title);
        if (mangaMap.has(norm)) return mangaMap.get(norm);

        const lower = title.toLowerCase();
        for (const m of userMangas) {
            if (m.title.toLowerCase() === lower) return m;
            if (m.alt_title && m.alt_title.toLowerCase() === lower) return m;
        }

        const prefix = title.split(/[–\-:]/)[0].trim();
        const normPre = cleanStr(prefix);
        if (normPre.length >= 4 && mangaMap.has(normPre)) return mangaMap.get(normPre);
        return null;
    };

    // first volume per series + number, so the lookup per entry is constant time
    const volumeByKey = new Map();
    userVolumes.forEach(uv => {
        const key = `${uv.manga_id}:${String(uv.volume_number).trim()}`;
        if (!volumeByKey.has(key)) volumeByKey.set(key, uv);
    });

    return rawItems.map(item => {
        const matchedManga = matchSeries(item.title);
        let userVolumeStatus = null;
        let userVolumeId = null;

        if (matchedManga) {
            const existingVol = volumeByKey.get(`${matchedManga.id}:${String(item.volume_number || '').trim()}`);
            if (existingVol) {
                userVolumeStatus = existingVol.status;
                userVolumeId = existingVol.id;
            }
        }

        return {
            ...item,
            in_collection: Boolean(matchedManga),
            user_manga_id: matchedManga ? matchedManga.id : null,
            user_manga_title: matchedManga ? matchedManga.title : null,
            user_volume_status: userVolumeStatus,
            user_volume_id: userVolumeId
        };
    });
}

module.exports = { getMonthlyReleases, enrichReleases, mapRelease };
