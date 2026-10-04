// Manga Passion actions: gap check and import, edition sync and search, volume autofill and lookup, the monthly
// calendar and the 1-click import of a calendar entry.
const { normalizePublisher } = require('../lib/publishers');
const { qstr } = require('../lib/query');
const { normalizeIsbn } = require('../lib/isbn');
const { inferVolumeType } = require('../lib/volumeType');
const { canonicalVolumeNumber } = require('../lib/volumeNumber');
const { HttpError, badRequest, notFound, conflict } = require('../errors');
const { parseOptionalId, parseTrueFlag: parseFlag } = require('../lib/validate');
const { zonedToday, isValidReleaseDate } = require('../radar');
const client = require('../mangaPassion/client');
const gapsLib = require('../mangaPassion/gaps');
const autofill = require('../mangaPassion/autofill');
const releases = require('../mangaPassion/releases');
const { fillTagsFromEdition } = require('../mangaPassion/tags');
const { loadUserMangas, loadUserVolumes } = require('./radar');

const { toEditionId } = client;
const { GAP_IMPORT_STATUSES: IMPORT_STATUSES } = gapsLib;

// 404 instead of a logged 500 when the series of a Manga Passion action does not exist
function mangaExists(ctx, params) {
    const mangaId = parseInt(params.id, 10);
    if (!ctx.db.prepare('SELECT id FROM mangas WHERE id = ?').get(mangaId)) throw notFound('Manga');
    return mangaId;
}

// Every role may run the check; only editors and admins store an automatically found edition link or bypass the
// cache. A check that has to ask Manga Passion counts against the caller's lookup budget.
async function gaps(ctx, { params, query }) {
    const mangaId = mangaExists(ctx, params);
    const rawEdition = qstr(query.edition_id);
    let editionId = null;
    if (rawEdition !== undefined && rawEdition !== '') {
        editionId = toEditionId(rawEdition);
        if (!editionId) throw badRequest('Ungültige edition_id');
    }
    const canEdit = ['admin', 'editor'].includes(ctx.user.role);
    const forceRefresh = canEdit && qstr(query.force_refresh) === 'true';
    const target = editionId || ctx.db.prepare('SELECT manga_passion_id FROM mangas WHERE id = ?').get(mangaId).manga_passion_id;
    if (forceRefresh || !target || !client.editionCached(ctx, target)) await ctx.limit('lookup');
    const result = await gapsLib.reconcileMangaGaps(ctx, mangaId, {
        edition_id: editionId,
        force_refresh: forceRefresh,
        persist: canEdit,
        signal: ctx.signal
    });
    return { body: result };
}

// { tags_only: true } fills empty genres from the linked edition only ("Genres nachladen"); edition_id is not needed
async function syncEdition(ctx, { params, body }) {
    const mangaId = mangaExists(ctx, params);
    const { edition_id, update_total_volumes, update_status, update_publisher } = body;
    if (parseFlag(body.tags_only, false)) {
        const { manga, ...result } = await fillTagsFromEdition(ctx, mangaId);
        return { body: { ...result, manga } };
    }
    if (edition_id === undefined || edition_id === null || edition_id === '') {
        throw badRequest('edition_id ist erforderlich');
    }
    const editionId = toEditionId(edition_id);
    if (!editionId) throw badRequest('Ungültige edition_id');

    const updatedManga = await gapsLib.syncMangaWithEdition(ctx, mangaId, editionId, {
        update_total_volumes: parseFlag(update_total_volumes, true),
        update_status: parseFlag(update_status, false),
        update_publisher: parseFlag(update_publisher, false)
    });

    return { body: { success: true, manga: updatedManga } };
}

