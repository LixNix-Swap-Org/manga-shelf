const express = require('express');
const router = express.Router();
const { db, runTransaction } = require('../db');
const { requireAuth, requireEditor } = require('../middleware/auth');
const { normalizePublisher } = require('../utils/publishers');
const { qstr } = require('../utils/query');
const { searchMangaPassionEditions } = require('../mangaPassion');
const { buildShoppingList, buildReleaseRadar } = require('../services/radar');
const { getMonthlyReleases, enrichReleases } = require('../services/mangaPassionReleases');
const log = require('../utils/logger').child('radar');

// --- SHOPPING LIST / WISHLIST API ---
router.get('/shopping-list', requireAuth, (req, res) => {
    try {
        const missingVols = db.prepare(`
            SELECT 
                v.id, v.manga_id, v.volume_number, v.isbn, v.price, 
                v.release_year, v.condition, v.publisher as vol_publisher, 
                v.notes, v.status, v.type,
                m.title as manga_title, 
                m.cover_image as manga_cover,
                COALESCE(NULLIF(TRIM(v.publisher), ''), NULLIF(TRIM(m.publisher), ''), 'Unbekannt') as effective_publisher
            FROM volumes v
            JOIN mangas m ON v.manga_id = m.id
            WHERE v.status = 'Fehlt'
            ORDER BY 
                effective_publisher ASC,
                m.title ASC,
                CASE 
                    WHEN COALESCE(v.type, 'volume') = 'volume' AND (v.volume_number = '0' OR CAST(v.volume_number AS REAL) > 0) THEN 1 
                    WHEN COALESCE(v.type, 'volume') = 'special_edition' AND (v.volume_number = '0' OR CAST(v.volume_number AS REAL) > 0) THEN 1 
                    WHEN COALESCE(v.type, 'volume') = 'special_edition' THEN 1.5
                    WHEN COALESCE(v.type, 'volume') = 'schuber' THEN 2 
                    WHEN COALESCE(v.type, 'volume') = 'special' THEN 3 
                    ELSE 2 
                END ASC, 
                CASE 
                    WHEN CAST(v.volume_number AS REAL) > 0 THEN CAST(v.volume_number AS REAL) 
                    WHEN v.volume_number = '0' THEN 0 
                    ELSE 999999 
                END ASC, 
                CASE 
                    WHEN COALESCE(v.type, 'volume') = 'volume' THEN 0 
                    WHEN COALESCE(v.type, 'volume') = 'special_edition' THEN 1 
                    ELSE 2 
                END ASC,
                v.volume_number ASC
        `).all();

        res.json(buildShoppingList(missingVols));
    } catch (err) {
        log.error('Error fetching shopping list:', err);
        res.status(500).json({ error: 'Fehler beim Laden der Einkaufsliste' });
    }
});

// --- RELEASE RADAR / ERSCHEINUNGSKALENDER API ---
router.get('/release-radar', requireAuth, (req, res) => {
    try {
        const radarVols = db.prepare(`
            SELECT 
                v.id, v.manga_id, v.volume_number, v.isbn, v.price, 
                v.release_date, v.release_year, v.condition, v.publisher as vol_publisher, 
                v.notes, v.status, v.type, v.cover_image as vol_cover, v.images as vol_images,
                m.title as manga_title, 
                m.cover_image as manga_cover,
                m.publisher as manga_publisher,
                COALESCE(NULLIF(TRIM(v.publisher), ''), NULLIF(TRIM(m.publisher), ''), 'Unbekannt') as effective_publisher
            FROM volumes v
            JOIN mangas m ON v.manga_id = m.id
            WHERE v.status IN ('Vorbestellt', 'Erscheint bald', 'Bestellt')
               OR (v.release_date IS NOT NULL AND TRIM(v.release_date) != '' AND v.status NOT IN ('Vorhanden', 'Gelesen')
                   -- missing back-catalogue volumes (release in the past) belong on the shopping list, not on the radar
                   AND SUBSTR(TRIM(v.release_date), 1, 7) >= strftime('%Y-%m', 'now', 'localtime'))
            ORDER BY 
                CASE WHEN v.release_date IS NOT NULL AND TRIM(v.release_date) != '' THEN 0 ELSE 1 END ASC,
                CASE 
                    WHEN TRIM(v.release_date) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' THEN TRIM(v.release_date) || '-01'
                    WHEN TRIM(v.release_date) GLOB '[0-9][0-9][0-9][0-9]-[0-9]' THEN SUBSTR(TRIM(v.release_date), 1, 5) || '0' || SUBSTR(TRIM(v.release_date), 6) || '-01'
                    ELSE TRIM(v.release_date)
                END ASC,
                m.title ASC,
                CASE 
                    WHEN CAST(v.volume_number AS REAL) > 0 THEN CAST(v.volume_number AS REAL) 
                    WHEN v.volume_number = '0' THEN 0 
                    ELSE 999999 
                END ASC,
                v.volume_number ASC
        `).all();

        res.json(buildReleaseRadar(radarVols));
    } catch (err) {
        log.error('Error fetching release radar:', err);
        res.status(500).json({ error: 'Fehler beim Laden des Release-Radars' });
    }
});

