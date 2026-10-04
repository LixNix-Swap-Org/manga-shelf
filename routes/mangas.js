const express = require('express');
const router = express.Router();
const { db, runTransaction } = require('../db');
const { requireAuth, requireEditor } = require('../middleware/auth');
const { normalizePublisher } = require('../utils/publishers');
const {
    reconcileMangaGaps,
    syncMangaWithEdition,
    batchImportGaps,
    autofillMangaVolumes,
    toEditionId
} = require('../mangaPassion');
const { GAP_IMPORT_STATUSES } = require('../services/mangaPassion/gaps');
const { qstr } = require('../utils/query');
const snapshot = require('../services/snapshot');
const { conditional } = require('../utils/dataVersion');
const { badRequest, notFound, conflict } = require('../utils/httpError');

// The UI offers Laufend/Abgeschlossen/Pausiert/Geplant; the AniList lookup also sends Abgebrochen.
const MANGA_STATUSES = ['Laufend', 'Abgeschlossen', 'Pausiert', 'Abgebrochen', 'Geplant'];
// Manga Passion reports an unknown run state as 'Unbekannt'
const MANGA_STATUS_ALIASES = { Unbekannt: 'Laufend' };

// strict: reject an over-long value (a cut URL is broken); otherwise cut it like the POST handler always did
const TEXT_FIELDS = {
    alt_title: { max: 300, label: 'Alternativtitel' },
    author: { max: 300, label: 'Autor' },
    publisher: { max: 300, label: 'Verlag' },
    language: { max: 50, label: 'Sprache' },
    tags: { max: 500, label: 'Tags' },
    description: { max: 10000, label: 'Beschreibung' },
    cover_image: { max: 2048, label: 'Cover', strict: true },
    banner_image: { max: 2048, label: 'Banner', strict: true }
};

const TOTAL_VOLUMES_ERROR = 'Gesamtbände muss eine ganze Zahl zwischen 1 und 5000 sein';

function cleanText(field, value) {
    const spec = TEXT_FIELDS[field];
    if (value === undefined || value === null) return { value: null };
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
        return { error: `${spec.label} muss ein Text sein` };
    }
    const text = String(value).trim();
    if (!text) return { value: null };
    if (text.length > spec.max) {
        if (spec.strict) return { error: `${spec.label} ist zu lang (maximal ${spec.max} Zeichen)` };
        return { value: text.slice(0, spec.max) };
    }
    return { value: text };
}

function parseSeriesStatus(value) {
    if (value === undefined || value === null || value === '') return { value: 'Laufend' };
    const status = typeof value === 'string' ? (MANGA_STATUS_ALIASES[value.trim()] || value.trim()) : null;
    if (!MANGA_STATUSES.includes(status)) {
        return { error: 'Ungültiger Status (erlaubt: ' + MANGA_STATUSES.join(', ') + ')' };
    }
    return { value: status };
}

/** null, '' and 0 clear the total; anything else must be a whole number from 1 to 5000. */
function parseTotalVolumes(value) {
    if (value === undefined || value === null) return { value: null };
    const text = typeof value === 'number' ? String(value) : (typeof value === 'string' ? value.trim() : null);
    if (text === '') return { value: null };
    if (text === null || !/^\d+$/.test(text)) return { error: TOTAL_VOLUMES_ERROR };
    const n = Number(text);
    if (n === 0) return { value: null };
    if (n > 5000) return { error: TOTAL_VOLUMES_ERROR };
    return { value: n };
}

