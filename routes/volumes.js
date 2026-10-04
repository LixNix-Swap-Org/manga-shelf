const express = require('express');
const router = express.Router();
const { db, runTransaction } = require('../db');
const { requireEditor } = require('../middleware/auth');
const { normalizePublisher } = require('../utils/publishers');
const { qstr } = require('../utils/query');
const { normalizeIsbn } = require('../utils/isbn');
const { lookupVolumeMetadata } = require('../mangaPassion');
const {
    OWNED_STATUS, isLegacyReadStatus, addOwner, listOwners, markRead, syncOwnersWithStatus, syncStatusWithOwners, convertLegacyRead,
    purchaseDateFromRemainingOwners
} = require('../utils/owners');
const { canonicalVolumeNumber } = require('../utils/volumeNumber');
const { lookupLimiter } = require('../middleware/userLimits');
const { HttpError, badRequest, notFound, conflict } = require('../utils/httpError');
const { MAX_NOTES_LENGTH } = require('../services/csvExchange');

// Statuses the app works with (volume editor, shopping list, release radar, Manga Passion import).
// The legacy 'Gelesen' is still accepted as input and stored as 'Vorhanden' plus a read entry (utils/owners.js).
const VOLUME_STATUSES = ['Vorhanden', 'Fehlt', 'Vorbestellt', 'Erscheint bald', 'Bestellt'];
const VOLUME_TYPES = ['volume', 'special_edition', 'schuber', 'special'];
const MAX_BATCH_VOLUMES = 300;

const STATUS_ERROR = 'Ungültiger Status (erlaubt: ' + VOLUME_STATUSES.join(', ') + ')';
const TYPE_ERROR = 'Ungültiger Typ (erlaubt: ' + VOLUME_TYPES.join(', ') + ')';
const DATE_ERROR = 'Ungültiges Datum (erwartet: JJJJ-MM-TT)';
const FIELD_ERRORS = {
    price: 'Ungültiger Preis',
    target_price: 'Ungültiger Zielpreis',
    default_price: 'Ungültiger Preis',
    pages: 'Ungültige Seitenzahl',
    release_year: 'Ungültiges Erscheinungsjahr'
};

const isBlank = (val) => val === null || val === undefined || (typeof val === 'string' && val.trim() === '');

// Prices as typed in German forms: "7,50", "€ 7,99", "1.234,56"; plain numbers from JSON. Empty clears the field.
const parsePrice = (val) => {
    if (isBlank(val)) return { value: null };
    let num;
    if (typeof val === 'number') {
        num = val;
    } else if (typeof val === 'string') {
        let s = val.replace(/€|eur/gi, '').replace(/\s/g, '');
        if (s === '') return { value: null };
        if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
        if (!/^\d+(\.\d{1,2})?$/.test(s)) return { error: true };
        num = Number(s);
    } else {
        return { error: true };
    }
    if (!Number.isFinite(num) || num < 0 || num > 99999) return { error: true };
    return { value: Math.round(num * 100) / 100 };
};

const parseIntInRange = (min, max) => (val) => {
    if (isBlank(val)) return { value: null };
    if (typeof val !== 'number' && !(typeof val === 'string' && /^\d+$/.test(val.trim()))) return { error: true };
    const n = Number(val);
    return Number.isInteger(n) && n >= min && n <= max ? { value: n } : { error: true };
};
const parsePages = parseIntInRange(1, 99999);
const parseYear = parseIntInRange(1900, 2999);

// JSON booleans as well as "true"/"false"/"0"/"1" strings ("false" must not count as true)
const parseFlag = (val) => !(val === false || val === 0 || val === null || /^(false|0|no|nein|)$/i.test(String(val).trim()));

/** 0 (keine) bis 3 (hoch); leer = 0, alles andere null (ungültig). */
const parsePriority = (val) => {
    if (val === undefined || val === null || val === '') return 0;
    const n = Number(val);
    return Number.isInteger(n) && n >= 0 && n <= 3 ? n : null;
};

