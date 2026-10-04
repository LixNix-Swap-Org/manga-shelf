const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, uploadsDir } = require('../db');
const { requireAuth, requireEditor } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { lookupLimiter, remoteImageLimiter } = require('../middleware/userLimits');
const { stripImageMetadata } = require('../utils/imageMeta');
const { fetchRemoteImage } = require('../utils/safeFetch');
const { qstr } = require('../utils/query');
const { normalizeIsbn, isValidIsbn } = require('../utils/isbn');
const mangaPassion = require('../mangaPassion');
const { lookupBookByIsbn, matchCollection, decodeHtmlEntities } = require('../services/isbnLookup');
const log = require('../utils/logger').child('lookup');
const { badRequest, sendError } = require('../utils/httpError');

const ANILIST_URL = 'https://graphql.anilist.co/';
const ANILIST_TIMEOUT_MS = 8000;
const ANILIST_MAX_BYTES = 1024 * 1024;
const SOURCE_DEADLINE_MS = 12000;
// mutable for tests only
const lookupTimings = { aniListTimeoutMs: ANILIST_TIMEOUT_MS, sourceDeadlineMs: SOURCE_DEADLINE_MS };

const ANILIST_QUERY = `
    query ($search: String) {
        Page(page: 1, perPage: 5) {
            media(search: $search, type: MANGA, sort: SEARCH_MATCH) {
                id
                title { romaji english native }
                description(asHtml: false)
                coverImage { extraLarge large medium }
                bannerImage
                status
                volumes
                genres
                staff(perPage: 5) {
                    edges {
                        role
                        node { name { full } }
                    }
                }
            }
        }
    }
`;

/** AniList text: line breaks kept, tags removed, then entities decoded (in this order, or "&lt;Twilight&gt;" would vanish as a tag). */
function cleanAniListDescription(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const text = decodeHtmlEntities(raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''))
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return text || null;
}

async function readTextCapped(res, maxBytes) {
    const declared = parseInt(res.headers.get('content-length'), 10);
    if (declared > maxBytes) throw new Error('Antwort zu groß');
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new Error('Antwort zu groß');
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function mapAniListMedia(m) {
    let author = null;
    if (m.staff?.edges) {
        const storyOrArt = m.staff.edges.find(e =>
            e.role?.toLowerCase().includes('story') ||
            e.role?.toLowerCase().includes('art') ||
            e.role?.toLowerCase().includes('original creator')
        );
        author = storyOrArt ? storyOrArt.node?.name?.full : m.staff.edges[0]?.node?.name?.full;
    }

    let status = 'Laufend';
    if (m.status === 'FINISHED') status = 'Abgeschlossen';
    else if (m.status === 'HIATUS') status = 'Pausiert';
    else if (m.status === 'CANCELLED') status = 'Abgebrochen';

    return {
        id: 'al_' + m.id,
        manga_passion_id: null,
        source: 'anilist',
        source_label: '🌐 AniList',
        title: m.title?.english || m.title?.romaji,
        alt_title: m.title?.native || m.title?.romaji,
        author: author || null,
        publisher: null,
        description: cleanAniListDescription(m.description),
        cover_image: m.coverImage?.extraLarge || m.coverImage?.large || m.coverImage?.medium || null,
        banner_image: m.bannerImage || null,
        tags: Array.isArray(m.genres) ? m.genres.join(', ') : null,
        total_volumes: m.volumes || null,
        status: status
    };
}

/**
 * AniList GraphQL search; never rejects and never hangs: any failure (HTTP error, dropped connection, slow drip,
 * oversized or broken JSON) gives []. The timeout also covers reading the body.
 */
async function searchAniList(queryTerm, { url = ANILIST_URL, timeoutMs = ANILIST_TIMEOUT_MS } = {}) {
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'MangaShelf/2.8.0'
            },
            body: JSON.stringify({ query: ANILIST_QUERY, variables: { search: queryTerm.trim() } }),
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (!res.ok) {
            await res.body?.cancel().catch(() => {});
            log.warn(`AniList lookup failed: HTTP ${res.status}`);
            return [];
        }
        const parsed = JSON.parse(await readTextCapped(res, ANILIST_MAX_BYTES));
        const list = parsed?.data?.Page?.media;
        return Array.isArray(list) ? list.filter(m => m && m.title).map(mapAniListMedia) : [];
    } catch (err) {
        log.warn('AniList lookup error:', err);
        return [];
    }
}

