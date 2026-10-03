const express = require('express');
const router = express.Router();
const { db, runTransaction } = require('../db');
const { requireAuth, requireEditor } = require('../middleware/auth');
const { normalizePublisher } = require('../utils/publishers');
const { qstr } = require('../utils/query');
const { normalizeIsbn } = require('../utils/isbn');
const { lookupVolumeMetadata } = require('../mangaPassion');
const { addOwner, listOwners, syncOwnersWithStatus, syncStatusWithOwners, recountOwned } = require('../utils/owners');
const log = require('../utils/logger').child('volumes');

const parsePrice = (val) => {
    if (val === null || val === undefined || val === '') return null;
    const str = String(val).replace(',', '.').trim();
    const parsed = parseFloat(str);
    return (isNaN(parsed) || parsed < 0 || parsed > 99999) ? null : Math.round(parsed * 100) / 100;
};

// Statuses the app works with (volume editor, shopping list, release radar, Manga Passion import)
const VOLUME_STATUSES = ['Vorhanden', 'Fehlt', 'Vorbestellt', 'Erscheint bald', 'Bestellt', 'Gelesen'];

// JSON booleans as well as "true"/"false"/"0"/"1" strings ("false" must not count as true)
const parseFlag = (val) => !(val === false || val === 0 || val === null || /^(false|0|no|nein|)$/i.test(String(val).trim()));

/** 0 (keine) bis 3 (hoch); leer = 0, alles andere null (ungültig). */
const parsePriority = (val) => {
    if (val === undefined || val === null || val === '') return 0;
    const n = Number(val);
    return Number.isInteger(n) && n >= 0 && n <= 3 ? n : null;
};

const parseNum = (val) => {
    if (val === null || val === undefined || val === '') return null;
    const parsed = parseInt(val, 10);
    return (isNaN(parsed) || parsed < 0 || parsed > 99999) ? null : parsed;
};

// Dates as the forms and imports write them: YYYY, YYYY-MM or YYYY-MM-DD (empty = not set)
const isValidDate = (val) => {
    if (val === null || val === undefined || val === '') return true;
    const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(String(val).trim());
    if (!m) return false;
    const month = m[2] ? parseInt(m[2], 10) : 1;
    const day = m[3] ? parseInt(m[3], 10) : 1;
    return month >= 1 && month <= 12 && day >= 1 && day <= 31;
};

// Photo list as a JSON array of strings, given as an array or a JSON string (empty = none)
const parseImagesInput = (val) => {
    if (val === null || val === undefined || val === '') return { value: null };
    let list = val;
    if (typeof val === 'string') {
        try { list = JSON.parse(val); } catch (e) { return { error: true }; }
    }
    if (!Array.isArray(list) || list.length > 50 || !list.every(x => typeof x === 'string' && x.length <= 1000)) return { error: true };
    return { value: JSON.stringify(list) };
};

