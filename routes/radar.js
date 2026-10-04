const express = require('express');
const router = express.Router();
const { db, runTransaction } = require('../db');
const { requireAuth, requireEditor } = require('../middleware/auth');
const { normalizePublisher } = require('../utils/publishers');
const { qstr } = require('../utils/query');
const { searchMangaPassionEditions } = require('../mangaPassion');
const { inferVolumeType } = require('../utils/volumeType');
const { canonicalVolumeNumber, volumeOrderSql } = require('../utils/volumeNumber');
const { downloadRemoteImageToUploads } = require('../services/mangaPassion/client');
const { GAP_IMPORT_STATUSES: IMPORT_STATUSES } = require('../services/mangaPassion/gaps');
const { buildShoppingList, buildReleaseRadar, zonedToday, monthKeyOf, isValidReleaseDate } = require('../services/radar');
const {
    getMonthlyReleases, fetchMonthsForCheck, buildMatcher, findSeriesForImport, monthsToCheck, detectDateChanges, calendarItemType
} = require('../services/mangaPassionReleases');
const log = require('../utils/logger').child('radar');
const { HttpError, badRequest, notFound } = require('../utils/httpError');
const { conditional } = require('../utils/dataVersion');
const { lookupLimiter } = require('../middleware/userLimits');

// Volumes on the release radar: pre-orders, plus missing ones that come out this month or later (missing back-catalogue
// volumes belong on the shopping list). Parameter: the current month "YYYY-MM".
const RADAR_WHERE = `(
    v.status IN ('Vorbestellt', 'Erscheint bald', 'Bestellt')
    OR (v.release_date IS NOT NULL AND TRIM(v.release_date) != '' AND v.status NOT IN ('Vorhanden', 'Gelesen')
        AND SUBSTR(TRIM(v.release_date), 1, 7) >= ?))`;

// --- SHOPPING LIST / WISHLIST API ---
router.get('/shopping-list', requireAuth, conditional(), (req, res) => {
    const missingVols = db.prepare(`
        SELECT 
            v.id, v.manga_id, v.volume_number, v.isbn, v.price, 
            v.release_year, v.condition, v.publisher as vol_publisher, 
            v.notes, v.status, v.type, v.priority, v.target_price,
            m.title as manga_title, 
            m.cover_image as manga_cover,
            COALESCE(NULLIF(TRIM(v.publisher), ''), NULLIF(TRIM(m.publisher), ''), 'Unbekannt') as effective_publisher
        FROM volumes v
        JOIN mangas m ON v.manga_id = m.id
        WHERE v.status = 'Fehlt'
        ORDER BY 
            effective_publisher ASC,
            m.title ASC,
            ${volumeOrderSql('v')}
    `).all();

    // ?include_others=1: Bände, die andere besitzen und der Aufrufer noch nicht, in Reihen, die er schon sammelt
    if (qstr(req.query.include_others) === '1') {
        const others = db.prepare(`
            SELECT
                v.id, v.manga_id, v.volume_number, v.isbn, v.price,
                v.release_year, v.condition, v.publisher as vol_publisher,
                v.notes, v.status, v.type,
                m.title as manga_title,
                m.cover_image as manga_cover,
                COALESCE(NULLIF(TRIM(v.publisher), ''), NULLIF(TRIM(m.publisher), ''), 'Unbekannt') as effective_publisher,
                (SELECT GROUP_CONCAT(u.username, ', ') FROM volume_owners vo JOIN users u ON u.id = vo.user_id WHERE vo.volume_id = v.id) as owned_by_others
            FROM volumes v
            JOIN mangas m ON v.manga_id = m.id
            WHERE v.status = 'Vorhanden'
              AND NOT EXISTS (SELECT 1 FROM volume_owners vo WHERE vo.volume_id = v.id AND vo.user_id = ?)
              AND EXISTS (SELECT 1 FROM volume_owners vo WHERE vo.volume_id = v.id)
              AND m.id IN (
                  SELECT v2.manga_id FROM volumes v2
                  JOIN volume_owners vo2 ON vo2.volume_id = v2.id AND vo2.user_id = ?
              )
            ORDER BY m.title ASC, COALESCE(v.number_sort, 0) ASC, v.volume_number ASC
        `).all(req.user.id, req.user.id);
        const result = buildShoppingList(missingVols);
        return res.json({ ...result, others: others.map(o => ({ ...o, owned_by_others: o.owned_by_others || '' })) });
    }

    res.json(buildShoppingList(missingVols));
});

