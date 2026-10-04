// Monthly release calendar of Manga Passion: fetching (with cache) and matching against the user's collection.
const { normalizePublisher } = require('../lib/publishers');
const { inferVolumeType } = require('../lib/volumeType');
const { API_BASE, mpHeaders, fetchWithTimeout, readCache, writeCache } = require('./client');
const { classifyOfficialVolume, cleanOfficialDate } = require('./classify');
const { HttpError } = require('../errors');

const log = (ctx) => ctx.log.child('mp-releases');

const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
// the wording of v2.19.1, answered with 503 when neither the API nor an older cached copy of the month is there
const RELEASES_UNAVAILABLE = 'Fehler beim Abrufen der Manga-Passion-Neuerscheinungen';
const PAGE_SIZE = 100;
// upper bound for one month; the real page count follows hydra:totalItems of the first page
const HARD_MAX_PAGES = 20;
// a month that just failed is not asked again for a while (an outage would otherwise cost every request the timeout)
const FAILURE_TTL_MS = 10 * 60 * 1000;
// force_refresh within this window of the last fetch (or failure) is answered from the cache
const FORCE_COOLDOWN_MS = 60 * 1000;
const VOLUME_TYPES = new Set(['volume', 'special_edition', 'schuber', 'special']);
const SPECIAL_EDITION_RE = /\b(?:collector'?s?|limited|special|spezial)[\s-]+edition\b|\bvariant\b/i;
const EDITION_SUFFIX_RE = /^(?:(?:collector'?s?|limited|special|spezial)[\s-]+edition|variant(?:[\s-]+(?:edition|cover))?|schuber)\b/i;

/**
 * Entry type of a calendar entry. The edition title marks Collectors / Limited editions and Schuber ("X – Collectors
 * Edition"); otherwise the volume itself decides, like gap imports do (classifyOfficialVolume).
 */
function calendarItemType(item) {
    if (item.type && VOLUME_TYPES.has(item.type)) return item.type;
    const editionTitle = String(item.raw_title || item.title || '');
    if (/\bschuber\b/i.test(editionTitle)) return 'schuber';
    if (SPECIAL_EDITION_RE.test(editionTitle)) return 'special_edition';
    return classifyOfficialVolume({
        volume_number: item.volume_number, title: item.volume_title, specialType: item.special_type, type: item.mp_type ?? undefined
    });
}

/** API volume -> calendar entry. */
function mapRelease(v) {
    const rawTitle = v.edition?.title || '';
    const isDigital = Boolean(v.edition?.digital || rawTitle.includes('(eBook)'));
    const cleanTitle = rawTitle.replace(/\s*\(eBook\)/i, '').trim();
    const rawPub = v.edition?.publishers?.[0]?.name ? normalizePublisher(v.edition.publishers[0].name) : 'Unbekannt';
    const volumeTitle = typeof v.title === 'string' && v.title.trim() ? v.title.trim() : null;
    const hasNumber = v.numberDisplay || (v.number !== null && v.number !== undefined);
    // numberless specials (artbook, fanbook, box) are told apart by their title, like officialVolumeNumber() does
    const volumeNumber = hasNumber
        ? (v.numberDisplay || String(v.number))
        : (volumeTitle || `Special ${v.id}`);

    const item = {
        id: v.id,
        edition_id: v.edition?.id || null,
        title: cleanTitle,
        raw_title: rawTitle,
        volume_number: volumeNumber,
        volume_title: volumeTitle,
        special_type: v.specialType ?? null,
        mp_type: typeof v.type === 'number' ? v.type : null,
        publisher: rawPub,
        // "YYYY-MM" when Manga Passion only knows the month, null for its "no date yet" placeholder
        date: cleanOfficialDate(v),
        year: v.year,
        month: v.month,
        day: v.day,
        price: v.price ? Math.round(v.price) / 100 : null,
        cover_image: v.cover || null,
        pages: v.pages || null,
        is_digital: isDigital,
        format: v.format ?? 0
    };
    item.type = hasNumber ? calendarItemType(item) : (calendarItemType({ ...item, volume_number: 'Special' }));
    return item;
}

/**
 * All pages of one month. `complete` is false when a later page failed or the month exceeds HARD_MAX_PAGES
 * (`truncated`): usable, but not to be cached as the whole month. A failing first page throws.
 */
async function fetchReleasePages(ctx, year, month) {
    // Many releases share a day. Ordering by date alone is not stable across pages (the same entry can appear on two pages
    // and another on none: 272 of 280 entries seen), so the id breaks the ties.
    const baseUrl = `${API_BASE}/volumes?year=${year}&month=${month}&itemsPerPage=${PAGE_SIZE}&order[date]=asc&order[id]=asc`;
    let allVolumes = [];
    let complete = true;
    let totalItems = null;
    let maxPages = HARD_MAX_PAGES;
    let reachedCap = false;

    for (let page = 1; ; page++) {
        if (page > maxPages) { reachedCap = true; break; }
        try {
            const response = await fetchWithTimeout(ctx, `${baseUrl}&page=${page}`, { headers: mpHeaders(ctx) });
            if (!response.ok) {
                if (page === 1) throw new Error(`Manga Passion API Fehler (Status ${response.status})`);
                complete = false;
                break;
            }
            const data = await response.json();
            const members = data['hydra:member'] || (Array.isArray(data) ? data : []);
            if (members.length === 0) break;

            allVolumes = allVolumes.concat(members);
            const total = Number(data['hydra:totalItems']);
            if (data['hydra:totalItems'] !== undefined && Number.isFinite(total) && total >= 0) {
                totalItems = total;
                maxPages = Math.min(HARD_MAX_PAGES, Math.max(1, Math.ceil(total / PAGE_SIZE)));
            }
            if ((totalItems !== null && allVolumes.length >= totalItems) || members.length < PAGE_SIZE) break;
        } catch (fetchErr) {
            log(ctx).warn(`Error on page ${page}:`, fetchErr);
            if (allVolumes.length === 0) throw fetchErr;
            complete = false;
            break;
        }
    }
    // raw count, not the deduplicated one: the API repeats entries across pages
    const truncated = reachedCap && totalItems !== null && allVolumes.length < totalItems;
    if (truncated) {
        log(ctx).warn(`Calendar ${year}-${month} truncated: ${allVolumes.length} of ${totalItems} entries loaded`);
        complete = false;
    }
    // defensive: never show an entry twice even if the API repeats it
    const unique = [...new Map(allVolumes.map(v => [v.id, v])).values()];
    return { items: unique.map(mapRelease), complete, truncated };
}

const inFlight = new Map();
const failedAt = new Map();

/** One upstream fetch per month at a time; concurrent callers share it. Records failures for the negative cache. */
function fetchMonthShared(ctx, year, month, cacheKey) {
    let pending = inFlight.get(cacheKey);
    if (pending) return pending;
    pending = (async () => {
        try {
            const result = await fetchReleasePages(ctx, year, month);
            failedAt.delete(cacheKey);
            if (result.complete) writeCache(ctx, cacheKey, result.items);
            return result;
        } catch (err) {
            failedAt.set(cacheKey, Date.now());
            throw err;
        } finally {
            inFlight.delete(cacheKey);
        }
    })();
    inFlight.set(cacheKey, pending);
    return pending;
}

/** Resolves like `promise`, but rejects as soon as `signal` aborts; the underlying fetch keeps running and fills the cache. */
function untilAborted(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason || new Error('aborted'));
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason || new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
            (e) => { signal.removeEventListener('abort', onAbort); reject(e); }
        );
    });
}