// --- VOLUMES API ---
router.post('/volumes', requireEditor, (req, res) => {
    try {
        const { 
            manga_id, 
            volume_number, 
            isbn = null, 
            price = null,
            release_date = null,
            release_year = null,
            condition = null,
            pages = null,
            publisher = null,
            purchase_date = null, 
            status = 'Vorhanden', 
            notes = null,
            cover_image = null,
            images = null,
            type = 'volume',
            priority = 0,
            target_price = null
        } = req.body;

        const mId = parseInt(manga_id, 10);
        if (!mId || isNaN(mId) || volume_number === undefined || volume_number === '') {
            return res.status(400).json({ error: 'Gültige manga_id und Bandnummer erforderlich' });
        }
        if (!VOLUME_STATUSES.includes(status || 'Vorhanden')) {
            return res.status(400).json({ error: 'Ungültiger Status (erlaubt: ' + VOLUME_STATUSES.join(', ') + ')' });
        }

        const prio = parsePriority(priority);
        if (prio === null) return res.status(400).json({ error: 'Ungültige Priorität (0 bis 3)' });

        const volNumStr = String(volume_number).trim();
        if (volNumStr.length > 80) {
            return res.status(400).json({ error: 'Bandnummer ist zu lang (maximal 80 Zeichen)' });
        }

        let volType = type ? String(type).trim().toLowerCase() : 'volume';
        if (!['volume', 'special_edition', 'schuber', 'special'].includes(volType)) {
            const vLower = volNumStr.toLowerCase();
            const nLower = notes ? String(notes).toLowerCase() : '';
            if (vLower.includes('schuber') || nLower.includes('schuber')) {
                volType = 'schuber';
            } else if (vLower.includes('special edition') || vLower.includes('limited edition') || vLower.includes('spezial edition') || nLower.includes('special edition') || nLower.includes('limited edition')) {
                volType = 'special_edition';
            } else if (vLower.includes('special') || vLower.includes('extra') || vLower.includes('sonderband')) {
                volType = 'special';
            } else {
                volType = 'volume';
            }
        }

        // The same type + number twice is almost always a double click or a repeated entry; edit the existing one instead
        const duplicate = db.prepare(`
            SELECT id, status FROM volumes
            WHERE manga_id = ? AND LOWER(TRIM(volume_number)) = LOWER(?) AND COALESCE(type, 'volume') = ?
        `).get(mId, volNumStr, volType);
        if (duplicate) {
            const label = volType === 'volume' ? `Band ${volNumStr}` : volNumStr;
            return res.status(409).json({
                error: `${label} existiert bereits (${duplicate.status}). Bitte den vorhandenen Eintrag bearbeiten.`,
                existing_id: duplicate.id
            });
        }

        if (!isValidDate(release_date) || !isValidDate(purchase_date)) {
            return res.status(400).json({ error: 'Ungültiges Datum (erwartet: JJJJ-MM-TT)' });
        }
        if (!db.prepare('SELECT id FROM mangas WHERE id = ?').get(mId)) {
            return res.status(404).json({ error: 'Manga nicht gefunden' });
        }

        let imagesVal = null;
        if (images) {
            const parsedImages = parseImagesInput(images);
            if (parsedImages.error) return res.status(400).json({ error: 'Ungültige Bilderliste' });
            imagesVal = parsedImages.value;
        } else if (cover_image) {
            imagesVal = JSON.stringify([String(cover_image).trim()]);
        }

        const stmt = db.prepare(`
            INSERT INTO volumes (manga_id, volume_number, isbn, price, release_date, release_year, condition, pages, publisher, purchase_date, status, notes, cover_image, images, type, priority, target_price)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        let newVolumeId = null;
        runTransaction(() => {
            const result = stmt.run(
                mId,
                volNumStr,
                normalizeIsbn(isbn),
                parsePrice(price),
                release_date ? String(release_date).trim() : null,
                parseNum(release_year),
                condition ? String(condition).trim() : null,
                parseNum(pages),
                publisher ? normalizePublisher(publisher) : null,
                purchase_date ? String(purchase_date).trim() : null,
                status || 'Vorhanden',
                notes ? String(notes).trim() : null,
                cover_image ? String(cover_image).trim() : null,
                imagesVal,
                volType,
                prio,
                parsePrice(target_price)
            );
            newVolumeId = Number(result.lastInsertRowid);
            syncOwnersWithStatus(db, newVolumeId, req.user.id);

            // Update owned count atomically
            const countRow = db.prepare("SELECT count(*) as count FROM volumes WHERE manga_id = ? AND status = 'Vorhanden'").get(mId);
            db.prepare('UPDATE mangas SET owned_volumes = ? WHERE id = ?').run(countRow.count, mId);
        });

        res.json({ success: true, id: newVolumeId });
    } catch (err) {
        log.error('Error adding volume:', err);
        res.status(500).json({ error: 'Fehler beim Hinzufügen des Bands' });
    }
});

// Batch add volumes (e.g. 1 to 20)
router.post('/volumes/batch', requireEditor, (req, res) => {
    try {
        const { 
            manga_id, 
            from, 
            to, 
            status = 'Vorhanden',
            default_price = null,
            publisher = null,
            condition = null,
            release_date = null,
            release_year = null
        } = req.body;
        const mId = parseInt(manga_id, 10);
        const start = parseInt(from, 10);
        const end = parseInt(to, 10);

        if (!mId || isNaN(start) || isNaN(end) || start < 0 || end < 0 || start > end || (end - start) > 300) {
            return res.status(400).json({ error: 'Ungültiger Bereich (maximal 300 Bände, positive Zahlen)' });
        }
        if (!VOLUME_STATUSES.includes(status || 'Vorhanden')) {
            return res.status(400).json({ error: 'Ungültiger Status (erlaubt: ' + VOLUME_STATUSES.join(', ') + ')' });
        }

        if (!db.prepare('SELECT id FROM mangas WHERE id = ?').get(mId)) {
            return res.status(404).json({ error: 'Manga nicht gefunden' });
        }

        const existing = db.prepare('SELECT volume_number FROM volumes WHERE manga_id = ?').all(mId);
        const existingSet = new Set(existing.map(v => String(v.volume_number)));

        const insertStmt = db.prepare(`
            INSERT INTO volumes (manga_id, volume_number, status, price, publisher, condition, release_date, release_year)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const p = parsePrice(default_price);
        const pub = publisher ? normalizePublisher(publisher) : null;
        const cond = condition ? String(condition).trim() : null;
        const rDate = release_date ? String(release_date).trim() : null;
        const year = parseNum(release_year);

        runTransaction(() => {
            for (let i = start; i <= end; i++) {
                if (!existingSet.has(String(i))) {
                    const r = insertStmt.run(mId, String(i), status || 'Vorhanden', p, pub, cond, rDate, year);
                    syncOwnersWithStatus(db, Number(r.lastInsertRowid), req.user.id);
                }
            }
            // Update owned count within the same transaction
            const countRow = db.prepare("SELECT count(*) as count FROM volumes WHERE manga_id = ? AND status = 'Vorhanden'").get(mId);
            db.prepare('UPDATE mangas SET owned_volumes = ? WHERE id = ?').run(countRow.count, mId);
        });

        res.json({ success: true });
    } catch (err) {
        log.error('Error batch adding volumes:', err);
        res.status(500).json({ error: 'Fehler beim Hinzufügen mehrerer Bände' });
    }
});

router.put('/volumes/:id', requireEditor, (req, res) => {
    try {
        const vol = db.prepare('SELECT * FROM volumes WHERE id = ?').get(req.params.id);
        if (!vol) return res.status(404).json({ error: 'Band nicht gefunden' });

        const body = req.body;
        if (body.status !== undefined && body.status !== vol.status && !VOLUME_STATUSES.includes(body.status)) {
            return res.status(400).json({ error: 'Ungültiger Status (erlaubt: ' + VOLUME_STATUSES.join(', ') + ')' });
        }
        const volume_number = body.volume_number !== undefined ? String(body.volume_number).trim() : vol.volume_number;
        const isbn = body.isbn !== undefined ? normalizeIsbn(body.isbn) : vol.isbn;
        const price = body.price !== undefined ? parsePrice(body.price) : vol.price;
        const release_date = body.release_date !== undefined ? (body.release_date ? String(body.release_date).trim() : null) : vol.release_date;
        const release_year = body.release_year !== undefined ? parseNum(body.release_year) : vol.release_year;
        const condition = body.condition !== undefined ? (body.condition ? String(body.condition).trim() : null) : vol.condition;
        const pages = body.pages !== undefined ? parseNum(body.pages) : vol.pages;
        const publisher = body.publisher !== undefined ? normalizePublisher(body.publisher) : normalizePublisher(vol.publisher);
        const purchase_date = body.purchase_date !== undefined ? (body.purchase_date ? String(body.purchase_date).trim() : null) : vol.purchase_date;
        const status = body.status !== undefined ? body.status : vol.status;
        const notes = body.notes !== undefined ? (body.notes ? String(body.notes).trim() : null) : vol.notes;

        const priority = body.priority !== undefined ? parsePriority(body.priority) : (vol.priority || 0);
        if (priority === null) return res.status(400).json({ error: 'Ungültige Priorität (0 bis 3)' });
        const target_price = body.target_price !== undefined ? parsePrice(body.target_price) : vol.target_price;

        let volType = vol.type || 'volume';
        if (body.type !== undefined) {
            const rawType = String(body.type).trim().toLowerCase();
            if (['volume', 'special_edition', 'schuber', 'special'].includes(rawType)) {
                volType = rawType;
            }
        }

        // Only values that change are checked: the app sends the whole row back on a status toggle, and older rows may hold odd dates
        if ((release_date !== vol.release_date && !isValidDate(release_date)) || (purchase_date !== vol.purchase_date && !isValidDate(purchase_date))) {
            return res.status(400).json({ error: 'Ungültiges Datum (erwartet: JJJJ-MM-TT)' });
        }

        let imagesVal = vol.images;
        if (body.images !== undefined) {
            const parsedImages = parseImagesInput(body.images);
            if (parsedImages.error) return res.status(400).json({ error: 'Ungültige Bilderliste' });
            imagesVal = parsedImages.value;
        }

        let cover_image = body.cover_image !== undefined 
            ? (body.cover_image ? String(body.cover_image).trim() : null) 
            : vol.cover_image;

        if (!cover_image && imagesVal) {
            try {
                const parsed = JSON.parse(imagesVal);
                if (Array.isArray(parsed) && parsed.length > 0) cover_image = parsed[0];
            } catch (e) {}
        }

        // Renumbering or retyping must not collide with another entry of the same series (same rule as POST)
        if (volume_number !== vol.volume_number || volType !== (vol.type || 'volume')) {
            const duplicate = db.prepare(`
                SELECT id, status FROM volumes
                WHERE manga_id = ? AND id != ? AND LOWER(TRIM(volume_number)) = LOWER(?) AND COALESCE(type, 'volume') = ?
            `).get(vol.manga_id, vol.id, volume_number, volType);
            if (duplicate) {
                const label = volType === 'volume' ? `Band ${volume_number}` : volume_number;
                return res.status(409).json({
                    error: `${label} existiert bereits (${duplicate.status}). Bitte den vorhandenen Eintrag bearbeiten.`,
                    existing_id: duplicate.id
                });
            }
        }

        const stmt = db.prepare(`
            UPDATE volumes SET 
                volume_number = ?, isbn = ?, price = ?, release_date = ?, release_year = ?, 
                condition = ?, pages = ?, publisher = ?, purchase_date = ?, 
                status = ?, notes = ?, cover_image = ?, images = ?, type = ?, priority = ?, target_price = ?
            WHERE id = ?
        `);

        runTransaction(() => {
            stmt.run(volume_number, isbn, price, release_date, release_year, condition, pages, publisher, purchase_date, status, notes, cover_image, imagesVal, volType, priority, target_price, req.params.id);
            syncOwnersWithStatus(db, vol.id, req.user.id);

            // Update owned count atomically
            const countRow = db.prepare("SELECT count(*) as count FROM volumes WHERE manga_id = ? AND status = 'Vorhanden'").get(vol.manga_id);
            db.prepare('UPDATE mangas SET owned_volumes = ? WHERE id = ?').run(countRow.count, vol.manga_id);
        });

        res.json({ success: true });
    } catch (err) {
        log.error('Error updating volume:', err);
        res.status(500).json({ error: 'Fehler beim Aktualisieren des Bands' });
    }
});

router.delete('/volumes/:id', requireEditor, (req, res) => {
    try {
        const vol = db.prepare('SELECT manga_id FROM volumes WHERE id = ?').get(req.params.id);
        if (!vol) return res.status(404).json({ error: 'Band nicht gefunden' });

        runTransaction(() => {
            db.prepare('DELETE FROM volume_reads WHERE volume_id = ?').run(req.params.id);
            db.prepare('DELETE FROM volumes WHERE id = ?').run(req.params.id);

            // Update owned count atomically
            const countRow = db.prepare("SELECT count(*) as count FROM volumes WHERE manga_id = ? AND status = 'Vorhanden'").get(vol.manga_id);
            db.prepare('UPDATE mangas SET owned_volumes = ? WHERE id = ?').run(countRow.count, vol.manga_id);
        });

        res.json({ success: true });
    } catch (err) {
        log.error('Error deleting volume:', err);
        res.status(500).json({ error: 'Fehler beim Löschen des Bands' });
    }
});

// --- VOLUME OWNERSHIP (Multi-User): mehrere Personen können denselben Band besitzen ---
router.post('/volumes/:id/owners', requireEditor, (req, res) => {
    try {
        const volumeId = parseInt(req.params.id, 10);
        const body = req.body || {};
        // Jeder ändert nur den eigenen Besitz; Admins dürfen für andere eintragen
        const targetUserId = (body.user_id && req.user.role === 'admin') ? parseInt(body.user_id, 10) : req.user.id;
        const vol = db.prepare('SELECT id, manga_id, price, purchase_date, condition FROM volumes WHERE id = ?').get(volumeId);
        if (!vol) return res.status(404).json({ error: 'Band nicht gefunden' });
        if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(targetUserId)) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

        let status;
        runTransaction(() => {
            const exists = db.prepare('SELECT 1 FROM volume_owners WHERE volume_id = ? AND user_id = ?').get(volumeId, targetUserId);
            const wantOwned = body.owned !== undefined ? !!body.owned : !exists;
            if (wantOwned && !exists) {
                const price = body.price !== undefined ? parsePrice(body.price) : vol.price;
                addOwner(db, volumeId, targetUserId, {
                    price,
                    purchase_date: body.purchase_date ? String(body.purchase_date).trim() : vol.purchase_date,
                    condition: vol.condition
                });
            } else if (!wantOwned && exists) {
                db.prepare('DELETE FROM volume_owners WHERE volume_id = ? AND user_id = ?').run(volumeId, targetUserId);
            }
            status = syncStatusWithOwners(db, volumeId);
            recountOwned(db, vol.manga_id);
        });

        const owners = listOwners(db, volumeId);
        res.json({ success: true, status, owners, owned_by_me: owners.some(o => o.user_id === req.user.id) });
    } catch (e) {
        log.error('Error updating ownership:', e);
        res.status(500).json({ error: 'Fehler beim Aktualisieren des Besitzes' });
    }
});