// --- RELEASE RADAR / ERSCHEINUNGSKALENDER API ---
router.get('/release-radar', requireAuth, conditional(), (req, res) => {
    const today = zonedToday();
    const radarVols = db.prepare(`
        SELECT 
            v.id, v.manga_id, v.volume_number, v.isbn, v.price, v.purchase_date,
            v.release_date, v.release_year, v.condition, v.publisher as vol_publisher, 
            v.notes, v.status, v.type, v.cover_image as vol_cover, v.images as vol_images,
            m.title as manga_title, 
            m.cover_image as manga_cover,
            m.publisher as manga_publisher,
            COALESCE(NULLIF(TRIM(v.publisher), ''), NULLIF(TRIM(m.publisher), ''), 'Unbekannt') as effective_publisher
        FROM volumes v
        JOIN mangas m ON v.manga_id = m.id
        WHERE ${RADAR_WHERE}
        ORDER BY 
            CASE WHEN v.release_date IS NOT NULL AND TRIM(v.release_date) != '' THEN 0 ELSE 1 END ASC,
            CASE 
                WHEN TRIM(v.release_date) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' THEN TRIM(v.release_date) || '-01'
                WHEN TRIM(v.release_date) GLOB '[0-9][0-9][0-9][0-9]-[0-9]' THEN SUBSTR(TRIM(v.release_date), 1, 5) || '0' || SUBSTR(TRIM(v.release_date), 6) || '-01'
                ELSE TRIM(v.release_date)
            END ASC,
            m.title ASC,
            COALESCE(v.number_sort, 999999) ASC,
            v.volume_number ASC
    `).all(monthKeyOf(today));

    // the client reads groups[].items; the flat copy only doubled the body
    const radar = buildReleaseRadar(radarVols, today);
    delete radar.items;
    res.json(radar);
});

// Badge counts of the dashboard without loading the shopping list and the radar: the same numbers as their
// total_missing, total_releases and preordered_count.
router.get('/dashboard-summary', requireAuth, conditional(), (req, res) => {
    const missing = db.prepare("SELECT count(*) AS c FROM volumes v JOIN mangas m ON v.manga_id = m.id WHERE v.status = 'Fehlt'").get().c;
    const radar = db.prepare(`
        SELECT count(*) AS total, sum(CASE WHEN v.status IN ('Vorbestellt', 'Bestellt') THEN 1 ELSE 0 END) AS preordered
        FROM volumes v JOIN mangas m ON v.manga_id = m.id WHERE ${RADAR_WHERE}
    `).get(monthKeyOf(zonedToday()));
    res.json({ total_missing: missing, total_releases: radar.total, preordered_count: radar.preordered || 0 });
});

// --- MANGA PASSION GERMAN RELEASE CALENDAR API ---
const loadUserMangas = () => db.prepare('SELECT id, title, alt_title, publisher, cover_image, manga_passion_id FROM mangas ORDER BY id').all();
const loadUserVolumes = () => db.prepare('SELECT id, manga_id, volume_number, type, notes, status, price, release_date, manga_passion_volume_id FROM volumes ORDER BY id').all();