// Calendar entries of a month: from the 12-hour cache, else the API. Only complete answers are cached; when the API
// is unreachable (or `signal` aborts) the last cached month is served with `stale: true`. A month that failed within
// FAILURE_TTL_MS is not refetched; `forceRefresh` only waits FORCE_COOLDOWN_MS.
async function getMonthlyReleases(ctx, year, month, forceRefresh = false, { signal } = {}) {
    const cacheKey = `mp_releases_${year}_${month}`;

    const cached = readCache(ctx, cacheKey, forceRefresh ? FORCE_COOLDOWN_MS : CACHE_TTL_MS);
    if (Array.isArray(cached)) return { items: cached, stale: false, truncated: false };

    const serveStale = (err, logIt = true) => {
        const old = readCache(ctx, cacheKey, Infinity);
        if (Array.isArray(old)) {
            if (logIt) log(ctx).warn(`Serving stale releases for ${year}-${month}:`, err);
            return { items: old, stale: true, truncated: false };
        }
        if (logIt) log(ctx).warn(`Releases ${year}-${month} unavailable:`, err);
        throw Object.assign(new HttpError(503, RELEASES_UNAVAILABLE, 'MP_UNAVAILABLE'), { cause: err });
    };

    if (signal?.aborted) return serveStale(signal.reason || new Error('aborted'), false);
    const lastFailure = failedAt.get(cacheKey);
    if (lastFailure && !inFlight.has(cacheKey) && Date.now() - lastFailure < (forceRefresh ? FORCE_COOLDOWN_MS : FAILURE_TTL_MS)) {
        return serveStale(new Error(`Manga Passion war für ${year}-${month} eben nicht erreichbar`), false);
    }

    try {
        const { items, truncated } = await untilAborted(fetchMonthShared(ctx, year, month, cacheKey), signal);
        return { items, stale: false, truncated };
    } catch (err) {
        return serveStale(err);
    }
}