/** Resolves with `fallback` after `ms`, so one stuck source can never hold back the answer of the others. */
function withDeadline(promise, ms, fallback, label) {
    let timer;
    const timeout = new Promise(resolve => {
        timer = setTimeout(() => {
            log.warn(`${label} lookup took longer than ${ms} ms, answering without it`);
            resolve(fallback);
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 1. MANGA METADATA LOOKUP (Manga Passion and AniList in parallel, Manga Passion results first)
router.get('/lookup/manga', requireAuth, lookupLimiter, async (req, res) => {
    const queryTerm = qstr(req.query.q);
    if (!queryTerm || !queryTerm.trim()) {
        throw badRequest('Suchbegriff erforderlich');
    }

    const trimmed = queryTerm.trim();

    // Manga Passion (official German editions) and AniList run at the same time; one failing never blocks the other
    const deadline = lookupTimings.sourceDeadlineMs;
    const [mpResults, aniListResults] = await Promise.all([
        withDeadline(mangaPassion.searchMangaPassionForLookup(trimmed).catch(err => { log.warn('Manga Passion lookup error:', err); return []; }), deadline, [], 'Manga Passion'),
        withDeadline(searchAniList(trimmed, { timeoutMs: lookupTimings.aniListTimeoutMs }), deadline, [], 'AniList')
    ]);

    // Manga Passion hat Vorrang (deutsche Verlage, korrekte deutsche Bandzahlen & Cover)
    const combined = [...mpResults, ...aniListResults];
    res.json(combined);
});

const UNREACHABLE_IMAGE = 'Bild-URL nicht erreichbar oder nicht erlaubt';

/**
 * Status and a fixed German text for a failed remote image download; raw Node/DNS/TLS messages stay in the server log.
 * A blocked address and a name that does not resolve answer alike, so the endpoint does not reveal which internal
 * host names exist (only the response time still differs a little).
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

// 2. Download remote image (e.g. from AniList) and save locally to data/uploads
// SSRF-protected: public hosts only, size-capped, verified by magic bytes.
router.post('/upload-remote', requireEditor, remoteImageLimiter, async (req, res) => {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        throw badRequest('Ungültige Bild-URL');
    }
    let image;
    try {
        image = await fetchRemoteImage(url);
    } catch (e) {
        log.warn('Remote upload failed:', e);
        if (res.headersSent) return;
        const { status, error } = remoteImageError(e);
        return sendError(res, status, error);
    }
    const filename = crypto.randomUUID() + image.ext;
    await fs.promises.writeFile(path.join(uploadsDir, filename), stripImageMetadata(image.buffer, image.ext));
    res.json({ url: '/uploads/' + filename });
});

/** Adds who owns the matched volume, so the store scan can tell "mine" from "a household member's". */
function withOwnership(volume, userId) {
    if (!volume) return volume;
    const extra = db.prepare('SELECT type, notes FROM volumes WHERE id = ?').get(volume.id) || {};
    const owners = db.prepare(`
        SELECT vo.user_id, u.username FROM volume_owners vo JOIN users u ON u.id = vo.user_id
        WHERE vo.volume_id = ? ORDER BY vo.created_at, vo.user_id
    `).all(volume.id);
    return {
        ...volume,
        type: extra.type ?? null,
        notes: extra.notes ?? null,
        owned_by_me: owners.some(o => o.user_id === userId),
        owners: owners.map(o => o.username)
    };
}

// 3. RESILIENT GERMAN MANGA ISBN LOOKUP (DNB -> K10plus -> Google Books)
router.get('/lookup/isbn', requireAuth, async (req, res) => {
    const rawIsbn = qstr(req.query.isbn);
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
    const known = db.prepare('SELECT 1 FROM volumes WHERE isbn = ? LIMIT 1').get(isbn13);
    if (!known && lookupLimiter.consume(req, res)) return;
    const book = known ? null : await lookupBookByIsbn(cleanIsbn);
    if (!book && !known) {
        return res.json({
            isbn: cleanIsbn,
            found: false,
            message: 'Keine Metadaten für diese ISBN in DNB, K10plus oder Google Books gefunden.'
        });
    }

    const bookData = book || { title: '', volume_number: '1', volume_number_known: false, source: 'Sammlung' };
    const match = matchCollection(db, bookData, isbn13);
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

    res.json({
        isbn: cleanIsbn,
        found: true,
        book: bookData,
        matched_manga: match.manga,
        matched_volume: withOwnership(match.volume, req.user.id),
        match_reason: match.reason,
        matched_candidates: match.candidates
    });
});

// 4. File uploads (single and multiple)
router.post('/upload', requireEditor, upload.single('image'), (req, res) => {
    if (!req.file) throw badRequest('Keine Datei hochgeladen');
    res.json({ url: '/uploads/' + req.file.filename });
});

router.post('/upload/multiple', requireEditor, upload.array('images', 10), (req, res) => {
    if (!req.files || req.files.length === 0) throw badRequest('Keine Dateien hochgeladen');
    const urls = req.files.map(f => '/uploads/' + f.filename);
    res.json({ urls });
});

module.exports = router;
// internals for tests
module.exports.searchAniList = searchAniList;
module.exports.cleanAniListDescription = cleanAniListDescription;
module.exports.remoteImageError = remoteImageError;
module.exports.lookupTimings = lookupTimings;
