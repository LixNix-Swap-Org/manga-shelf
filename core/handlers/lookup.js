// Lookups for new series and scanned books: Manga Passion, AniList and MyAnimeList (GET /lookup/manga), ISBN catalogues and the
// collection (GET /lookup/isbn), and a cover taken from a URL into the uploads (POST /upload-remote).
const { qstr } = require('../lib/query');
const { normalizeIsbn, isValidIsbn } = require('../lib/isbn');
const { HttpError, badRequest } = require('../errors');
const client = require('../mangaPassion/client');
const { ANILIST_TIMEOUT_MS } = require('../anilist');
const gateway = require('../anime/gateway');
const { lookupBookByIsbn, matchCollection } = require('../isbnLookup');
const { fetchImage } = require('../lib/imageCheck');

const log = (ctx) => ctx.log.child('lookup');

const SOURCE_DEADLINE_MS = 12000;
const MAX_TERM_LENGTH = 100;
// mutable for tests only
const lookupTimings = { aniListTimeoutMs: ANILIST_TIMEOUT_MS, sourceDeadlineMs: SOURCE_DEADLINE_MS };

/** Resolves with `fallback` after `ms`, so one stuck source can never hold back the answer of the others. */
function withDeadline(ctx, promise, ms, fallback, label) {
    let timer;
    const timeout = new Promise(resolve => {
        timer = setTimeout(() => {
            log(ctx).warn(`${label} lookup took longer than ${ms} ms, answering without it`);
            resolve(fallback);
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const FAILED = Symbol('failed');
const SOURCES_UNAVAILABLE = 'Manga Passion und AniList sind gerade nicht erreichbar. Reihe von Hand anlegen oder später erneut suchen.';

// Manga Passion (official German editions) and the anime gateway (AniList, MyAnimeList: budget, cache) in parallel,
// Manga Passion results first. 503 SOURCES_UNAVAILABLE when no source could be asked, so "no hits" stays truthful.
async function lookupManga(ctx, { query }) {
    const queryTerm = qstr(query.q);
    if (!queryTerm || !queryTerm.trim()) {
        throw badRequest('Suchbegriff erforderlich');
    }

    // capped like /anime/search: the term becomes an api_cache key
    const trimmed = queryTerm.trim().slice(0, MAX_TERM_LENGTH).trim();

    // one failing source never blocks the other
    const deadline = lookupTimings.sourceDeadlineMs;
    const failed = (label) => (err) => {
        if (!err?.unavailable) log(ctx).warn(`${label} lookup error:`, err);
        return FAILED;
    };
    const [mpResults, gatewayResults] = await Promise.all([
        withDeadline(ctx, client.searchMangaPassionForLookup(ctx, trimmed).catch(failed('Manga Passion')), deadline, FAILED, 'Manga Passion'),
        withDeadline(ctx, gateway.searchManga(ctx, trimmed, { timeoutMs: lookupTimings.aniListTimeoutMs }).catch(failed('AniList/MyAnimeList')),
            deadline, FAILED, 'AniList/MyAnimeList')
    ]);
    if (mpResults === FAILED && gatewayResults === FAILED) throw new HttpError(503, SOURCES_UNAVAILABLE, 'SOURCES_UNAVAILABLE');

    // Manga Passion takes precedence (German publishers, correct German volume counts & covers)
    return { body: [...(mpResults === FAILED ? [] : mpResults), ...(gatewayResults === FAILED ? [] : gatewayResults)] };
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

// German ISBN lookup: DNB -> K10plus -> Google Books, then the match against the collection
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
    const known = ctx.db.prepare('SELECT 1 FROM volumes WHERE isbn = ? LIMIT 1').get(isbn13);
    if (!known) await ctx.limit('lookup');
    const book = known ? null : await lookupBookByIsbn(ctx, cleanIsbn);
    if (!book && !known) {
        return {
            body: {
                isbn: cleanIsbn,
                found: false,
                message: 'Keine Metadaten für diese ISBN in DNB, K10plus oder Google Books gefunden.'
            }
        };
    }

    const bookData = book || { title: '', volume_number: '1', volume_number_known: false, source: 'Sammlung' };
    const match = matchCollection(ctx.db, bookData, isbn13);
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

module.exports = { lookupManga, lookupIsbn, uploadRemote, remoteImageError, lookupTimings };