// Vorbestellungen, deren Termin im Manga-Passion-Kalender inzwischen anders lautet (Verschiebungen)
router.get('/release-radar/changes', requireAuth, async (req, res) => {
    const pending = db.prepare(`
        SELECT v.id, v.manga_id, v.volume_number, v.type, v.notes, v.status, v.release_date, m.title AS manga_title
        FROM volumes v JOIN mangas m ON m.id = v.manga_id
        WHERE v.status IN ('Vorbestellt', 'Erscheint bald', 'Bestellt')
          AND v.release_date IS NOT NULL AND TRIM(v.release_date) != ''
    `).all();
    const months = monthsToCheck(pending, zonedToday());
    const results = await fetchMonthsForCheck(months);
    const matcher = buildMatcher(loadUserMangas(), loadUserVolumes());
    const enriched = [];
    let failed = 0;
    for (const r of results) {
        if (r.error) {
            failed++;
            log.warn(`Terminabgleich ${r.year}-${r.month} fehlgeschlagen:`, r.error);
        } else if (r.stale) {
            // a month cached long ago may still list the old date: never suggest it as the new one
            failed++;
            log.warn(`Terminabgleich ${r.year}-${r.month}: nur veraltete Daten im Cache, Monat übersprungen`);
        } else {
            enriched.push(...matcher.enrich(r.items));
        }
    }
    res.json({ changes: detectDateChanges(pending, enriched), months_checked: months.length - failed, months_failed: failed });
});

router.get('/manga-passion/releases', requireAuth, async (req, res) => {
    const today = zonedToday();
    const year = parseInt(qstr(req.query.year), 10) || today.getFullYear();
    const month = parseInt(qstr(req.query.month), 10) || (today.getMonth() + 1);
    const forceRefresh = qstr(req.query.force_refresh) === 'true';

    if (month < 1 || month > 12 || year < 2000 || year > 2100) {
        throw badRequest('Ungültiges Jahr oder Monat');
    }

    const { items: rawItems, stale, truncated } = await getMonthlyReleases(year, month, forceRefresh);

    // Live reconciliation with user's collection in SQLite
    const enrichedItems = buildMatcher(loadUserMangas(), loadUserVolumes()).enrich(rawItems);

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

    res.json({
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
    });
});

const IMPORT_TYPES = ['volume', 'special_edition', 'schuber', 'special'];
const OWNED_STATUSES = ['Vorhanden', 'Gelesen'];
// an ordered volume is never put back on the shopping list by a calendar import
const ORDERED_STATUSES = ['Vorbestellt', 'Bestellt'];
const EDITION_TYPES = new Set(['special_edition', 'schuber']);
const COVER_PATTERN = /^(?:https?:\/\/[^\s]+|\/uploads\/[^/\\\s]+)$/i;
const isBlank = (v) => v === undefined || v === null || v === '';

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
        const fromTitle = rawTitle ? calendarItemType({ title: rawTitle, volume_number: volNumStr, volume_title: volumeTitle }) : null;
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

