// Lookups for new series and scanned books: Manga Passion, AniList and MyAnimeList (GET /lookup/manga), ISBN catalogues and the
// collection (GET /lookup/isbn), and a cover taken from a URL into the uploads (POST /upload-remote).
const { qstr } = require('../lib/query');
const { normalizeIsbn, isValidIsbn } = require('../lib/isbn');
const { HttpError, badRequest, msg, payloadMsg } = require('../errors');
const client = require('../mangaPassion/client');
const gateway = require('../anime/gateway');
const cache = require('../anime/cache');
const { titleScore } = require('../anime/normalize');
const access = require('../lib/access');
const { lookupBookByIsbn, matchCollection } = require('../isbnLookup');
const { fetchImage } = require('../lib/imageCheck');
const { anySignal } = require('../lib/signals');
const { normalizeLanguage, isMpLanguage, workKeyOfHit } = require('../lib/language');

const log = (ctx) => ctx.log.child('lookup');

const SOURCE_DEADLINE_MS = 6000;
const SEARCH_TIMEOUT_MS = 5000;
const MAX_TERM_LENGTH = 100;
const MAX_HITS = 10;
const KEPT_MP_HITS = 3;
const FOLD_SCORE = 0.95;
const FOLD_FIELDS = ['author', 'alt_title', 'description', 'cover_image', 'tags', 'total_volumes'];
// mutable for tests only
const lookupTimings = { searchTimeoutMs: SEARCH_TIMEOUT_MS, sourceDeadlineMs: SOURCE_DEADLINE_MS };