const MAX_GAP_ENTRIES = 500;
// raw UI labels such as "26 (Titel)"; the stored number is limited separately in batchImportGaps
const MAX_GAP_LABEL_LENGTH = 200;
// Creates the listed volume numbers of a series (at most MAX_GAP_ENTRIES), optionally tied to an edition.
async function batchImportGaps(ctx, { params, body }) {
    const mangaId = mangaExists(ctx, params);
    const { volume_numbers, target_status, edition_id, confirm_edition } = body;

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
        if (typeof target_status !== 'string' || !IMPORT_STATUSES.includes(target_status)) {
            throw badRequest('Ungültiger Zielstatus (erlaubt: ' + IMPORT_STATUSES.join(', ') + ')');
        }
        status = target_status;
    }
    const edition = parseOptionalId(edition_id);
    if (edition.error) throw badRequest('Ungültige edition_id');
    // prices, dates and covers of a guessed edition are only written once the user confirmed that edition
    if (edition.value && !parseFlag(confirm_edition, false)) {
        const linked = toEditionId(ctx.db.prepare('SELECT manga_passion_id FROM mangas WHERE id = ?').get(mangaId)?.manga_passion_id);
        if (linked !== edition.value) {
            throw conflict('Edition nicht bestätigt: bitte die Manga-Passion-Edition zuerst übernehmen', 'EDITION_NOT_CONFIRMED', { needs_confirmation: true });
        }
    }

    const result = await gapsLib.batchImportGaps(ctx, mangaId, entries, status, edition.value);
    return { body: result };
}

// Fills the volumes of a series from its Manga Passion edition; `overwrite` replaces existing values.
async function autofillVolumes(ctx, { params, body }) {
    const mangaId = mangaExists(ctx, params);
    const { overwrite, edition_id } = body;
    const edition = parseOptionalId(edition_id);
    if (edition.error) throw badRequest('Ungültige edition_id');

    const result = await autofill.autofillMangaVolumes(ctx, mangaId, {
        overwrite: Boolean(overwrite),
        edition_id: edition.value
    });

    return { body: result };
}

// Editors only: a lookup downloads covers into the uploads and may link the series to an edition
async function volumeLookup(ctx, { query }) {
    const mangaId = query.manga_id ? parseInt(qstr(query.manga_id), 10) : null;
    const volumeNumber = qstr(query.volume_number);
    const isbn = normalizeIsbn(qstr(query.isbn));
    const type = qstr(query.type)?.trim() || null;
    const notes = qstr(query.notes)?.trim() || null;
    const rawPrice = qstr(query.price);
    const price = rawPrice ? parseFloat(rawPrice) : null;
    const url = qstr(query.url)?.trim() || null;
    const mpVolumeId = qstr(query.mp_volume_id)?.trim() || null;
    const forceRefresh = query.force_refresh === 'true';

    if (!volumeNumber && !isbn && !url && !mpVolumeId) {
        throw badRequest('Band-Nummer, ISBN oder URL erforderlich');
    }

    const result = await autofill.lookupVolumeMetadata(ctx, mangaId, volumeNumber, {
        isbn,
        type,
        notes,
        price,
        url,
        mp_volume_id: mpVolumeId,
        force_refresh: forceRefresh
    });

    return { body: result };
}

// The year selection of the release radar offers today - 2 .. today + 3; older months stay reachable for a while.
const RELEASE_YEARS_BACK = 5;
const RELEASE_YEARS_AHEAD = 3;

