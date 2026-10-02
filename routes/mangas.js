const express = require('express');
const router = express.Router();
const { db, runTransaction } = require('../db');
const { requireAuth, requireEditor } = require('../middleware/auth');
const { normalizePublisher } = require('../utils/publishers');
const {
    reconcileMangaGaps,
    syncMangaWithEdition,
    batchImportGaps,
    autofillMangaVolumes
} = require('../mangaPassion');
const log = require('../utils/logger').child('mangas');

// --- MANGA API ---
// Series list with aggregates for the dashboard (also reused by the offline snapshot)
function listMangas(userId) {
    return db.prepare(`
            SELECT m.*, 
                   COALESCE(SUM(CASE WHEN v.status = 'Vorhanden' THEN v.price ELSE 0 END), 0) as total_value,
                   COALESCE(SUM(v.price), 0) as full_value,
                   COUNT(DISTINCT v.id) as volume_count,
                   COUNT(DISTINCT vr.volume_id) as read_volume_count
            FROM mangas m
            LEFT JOIN volumes v ON m.id = v.manga_id
            LEFT JOIN volume_reads vr ON v.id = vr.volume_id AND vr.user_id = ?
            GROUP BY m.id
            ORDER BY m.title ASC
        `).all(userId);
}

router.get('/mangas', requireAuth, (req, res) => {
    try {
        res.json(listMangas(req.user.id));
    } catch (err) {
        log.error('Error fetching mangas:', err);
        res.status(500).json({ error: 'Fehler beim Laden der Mangas' });
    }
});