// --- VOLUME READING STATUS (Multi-User) ---
router.post('/volumes/:id/read', requireEditor, (req, res) => {
    try {
        const volumeId = parseInt(req.params.id, 10);
        const targetUserId = (req.body.user_id && req.user.role === 'admin') ? parseInt(req.body.user_id, 10) : req.user.id;
        const vol = db.prepare('SELECT id FROM volumes WHERE id = ?').get(volumeId);
        if (!vol) return res.status(404).json({ error: 'Band nicht gefunden' });
        if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(targetUserId)) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

        const existing = db.prepare('SELECT * FROM volume_reads WHERE volume_id = ? AND user_id = ?').get(volumeId, targetUserId);
        let isRead = false;

        const explicitRead = req.body.read !== undefined ? req.body.read : req.body.is_read;
        if (explicitRead !== undefined) {
            if (parseFlag(explicitRead)) {
                if (!existing) {
                    db.prepare('INSERT INTO volume_reads (volume_id, user_id) VALUES (?, ?)').run(volumeId, targetUserId);
                }
                isRead = true;
            } else {
                if (existing) {
                    db.prepare('DELETE FROM volume_reads WHERE volume_id = ? AND user_id = ?').run(volumeId, targetUserId);
                }
                isRead = false;
            }
        } else {
            // Toggle
            if (existing) {
                db.prepare('DELETE FROM volume_reads WHERE volume_id = ? AND user_id = ?').run(volumeId, targetUserId);
                isRead = false;
            } else {
                db.prepare('INSERT INTO volume_reads (volume_id, user_id) VALUES (?, ?)').run(volumeId, targetUserId);
                isRead = true;
            }
        }

        const readRows = db.prepare('SELECT vr.user_id, u.username FROM volume_reads vr JOIN users u ON vr.user_id = u.id WHERE vr.volume_id = ?').all(volumeId);
        const readBy = readRows.map(r => r.user_id);

        res.json({ success: true, is_read: isRead, read_by: readBy, read_users: readRows });
    } catch (e) {
        log.error('Error updating read status:', e);
        res.status(500).json({ error: 'Fehler beim Aktualisieren des Lesestatus' });
    }
});