// Like gaps: only editors and admins bypass the cache, and an answer that may ask Manga Passion costs lookup budget.
async function monthlyReleases(ctx, { query }) {
    const today = zonedToday(ctx.now(), ctx.config.appTimeZone);
    const thisYear = today.getFullYear();
    const year = parseInt(qstr(query.year), 10) || thisYear;
    const month = parseInt(qstr(query.month), 10) || (today.getMonth() + 1);
    const forceRefresh = ['admin', 'editor'].includes(ctx.user.role) && qstr(query.force_refresh) === 'true';

    if (month < 1 || month > 12 || year < thisYear - RELEASE_YEARS_BACK || year > thisYear + RELEASE_YEARS_AHEAD) {
        throw badRequest('Ungültiges Jahr oder Monat');
    }
    if (forceRefresh || !releases.monthCached(ctx, year, month)) await ctx.limit('lookup');

    const { items: rawItems, stale, truncated } = await releases.getMonthlyReleases(ctx, year, month, forceRefresh);

    // Live reconciliation with user's collection in SQLite
    const enrichedItems = releases.buildMatcher(loadUserMangas(ctx), loadUserVolumes(ctx)).enrich(rawItems);

    // Publisher list
    const pubMap = new Map();
    enrichedItems.forEach(it => {
        if (it.publisher && it.publisher !== 'Unbekannt') {
            pubMap.set(it.publisher, (pubMap.get(it.publisher) || 0) + 1);
        }
    });

    const publishers = Array.from(pubMap.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

    return {
        body: {
            year,
            month,
            total_items: enrichedItems.length,
            print_count: enrichedItems.filter(i => !i.is_digital).length,
            user_series_count: enrichedItems.filter(i => i.in_collection).length,
            user_series_print_count: enrichedItems.filter(i => i.in_collection && !i.is_digital).length,
            publishers,
            stale,
            truncated: Boolean(truncated),
            items: enrichedItems
        }
    };
}

const IMPORT_TYPES = ['volume', 'special_edition', 'schuber', 'special'];
const OWNED_STATUSES = ['Vorhanden', 'Gelesen'];
// an ordered volume is never put back on the shopping list by a calendar import
const ORDERED_STATUSES = ['Vorbestellt', 'Bestellt'];
const EDITION_TYPES = new Set(['special_edition', 'schuber']);
const COVER_PATTERN = /^(?:https?:\/\/[^\s]+|\/uploads\/[^/\\\s]+)$/i;
const isBlank = (v) => v === undefined || v === null || v === '';

/** Author and tags of an edition from the Manga Passion cache (any age); no request is made for an import. */
function cachedEditionMeta(ctx, editionId) {
    if (!editionId) return {};
    const edition = client.readCache(ctx, `mp_edition_vols_${editionId}`, Infinity)?.edition
        || client.readCache(ctx, `mp_edition_info_${editionId}`, Infinity)?.edition;
    const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    return edition ? { author: text(edition.author, 300), tags: text(edition.tags, 500) } : {};
}

/** Positive integer id from a number or digit string; null when absent, undefined when invalid. */
function optionalId(v) {
    if (isBlank(v)) return null;
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Checks and normalises the import body; returns { error } or the cleaned fields. */
function parseImportBody(body) {
    for (const field of ['title', 'publisher', 'cover_image', 'release_date', 'target_status', 'type', 'volume_title']) {
        if (!isBlank(body[field]) && typeof body[field] !== 'string') return { error: `Ungültiger Wert für ${field}` };
    }

    const effStatus = body.target_status || 'Vorbestellt';
    if (!IMPORT_STATUSES.includes(effStatus)) {
        return { error: 'Ungültiger Zielstatus (erlaubt: ' + IMPORT_STATUSES.join(', ') + ')' };
    }

    let price = null;
    if (!isBlank(body.price)) {
        price = typeof body.price === 'number' || typeof body.price === 'string' ? Number(body.price) : NaN;
        if (!Number.isFinite(price) || price < 0 || price > 10000) return { error: 'Ungültiger Preis' };
    }

    const releaseDate = body.release_date ? body.release_date.trim() : null;
    if (releaseDate && !isValidReleaseDate(releaseDate)) {
        return { error: 'Ungültiges Erscheinungsdatum (erwartet: YYYY-MM-DD oder YYYY-MM)' };
    }

    const rawNumber = body.volume_number ?? '1';
    if (!(typeof rawNumber === 'string' || (typeof rawNumber === 'number' && Number.isFinite(rawNumber)))) {
        return { error: 'Ungültige Bandnummer' };
    }
    let volNumStr = String(rawNumber).trim();
    if (!volNumStr || volNumStr.length > 80) return { error: 'Ungültige Bandnummer' };

    const rawTitle = String(body.title || '');
    const volumeTitle = body.volume_title ? body.volume_title.trim().slice(0, 300) || null : null;
    // Without a type (older clients) the edition title still marks a Collectors Edition or Schuber ("X – Collectors
    // Edition"), like the calendar does; otherwise a number without any digit is a numberless special ("Artbook").
    let type = body.type ? body.type.trim() : null;
    if (!type) {
        const fromTitle = rawTitle ? releases.calendarItemType({ title: rawTitle, volume_number: volNumStr, volume_title: volumeTitle }) : null;
        const inferred = inferVolumeType({ volume_number: volNumStr });
        type = EDITION_TYPES.has(fromTitle) && inferred === 'volume' ? fromTitle
            : (inferred === 'volume' && !/\d/.test(volNumStr) ? 'special' : inferred);
    }
    if (!IMPORT_TYPES.includes(type)) return { error: 'Ungültiger Typ (erlaubt: ' + IMPORT_TYPES.join(', ') + ')' };
    // "Band 4" is regular volume 4, like POST /volumes stores it
    volNumStr = canonicalVolumeNumber(volNumStr, type);

    const editionId = optionalId(body.edition_id);
    const mpVolumeId = optionalId(body.mp_volume_id);
    if (editionId === undefined || mpVolumeId === undefined) return { error: 'Ungültige Manga-Passion-ID' };

    const coverImage = body.cover_image ? body.cover_image.trim() : null;
    if (coverImage && (coverImage.length > 2048 || !COVER_PATTERN.test(coverImage))) {
        return { error: 'Ungültige Cover-URL (erlaubt: http(s)-Adresse oder /uploads/…)' };
    }

    let mangaId = null;
    const cleanTitle = rawTitle.replace(/\s*\(eBook\)/i, '').trim();
    if (!isBlank(body.manga_id)) {
        mangaId = optionalId(body.manga_id);
        if (!mangaId) return { notFound: true };
    } else if (!cleanTitle || cleanTitle.length > 300) {
        return { error: 'Titel ist erforderlich (maximal 300 Zeichen)' };
    }

    return {
        effStatus, price, releaseDate, volNumStr, type, editionId, mpVolumeId, volumeTitle, coverImage, mangaId, cleanTitle,
        publisher: normalizePublisher(body.publisher) || null
    };
}

// 1-click import of a calendar entry: the series (if new) and its volume are created in one transaction.
async function importRelease(ctx, { body }) {
    const parsed = parseImportBody(body || {});
    if (parsed.error) throw badRequest(parsed.error);
    if (parsed.notFound) throw notFound('Manga');
    const { effStatus, price, releaseDate, volNumStr, type, editionId, mpVolumeId, volumeTitle, publisher, cleanTitle } = parsed;
    let { mangaId } = parsed;

    if (mangaId) {
        const series = ctx.db.prepare('SELECT id, title, alt_title, manga_passion_id FROM mangas WHERE id = ?').get(mangaId);
        if (!series) throw notFound('Manga');
        // Older clients send the main series' id for a spin-off ("X – Episode Nagi"): that is another work
        if (cleanTitle && cleanTitle.length <= 300) {
            const [probe] = releases.buildMatcher([series]).enrich([{ title: cleanTitle, edition_id: editionId, volume_number: volNumStr }]);
            if (probe.match_kind === 'prefix') mangaId = null;
        }
    }

    // cover stored locally like every other Manga Passion cover (falls back to the URL when the download fails);
    // the client chose the URL, so a real download counts like POST /upload-remote; network I/O stays outside the transaction
    const coverImage = parsed.coverImage && /^https?:/i.test(parsed.coverImage)
        ? await client.downloadRemoteImageToUploads(ctx, parsed.coverImage, { beforeDownload: () => ctx.limit('remoteImage') })
        : parsed.coverImage;
    const notes = type === 'volume' ? null : volumeTitle;
    const editionMeta = mangaId ? {} : cachedEditionMeta(ctx, editionId);
    // a bare "Special" says nothing about which special it is: never merge two of them
    const dedupeByNumber = volNumStr.toLowerCase() !== 'special';

    // series (if new) and volume are created together or not at all
    const result = ctx.db.transaction(() => {
        let seriesCreated = false;
        if (!mangaId) {
            const existing = releases.findSeriesForImport(
                ctx.db.prepare('SELECT id, title, alt_title, manga_passion_id FROM mangas ORDER BY id').all(), cleanTitle, editionId
            );
            if (existing) {
                mangaId = existing.id;
            } else {
                const insManga = ctx.db.prepare(`
                    INSERT INTO mangas (title, author, tags, publisher, cover_image, manga_passion_id, status, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, 'Laufend', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `).run(cleanTitle, editionMeta.author ?? null, editionMeta.tags ?? null, publisher, coverImage, editionId);
                mangaId = Number(insManga.lastInsertRowid);
                seriesCreated = true;
            }
        }

        // the same Manga Passion volume, else same series + type + number (case / whitespace independent), like POST /volumes;
        // a row of another type is never overwritten
        let existingVol = mpVolumeId
            ? ctx.db.prepare(`
                SELECT id, status FROM volumes
                WHERE manga_id = ? AND manga_passion_volume_id = ? AND COALESCE(type, 'volume') = ?
                ORDER BY id
            `).get(mangaId, mpVolumeId, type)
            : null;
        if (!existingVol && dedupeByNumber) {
            existingVol = ctx.db.prepare(`
                SELECT id, status FROM volumes
                WHERE manga_id = ? AND LOWER(TRIM(volume_number)) = LOWER(?) AND COALESCE(type, 'volume') = ?
                ORDER BY id
            `).get(mangaId, volNumStr, type);
        }

        // the Manga Passion id stays on the row of the matching type; a second row of another type does not get it
        const mpIdTaken = mpVolumeId && ctx.db.prepare('SELECT 1 FROM volumes WHERE manga_id = ? AND manga_passion_volume_id = ? AND id != ?')
            .get(mangaId, mpVolumeId, existingVol ? existingVol.id : 0);
        const linkMpId = mpIdTaken ? null : mpVolumeId;
        // without the id link a re-import of the same special (no number to dedupe by) would add a row every time
        if (!existingVol && mpIdTaken && !dedupeByNumber) {
            existingVol = ctx.db.prepare(`
                SELECT id, status FROM volumes
                WHERE manga_id = ? AND manga_passion_volume_id IS NULL AND LOWER(TRIM(volume_number)) = LOWER(?)
                  AND COALESCE(type, 'volume') = ? AND notes IS ?
                ORDER BY id
            `).get(mangaId, volNumStr, type, notes);
        }

        if (existingVol) {
            // an owned / read volume is never put back to "pre-ordered" or "missing"
            if (OWNED_STATUSES.includes(existingVol.status)) {
                return { volumeId: existingVol.id, status: existingVol.status, skippedOwned: true, seriesCreated };
            }
            if (effStatus === 'Fehlt' && ORDERED_STATUSES.includes(existingVol.status)) {
                return { volumeId: existingVol.id, status: existingVol.status, skippedOwned: false, skippedOrdered: true, seriesCreated };
            }
            ctx.db.prepare(`
                UPDATE volumes
                SET status = ?,
                    price = COALESCE(?, price),
                    release_date = COALESCE(?, release_date),
                    publisher = COALESCE(?, publisher),
                    cover_image = COALESCE(cover_image, ?),
                    notes = COALESCE(notes, ?),
                    manga_passion_volume_id = COALESCE(manga_passion_volume_id, ?)
                WHERE id = ?
            `).run(effStatus, price, releaseDate, publisher, coverImage, notes, linkMpId, existingVol.id);
            return { volumeId: existingVol.id, status: effStatus, skippedOwned: false, seriesCreated };
        }

        const insVol = ctx.db.prepare(`
            INSERT INTO volumes (manga_id, volume_number, status, price, release_date, publisher, cover_image, type, notes, manga_passion_volume_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(mangaId, volNumStr, effStatus, price, releaseDate, publisher, coverImage, type, notes, linkMpId);
        return { volumeId: Number(insVol.lastInsertRowid), status: effStatus, skippedOwned: false, seriesCreated };
    });

    return {
        body: {
            success: true,
            manga_id: mangaId,
            volume_id: result.volumeId,
            status: result.status,
            type,
            skipped_owned: result.skippedOwned,
            skipped_ordered: Boolean(result.skippedOrdered),
            series_created: result.seriesCreated
        }
    };
}

// Searches Manga Passion editions by title (503 MP_UNAVAILABLE when the source is down).
async function editions(ctx, { query }) {
    const title = qstr(query.title) || '';
    const publisher = qstr(query.publisher) || '';
    const totalVolumes = parseInt(query.total_volumes, 10) || null;
    if (!title.trim()) {
        throw badRequest('Titel-Parameter ist erforderlich');
    }
    const result = await client.searchMangaPassionEditions(ctx, title, publisher, totalVolumes, {
        forceRefresh: qstr(query.force_refresh) === 'true',
        signal: ctx.signal
    });
    if (result.unavailable) throw new HttpError(503, 'Manga Passion ist gerade nicht erreichbar', 'MP_UNAVAILABLE');
    return { body: result };
}

module.exports = { gaps, syncEdition, batchImportGaps, autofillVolumes, volumeLookup, monthlyReleases, importRelease, editions };