// Dates as the forms and imports write them: YYYY, YYYY-MM or YYYY-MM-DD (empty = not set); full dates must exist
const isValidDate = (val) => {
    if (isBlank(val)) return true;
    if (typeof val !== 'string' && typeof val !== 'number') return false;
    const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(String(val).trim());
    if (!m) return false;
    const year = parseInt(m[1], 10);
    const month = m[2] ? parseInt(m[2], 10) : 1;
    const day = m[3] ? parseInt(m[3], 10) : 1;
    if (year < 1900 || year > 2999 || month < 1 || month > 12) return false;
    const dt = new Date(Date.UTC(year, month - 1, day));
    return dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
};
// volume_reads.read_at as SQLite's CURRENT_TIMESTAMP writes it (UTC)
const isValidReadAt = (val) => {
    if (typeof val !== 'string') return false;
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(val.trim());
    if (!m || !isValidDate(`${m[1]}-${m[2]}-${m[3]}`)) return false;
    return Number(m[4]) < 24 && Number(m[5]) < 60 && Number(m[6]) < 60;
};
const parseDate = (val) => (isValidDate(val) ? { value: isBlank(val) ? null : String(val).trim() } : { error: true });

const parseStatus = (val, { allowEmpty }) => {
    if (val === undefined || val === null || val === '') return allowEmpty ? { value: OWNED_STATUS, read: false } : { error: true };
    if (isLegacyReadStatus(val)) return { value: OWNED_STATUS, read: true };
    return VOLUME_STATUSES.includes(val) ? { value: val, read: false } : { error: true };
};

// Empty means "not given"; anything else must be one of the four types (case and surrounding spaces do not matter)
const parseType = (val) => {
    if (isBlank(val)) return { value: null };
    const t = typeof val === 'string' ? val.trim().toLowerCase() : null;
    return VOLUME_TYPES.includes(t) ? { value: t } : { error: true };
};

const volumeKey = (num, type) => canonicalVolumeNumber(num, type).toLowerCase();

const parseVolumeNumber = (val, type) => {
    if (!(typeof val === 'string' || (typeof val === 'number' && Number.isFinite(val))) || String(val).trim() === '') {
        return { error: 'Gültige Bandnummer erforderlich' };
    }
    const s = String(val).trim();
    if (s.length > 80) return { error: 'Bandnummer ist zu lang (maximal 80 Zeichen)' };
    return { value: canonicalVolumeNumber(s, type) };
};

// Same wording as getVolumeDisplayTitle() in the frontend (without the edition name from the notes)
const entryLabel = (type, num) => {
    const s = String(num);
    const lower = s.toLowerCase();
    if (type === 'schuber') return lower.includes('schuber') ? s : `Schuber ${s}`;
    if (type === 'special') return /^(special|extra|sonderband)/.test(lower) ? s : `Special ${s}`;
    if (type === 'special_edition') return `Special Edition ${s}`;
    return lower.startsWith('band') ? s : `Band ${s}`;
};

/** Another entry of the series with the same type and number (case, spaces and a "Band " prefix ignored). */
function findDuplicate(mangaId, volumeNumber, type, excludeId = null) {
    const key = volumeKey(volumeNumber, type);
    const rows = db.prepare("SELECT id, status, volume_number FROM volumes WHERE manga_id = ? AND COALESCE(type, 'volume') = ?").all(mangaId, type);
    return rows.find(r => r.id !== excludeId && volumeKey(r.volume_number, type) === key) || null;
}

const duplicateError = (type, volumeNumber, duplicate) => conflict(
    `${entryLabel(type, volumeNumber)} existiert bereits (${duplicate.status}). Bitte den vorhandenen Eintrag bearbeiten.`,
    'VOLUME_DUPLICATE',
    { existing_id: duplicate.id }
);

const NOTES_ERROR = `Notizen sind zu lang (maximal ${MAX_NOTES_LENGTH} Zeichen)`;
const cleanNotes = (val) => {
    const text = val ? String(val).trim() : null;
    if (text && text.length > MAX_NOTES_LENGTH) throw badRequest(NOTES_ERROR, 'NOTES_TOO_LONG');
    return text || null;
};

const sameAsStored = (input, stored) => (isBlank(input) ? '' : String(input).trim()) === (isBlank(stored) ? '' : String(stored).trim());

// PUT: only values that change are validated. The app sends the whole row back (status toggle, cover pick), and older rows may hold odd values
function updatedField(body, key, stored, parse) {
    if (body[key] === undefined) return { value: stored };
    const parsed = parse(body[key]);
    if (parsed.error && sameAsStored(body[key], stored)) return { value: stored };
    return parsed;
}