router.post('/volumes/batch-read', requireEditor, (req, res) => {
    try {
        const readParam = req.body.read !== undefined ? req.body.read : req.body.is_read;
        const read = readParam !== undefined ? parseFlag(readParam) : true;
        const { manga_id, up_to_volume, user_id } = req.body;
        const targetUserId = (user_id && req.user.role === 'admin') ? parseInt(user_id, 10) : req.user.id;
        const mId = parseInt(manga_id, 10);
        const maxVol = parseFloat(up_to_volume);

        if (!mId || isNaN(maxVol)) {
            return res.status(400).json({ error: 'Ungültige Parameter' });
        }
        if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(targetUserId)) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

        const volumes = db.prepare("SELECT id, volume_number, type FROM volumes WHERE manga_id = ? AND status = 'Vorhanden'").all(mId);
        const targetVols = volumes.filter(v => {
            if (v.type === 'schuber') return false;
            const num = parseFloat(v.volume_number);
            return !isNaN(num) && num <= maxVol;
        });

        const insertStmt = db.prepare('INSERT OR IGNORE INTO volume_reads (volume_id, user_id) VALUES (?, ?)');
        const deleteStmt = db.prepare('DELETE FROM volume_reads WHERE volume_id = ? AND user_id = ?');

        runTransaction(() => {
            for (const v of targetVols) {
                if (read) {
                    insertStmt.run(v.id, targetUserId);
                } else {
                    deleteStmt.run(v.id, targetUserId);
                }
            }
        });

        res.json({ success: true, count: targetVols.length });
    } catch (e) {
        log.error('Error batch updating read status:', e);
        res.status(500).json({ error: 'Fehler beim Batch-Lesestatus' });
    }
});