/** Resolves with `fallback` after `ms` and aborts `controller`, so one stuck source can never hold back the others. */
function withDeadline(ctx, promise, ms, fallback, label, controller) {
    let timer;
    const timeout = new Promise(resolve => {
        timer = setTimeout(() => {
            log(ctx).warn(`${label} lookup took longer than ${ms} ms, answering without it`);
            controller.abort();
            resolve(fallback);
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const titlesOf = (hit) => [hit.title, hit.alt_title, ...(Array.isArray(hit.alt_titles) ? hit.alt_titles : [])].filter(Boolean);
const isEmpty = (value) => value === null || value === undefined || value === '';

function idNumber(id, prefix) {
    const m = new RegExp(`^${prefix}_(\\d+)$`).exec(String(id ?? ''));
    return m ? Number(m[1]) : null;
}

function foldPairs(mpHits, gatewayHits) {
    const matches = (mp, hit) => Boolean(mp.title) && titleScore(mp.title, titlesOf(hit)) >= FOLD_SCORE;
    const pairs = new Map();
    gatewayHits.forEach((hit, i) => {
        if (hit.source !== 'anilist' && hit.source !== 'mal') return;
        const targets = mpHits.map((mp, j) => j).filter((j) => matches(mpHits[j], hit));
        if (targets.length !== 1) return;
        const rival = gatewayHits.some((other, k) => k !== i && other.source === hit.source && matches(mpHits[targets[0]], other));
        if (!rival) pairs.set(i, targets[0]);
    });
    for (const [i, j] of [...pairs]) {
        if (gatewayHits[i].source !== 'mal') continue;
        const ani = [...pairs].find(([k, target]) => target === j && gatewayHits[k].source === 'anilist');
        if (ani && gatewayHits[ani[0]].mal_id) pairs.delete(i);
    }
    return pairs;
}

function foldInto(mp, folded) {
    const ani = folded.find((hit) => hit.source === 'anilist');
    const mal = folded.find((hit) => hit.source === 'mal');
    const out = { ...mp };
    for (const field of FOLD_FIELDS) {
        if (!isEmpty(out[field])) continue;
        const from = [ani, mal].find((hit) => hit && !isEmpty(hit[field]));
        if (from) out[field] = from[field];
    }
    const names = [ani, mal].filter(Boolean).flatMap((hit) => [hit.source, ...(Array.isArray(hit.also_on) ? hit.also_on : [])]);
    out.also_on = [...new Set(names)].filter((name) => name === 'anilist' || name === 'mal');
    out.work_key = workKeyOfHit(ani || mal);
    const anilistId = ani ? idNumber(ani.id, 'al') : null;
    const malId = ani && ani.mal_id ? Number(ani.mal_id) : (mal ? idNumber(mal.id, 'mal') : null);
    if (anilistId) out.anilist_id = anilistId;
    if (malId) out.mal_id = malId;
    return out;
}

/** Lookup hits folded into their Manga Passion edition, ranked by title and cut to 10 (up to 3 Manga Passion hits kept). */
function rankLookupHits(query, mpHits, gatewayHits) {
    const pairs = foldPairs(mpHits, gatewayHits);
    const entries = mpHits.map((mp, j) => {
        const folded = [...pairs].filter(([, target]) => target === j).map(([i]) => gatewayHits[i]);
        return folded.length
            ? { hit: foldInto(mp, folded), titles: [...titlesOf(mp), ...folded.flatMap(titlesOf)], mp: true }
            : { hit: mp, titles: titlesOf(mp), mp: true };
    });
    gatewayHits.forEach((hit, i) => {
        if (!pairs.has(i)) entries.push({ hit: { ...hit, work_key: workKeyOfHit(hit) }, titles: titlesOf(hit), mp: false });
    });
    const order = (a, b) => b.score - a.score || Number(b.mp) - Number(a.mp) || a.index - b.index;
    const ranked = entries.map((entry, index) => ({ ...entry, index, score: titleScore(query, entry.titles) })).sort(order);
    const top = ranked.slice(0, MAX_HITS);
    for (const entry of ranked.filter((e) => e.mp && e.score > 0).slice(0, KEPT_MP_HITS)) {
        if (top.includes(entry)) continue;
        let lowest = -1;
        for (let k = top.length - 1; k >= 0 && lowest < 0; k--) if (!top[k].mp) lowest = k;
        if (lowest < 0) break;
        top.splice(lowest, 1);
        top.push(entry);
    }
    return top.sort(order).map((entry) => entry.hit);
}

const FAILED = Symbol('failed');
const SOURCES_UNAVAILABLE = 'Manga Passion und AniList sind gerade nicht erreichbar. Reihe von Hand anlegen oder später erneut suchen.';

// Manga Passion (official German editions, only for ?language=de, the default) and the anime gateway (AniList,
// MyAnimeList: budget, cache) in parallel, folded and ranked. 503 SOURCES_UNAVAILABLE when no source could be asked, so
// "no hits" stays truthful. Gateway hits carry the work_key their editions share.
async function lookupManga(ctx, { query }) {
    const queryTerm = qstr(query.q);
    if (!queryTerm || !queryTerm.trim()) {
        throw badRequest('Suchbegriff erforderlich');
    }

    // capped like /anime/search: the term becomes an api_cache key
    const trimmed = queryTerm.trim().slice(0, MAX_TERM_LENGTH).trim();

    // one failing source never blocks the other
    const { sourceDeadlineMs: deadline, searchTimeoutMs: timeoutMs } = lookupTimings;
    const failed = (label) => (err) => {
        if (ctx.signal && ctx.signal.aborted) log(ctx).debug(`${label} lookup aborted`);
        else if (!err?.unavailable) log(ctx).warn(`${label} lookup error:`, err);
        return FAILED;
    };
    const branch = () => {
        const controller = new AbortController();
        return { controller, signal: anySignal([ctx.signal, controller.signal]) };
    };
    const mp = branch();
    const gw = branch();
    const askMangaPassion = isMpLanguage(normalizeLanguage(qstr(query.language)));
    const [mpResults, gatewayResults] = await Promise.all([
        askMangaPassion
            ? withDeadline(ctx, client.searchMangaPassionForLookup(ctx, trimmed, { signal: mp.signal, requestTimeoutMs: timeoutMs }).catch(failed('Manga Passion')),
                deadline, FAILED, 'Manga Passion', mp.controller)
            : Promise.resolve(FAILED),
        withDeadline(ctx, gateway.searchManga(ctx, trimmed, { timeoutMs, signal: gw.signal }).catch(failed('AniList/MyAnimeList')),
            deadline, FAILED, 'AniList/MyAnimeList', gw.controller)
    ]);
    if (mpResults === FAILED && gatewayResults === FAILED) throw new HttpError(503, SOURCES_UNAVAILABLE, 'SOURCES_UNAVAILABLE');
    return { body: rankLookupHits(trimmed, mpResults === FAILED ? [] : mpResults, gatewayResults === FAILED ? [] : gatewayResults) };
}

const UNREACHABLE_IMAGE = 'Bild-URL nicht erreichbar oder nicht erlaubt';

/**
 * Status and a fixed German text for a failed remote image download; raw network errors stay in the log.
 * A blocked address and an unresolvable name answer alike, so internal host names are not revealed.
 */
function remoteImageError(err) {
    const message = String(err && err.message || '');
    const code = String(err && err.code || '');
    if (/^Ungültige URL|^Nur http\(s\)|Zugangsdaten/.test(message)) return { status: 400, error: 'Ungültige Bild-URL' };
    if (message === 'Zieladresse nicht erlaubt' || code === 'ENOTFOUND' || code === 'ENODATA' || code.startsWith('EAI_')) {
        return { status: 400, error: UNREACHABLE_IMAGE };
    }
    if (message === 'Bild ist zu groß') return { status: 413, error: 'Bild ist zu groß (maximal 15 MB)' };
    if (message === 'Die Datei ist kein gültiges Bild') return { status: 415, error: 'Die Datei ist kein gültiges Bild' };
    if (message === 'Download-Zeitüberschreitung' || code === 'ETIMEDOUT') return { status: 504, error: 'Zeitüberschreitung beim Laden des Bildes' };
    return { status: 502, error: 'Bild konnte nicht geladen werden' };
}

// Remote image (e.g. from AniList) saved in the uploads: public hosts only, size-capped, checked by magic bytes
async function uploadRemote(ctx, { body }) {
    const { url } = body || {};
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        throw badRequest('Ungültige Bild-URL');
    }
    let image;
    try {
        image = await fetchImage(ctx, url);
    } catch (e) {
        log(ctx).warn('Remote upload failed:', e);
        const { status, error } = remoteImageError(e);
        throw new HttpError(status, error);
    }
    const filename = ctx.randomId() + image.ext;
    await ctx.files.write(filename, image.buffer, { image: image.ext });
    return { body: { url: ctx.files.url(filename) } };
}

/** Adds who owns the matched volume, so the store scan can tell "mine" from "a household member's". */
function withOwnership(ctx, volume, userId) {
    if (!volume) return volume;
    const extra = ctx.db.prepare('SELECT type, notes FROM volumes WHERE id = ?').get(volume.id) || {};
    const owners = ctx.db.prepare(`
        SELECT vo.user_id, u.username FROM volume_owners vo JOIN users u ON u.id = vo.user_id
        WHERE vo.volume_id = ? ORDER BY vo.created_at, vo.rowid
    `).all(volume.id);
    return {
        ...volume,
        type: extra.type ?? null,
        notes: extra.notes ?? null,
        owned_by_me: owners.some(o => o.user_id === userId),
        owners: owners.map(o => o.username)
    };
}

function cacheIsbn(ctx, key, book, ttlMs) {
    try {
        cache.write(ctx, key, { book }, ttlMs);
    } catch (err) {
        log(ctx).debug('ISBN cache write failed:', err && err.message);
    }
}

async function catalogueBook(ctx, cleanIsbn, isbn13) {
    const key = `isbn:${isbn13}`;
    const cached = cache.read(ctx, key);
    if (cached && cached.value) return cached.value.book || null;
    await ctx.limit('lookup');
    let complete = false;
    const book = await lookupBookByIsbn(ctx, cleanIsbn, { onSettled: (outcome) => { complete = Boolean(outcome && outcome.complete); } });
    if (book) cacheIsbn(ctx, key, book, cache.TTL.isbnFound);
    else if (complete) cacheIsbn(ctx, key, null, cache.TTL.isbnNotFound);
    return book;
}

// German ISBN lookup: DNB and K10plus, then Google Books (cached), then the match against the collection
async function lookupIsbn(ctx, { query }) {
    const rawIsbn = qstr(query.isbn);
    if (!rawIsbn || !rawIsbn.trim()) {
        throw badRequest('ISBN erforderlich');
    }

    const cleanIsbn = rawIsbn.replace(/[^0-9X]/gi, '').toUpperCase();
    if (cleanIsbn.length !== 10 && cleanIsbn.length !== 13) {
        throw badRequest('Ungültiges ISBN-Format (muss 10 oder 13 Zeichen lang sein)');
    }
    // a wrong check digit means a misread barcode (or no book at all): say so instead of three failing lookups
    if (!isValidIsbn(cleanIsbn)) {
        throw badRequest('Das ist keine gültige ISBN (Prüfziffer stimmt nicht). Bitte den Barcode erneut scannen.');
    }

    const isbn13 = normalizeIsbn(cleanIsbn);

    // a volume of the collection with this ISBN is certain and needs no catalogue (also works without internet)
    const mine = access.scopedCtx(ctx, access.accessibleShelfIds(ctx));
    const known = mine.db.prepare('SELECT 1 FROM volumes WHERE isbn = ? LIMIT 1').get(isbn13);
    const book = known ? null : await catalogueBook(ctx, cleanIsbn, isbn13);
    if (!book && !known) {
        return {
            body: {
                isbn: cleanIsbn,
                found: false,
                ...payloadMsg('message', msg('Keine Metadaten für diese ISBN in DNB, K10plus oder Google Books gefunden.'))
            }
        };
    }

    const bookData = book || { title: '', volume_number: '1', volume_number_known: false, source: 'Sammlung' };
    const match = matchCollection(mine.db, bookData, isbn13);
    if (match.number_in_title) {
        // "Eyeshield 21": the number belongs to the series name, the catalogue did not say which volume this is
        bookData.volume_number = '1';
        bookData.volume_number_known = false;
    }
    if (!book && match.volume) {
        // no catalogue entry: describe the book from our own volume
        bookData.title = match.manga ? match.manga.title : '';
        bookData.volume_number = match.volume.volume_number;
        bookData.volume_number_known = true;
    }

    return {
        body: {
            isbn: cleanIsbn,
            found: true,
            book: bookData,
            matched_manga: match.manga,
            matched_volume: withOwnership(ctx, match.volume, ctx.user.id),
            match_reason: match.reason,
            matched_candidates: match.candidates
        }
    };
}

module.exports = { lookupManga, lookupIsbn, uploadRemote, remoteImageError, rankLookupHits, lookupTimings };