/** True when the month is answered from the 12-hour cache without asking Manga Passion. */
function monthCached(ctx, year, month) {
    return Array.isArray(readCache(ctx, `mp_releases_${year}_${month}`, CACHE_TTL_MS));
}

/**
 * Fetches several months for the date check with at most `concurrency` months at once and one time budget for all of
 * them. Returns one entry per month in input order: { year, month, items } or { year, month, error }.
 */
async function fetchMonthsForCheck(ctx, months, { concurrency = 3, budgetMs = 12000 } = {}) {
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(new Error('Zeitbudget des Terminabgleichs aufgebraucht')), budgetMs);
    const results = new Array(months.length);
    let next = 0;
    const worker = async () => {
        while (next < months.length) {
            const i = next++;
            const { year, month } = months[i];
            try {
                const { items, stale } = await getMonthlyReleases(ctx, year, month, false, { signal: budget.signal });
                results[i] = { year, month, items, stale };
            } catch (error) {
                results[i] = { year, month, error };
            }
        }
    };
    try {
        await Promise.all(Array.from({ length: Math.min(concurrency, months.length) }, worker));
    } finally {
        clearTimeout(timer);
    }
    return results;
}

/** For tests: forget in-flight fetches and recorded failures. */
function resetReleaseFetchState() {
    inFlight.clear();
    failedAt.clear();
}