router.post('/manga-passion/import', requireEditor, async (req, res) => {
    const parsed = parseImportBody(req.body || {});
    if (parsed.error) throw badRequest(parsed.error);
    if (parsed.notFound) throw notFound('Manga');
    const { effStatus, price, releaseDate, volNumStr, type, editionId, mpVolumeId, volumeTitle, publisher, cleanTitle } = parsed;
    let { mangaId } = parsed;

    if (mangaId) {
        const series = db.prepare('SELECT id, title, alt_title, manga_passion_id FROM mangas WHERE id = ?').get(mangaId);
        if (!series) throw notFound('Manga');
        // Older clients send the main series' id for a spin-off ("X – Episode Nagi"): that is another work
        if (cleanTitle && cleanTitle.length <= 300) {
            const [probe] = buildMatcher([series]).enrich([{ title: cleanTitle, edition_id: editionId, volume_number: volNumStr }]);
            if (probe.match_kind === 'prefix') mangaId = null;
        }
    }

    // cover stored locally like every other Manga Passion cover (falls back to the URL when the download fails);
    // network I/O stays outside the transaction
    const coverImage = parsed.coverImage && /^https?:/i.test(parsed.coverImage)
        ? await downloadRemoteImageToUploads(parsed.coverImage)
        : parsed.coverImage;
    const notes = type === 'volume' ? null : volumeTitle;
    // a bare "Special" says nothing about which special it is: never merge two of them
    const dedupeByNumber = volNumStr.toLowerCase() !== 'special';

    // series (if new) and volume are created together or not at all
    const result = runTransaction(() => {
        let seriesCreated = false;
        if (!mangaId) {
            const existing = findSeriesForImport(db.prepare('SELECT id, title, alt_title FROM mangas ORDER BY id').all(), cleanTitle);
            if (existing) {
                mangaId = existing.id;
            } else {
                const insManga = db.prepare(`
                    INSERT INTO mangas (title, publisher, cover_image, manga_passion_id, status, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 'Laufend', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `).run(cleanTitle, publisher, coverImage, editionId);
                mangaId = Number(insManga.lastInsertRowid);
                seriesCreated = true;
            }
        }

        // the same Manga Passion volume, else same series + type + number (case / whitespace independent), like POST /volumes;
        // a row of another type is never overwritten
        let existingVol = mpVolumeId
            ? db.prepare(`
                SELECT id, status FROM volumes
                WHERE manga_id = ? AND manga_passion_volume_id = ? AND COALESCE(type, 'volume') = ?
                ORDER BY id
            `).get(mangaId, mpVolumeId, type)
            : null;
        if (!existingVol && dedupeByNumber) {
            existingVol = db.prepare(`
                SELECT id, status FROM volumes
                WHERE manga_id = ? AND LOWER(TRIM(volume_number)) = LOWER(?) AND COALESCE(type, 'volume') = ?
                ORDER BY id
            `).get(mangaId, volNumStr, type);
        }

        // the Manga Passion id stays on the row of the matching type; a second row of another type does not get it
        const mpIdTaken = mpVolumeId && db.prepare('SELECT 1 FROM volumes WHERE manga_id = ? AND manga_passion_volume_id = ? AND id != ?')
            .get(mangaId, mpVolumeId, existingVol ? existingVol.id : 0);
        const linkMpId = mpIdTaken ? null : mpVolumeId;
        // without the id link a re-import of the same special (no number to dedupe by) would add a row every time
        if (!existingVol && mpIdTaken && !dedupeByNumber) {
            existingVol = db.prepare(`
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
            db.prepare(`
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

        const insVol = db.prepare(`
            INSERT INTO volumes (manga_id, volume_number, status, price, release_date, publisher, cover_image, type, notes, manga_passion_volume_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(mangaId, volNumStr, effStatus, price, releaseDate, publisher, coverImage, type, notes, linkMpId);
        return { volumeId: Number(insVol.lastInsertRowid), status: effStatus, skippedOwned: false, seriesCreated };
    });

    res.json({
        success: true,
        manga_id: mangaId,
        volume_id: result.volumeId,
        status: result.status,
        type,
        skipped_owned: result.skippedOwned,
        skipped_ordered: Boolean(result.skippedOrdered),
        series_created: result.seriesCreated
    });
});

// --- MANGA PASSION EDITION SEARCH ---
router.get('/manga-passion/editions', requireAuth, lookupLimiter, async (req, res) => {
    const title = qstr(req.query.title) || '';
    const publisher = qstr(req.query.publisher) || '';
    const totalVolumes = parseInt(req.query.total_volumes, 10) || null;
    if (!title.trim()) {
        throw badRequest('Titel-Parameter ist erforderlich');
    }
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    const result = await searchMangaPassionEditions(title, publisher, totalVolumes, {
        forceRefresh: qstr(req.query.force_refresh) === 'true',
        signal: ac.signal
    });
    if (result.unavailable) throw new HttpError(503, 'Manga Passion ist gerade nicht erreichbar', 'MP_UNAVAILABLE');
    res.json(result);
});

module.exports = router;
