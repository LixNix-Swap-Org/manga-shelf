// Volumes: create (single and batch), edit, delete, bulk edit (POST /volumes, /volumes/batch, /volumes/bulk, PUT/DELETE /volumes/:id).
const { normalizePublisher } = require('../lib/publishers');
const { normalizeIsbn } = require('../lib/isbn');
const {
    OWNED_STATUS, isLegacyReadStatus, addOwner, markRead, syncOwnersWithStatus, syncStatusWithOwners, convertLegacyRead,
    purchaseDateFromRemainingOwners
} = require('../lib/owners');
const { canonicalVolumeNumber } = require('../lib/volumeNumber');
const { resolveTargetUser } = require('../lib/access');
const { badRequest, notFound, conflict } = require('../errors');
const { MAX_NOTES_LENGTH } = require('../csvExchange');
const { moveVolumeToTrash, forgetTrashedVolume } = require('../lib/trash');
const {
    VOLUME_STATUSES, VOLUME_TYPES, BULK_SET_FIELDS, isBlank, parsePrice, parsePages, parseYear, parsePriority, isValidDate, parseDate,
    parseWholeNumber, parsePositiveInt, parseIdList, parseBulkSet, parseCondition, parseFlag, isValidReadAt
} = require('../lib/validate');

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
function findDuplicate(ctx, mangaId, volumeNumber, type, excludeId = null) {
    const key = volumeKey(volumeNumber, type);
    const rows = ctx.db.prepare("SELECT id, status, volume_number FROM volumes WHERE manga_id = ? AND COALESCE(type, 'volume') = ?").all(mangaId, type);
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

function create(ctx, { body }) {
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
    } = body;

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
    const numeric = parseNumericFields(body, { price: parsePrice, target_price: parsePrice, pages: parsePages, release_year: parseYear });
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

    if (!ctx.db.prepare('SELECT id FROM mangas WHERE id = ?').get(mId)) {
        throw notFound('Manga');
    }

    // The same type + number twice is almost always a double click or a repeated entry; edit the existing one instead
    const duplicate = findDuplicate(ctx, mId, volNumStr, volType);
    if (duplicate) throw duplicateError(volType, volNumStr, duplicate);

    const stmt = ctx.db.prepare(`
        INSERT INTO volumes (manga_id, volume_number, isbn, price, release_date, release_year, condition, pages, publisher, purchase_date, status, notes, cover_image, images, type, priority, target_price)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const { price, target_price, pages, release_year } = numeric.values;
    let newVolumeId = null;
    ctx.db.transaction(() => {
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
        syncOwnersWithStatus(ctx.db, newVolumeId, ctx.user.id);
        if (st.read) markRead(ctx.db, newVolumeId, ctx.user.id);
    });

    return { body: { success: true, id: newVolumeId } };
}

// Batch add regular volumes (e.g. 1 to 20); numbers that already exist as a regular volume are skipped
function createBatch(ctx, { body }) {
    const {
        manga_id,
        from,
        to,
        status,
        publisher = null,
        condition = null,
        release_date = null
    } = body;
    const mId = parseInt(manga_id, 10);
    const start = parseWholeNumber(from);
    const end = parseWholeNumber(to);

    if (!mId || start === null || end === null || start < 1 || start > end || end - start + 1 > MAX_BATCH_VOLUMES) {
        throw badRequest(`Ungültiger Bereich (maximal ${MAX_BATCH_VOLUMES} Bände, positive Zahlen)`);
    }
    const st = parseStatus(status, { allowEmpty: true });
    if (st.error) throw badRequest(STATUS_ERROR);
    if (!isValidDate(release_date)) throw badRequest(DATE_ERROR);
    const numeric = parseNumericFields(body, { default_price: parsePrice, release_year: parseYear });
    if (numeric.error) throw badRequest(numeric.error);

    if (!ctx.db.prepare('SELECT id FROM mangas WHERE id = ?').get(mId)) {
        throw notFound('Manga');
    }

    // Special editions, Schuber and Specials carry their own numbers and never block a regular volume
    const existing = ctx.db.prepare("SELECT volume_number FROM volumes WHERE manga_id = ? AND COALESCE(type, 'volume') = 'volume'").all(mId);
    const existingSet = new Set(existing.map(v => volumeKey(v.volume_number, 'volume')));

    const insertStmt = ctx.db.prepare(`
        INSERT INTO volumes (manga_id, volume_number, status, price, publisher, condition, release_date, release_year, type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'volume')
    `);

    const pub = publisher ? normalizePublisher(publisher) : null;
    const cond = condition ? String(condition).trim() : null;
    const rDate = isBlank(release_date) ? null : String(release_date).trim();
    const { default_price: price, release_year: year } = numeric.values;
    let created = 0;
    const skipped = [];

    ctx.db.transaction(() => {
        for (let i = start; i <= end; i++) {
            if (existingSet.has(String(i))) {
                skipped.push(String(i));
                continue;
            }
            const volumeId = Number(insertStmt.run(mId, String(i), st.value, price, pub, cond, rDate, year).lastInsertRowid);
            syncOwnersWithStatus(ctx.db, volumeId, ctx.user.id);
            if (st.read) markRead(ctx.db, volumeId, ctx.user.id);
            created++;
        }
    });

    return { body: { success: true, created, skipped } };
}

function update(ctx, { params, body }) {
    const vol = ctx.db.prepare('SELECT * FROM volumes WHERE id = ?').get(params.id);
    if (!vol) throw notFound('Band');

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
        const duplicate = findDuplicate(ctx, vol.manga_id, volume_number, volType, vol.id);
        if (duplicate) throw duplicateError(volType, volume_number, duplicate);
    }

    const stmt = ctx.db.prepare(`
        UPDATE volumes SET 
            volume_number = ?, isbn = ?, price = ?, release_date = ?, release_year = ?, 
            condition = ?, pages = ?, publisher = ?, purchase_date = ?, 
            status = ?, notes = ?, cover_image = ?, images = ?, type = ?, priority = ?, target_price = ?
        WHERE id = ?
    `);

    ctx.db.transaction(() => {
        // Owner rows copied the volume's price/date/condition; those still holding the old value follow the correction,
        // a different value set per owner stays
        for (const [column, next] of [['price', price], ['purchase_date', purchase_date], ['condition', condition]]) {
            if (next !== vol[column]) {
                ctx.db.prepare(`UPDATE volume_owners SET ${column} = ? WHERE volume_id = ? AND ${column} IS ?`).run(next, vol.id, vol[column]);
            }
        }
        stmt.run(volume_number, isbn, price, release_date, release_year, condition, pages, publisher, purchase_date, status, notes, cover_image, imagesVal, volType, priority, target_price, vol.id);
        syncOwnersWithStatus(ctx.db, vol.id, ctx.user.id);
        if (markAsRead && status === OWNED_STATUS) markRead(ctx.db, vol.id, ctx.user.id);
    });

    return { body: { success: true } };
}

function remove(ctx, { params }) {
    const vol = ctx.db.prepare('SELECT manga_id FROM volumes WHERE id = ?').get(params.id);
    if (!vol) throw notFound('Band');

    let trashId = null;
    ctx.db.transaction(() => {
        trashId = moveVolumeToTrash(ctx, params.id);
    });

    return { body: { success: true, trash_id: trashId } };
}

const MAX_BULK_IDS = 500;
const READ_AT_ERROR = 'Ungültiger Lesezeitpunkt (erwartet: JJJJ-MM-TT HH:MM:SS, UTC)';
const BULK_FIELD_ERRORS = {
    status: STATUS_ERROR,
    price: FIELD_ERRORS.price,
    target_price: FIELD_ERRORS.target_price,
    purchase_date: DATE_ERROR,
    release_date: DATE_ERROR,
    condition: 'Ungültiger Zustand (höchstens 200 Zeichen)',
    priority: 'Ungültige Priorität (0 bis 3)'
};
const OWNER_COLUMNS = ['price', 'purchase_date', 'condition'];

/** owners: { add: [userId], remove: [userId] }; each id passes the same check as the owners route. */
function parseOwnerOps(ctx, owners) {
    if (owners === undefined || owners === null) return null;
    if (typeof owners !== 'object' || Array.isArray(owners)) throw badRequest('Ungültige Besitzer-Änderung');
    const list = (key) => {
        const raw = owners[key];
        if (raw === undefined || raw === null) return [];
        const ids = Array.isArray(raw) ? raw : [raw];
        if (ids.length > 50) throw badRequest('Ungültige Besitzer-Änderung');
        return [...new Set(ids.map((id) => resolveTargetUser(ctx, id)))];
    };
    const add = list('add');
    const remove = list('remove');
    if (add.length === 0 && remove.length === 0) return null;
    if (add.some((id) => remove.includes(id))) throw badRequest('Ein Benutzer kann nicht gleichzeitig Besitzer werden und abgeben');
    return { add, remove };
}

/** read: { user_id?, read, read_at? } for one reader (others only for admins). */
function parseReadOp(ctx, read) {
    if (read === undefined || read === null) return null;
    if (typeof read !== 'object' || Array.isArray(read) || read.read === undefined) throw badRequest('Ungültige Lese-Änderung');
    const readAt = isBlank(read.read_at) ? null : read.read_at;
    if (readAt !== null && !isValidReadAt(readAt)) throw badRequest(READ_AT_ERROR);
    return { userId: resolveTargetUser(ctx, read.user_id), read: parseFlag(read.read), readAt: readAt && readAt.trim() };
}

const ownerRows = (ctx, volumeId) => ctx.db.prepare(
    'SELECT user_id, price, purchase_date, condition, created_at FROM volume_owners WHERE volume_id = ? ORDER BY created_at, rowid'
).all(volumeId);

const BULK_SNAPSHOT_COLUMNS = ['manga_id', ...BULK_SET_FIELDS];

/** What an undo needs: the fields a bulk edit may change, the owner rows and (for read/delete) the read rows. */
function bulkSnapshot(ctx, vol, { full, readUser }) {
    const volume = full
        ? Object.fromEntries(Object.entries(vol).filter(([key]) => key !== 'number_sort'))
        : Object.fromEntries(BULK_SNAPSHOT_COLUMNS.map((key) => [key, vol[key] ?? null]));
    const entry = { id: vol.id, volume, owners: ownerRows(ctx, vol.id) };
    if (full) {
        entry.reads = ctx.db.prepare('SELECT user_id, read_at FROM volume_reads WHERE volume_id = ? ORDER BY user_id').all(vol.id);
    } else if (readUser) {
        entry.read_user = readUser;
        entry.reads = ctx.db.prepare('SELECT user_id, read_at FROM volume_reads WHERE volume_id = ? AND user_id = ?').all(vol.id, readUser);
    }
    return entry;
}

/** Applies `set` to one volume: owner rows that still hold the old price/date/condition follow (as PUT does). */
function applyBulkSet(ctx, vol, set) {
    const keys = Object.keys(set);
    if (keys.length === 0) return;
    for (const column of OWNER_COLUMNS) {
        if (column in set && set[column] !== vol[column]) {
            ctx.db.prepare(`UPDATE volume_owners SET ${column} = ? WHERE volume_id = ? AND ${column} IS ?`).run(set[column], vol.id, vol[column]);
        }
    }
    ctx.db.prepare(`UPDATE volumes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), vol.id);
    if ('status' in set) syncOwnersWithStatus(ctx.db, vol.id, ctx.user.id);
}