/** Comparison key of a title: accents folded, case and everything but letters / digits dropped (any script). */
const titleKey = (s) => String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const volumeKey = (n) => String(n ?? '').trim().toLowerCase();
// Number fallback of the matcher: a regular volume or a Schuber only by a number prefix ("Band", "Vol.", "Teil", "#",
// "Box" ...), never an edition word, so a row "Ultimative Edition 14" stored as type volume is not the calendar's "14";
// specials and special editions carry their own type.
const NUMBER_LABELS = {
    volume: /^(?:(?:band|bd\.?|vol(?:ume)?\.?|nr\.?|no\.?|teil|tome|ausgabe|#)\s*)?(\d+)$/i,
    schuber: /^(?:(?:schuber|box)\s*(?:nr\.?\s*)?)?(\d+)$/i
};
const ANY_LABEL = /^(?:\D*?\s)?(\d+)$/;
const labelNumberOf = (number, type) => {
    const m = String(number ?? '').trim().match(NUMBER_LABELS[type] || ANY_LABEL);
    return m ? parseInt(m[1], 10) : null;
};
const MIN_PREFIX_KEY = 4;
// match kinds that identify the user's volume, not just the series
const VOLUME_MATCH_KINDS = new Set(['volume_id', 'edition', 'exact', 'variant']);

/** A wished series: wish_priority set and no owned volume (owned_count from the query). */
const isWishedSeries = (m) => m.wish_priority !== null && m.wish_priority !== undefined && !(Number(m.owned_count) > 0);

// Lookup structures for matching calendar entries against the collection, built once per request.
// Series: linked MP volume > linked MP edition > title / alt title > prefix before "–", "-", ":" (badge only).
// Volumes: series + type + number ("Band 14", "Vol. 14", "Schuber 8" equal the calendar's "14" / "8" of that type;
// a Collectors Edition never stands in for the regular volume).
function buildMatcher(userMangas, userVolumes = []) {
    const mangaById = new Map();
    const byEdition = new Map();
    const byTitle = new Map();
    for (const m of userMangas) {
        mangaById.set(m.id, m);
        if (m.manga_passion_id && !byEdition.has(Number(m.manga_passion_id))) byEdition.set(Number(m.manga_passion_id), m);
    }
    const unlinkedFirst = [...userMangas.filter(m => !m.manga_passion_id), ...userMangas.filter(m => m.manga_passion_id)];
    for (const m of unlinkedFirst) {
        const k = titleKey(m.title);
        if (k && !byTitle.has(k)) byTitle.set(k, m);
    }
    // alt titles never shadow another series' main title
    for (const m of unlinkedFirst) {
        const k = titleKey(m.alt_title);
        if (k && !byTitle.has(k)) byTitle.set(k, m);
    }

    const volumeByKey = new Map();
    const volumeByNumber = new Map();
    // mp volume id -> rows linked to it; an import may link a Collectors Edition and the regular volume alike
    const volumesByMpId = new Map();
    for (const uv of userVolumes) {
        const type = inferVolumeType(uv);
        const key = `${uv.manga_id}:${type}:${volumeKey(uv.volume_number)}`;
        if (!volumeByKey.has(key)) volumeByKey.set(key, uv);
        const n = labelNumberOf(uv.volume_number, type);
        const numKey = `${uv.manga_id}:${type}:#${n}`;
        if (n !== null && !volumeByNumber.has(numKey)) volumeByNumber.set(numKey, uv);
        if (uv.manga_passion_volume_id) {
            const id = Number(uv.manga_passion_volume_id);
            if (!volumesByMpId.has(id)) volumesByMpId.set(id, []);
            volumesByMpId.get(id).push(uv);
        }
    }

    /**
     * The row linked to this calendar entry: same id and type. The id alone only when exactly one row holds it and its
     * series has no row of the entry's own type and number (an import links the id to one type only).
     */
    const linkedVolume = (item, type = calendarItemType(item)) => {
        const rows = item.id != null ? volumesByMpId.get(Number(item.id)) : null;
        if (!rows) return null;
        const sameType = rows.find(uv => inferVolumeType(uv) === type);
        if (sameType || rows.length !== 1) return sameType || null;
        const own = ownVolume(rows[0].manga_id, type, item.volume_number);
        return !own || own === rows[0] ? rows[0] : null;
    };

    const matchSeries = (item, type) => {
        const linkedVol = linkedVolume(item, type);
        if (linkedVol && mangaById.has(linkedVol.manga_id)) return { manga: mangaById.get(linkedVol.manga_id), kind: 'volume_id', volume: linkedVol };

        const linkedSeries = item.edition_id ? byEdition.get(Number(item.edition_id)) : null;
        if (linkedSeries) return { manga: linkedSeries, kind: 'edition' };

        const title = String(item.title || '');
        const key = titleKey(title);
        const exact = key ? byTitle.get(key) : null;
        if (exact) {
            const otherEdition = exact.manga_passion_id && item.edition_id && Number(exact.manga_passion_id) !== Number(item.edition_id);
            return { manga: exact, kind: otherEdition ? 'other_edition' : 'exact' };
        }

        const sep = title.search(/[–—\-:]/);
        if (sep > 0) {
            const prefixKey = titleKey(title.slice(0, sep));
            const prefixManga = prefixKey.length >= MIN_PREFIX_KEY ? byTitle.get(prefixKey) : null;
            if (prefixManga) {
                // "X – Collectors Edition" is a variant of X; "X – Episode Nagi" or "X: Novel" is another work
                const rest = title.slice(sep + 1).replace(/^[\s–—\-:]+/, '');
                return { manga: prefixManga, kind: EDITION_SUFFIX_RE.test(rest) ? 'variant' : 'prefix' };
            }
        }
        return null;
    };

    const ownVolume = (mangaId, type, number) => {
        const exact = volumeByKey.get(`${mangaId}:${type}:${volumeKey(number)}`);
        if (exact) return exact;
        const n = labelNumberOf(number, type);
        return n === null ? null : (volumeByNumber.get(`${mangaId}:${type}:#${n}`) || null);
    };

    const matchVolume = (item, match, type) => {
        if (match.volume) return match.volume;
        if (!VOLUME_MATCH_KINDS.has(match.kind)) return null;
        const uv = ownVolume(match.manga.id, type, item.volume_number);
        // a volume already linked to another Manga Passion volume (e.g. the print one) is not this entry
        if (!uv || (uv.manga_passion_volume_id && item.id != null && Number(uv.manga_passion_volume_id) !== Number(item.id))) return null;
        return uv;
    };

    const enrich = (rawItems) => rawItems.map(item => {
        const type = calendarItemType(item);
        const match = matchSeries(item, type);
        const vol = match ? matchVolume(item, match, type) : null;
        return {
            ...item,
            type,
            in_collection: Boolean(match),
            match_kind: match ? match.kind : null,
            user_manga_id: match ? match.manga.id : null,
            user_manga_title: match ? match.manga.title : null,
            user_manga_wished: Boolean(match && match.kind !== 'prefix' && isWishedSeries(match.manga)),
            user_manga_collecting: match && match.kind !== 'prefix' ? (match.manga.collecting || 'aktiv') : null,
            user_volume_status: vol ? vol.status : null,
            user_volume_id: vol ? vol.id : null
        };
    });

    return { enrich, matchSeries };
}

/** Marks which calendar entries belong to a series (and volume) of the user's collection. */
function enrichReleases(rawItems, userMangas, userVolumes) {
    return buildMatcher(userMangas, userVolumes).enrich(rawItems);
}

// Existing series an import without manga_id belongs to: the one linked to the entry's edition, else the same title
// or alt title (case / whitespace independent), else the same comparison key when long enough. By title, a series
// without an edition link (or linked to this one) wins. Never the prefix rule.
function findSeriesForImport(mangas, title, editionId = null) {
    const edition = Number(editionId) || null;
    if (edition) {
        const linked = mangas.find(m => Number(m.manga_passion_id) === edition);
        if (linked) return linked;
    }
    const lower = String(title || '').trim().toLowerCase();
    if (!lower) return null;
    const ordered = edition
        ? [...mangas.filter(m => !m.manga_passion_id), ...mangas.filter(m => m.manga_passion_id)]
        : mangas;
    const same = (s) => String(s || '').trim().toLowerCase() === lower;
    const byLower = ordered.find(m => same(m.title)) || ordered.find(m => same(m.alt_title));
    if (byLower) return byLower;
    const key = titleKey(title);
    if (key.length < MIN_PREFIX_KEY) return null;
    return ordered.find(m => titleKey(m.title) === key) || ordered.find(m => titleKey(m.alt_title) === key) || null;
}

const MAX_CHECK_MONTHS = 14;
// how far the check reaches back for overdue pre-orders, and beyond the latest stored date for postponements
const LOOKBACK_MONTHS = 1;
const LOOKAHEAD_MONTHS = 6;

// Months to compare against the calendar: from the earliest pending month (at most LOOKBACK_MONTHS back) to
// LOOKAHEAD_MONTHS after the latest (at least the next month), capped at MAX_CHECK_MONTHS. A postponed volume is
// listed under its new month, so the window reaches past the stored dates.
function monthsToCheck(pending, now = new Date()) {
    const indexOf = (d) => {
        const m = String(d || '').trim().match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
        if (!m) return null;
        const month = Number(m[2]);
        return month >= 1 && month <= 12 ? Number(m[1]) * 12 + month - 1 : null;
    };
    const idx = pending.map(p => indexOf(p.release_date)).filter(i => i !== null);
    if (!idx.length) return [];
    const cur = now.getFullYear() * 12 + now.getMonth();
    const start = Math.max(Math.min(cur, ...idx), cur - LOOKBACK_MONTHS);
    const end = Math.max(cur + 1, Math.max(...idx) + LOOKAHEAD_MONTHS);
    const months = [];
    for (let i = start; i <= end && months.length < MAX_CHECK_MONTHS; i++) {
        months.push({ year: Math.floor(i / 12), month: (i % 12) + 1 });
    }
    return months;
}

// Manga Passion's placeholder for "no date yet" (2999-12-31) is not a new date
const isKnownDate = (d) => /^\d{4}-\d{2}(-\d{2})?$/.test(String(d || '')) && Number(String(d).slice(0, 4)) < 2100;
const monthOf = (d) => {
    const m = String(d || '').trim().match(/^(\d{4})-(\d{1,2})/);
    return m ? `${m[1]}-${m[2].padStart(2, '0')}` : '';
};

/**
 * Pending volumes whose stored date differs from the calendar; `enriched` = entries after `enrichReleases`. Unchanged
 * when any print entry has the stored date; a month-only date on either side only counts when the month differs.
 */
function detectDateChanges(pending, enriched) {
    const byId = new Map(pending.map(p => [p.id, p]));
    const datesByVolume = new Map();
    for (const it of enriched) {
        const vol = byId.get(it.user_volume_id);
        if (!vol || it.is_digital || !isKnownDate(it.date)) continue;
        if (!datesByVolume.has(vol.id)) datesByVolume.set(vol.id, []);
        datesByVolume.get(vol.id).push(it.date);
    }
    const changes = [];
    for (const [id, dates] of datesByVolume) {
        const vol = byId.get(id);
        const stored = String(vol.release_date || '').trim();
        if (!stored) continue;
        // month precision on either side compares months only
        const storedMonthOnly = !/^\d{4}-\d{1,2}-\d{1,2}/.test(stored);
        const same = (d) => (storedMonthOnly || d.length <= 7 ? monthOf(stored) === monthOf(d) : stored === d);
        if (dates.some(same)) continue;
        changes.push({
            volume_id: vol.id, manga_id: vol.manga_id, manga_title: vol.manga_title,
            volume_number: vol.volume_number, type: vol.type ?? null, notes: vol.notes ?? null,
            status: vol.status, stored_date: stored, new_date: dates[0]
        });
    }
    return changes;
}

module.exports = {
    getMonthlyReleases, monthCached, fetchMonthsForCheck, resetReleaseFetchState,
    enrichReleases, buildMatcher, findSeriesForImport, calendarItemType, titleKey,
    mapRelease, monthsToCheck, detectDateChanges
};