router.post('/mangas', requireEditor, (req, res) => {
    try {
        const {
            title,
            alt_title = null,
            author = null,
            publisher = null,
            language = 'Deutsch',
            status = 'Laufend',
            tags = null,
            total_volumes = null,
            description = null,
            cover_image = null,
            banner_image = null,
            manga_passion_id = null
        } = req.body;

        if (!title || typeof title !== 'string' || !title.trim()) {
            return res.status(400).json({ error: 'Titel darf nicht leer sein' });
        }

        const cleanTitle = title.trim();
        if (cleanTitle.length > 300) {
            return res.status(400).json({ error: 'Titel ist zu lang (maximal 300 Zeichen)' });
        }

        let cleanTotal = null;
        if (total_volumes !== null && total_volumes !== undefined && total_volumes !== '') {
            const parsed = parseInt(total_volumes, 10);
            if (!isNaN(parsed) && parsed >= 0 && parsed <= 5000) {
                cleanTotal = parsed;
            }
        }

        const cleanMpId = manga_passion_id ? (parseInt(manga_passion_id, 10) || null) : null;

        const stmt = db.prepare(`
            INSERT INTO mangas (title, alt_title, author, publisher, language, status, tags, total_volumes, description, cover_image, banner_image, manga_passion_id, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const result = stmt.run(
            cleanTitle,
            alt_title ? String(alt_title).trim().slice(0, 300) : null,
            author ? String(author).trim().slice(0, 300) : null,
            publisher ? normalizePublisher(publisher) : null,
            language ? String(language).trim().slice(0, 50) : 'Deutsch',
            status || 'Laufend',
            tags ? String(tags).trim().slice(0, 500) : null,
            cleanTotal,
            description ? String(description).trim() : null,
            cover_image ? String(cover_image).trim() : null,
            banner_image ? String(banner_image).trim() : null,
            cleanMpId,
            req.user.id
        );
        res.json({ success: true, id: Number(result.lastInsertRowid) });
    } catch (err) {
        log.error('Error creating manga:', err);
        res.status(500).json({ error: 'Fehler beim Erstellen des Mangas: ' + err.message });
    }
});

// Full series detail (volumes with read info, values, reader stats) as served by GET /mangas/:id
function loadMangaDetail(mangaId, userId) {
    const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
    if (!manga) return null;
    const volumes = db.prepare(`
        SELECT * FROM volumes 
        WHERE manga_id = ? 
        ORDER BY 
            CASE 
                WHEN COALESCE(type, 'volume') = 'volume' AND (volume_number = '0' OR CAST(volume_number AS REAL) > 0) THEN 1 
                WHEN COALESCE(type, 'volume') = 'special_edition' AND (volume_number = '0' OR CAST(volume_number AS REAL) > 0) THEN 1 
                WHEN COALESCE(type, 'volume') = 'special_edition' THEN 1.5
                WHEN COALESCE(type, 'volume') = 'schuber' THEN 2 
                WHEN COALESCE(type, 'volume') = 'special' THEN 3 
                ELSE 2 
            END ASC, 
            CASE 
                WHEN CAST(volume_number AS REAL) > 0 THEN CAST(volume_number AS REAL) 
                WHEN volume_number = '0' THEN 0 
                ELSE 999999 
            END ASC, 
            CASE 
                WHEN COALESCE(type, 'volume') = 'volume' THEN 0 
                WHEN COALESCE(type, 'volume') = 'special_edition' THEN 1 
                ELSE 2 
            END ASC,
            volume_number ASC
    `).all(mangaId);
    manga.volumes = volumes || [];

    // Fetch volume reading records
    const reads = db.prepare(`
        SELECT vr.volume_id, vr.user_id, u.username
        FROM volume_reads vr
        JOIN users u ON vr.user_id = u.id
        JOIN volumes v ON vr.volume_id = v.id
        WHERE v.manga_id = ?
    `).all(mangaId);

    const readMap = {};
    for (const r of reads) {
        if (!readMap[r.volume_id]) readMap[r.volume_id] = [];
        // both keys: POST /volumes/:id/read answers with user_id, older clients read id
        readMap[r.volume_id].push({ id: r.user_id, user_id: r.user_id, username: r.username });
    }

    let total_value = 0;
    let full_value = 0;
    for (const v of manga.volumes) {
        const p = typeof v.price === 'number' ? v.price : (parseFloat(v.price) || 0);
        if (v.status === 'Vorhanden') total_value += p;
        full_value += p;

        // Reading info
        const usersWhoRead = readMap[v.id] || [];
        v.read_by = usersWhoRead.map(u => u.id);
        v.read_users = usersWhoRead;
        v.is_read = v.read_by.includes(userId);

        // Parse images
        try {
            if (v.images) {
                v.images = Array.isArray(v.images) ? v.images : JSON.parse(v.images);
            } else if (v.cover_image) {
                v.images = [v.cover_image];
            } else {
                v.images = [];
            }
        } catch (e) {
            v.images = v.cover_image ? [v.cover_image] : [];
        }
        if (!v.cover_image && v.images.length > 0) {
            v.cover_image = v.images[0];
        }
    }
    manga.total_value = Math.round(total_value * 100) / 100;
    manga.full_value = Math.round(full_value * 100) / 100;

    // Statistics for each reader
    const allUsers = db.prepare('SELECT id, username FROM users ORDER BY id ASC').all();
    manga.reader_stats = allUsers.map(u => {
        const count = manga.volumes.filter(v => v.read_by.includes(u.id)).length;
        const total = manga.volumes.filter(v => v.status === 'Vorhanden').length;
        return {
            user_id: u.id,
            username: u.username,
            read_count: count,
            total_owned: total,
            unread_count: Math.max(0, total - count),
            percentage: total > 0 ? Math.round((count / total) * 100) : 0
        };
    });
    return manga;
}

router.get('/mangas/:id', requireAuth, (req, res) => {
    try {
        const manga = loadMangaDetail(req.params.id, req.user.id);
        if (!manga) {
            return res.status(404).json({ error: 'Manga nicht gefunden' });
        }
        res.json(manga);
    } catch (err) {
        log.error('Error fetching manga:', err);
        res.status(500).json({ error: 'Fehler beim Laden des Mangas' });
    }
});

// Whole collection in one response so the client can keep a read-only offline copy.
router.get('/offline-snapshot', requireAuth, (req, res) => {
    try {
        const mangas = listMangas(req.user.id);
        const details = {};
        for (const m of mangas) details[m.id] = loadMangaDetail(m.id, req.user.id);
        res.json({
            generated_at: new Date().toISOString(),
            user: { id: req.user.id, username: req.user.username, role: req.user.role },
            mangas,
            details
        });
    } catch (err) {
        log.error('Error building offline snapshot:', err);
        res.status(500).json({ error: 'Fehler beim Erstellen der Offline-Kopie' });
    }
});

router.put('/mangas/:id', requireEditor, (req, res) => {
    try {
        const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(req.params.id);
        if (!manga) return res.status(404).json({ error: 'Manga nicht gefunden' });

        const body = req.body;
        const title = body.title !== undefined ? body.title : manga.title;
        const alt_title = body.alt_title !== undefined ? body.alt_title : manga.alt_title;
        const author = body.author !== undefined ? body.author : manga.author;
        const publisher = body.publisher !== undefined ? normalizePublisher(body.publisher) : normalizePublisher(manga.publisher);
        const language = body.language !== undefined ? body.language : manga.language;
        const status = body.status !== undefined ? body.status : manga.status;
        const tags = body.tags !== undefined ? body.tags : manga.tags;
        const total_volumes = body.total_volumes !== undefined ? (parseInt(body.total_volumes, 10) || null) : manga.total_volumes;
        const owned_volumes = body.owned_volumes !== undefined ? (parseInt(body.owned_volumes, 10) || 0) : manga.owned_volumes;
        const description = body.description !== undefined ? body.description : manga.description;
        const cover_image = body.cover_image !== undefined ? body.cover_image : manga.cover_image;
        const banner_image = body.banner_image !== undefined ? body.banner_image : manga.banner_image;
        const manga_passion_id = body.manga_passion_id !== undefined ? (parseInt(body.manga_passion_id, 10) || null) : manga.manga_passion_id;

        const stmt = db.prepare(`
            UPDATE mangas SET title = ?, alt_title = ?, author = ?, publisher = ?, 
            language = ?, status = ?, tags = ?, total_volumes = ?, 
            owned_volumes = ?, description = ?, cover_image = ?, 
            banner_image = ?, manga_passion_id = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);
        stmt.run(
            title ? title.trim() : manga.title,
            alt_title || null,
            author || null,
            publisher || null,
            language || 'Deutsch',
            status || 'Laufend',
            tags || null,
            total_volumes,
            owned_volumes,
            description || null,
            cover_image || null,
            banner_image || null,
            manga_passion_id,
            req.user.id,
            req.params.id
        );
        res.json({ success: true });
    } catch (err) {
        log.error('Error updating manga:', err);
        res.status(500).json({ error: 'Fehler beim Speichern: ' + err.message });
    }
});