/**
 * Owner changes of one volume, with the same follow-up rules as POST /volumes/:id/owners. `purchase` (price, date,
 * condition of a bulk "set") belongs to the newly added owners; the volume takes it only when this makes it owned.
 */
function applyOwnerOps(ctx, volumeId, { add, remove }, purchase = {}) {
    convertLegacyRead(ctx.db, volumeId, add[0] ?? ctx.user.id);
    const hadOwners = Boolean(ctx.db.prepare('SELECT 1 FROM volume_owners WHERE volume_id = ? LIMIT 1').get(volumeId));
    const vol = ctx.db.prepare('SELECT price, purchase_date, condition FROM volumes WHERE id = ?').get(volumeId);
    const given = OWNER_COLUMNS.filter((column) => purchase[column] !== undefined && purchase[column] !== null);
    const details = { ...vol, ...Object.fromEntries(given.map((column) => [column, purchase[column]])) };
    // an existing owner keeps the price and date of the own purchase
    for (const userId of add) addOwner(ctx.db, volumeId, userId, details);
    let removed = false;
    for (const userId of remove) {
        if (ctx.db.prepare('DELETE FROM volume_owners WHERE volume_id = ? AND user_id = ?').run(volumeId, userId).changes > 0) removed = true;
    }
    const status = syncStatusWithOwners(ctx.db, volumeId);
    if (removed && status === OWNED_STATUS) purchaseDateFromRemainingOwners(ctx.db, volumeId);
    if (!hadOwners && status === OWNED_STATUS && given.length) {
        ctx.db.prepare(`UPDATE volumes SET ${given.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...given.map((c) => details[c]), volumeId);
    }
}

/** Sets one reader's state; "read" only counts for owned volumes (as batch-read). Returns false when skipped. */
function applyReadOp(ctx, volumeId, { userId, read, readAt }) {
    if (!read) {
        ctx.db.prepare('DELETE FROM volume_reads WHERE volume_id = ? AND user_id = ?').run(volumeId, userId);
        return true;
    }
    const status = ctx.db.prepare('SELECT status FROM volumes WHERE id = ?').get(volumeId)?.status;
    if (status !== OWNED_STATUS) return false;
    if (readAt) ctx.db.prepare('INSERT OR IGNORE INTO volume_reads (volume_id, user_id, read_at) VALUES (?, ?, ?)').run(volumeId, userId, readAt);
    else ctx.db.prepare('INSERT OR IGNORE INTO volume_reads (volume_id, user_id) VALUES (?, ?)').run(volumeId, userId);
    return true;
}

/**
 * POST /volumes/bulk: one change for up to 500 volumes in one transaction.
 * { ids, set?: { status, price, purchase_date, condition, priority, target_price, release_date },
 *   owners?: { add, remove }, read?: { user_id, read, read_at }, delete?: true } or { revert: previous }.
 * With owners.add, price/purchase_date/condition of `set` describe that purchase (see applyOwnerOps).
 * The answer lists the ids it changed, the unknown ones (not_found) and `previous`, which a later { revert } restores.
 */
function bulk(ctx, { body }) {
    if (body.revert !== undefined) return revertBulk(ctx, body.revert);
    const ids = parseIdList(body.ids, MAX_BULK_IDS);
    if (ids.error) throw badRequest(`Ungültige Auswahl (1 bis ${MAX_BULK_IDS} Band-IDs)`, 'BULK_IDS');
    const set = parseBulkSet(body.set);
    if (set.error) throw badRequest(BULK_FIELD_ERRORS[set.error] || `Unbekanntes Feld: ${set.error}`, 'BULK_FIELD', { field: set.error });
    const owners = parseOwnerOps(ctx, body.owners);
    const read = parseReadOp(ctx, body.read);
    const remove = body.delete === true || body.delete === 'true';
    const changes = Object.keys(set.value).length > 0 || owners || read;
    if (remove && changes) throw badRequest('Löschen lässt sich nicht mit anderen Änderungen verbinden');
    if (!remove && !changes) throw badRequest('Keine Änderung angegeben');
    if ('status' in set.value && owners) throw badRequest('Status und Besitzer bitte getrennt ändern');

    const select = ctx.db.prepare('SELECT * FROM volumes WHERE id = ?');
    const rows = ids.value.map((id) => select.get(id)).filter(Boolean);
    const found = new Set(rows.map((v) => v.id));
    const missing = ids.value.filter((id) => !found.has(id));
    if (rows.length === 0) throw notFound('Band');

    const previous = [];
    const readSkipped = [];
    ctx.db.transaction(() => {
        for (const vol of rows) {
            previous.push(bulkSnapshot(ctx, vol, { full: remove, readUser: read?.userId }));
            if (remove) {
                moveVolumeToTrash(ctx, vol.id);
                continue;
            }
            if (owners?.add.length) {
                const purchase = Object.fromEntries(OWNER_COLUMNS.filter((c) => c in set.value).map((c) => [c, set.value[c]]));
                const rest = Object.fromEntries(Object.entries(set.value).filter(([c]) => !(c in purchase)));
                applyBulkSet(ctx, vol, rest);
                applyOwnerOps(ctx, vol.id, owners, purchase);
            } else {
                applyBulkSet(ctx, vol, set.value);
                if (owners) applyOwnerOps(ctx, vol.id, owners);
            }
            if (read && !applyReadOp(ctx, vol.id, read)) readSkipped.push(vol.id);
        }
    });

    const answer = { success: true, updated: rows.length, ids: rows.map((v) => v.id), not_found: missing, previous };
    if (remove) answer.deleted = true;
    if (readSkipped.length) answer.read_skipped = readSkipped;
    return { body: answer };
}

const snapshotError = () => badRequest('Ungültige Rückgängig-Daten', 'BULK_REVERT');
const checked = (parsed) => {
    if (parsed.error) throw snapshotError();
    return parsed.value;
};
const optionalTimestamp = (val) => {
    if (isBlank(val)) return null;
    if (!isValidReadAt(val)) throw snapshotError();
    return val.trim();
};

function parseSnapshotOwners(ctx, list) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list) || list.length > 50) throw snapshotError();
    const userExists = ctx.db.prepare('SELECT 1 FROM users WHERE id = ?');
    return list.map((o) => {
        const userId = parsePositiveInt(o?.user_id);
        if (!userId) throw snapshotError();
        return {
            user_id: userId,
            price: checked(parsePrice(o.price)),
            purchase_date: checked(parseDate(o.purchase_date)),
            condition: checked(parseCondition(o.condition)),
            created_at: optionalTimestamp(o.created_at)
        };
    }).filter((o) => userExists.get(o.user_id));
}

function parseSnapshotReads(ctx, list) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list) || list.length > 1000) throw snapshotError();
    const userExists = ctx.db.prepare('SELECT 1 FROM users WHERE id = ?');
    return list.map((r) => {
        const userId = parsePositiveInt(r?.user_id);
        if (!userId) throw snapshotError();
        return { user_id: userId, read_at: optionalTimestamp(r.read_at) };
    }).filter((r) => userExists.get(r.user_id));
}

/**
 * The bulk-editable fields of a snapshot that differ from `current` (the stored row; null for a deleted volume),
 * validated like a bulk edit. A legacy 'Gelesen' counts as 'Vorhanden'; an empty status of old rows stays empty.
 */
function parseSnapshotFields(volume, current = null) {
    const input = {};
    for (const key of BULK_SET_FIELDS) {
        const value = volume[key] ?? null;
        if (current && value === (current[key] ?? null)) continue;
        input[key] = key === 'status' && isLegacyReadStatus(value) ? OWNED_STATUS : value;
    }
    const emptyStatus = 'status' in input && isBlank(input.status);
    if (emptyStatus) delete input.status;
    const fields = checked(parseBulkSet(input));
    if (emptyStatus) fields.status = null;
    return fields;
}

/** Full row of a deleted volume, validated like POST /volumes. */
function parseDeletedVolume(volume) {
    const ty = parseType(volume.type);
    if (ty.error) throw snapshotError();
    const type = ty.value || 'volume';
    const num = parseVolumeNumber(volume.volume_number, type);
    if (num.error) throw snapshotError();
    const images = parseImagesInput(volume.images);
    if (images.error) throw snapshotError();
    const mangaId = parsePositiveInt(volume.manga_id);
    if (!mangaId) throw snapshotError();
    const mpId = volume.manga_passion_volume_id === null || volume.manga_passion_volume_id === undefined
        ? null : parsePositiveInt(volume.manga_passion_volume_id);
    if (mpId === null && !isBlank(volume.manga_passion_volume_id)) throw snapshotError();
    const text = (val) => (isBlank(val) ? null : String(val).trim());
    return {
        ...parseSnapshotFields(volume),
        manga_id: mangaId,
        volume_number: num.value,
        type,
        isbn: normalizeIsbn(volume.isbn),
        release_year: checked(parseYear(volume.release_year)),
        pages: checked(parsePages(volume.pages)),
        publisher: isBlank(volume.publisher) ? null : normalizePublisher(volume.publisher),
        notes: cleanNotes(volume.notes),
        cover_image: text(volume.cover_image),
        images: images.value,
        manga_passion_volume_id: mpId,
        created_at: optionalTimestamp(volume.created_at)
    };
}

function restoreOwners(ctx, volumeId, owners) {
    ctx.db.prepare('DELETE FROM volume_owners WHERE volume_id = ?').run(volumeId);
    const insert = ctx.db.prepare(`
        INSERT INTO volume_owners (volume_id, user_id, price, purchase_date, condition, created_at)
        VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
    `);
    for (const o of owners) insert.run(volumeId, o.user_id, o.price, o.purchase_date, o.condition, o.created_at);
}

function restoreReads(ctx, volumeId, reads) {
    const insert = ctx.db.prepare('INSERT OR REPLACE INTO volume_reads (volume_id, user_id, read_at) VALUES (?, ?, COALESCE(?, CURRENT_TIMESTAMP))');
    for (const r of reads) insert.run(volumeId, r.user_id, r.read_at);
}

/**
 * { revert: previous } puts back what a bulk edit changed: the fields, owner rows and the reader's state of existing
 * volumes, deleted volumes with their id, owners and reads. A deleted volume whose type and number were taken again
 * meanwhile is not restored (conflicts, 409 per entry); the answer is 409 when nothing could be restored for that reason.
 */
function revertBulk(ctx, revert) {
    if (!Array.isArray(revert) || revert.length === 0 || revert.length > MAX_BULK_IDS) throw snapshotError();
    const entries = revert.map((entry) => {
        const id = parsePositiveInt(entry?.id);
        if (!id || !entry.volume || typeof entry.volume !== 'object') throw snapshotError();
        return { id, raw: entry };
    });

    const exists = ctx.db.prepare('SELECT * FROM volumes WHERE id = ?');
    const mangaExists = ctx.db.prepare('SELECT 1 FROM mangas WHERE id = ?');
    const plans = entries.map(({ id, raw }) => {
        const owners = parseSnapshotOwners(ctx, raw.owners);
        const current = exists.get(id);
        if (current) {
            const readUser = raw.read_user === undefined || raw.read_user === null ? null : resolveTargetUser(ctx, raw.read_user);
            const reads = readUser ? parseSnapshotReads(ctx, raw.reads).filter((r) => r.user_id === readUser) : [];
            return { id, kind: 'update', fields: parseSnapshotFields(raw.volume, current), owners, readUser, reads };
        }
        return { id, kind: 'insert', row: parseDeletedVolume(raw.volume), owners, reads: parseSnapshotReads(ctx, raw.reads) };
    });

    const restored = [];
    const conflicts = [];
    const missing = [];
    ctx.db.transaction(() => {
        for (const plan of plans) {
            if (plan.kind === 'update') {
                const keys = Object.keys(plan.fields);
                if (keys.length) {
                    ctx.db.prepare(`UPDATE volumes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => plan.fields[k]), plan.id);
                }
                restoreOwners(ctx, plan.id, plan.owners);
                if (plan.readUser) {
                    ctx.db.prepare('DELETE FROM volume_reads WHERE volume_id = ? AND user_id = ?').run(plan.id, plan.readUser);
                    restoreReads(ctx, plan.id, plan.reads);
                }
                restored.push(plan.id);
                continue;
            }
            const { row } = plan;
            if (!mangaExists.get(row.manga_id)) {
                missing.push(plan.id);
                continue;
            }
            const duplicate = findDuplicate(ctx, row.manga_id, row.volume_number, row.type);
            if (duplicate) {
                const err = duplicateError(row.type, row.volume_number, duplicate);
                conflicts.push({ id: plan.id, status: 409, code: err.code, error: err.message, existing_id: duplicate.id });
                continue;
            }
            const columns = ['id', ...Object.keys(row).filter((k) => k !== 'created_at')];
            const values = columns.map((k) => (k === 'id' ? plan.id : row[k]));
            ctx.db.prepare(`INSERT INTO volumes (${columns.join(', ')}, created_at) VALUES (${columns.map(() => '?').join(', ')}, COALESCE(?, CURRENT_TIMESTAMP))`)
                .run(...values, row.created_at);
            restoreOwners(ctx, plan.id, plan.owners);
            restoreReads(ctx, plan.id, plan.reads);
            forgetTrashedVolume(ctx, plan.id);
            restored.push(plan.id);
        }
    });

    const answer = { success: restored.length > 0, restored, conflicts, not_found: missing };
    if (restored.length === 0 && conflicts.length > 0) return { status: 409, body: { ...answer, error: conflicts[0].error, code: 'VOLUME_DUPLICATE' } };
    return { body: answer };
}

module.exports = { create, createBatch, update, remove, bulk, parseStatus, findDuplicate, duplicateError, FIELD_ERRORS, DATE_ERROR, MAX_BULK_IDS };