// --- MANGA PASSION GERMAN RELEASE CALENDAR API ---
router.get('/manga-passion/releases', requireAuth, async (req, res) => {
    try {
        const now = new Date();
        const year = parseInt(qstr(req.query.year), 10) || now.getFullYear();
        const month = parseInt(qstr(req.query.month), 10) || (now.getMonth() + 1);
        const forceRefresh = qstr(req.query.force_refresh) === 'true';

        if (month < 1 || month > 12 || year < 2000 || year > 2100) {
            return res.status(400).json({ error: 'Ungültiges Jahr oder Monat' });
        }

        const { items: rawItems, stale } = await getMonthlyReleases(year, month, forceRefresh);

        // Live reconciliation with user's collection in SQLite
        const userMangas = db.prepare('SELECT id, title, alt_title, publisher, cover_image FROM mangas').all();
        const userVolumes = db.prepare('SELECT id, manga_id, volume_number, status, price, release_date FROM volumes').all();
        const enrichedItems = enrichReleases(rawItems, userMangas, userVolumes);

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
            publishers,
            stale,
            items: enrichedItems
        });
    } catch (err) {
        log.error('Manga Passion releases error:', err);
        res.status(500).json({ error: 'Fehler beim Abrufen der Manga-Passion-Neuerscheinungen: ' + err.message });
    }
});

const IMPORT_STATUSES = ['Vorbestellt', 'Fehlt', 'Erscheint bald', 'Bestellt'];

router.post('/manga-passion/import', requireEditor, (req, res) => {
    try {
        const body = req.body || {};

        const effStatus = body.target_status ? String(body.target_status) : 'Vorbestellt';
        if (!IMPORT_STATUSES.includes(effStatus)) {
            return res.status(400).json({ error: 'Ungültiger Zielstatus (erlaubt: ' + IMPORT_STATUSES.join(', ') + ')' });
        }

        let price = null;
        if (body.price !== undefined && body.price !== null && body.price !== '') {
            price = Number(body.price);
            if (!Number.isFinite(price) || price < 0 || price > 10000) return res.status(400).json({ error: 'Ungültiger Preis' });
        }

        const releaseDate = body.release_date ? String(body.release_date).trim() : null;
        if (releaseDate && !/^\d{4}-\d{2}(-\d{2})?$/.test(releaseDate)) {
            return res.status(400).json({ error: 'Ungültiges Erscheinungsdatum (erwartet: YYYY-MM-DD)' });
        }

        const volNumStr = String(body.volume_number || '1').trim();
        if (!volNumStr || volNumStr.length > 80) return res.status(400).json({ error: 'Ungültige Bandnummer' });

        const publisher = normalizePublisher(body.publisher) || null;
        const coverImage = body.cover_image ? String(body.cover_image) : null;

        let mangaId = null;
        let cleanTitle = '';
        if (body.manga_id) {
            mangaId = parseInt(body.manga_id, 10);
            if (!mangaId || !db.prepare('SELECT 1 FROM mangas WHERE id = ?').get(mangaId)) {
                return res.status(404).json({ error: 'Manga nicht gefunden' });
            }
        } else {
            cleanTitle = String(body.title || '').replace(/\s*\(eBook\)/i, '').trim();
            if (!cleanTitle || cleanTitle.length > 300) return res.status(400).json({ error: 'Titel ist erforderlich (maximal 300 Zeichen)' });
        }

        // series (if new) and volume are created together or not at all
        const result = runTransaction(() => {
            if (!mangaId) {
                const insManga = db.prepare(`
                    INSERT INTO mangas (title, publisher, cover_image, status, created_at, updated_at)
                    VALUES (?, ?, ?, 'Laufend', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `).run(cleanTitle, publisher, coverImage);
                mangaId = Number(insManga.lastInsertRowid);
            }

            // same series + type + number (case / whitespace independent), like POST /volumes
            const existingVol = db.prepare(`
                SELECT id, status FROM volumes
                WHERE manga_id = ? AND LOWER(TRIM(volume_number)) = LOWER(?) AND COALESCE(type, 'volume') = 'volume'
            `).get(mangaId, volNumStr);

            if (existingVol) {
                // an owned / read volume is never put back to "pre-ordered" or "missing"
                if (['Vorhanden', 'Gelesen'].includes(existingVol.status)) {
                    return { volumeId: existingVol.id, status: existingVol.status, skippedOwned: true };
                }
                db.prepare(`
                    UPDATE volumes
                    SET status = ?,
                        price = COALESCE(?, price),
                        release_date = COALESCE(?, release_date),
                        publisher = COALESCE(?, publisher),
                        cover_image = COALESCE(cover_image, ?)
                    WHERE id = ?
                `).run(effStatus, price, releaseDate, publisher, coverImage, existingVol.id);
                return { volumeId: existingVol.id, status: effStatus, skippedOwned: false };
            }

            const insVol = db.prepare(`
                INSERT INTO volumes (manga_id, volume_number, status, price, release_date, publisher, cover_image, type, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'volume', CURRENT_TIMESTAMP)
            `).run(mangaId, volNumStr, effStatus, price, releaseDate, publisher, coverImage);
            return { volumeId: Number(insVol.lastInsertRowid), status: effStatus, skippedOwned: false };
        });

        res.json({
            success: true,
            manga_id: mangaId,
            volume_id: result.volumeId,
            status: result.status,
            skipped_owned: result.skippedOwned
        });
    } catch (err) {
        log.error('Import error:', err);
        res.status(500).json({ error: 'Fehler beim Übernehmen des Bands' });
    }
});

// --- MANGA PASSION EDITION SEARCH ---
router.get('/manga-passion/editions', requireAuth, async (req, res) => {
    try {
        const title = qstr(req.query.title) || '';
        const publisher = qstr(req.query.publisher) || '';
        const totalVolumes = parseInt(req.query.total_volumes, 10) || null;
        if (!title.trim()) {
            return res.status(400).json({ error: 'Titel-Parameter ist erforderlich' });
        }
        const result = await searchMangaPassionEditions(title, publisher, totalVolumes);
        res.json(result);
    } catch (err) {
        log.error('Manga Passion edition search error:', err);
        res.status(500).json({ error: 'Fehler bei der Editionssuche: ' + err.message });
    }
});

module.exports = router;