router.delete('/mangas/:id', requireEditor, (req, res) => {
    try {
        let deleted = false;
        runTransaction(() => {
            db.prepare('DELETE FROM volume_reads WHERE volume_id IN (SELECT id FROM volumes WHERE manga_id = ?)').run(req.params.id);
            db.prepare('DELETE FROM volumes WHERE manga_id = ?').run(req.params.id);
            const result = db.prepare('DELETE FROM mangas WHERE id = ?').run(req.params.id);
            deleted = result.changes > 0;
        });

        if (!deleted) return res.status(404).json({ error: 'Manga nicht gefunden' });
        res.json({ success: true });
    } catch (err) {
        log.error('Error deleting manga:', err);
        res.status(500).json({ error: 'Fehler beim Löschen des Mangas' });
    }
});

// --- MANGA GAPS CHECK (Manga Passion Live-Abgleich) ---
router.get('/mangas/:id/gaps', requireAuth, async (req, res) => {
    try {
        const mangaId = parseInt(req.params.id, 10);
        const editionId = req.query.edition_id ? parseInt(req.query.edition_id, 10) : null;
        const forceRefresh = req.query.force_refresh === 'true';

        const result = await reconcileMangaGaps(mangaId, { edition_id: editionId, force_refresh: forceRefresh });
        res.json(result);
    } catch (err) {
        log.error('Manga gaps check error:', err);
        res.status(500).json({ error: 'Fehler beim Abgleich der Lücken: ' + err.message });
    }
});

// --- SYNC MANGA WITH MANGA PASSION EDITION ---
router.post('/mangas/:id/sync-edition', requireEditor, async (req, res) => {
    try {
        const mangaId = parseInt(req.params.id, 10);
        const { edition_id, update_total_volumes, update_status, update_publisher } = req.body;
        if (!edition_id) {
            return res.status(400).json({ error: 'edition_id ist erforderlich' });
        }

        const updatedManga = await syncMangaWithEdition(mangaId, edition_id, {
            update_total_volumes: update_total_volumes !== false,
            update_status: Boolean(update_status),
            update_publisher: Boolean(update_publisher)
        });

        res.json({ success: true, manga: updatedManga });
    } catch (err) {
        log.error('Sync edition error:', err);
        res.status(500).json({ error: 'Fehler beim Synchronisieren der Edition: ' + err.message });
    }
});

// --- BATCH IMPORT GAPS FROM MANGA PASSION ---
router.post('/mangas/:id/batch-import-gaps', requireEditor, async (req, res) => {
    try {
        const mangaId = parseInt(req.params.id, 10);
        const { volume_numbers, target_status, edition_id } = req.body;

        if (!Array.isArray(volume_numbers) || volume_numbers.length === 0) {
            return res.status(400).json({ error: 'volume_numbers Array ist erforderlich' });
        }

        const result = await batchImportGaps(mangaId, volume_numbers, target_status || 'Fehlt', edition_id);
        res.json(result);
    } catch (err) {
        log.error('Batch import gaps error:', err);
        res.status(500).json({ error: 'Fehler beim Erfassen der Lücken: ' + err.message });
    }
});

// --- BATCH AUTOFILL MANGA VOLUMES (Release Dates, Year, Pages, Prices) ---
router.post('/mangas/:id/autofill-volumes', requireEditor, async (req, res) => {
    try {
        const mangaId = parseInt(req.params.id, 10);
        const { overwrite, edition_id } = req.body;

        const result = await autofillMangaVolumes(mangaId, {
            overwrite: Boolean(overwrite),
            edition_id: edition_id ? parseInt(edition_id, 10) : null
        });

        res.json(result);
    } catch (err) {
        log.error('Batch autofill volumes error:', err);
        res.status(500).json({ error: 'Fehler beim automatischen Ausfüllen der Bände: ' + err.message });
    }
});

module.exports = router;