/**
 * Whose ownership or reading state a request changes. Non-admins may only act for themselves; sending their own id is fine
 * (the UI always sends one). Returns the user id or throws 400/403/404.
 */
function resolveTargetUser(req, raw) {
    if (raw === undefined || raw === null || raw === '') return req.user.id;
    const text = String(raw).trim();
    const id = (typeof raw === 'number' || typeof raw === 'string') && /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(id)) throw badRequest('Ungültige user_id');
    if (id !== Number(req.user.id) && req.user.role !== 'admin') {
        throw new HttpError(403, 'Nur Administratoren dürfen das für andere Benutzer ändern', 'FORBIDDEN');
    }
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw notFound('Benutzer');
    return id;
}

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

/** Parses the numeric fields of a request body; returns { values } or { error }. */
function parseNumericFields(source, parsers) {
    const values = {};
    for (const [key, parse] of Object.entries(parsers)) {
        const parsed = parse(source[key]);
        if (parsed.error) return { error: FIELD_ERRORS[key] };
        values[key] = parsed.value;
    }
    return { values };
}

// --- VOLUMES API ---
router.post('/volumes', requireEditor, (req, res) => {
    const {
        manga_id,
        volume_number,
        isbn = null,
        release_date = null,
        condition = null,
        publisher = null,
        purchase_date = null,
        status,
        notes = null,
        cover_image = null,
        images = null,
        type,
        priority = 0
    } = req.body;

    const mId = parseInt(manga_id, 10);
    if (!mId || isNaN(mId)) {
        throw badRequest('Gültige manga_id und Bandnummer erforderlich');
    }
    const st = parseStatus(status, { allowEmpty: true });
    if (st.error) throw badRequest(STATUS_ERROR);

    const prio = parsePriority(priority);
    if (prio === null) throw badRequest('Ungültige Priorität (0 bis 3)');

    // An absent type means a regular volume; an unknown one is an error rather than a guess
    const ty = parseType(type);
    if (ty.error) throw badRequest(TYPE_ERROR);
    const volType = ty.value || 'volume';

    const num = parseVolumeNumber(volume_number, volType);
    if (num.error) throw badRequest(num.error);
    const volNumStr = num.value;

    if (!isValidDate(release_date) || !isValidDate(purchase_date)) {
        throw badRequest(DATE_ERROR);
    }
    const numeric = parseNumericFields(req.body, { price: parsePrice, target_price: parsePrice, pages: parsePages, release_year: parseYear });
    if (numeric.error) throw badRequest(numeric.error);

    const notesVal = cleanNotes(notes);
    let imagesVal = null;
    if (images) {
        const parsedImages = parseImagesInput(images);
        if (parsedImages.error) throw badRequest('Ungültige Bilderliste');
        imagesVal = parsedImages.value;
    } else if (cover_image) {
        imagesVal = JSON.stringify([String(cover_image).trim()]);
    }

    if (!db.prepare('SELECT id FROM mangas WHERE id = ?').get(mId)) {
        throw notFound('Manga');
    }

    // The same type + number twice is almost always a double click or a repeated entry; edit the existing one instead
    const duplicate = findDuplicate(mId, volNumStr, volType);
    if (duplicate) throw duplicateError(volType, volNumStr, duplicate);

    const stmt = db.prepare(`
        INSERT INTO volumes (manga_id, volume_number, isbn, price, release_date, release_year, condition, pages, publisher, purchase_date, status, notes, cover_image, images, type, priority, target_price)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const { price, target_price, pages, release_year } = numeric.values;
    let newVolumeId = null;
    runTransaction(() => {
        const result = stmt.run(
            mId,
            volNumStr,
            normalizeIsbn(isbn),
            price,
            isBlank(release_date) ? null : String(release_date).trim(),
            release_year,
            condition ? String(condition).trim() : null,
            pages,
            publisher ? normalizePublisher(publisher) : null,
            isBlank(purchase_date) ? null : String(purchase_date).trim(),
            st.value,
            notesVal,
            cover_image ? String(cover_image).trim() : null,
            imagesVal,
            volType,
            prio,
            target_price
        );
        newVolumeId = Number(result.lastInsertRowid);
        syncOwnersWithStatus(db, newVolumeId, req.user.id);
        if (st.read) markRead(db, newVolumeId, req.user.id);
    });

    res.json({ success: true, id: newVolumeId });
});

const parseWholeNumber = (val) => {
    const text = typeof val === 'number' ? String(val) : (typeof val === 'string' ? val.trim() : '');
    if (!/^\d+$/.test(text)) return null;
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : null;
};

// Batch add regular volumes (e.g. 1 to 20); numbers that already exist as a regular volume are skipped
router.post('/volumes/batch', requireEditor, (req, res) => {
    const {
        manga_id,
        from,
        to,
        status,
        publisher = null,
        condition = null,
        release_date = null
    } = req.body;
    const mId = parseInt(manga_id, 10);
    const start = parseWholeNumber(from);
    const end = parseWholeNumber(to);

    if (!mId || start === null || end === null || start < 1 || start > end || end - start + 1 > MAX_BATCH_VOLUMES) {
        throw badRequest(`Ungültiger Bereich (maximal ${MAX_BATCH_VOLUMES} Bände, positive Zahlen)`);
    }
    const st = parseStatus(status, { allowEmpty: true });
    if (st.error) throw badRequest(STATUS_ERROR);
    if (!isValidDate(release_date)) throw badRequest(DATE_ERROR);
    const numeric = parseNumericFields(req.body, { default_price: parsePrice, release_year: parseYear });
    if (numeric.error) throw badRequest(numeric.error);

    if (!db.prepare('SELECT id FROM mangas WHERE id = ?').get(mId)) {
        throw notFound('Manga');
    }

    // Special editions, Schuber and Specials carry their own numbers and never block a regular volume
    const existing = db.prepare("SELECT volume_number FROM volumes WHERE manga_id = ? AND COALESCE(type, 'volume') = 'volume'").all(mId);
    const existingSet = new Set(existing.map(v => volumeKey(v.volume_number, 'volume')));

    const insertStmt = db.prepare(`
        INSERT INTO volumes (manga_id, volume_number, status, price, publisher, condition, release_date, release_year, type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'volume')
    `);

    const pub = publisher ? normalizePublisher(publisher) : null;
    const cond = condition ? String(condition).trim() : null;
    const rDate = isBlank(release_date) ? null : String(release_date).trim();
    const { default_price: price, release_year: year } = numeric.values;
    let created = 0;
    const skipped = [];

    runTransaction(() => {
        for (let i = start; i <= end; i++) {
            if (existingSet.has(String(i))) {
                skipped.push(String(i));
                continue;
            }
            const volumeId = Number(insertStmt.run(mId, String(i), st.value, price, pub, cond, rDate, year).lastInsertRowid);
            syncOwnersWithStatus(db, volumeId, req.user.id);
            if (st.read) markRead(db, volumeId, req.user.id);
            created++;
        }
    });

    res.json({ success: true, created, skipped });
});

router.put('/volumes/:id', requireEditor, (req, res) => {
    const vol = db.prepare('SELECT * FROM volumes WHERE id = ?').get(req.params.id);
    if (!vol) throw notFound('Band');

    const body = req.body;
    let status = vol.status;
    if (body.status !== undefined && body.status !== vol.status) {
        const st = parseStatus(body.status, { allowEmpty: false });
        if (st.error) throw badRequest(STATUS_ERROR);
        status = st.value;
    }
    // A legacy 'Gelesen' (sent or still stored) becomes 'Vorhanden' plus a read entry for the editing user
    const markAsRead = isLegacyReadStatus(body.status) || isLegacyReadStatus(status);
    if (isLegacyReadStatus(status)) status = OWNED_STATUS;

    let volType = vol.type || 'volume';
    if (body.type !== undefined) {
        const ty = parseType(body.type);
        if (ty.error && !sameAsStored(body.type, vol.type)) throw badRequest(TYPE_ERROR);
        if (ty.value) volType = ty.value;
    }

    let volume_number = vol.volume_number;
    if (body.volume_number !== undefined && !sameAsStored(body.volume_number, vol.volume_number)) {
        const num = parseVolumeNumber(body.volume_number, volType);
        if (num.error) throw badRequest(num.error);
        volume_number = num.value;
    } else if (volType !== (vol.type || 'volume')) {
        volume_number = canonicalVolumeNumber(vol.volume_number, volType) || vol.volume_number;
    }

    const dates = {};
    for (const key of ['release_date', 'purchase_date']) {
        const parsed = updatedField(body, key, vol[key], parseDate);
        if (parsed.error) throw badRequest(DATE_ERROR);
        dates[key] = parsed.value;
    }
    const numbers = {};
    for (const [key, parse] of Object.entries({ price: parsePrice, target_price: parsePrice, pages: parsePages, release_year: parseYear })) {
        const parsed = updatedField(body, key, vol[key], parse);
        if (parsed.error) throw badRequest(FIELD_ERRORS[key]);
        numbers[key] = parsed.value;
    }
    const { release_date, purchase_date } = dates;
    const { price, target_price, pages, release_year } = numbers;

    const isbn = body.isbn !== undefined ? normalizeIsbn(body.isbn) : vol.isbn;
    const condition = body.condition !== undefined ? (body.condition ? String(body.condition).trim() : null) : vol.condition;
    const publisher = body.publisher !== undefined ? normalizePublisher(body.publisher) : normalizePublisher(vol.publisher);
    // a longer legacy note sent back unchanged does not block other edits
    const notes = body.notes === undefined || sameAsStored(body.notes, vol.notes) ? vol.notes : cleanNotes(body.notes);

    const priority = body.priority !== undefined ? parsePriority(body.priority) : (vol.priority || 0);
    if (priority === null) throw badRequest('Ungültige Priorität (0 bis 3)');

    let imagesVal = vol.images;
    if (body.images !== undefined) {
        const parsedImages = parseImagesInput(body.images);
        if (parsedImages.error) throw badRequest('Ungültige Bilderliste');
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
    if (volType !== (vol.type || 'volume') || volumeKey(volume_number, volType) !== volumeKey(vol.volume_number, volType)) {
        const duplicate = findDuplicate(vol.manga_id, volume_number, volType, vol.id);
        if (duplicate) throw duplicateError(volType, volume_number, duplicate);
    }

    const stmt = db.prepare(`
        UPDATE volumes SET 
            volume_number = ?, isbn = ?, price = ?, release_date = ?, release_year = ?, 
            condition = ?, pages = ?, publisher = ?, purchase_date = ?, 
            status = ?, notes = ?, cover_image = ?, images = ?, type = ?, priority = ?, target_price = ?
        WHERE id = ?
    `);

    runTransaction(() => {
        // Owner rows copied the volume's price/date/condition; those still holding the old value follow the correction,
        // a different value set per owner stays
        for (const [column, next] of [['price', price], ['purchase_date', purchase_date], ['condition', condition]]) {
            if (next !== vol[column]) {
                db.prepare(`UPDATE volume_owners SET ${column} = ? WHERE volume_id = ? AND ${column} IS ?`).run(next, vol.id, vol[column]);
            }
        }
        stmt.run(volume_number, isbn, price, release_date, release_year, condition, pages, publisher, purchase_date, status, notes, cover_image, imagesVal, volType, priority, target_price, vol.id);
        syncOwnersWithStatus(db, vol.id, req.user.id);
        if (markAsRead && status === OWNED_STATUS) markRead(db, vol.id, req.user.id);
    });

    res.json({ success: true });
});

router.delete('/volumes/:id', requireEditor, (req, res) => {
    const vol = db.prepare('SELECT manga_id FROM volumes WHERE id = ?').get(req.params.id);
    if (!vol) throw notFound('Band');

    runTransaction(() => {
        db.prepare('DELETE FROM volume_reads WHERE volume_id = ?').run(req.params.id);
        db.prepare('DELETE FROM volumes WHERE id = ?').run(req.params.id);
    });

    res.json({ success: true });
});

// --- VOLUME OWNERSHIP (Multi-User): mehrere Personen können denselben Band besitzen ---
router.post('/volumes/:id/owners', requireEditor, (req, res) => {
    const volumeId = parseInt(req.params.id, 10);
    const body = req.body || {};
    const vol = db.prepare('SELECT id, manga_id, status, price, purchase_date, condition FROM volumes WHERE id = ?').get(volumeId);
    if (!vol) throw notFound('Band');
    // Jeder ändert nur den eigenen Besitz; Admins dürfen für andere eintragen
    const targetUserId = resolveTargetUser(req, body.user_id);
    const ownerPrice = parsePrice(body.price);
    if (ownerPrice.error) throw badRequest(FIELD_ERRORS.price);
    if (!isValidDate(body.purchase_date)) throw badRequest(DATE_ERROR);
    // undo of a toggle: the volume date as the earlier answer reported it (previous_purchase_date)
    const restoreDate = Object.hasOwn(body, 'previous_purchase_date') ? parseDate(body.previous_purchase_date) : null;
    if (restoreDate?.error) throw badRequest(DATE_ERROR);

    let status;
    let removedOwner = null;
    runTransaction(() => {
        const isOwner = () => Boolean(db.prepare('SELECT 1 FROM volume_owners WHERE volume_id = ? AND user_id = ?').get(volumeId, targetUserId));
        const wasOwner = isOwner();
        const hadOwners = Boolean(db.prepare('SELECT 1 FROM volume_owners WHERE volume_id = ? LIMIT 1').get(volumeId));
        const wantOwned = body.owned !== undefined ? parseFlag(body.owned) : !wasOwner;
        const ownerPriceValue = ownerPrice.value ?? vol.price;
        const ownerDate = isBlank(body.purchase_date) ? vol.purchase_date : String(body.purchase_date).trim();
        // a legacy 'Gelesen' row is converted while its owners are still there (else the target becomes its owner)
        convertLegacyRead(db, volumeId, targetUserId);
        const ownsNow = isOwner();
        if (wantOwned && !wasOwner) {
            if (ownsNow) {
                db.prepare('UPDATE volume_owners SET price = ?, purchase_date = ? WHERE volume_id = ? AND user_id = ?')
                    .run(ownerPriceValue, ownerDate, volumeId, targetUserId);
            } else {
                addOwner(db, volumeId, targetUserId, { price: ownerPriceValue, purchase_date: ownerDate, condition: vol.condition });
            }
        } else if (!wantOwned && ownsNow) {
            removedOwner = db.prepare('SELECT user_id, price, purchase_date, condition FROM volume_owners WHERE volume_id = ? AND user_id = ?')
                .get(volumeId, targetUserId);
            db.prepare('DELETE FROM volume_owners WHERE volume_id = ? AND user_id = ?').run(volumeId, targetUserId);
        }
        status = syncStatusWithOwners(db, volumeId);
        if (removedOwner && status === OWNED_STATUS) purchaseDateFromRemainingOwners(db, volumeId);
        // stats, CSV and the edit form read volumes.purchase_date: the first purchase fills it, never overwrites it
        const becameOwned = wantOwned && !hadOwners && vol.status !== OWNED_STATUS && !isLegacyReadStatus(vol.status);
        if (becameOwned && status === OWNED_STATUS && !isBlank(ownerDate)) {
            db.prepare("UPDATE volumes SET purchase_date = ? WHERE id = ? AND (purchase_date IS NULL OR TRIM(purchase_date) = '')")
                .run(ownerDate, volumeId);
        }
        if (restoreDate) db.prepare('UPDATE volumes SET purchase_date = ? WHERE id = ?').run(restoreDate.value, volumeId);
    });

    const owners = listOwners(db, volumeId);
    res.json({
        success: true,
        status,
        owners,
        owned_by_me: owners.some(o => o.user_id === req.user.id),
        previous_purchase_date: vol.purchase_date,
        removed_owner: removedOwner
    });
});

// --- VOLUME READING STATUS (Multi-User) ---
router.post('/volumes/:id/read', requireEditor, (req, res) => {
    const volumeId = parseInt(req.params.id, 10);
    const vol = db.prepare('SELECT id FROM volumes WHERE id = ?').get(volumeId);
    if (!vol) throw notFound('Band');
    const targetUserId = resolveTargetUser(req, req.body.user_id);
    // undo of "unread": the read comes back with its original date (previous_read_at of that answer)
    const readAt = req.body.read_at;
    if (!isBlank(readAt) && !isValidReadAt(readAt)) throw badRequest('Ungültiger Lesezeitpunkt (erwartet: JJJJ-MM-TT HH:MM:SS, UTC)');

    const existing = db.prepare('SELECT read_at FROM volume_reads WHERE volume_id = ? AND user_id = ?').get(volumeId, targetUserId);
    const explicitRead = req.body.read !== undefined ? req.body.read : req.body.is_read;
    const isRead = explicitRead !== undefined ? parseFlag(explicitRead) : !existing;
    let previousReadAt = null;
    if (isRead && !existing) {
        if (isBlank(readAt)) db.prepare('INSERT INTO volume_reads (volume_id, user_id) VALUES (?, ?)').run(volumeId, targetUserId);
        else db.prepare('INSERT INTO volume_reads (volume_id, user_id, read_at) VALUES (?, ?, ?)').run(volumeId, targetUserId, readAt.trim());
    } else if (!isRead && existing) {
        db.prepare('DELETE FROM volume_reads WHERE volume_id = ? AND user_id = ?').run(volumeId, targetUserId);
        previousReadAt = existing.read_at;
    }

    const readRows = db.prepare('SELECT vr.user_id, u.username FROM volume_reads vr JOIN users u ON vr.user_id = u.id WHERE vr.volume_id = ?').all(volumeId);
    const readBy = readRows.map(r => r.user_id);

    const body = { success: true, is_read: isRead, read_by: readBy, read_users: readRows };
    if (!isRead) body.previous_read_at = previousReadAt;
    res.json(body);
});

router.post('/volumes/batch-read', requireEditor, (req, res) => {
    const readParam = req.body.read !== undefined ? req.body.read : req.body.is_read;
    const read = readParam !== undefined ? parseFlag(readParam) : true;
    const { manga_id, up_to_volume, user_id } = req.body;
    const mId = parseInt(manga_id, 10);
    const maxVol = parseFloat(up_to_volume);

    if (!mId || isNaN(maxVol)) {
        throw badRequest('Ungültige Parameter');
    }
    const targetUserId = resolveTargetUser(req, user_id);
    if (!db.prepare('SELECT 1 FROM mangas WHERE id = ?').get(mId)) throw notFound('Manga');

    const volumes = db.prepare("SELECT id, volume_number, type FROM volumes WHERE manga_id = ? AND status = 'Vorhanden'").all(mId);
    const targetVols = volumes.filter(v => {
        if (v.type === 'schuber') return false;
        const num = parseFloat(v.volume_number);
        return !isNaN(num) && num <= maxVol;
    });

    const insertStmt = db.prepare('INSERT OR IGNORE INTO volume_reads (volume_id, user_id) VALUES (?, ?)');
    const deleteStmt = db.prepare('DELETE FROM volume_reads WHERE volume_id = ? AND user_id = ? RETURNING read_at');

    // changed_ids: the entries whose read state this request flipped, so a client can undo exactly those;
    // previous_read_at (unread only) lets that undo restore the original dates
    const changedIds = [];
    const previousReadAt = {};
    runTransaction(() => {
        for (const v of targetVols) {
            if (read) {
                if (insertStmt.run(v.id, targetUserId).changes > 0) changedIds.push(v.id);
                continue;
            }
            const removed = deleteStmt.get(v.id, targetUserId);
            if (removed) {
                changedIds.push(v.id);
                previousReadAt[v.id] = removed.read_at;
            }
        }
    });

    const body = { success: true, count: targetVols.length, changed_ids: changedIds };
    if (!read) body.previous_read_at = previousReadAt;
    res.json(body);
});

// --- VOLUME METADATA LOOKUP (Manga Passion) ---
// Editors only: a lookup downloads covers into uploads/ and may link the series to an edition
router.get('/volumes/lookup', requireEditor, lookupLimiter, async (req, res) => {
    const mangaId = req.query.manga_id ? parseInt(qstr(req.query.manga_id), 10) : null;
    const volumeNumber = qstr(req.query.volume_number);
    const isbn = normalizeIsbn(qstr(req.query.isbn));
    const type = qstr(req.query.type)?.trim() || null;
    const notes = qstr(req.query.notes)?.trim() || null;
    const rawPrice = qstr(req.query.price);
    const price = rawPrice ? parseFloat(rawPrice) : null;
    const url = qstr(req.query.url)?.trim() || null;
    const mpVolumeId = qstr(req.query.mp_volume_id)?.trim() || null;
    const forceRefresh = req.query.force_refresh === 'true';

    if (!volumeNumber && !isbn && !url && !mpVolumeId) {
        throw badRequest('Band-Nummer, ISBN oder URL erforderlich');
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
});

module.exports = router;