/** Positive integer id (number or digit string); parseInt would accept '12abc' or 1.5. */
function parsePositiveInt(value) {
    const text = typeof value === 'number' ? String(value) : (typeof value === 'string' ? value.trim() : '');
    if (!/^\d+$/.test(text)) return null;
    const n = Number(text);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function parseOptionalId(value) {
    if (value === undefined || value === null || value === '' || value === 0) return { value: null };
    const id = parsePositiveInt(value);
    return id ? { value: id } : { error: true };
}

function parseFlag(value, fallback) {
    if (value === undefined || value === null) return fallback;
    return value === true || value === 'true' || value === 1 || value === '1';
}

/**
 * Validated manga columns from a request body; only fields present in the body are returned. With `stored` (PUT), a
 * text field sent back unchanged is left out, so a legacy value (e.g. a long data: cover) does not block other edits.
 */
function readMangaFields(body, stored = null) {
    const fields = {};
    for (const field of Object.keys(TEXT_FIELDS)) {
        if (body[field] === undefined) continue;
        if (stored && typeof body[field] === 'string' && typeof stored[field] === 'string'
            && body[field].trim() === stored[field].trim()) continue;
        const r = cleanText(field, body[field]);
        if (r.error) return { error: r.error };
        fields[field] = r.value;
    }
    if (fields.publisher !== undefined) fields.publisher = normalizePublisher(fields.publisher);
    if (body.total_volumes !== undefined) {
        const r = parseTotalVolumes(body.total_volumes);
        if (r.error) return { error: r.error };
        fields.total_volumes = r.value;
    }
    if (body.manga_passion_id !== undefined) {
        const r = parseOptionalId(body.manga_passion_id);
        if (r.error) return { error: 'Ungültige Manga-Passion-ID' };
        fields.manga_passion_id = r.value;
    }
    return { fields };
}

// --- MANGA API ---
// The read endpoints answer 304 from the data version before any query runs (utils/dataVersion.js)
router.get('/mangas', requireAuth, conditional(), (req, res) => {
    res.json(snapshot.listMangas(req.user.id));
});

router.post('/mangas', requireEditor, (req, res) => {
    const { title } = req.body;
    if (!title || typeof title !== 'string' || !title.trim()) {
        throw badRequest('Titel darf nicht leer sein');
    }
    const cleanTitle = title.trim();
    if (cleanTitle.length > 300) {
        throw badRequest('Titel ist zu lang (maximal 300 Zeichen)');
    }
    const { fields, error } = readMangaFields(req.body);
    if (error) throw badRequest(error);
    const status = parseSeriesStatus(req.body.status);
    if (status.error) throw badRequest(status.error);

    const stmt = db.prepare(`
        INSERT INTO mangas (title, alt_title, author, publisher, language, status, tags, total_volumes, description, cover_image, banner_image, manga_passion_id, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
        cleanTitle,
        fields.alt_title ?? null,
        fields.author ?? null,
        fields.publisher ?? null,
        fields.language || 'Deutsch',
        status.value,
        fields.tags ?? null,
        fields.total_volumes ?? null,
        fields.description ?? null,
        fields.cover_image ?? null,
        fields.banner_image ?? null,
        fields.manga_passion_id ?? null,
        req.user.id
    );
    res.json({ success: true, id: Number(result.lastInsertRowid) });
});

router.get('/mangas/:id', requireAuth, conditional(), (req, res) => {
    const manga = snapshot.loadMangaDetail(req.params.id, req.user.id);
    if (!manga) {
        throw notFound('Manga');
    }
    res.json(manga);
});

// Whole collection in one response so the client can keep a read-only offline copy. A restore during the build
// rejects with status 503, which the error handler passes on with its message.
router.get('/offline-snapshot', requireAuth, conditional({ cacheControl: 'private, no-store' }), async (req, res) => {
    res.json(await snapshot.buildOfflineSnapshot(req.user));
});

// owned_volumes is derived from the volumes and never taken from the body
router.put('/mangas/:id', requireEditor, (req, res) => {
    const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(req.params.id);
    if (!manga) throw notFound('Manga');

    const body = req.body;
    if (body.title !== undefined) {
        if (typeof body.title !== 'string' || !body.title.trim()) {
            throw badRequest('Titel darf nicht leer sein');
        }
        if (body.title.trim().length > 300) {
            throw badRequest('Titel ist zu lang (maximal 300 Zeichen)');
        }
    }
    const { fields, error } = readMangaFields(body, manga);
    if (error) throw badRequest(error);
    // a stored status from before the whitelist may be sent back unchanged
    let status = manga.status || 'Laufend';
    if (body.status !== undefined && body.status !== manga.status) {
        const r = parseSeriesStatus(body.status);
        if (r.error) throw badRequest(r.error);
        status = r.value;
    }
    const pick = (field) => (fields[field] !== undefined ? fields[field] : manga[field]);

    db.prepare(`
        UPDATE mangas SET title = ?, alt_title = ?, author = ?, publisher = ?, 
        language = ?, status = ?, tags = ?, total_volumes = ?, 
        description = ?, cover_image = ?, 
        banner_image = ?, manga_passion_id = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(
        body.title !== undefined ? body.title.trim() : manga.title,
        pick('alt_title') || null,
        pick('author') || null,
        fields.publisher !== undefined ? fields.publisher : (normalizePublisher(manga.publisher) || null),
        pick('language') || 'Deutsch',
        status,
        pick('tags') || null,
        pick('total_volumes') ?? null,
        pick('description') || null,
        pick('cover_image') || null,
        pick('banner_image') || null,
        pick('manga_passion_id') ?? null,
        req.user.id,
        req.params.id
    );
    res.json({ success: true });
});

router.delete('/mangas/:id', requireEditor, (req, res) => {
    let deleted = false;
    runTransaction(() => {
        db.prepare('DELETE FROM volume_reads WHERE volume_id IN (SELECT id FROM volumes WHERE manga_id = ?)').run(req.params.id);
        db.prepare('DELETE FROM volumes WHERE manga_id = ?').run(req.params.id);
        const result = db.prepare('DELETE FROM mangas WHERE id = ?').run(req.params.id);
        deleted = result.changes > 0;
    });

    if (!deleted) throw notFound('Manga');
    res.json({ success: true });
});

// 404 instead of a logged 500 when the series of a Manga Passion action does not exist
const mangaExists = (req, res, next) => {
    if (!db.prepare('SELECT id FROM mangas WHERE id = ?').get(parseInt(req.params.id, 10))) {
        throw notFound('Manga');
    }
    next();
};

// --- MANGA GAPS CHECK (Manga Passion Live-Abgleich) ---
// Every role may run the check; only editors and admins store an automatically found edition link.
router.get('/mangas/:id/gaps', requireAuth, mangaExists, async (req, res) => {
    const mangaId = parseInt(req.params.id, 10);
    const rawEdition = qstr(req.query.edition_id);
    let editionId = null;
    if (rawEdition !== undefined && rawEdition !== '') {
        editionId = toEditionId(rawEdition);
        if (!editionId) throw badRequest('Ungültige edition_id');
    }
    const forceRefresh = qstr(req.query.force_refresh) === 'true';
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });

    const result = await reconcileMangaGaps(mangaId, {
        edition_id: editionId,
        force_refresh: forceRefresh,
        persist: ['admin', 'editor'].includes(req.user.role),
        signal: ac.signal
    });
    res.json(result);
});