// --- VOLUME METADATA LOOKUP (Manga Passion & DNB) ---
router.get('/volumes/lookup', requireAuth, async (req, res) => {
    try {
        const mangaId = req.query.manga_id ? parseInt(req.query.manga_id, 10) : null;
        const volumeNumber = qstr(req.query.volume_number);
        const isbn = normalizeIsbn(qstr(req.query.isbn));
        const type = qstr(req.query.type)?.trim() || null;
        const notes = qstr(req.query.notes)?.trim() || null;
        const price = req.query.price ? parseFloat(req.query.price) : null;
        const url = qstr(req.query.url)?.trim() || null;
        const mpVolumeId = qstr(req.query.mp_volume_id)?.trim() || null;
        const forceRefresh = req.query.force_refresh === 'true';

        if (!volumeNumber && !isbn && !url && !mpVolumeId) {
            return res.status(400).json({ error: 'Band-Nummer, ISBN oder URL erforderlich' });
        }

        const result = await lookupVolumeMetadata(mangaId, volumeNumber, {
            isbn,
            type,
            notes,
            price,
            url,
            mp_volume_id: mpVolumeId,
            force_refresh: forceRefresh
        });

        res.json(result);
    } catch (err) {
        log.error('Volume metadata lookup error:', err);
        res.status(500).json({ error: 'Fehler beim Abrufen der Band-Metadaten' });
    }
});

module.exports = router;