// --- SYNC MANGA WITH MANGA PASSION EDITION ---
router.post('/mangas/:id/sync-edition', requireEditor, mangaExists, async (req, res) => {
    const mangaId = parseInt(req.params.id, 10);
    const { edition_id, update_total_volumes, update_status, update_publisher } = req.body;
    if (edition_id === undefined || edition_id === null || edition_id === '') {
        throw badRequest('edition_id ist erforderlich');
    }
    const editionId = toEditionId(edition_id);
    if (!editionId) throw badRequest('Ungültige edition_id');

    const updatedManga = await syncMangaWithEdition(mangaId, editionId, {
        update_total_volumes: parseFlag(update_total_volumes, true),
        update_status: parseFlag(update_status, false),
        update_publisher: parseFlag(update_publisher, false)
    });

    res.json({ success: true, manga: updatedManga });
});

// --- BATCH IMPORT GAPS FROM MANGA PASSION ---
const MAX_GAP_ENTRIES = 500;
// raw UI labels such as "26 (Titel)"; the stored number is limited separately in batchImportGaps
const MAX_GAP_LABEL_LENGTH = 200;
router.post('/mangas/:id/batch-import-gaps', requireEditor, mangaExists, async (req, res) => {
    const mangaId = parseInt(req.params.id, 10);
    const { volume_numbers, target_status, edition_id, confirm_edition } = req.body;

    if (!Array.isArray(volume_numbers) || volume_numbers.length === 0) {
        throw badRequest('volume_numbers Array ist erforderlich');
    }
    if (volume_numbers.length > MAX_GAP_ENTRIES) {
        throw badRequest(`Zu viele Einträge (maximal ${MAX_GAP_ENTRIES})`);
    }
    const entries = [];
    for (const entry of volume_numbers) {
        const valid = typeof entry === 'string' || (typeof entry === 'number' && Number.isFinite(entry));
        const label = valid ? String(entry).trim() : '';
        if (!label || label.length > MAX_GAP_LABEL_LENGTH) {
            throw badRequest(`Ungültiger Eintrag in volume_numbers (Text oder Zahl, 1 bis ${MAX_GAP_LABEL_LENGTH} Zeichen)`);
        }
        entries.push(label);
    }
    let status = 'Fehlt';
    if (target_status !== undefined && target_status !== null && target_status !== '') {
        if (typeof target_status !== 'string' || !GAP_IMPORT_STATUSES.includes(target_status)) {
            throw badRequest('Ungültiger Zielstatus (erlaubt: ' + GAP_IMPORT_STATUSES.join(', ') + ')');
        }
        status = target_status;
    }
    const edition = parseOptionalId(edition_id);
    if (edition.error) throw badRequest('Ungültige edition_id');
    // prices, dates and covers of a guessed edition are only written once the user confirmed that edition
    if (edition.value && !parseFlag(confirm_edition, false)) {
        const linked = toEditionId(db.prepare('SELECT manga_passion_id FROM mangas WHERE id = ?').get(mangaId)?.manga_passion_id);
        if (linked !== edition.value) {
            throw conflict('Edition nicht bestätigt: bitte die Manga-Passion-Edition zuerst übernehmen', 'EDITION_NOT_CONFIRMED', { needs_confirmation: true });
        }
    }

    const result = await batchImportGaps(mangaId, entries, status, edition.value);
    res.json(result);
});

// --- BATCH AUTOFILL MANGA VOLUMES (Release Dates, Year, Pages, Prices) ---
router.post('/mangas/:id/autofill-volumes', requireEditor, mangaExists, async (req, res) => {
    const mangaId = parseInt(req.params.id, 10);
    const { overwrite, edition_id } = req.body;
    const edition = parseOptionalId(edition_id);
    if (edition.error) throw badRequest('Ungültige edition_id');

    const result = await autofillMangaVolumes(mangaId, {
        overwrite: Boolean(overwrite),
        edition_id: edition.value
    });

    res.json(result);
});

module.exports = router;
