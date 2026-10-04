// Volumes: create (single and batch), edit, delete, bulk edit (POST /volumes, /volumes/batch, /volumes/bulk, PUT/DELETE /volumes/:id).
const { normalizePublisher } = require('../lib/publishers');
const { normalizeIsbn } = require('../lib/isbn');
const {
    OWNED_STATUS, isLegacyReadStatus, addOwner, markRead, syncOwnersWithStatus, syncStatusWithOwners, convertLegacyRead,
    purchaseDateFromRemainingOwners
} = require('../lib/owners');
const { canonicalVolumeNumber } = require('../lib/volumeNumber');
const { resolveTargetUser } = require('../lib/access');
const { HttpError, badRequest, forbidden, notFound, conflict } = require('../errors');
const { MAX_NOTES_LENGTH } = require('../csvExchange');
const { moveVolumeToTrash, forgetTrashedVolume } = require('../lib/trash');
const {
    VOLUME_STATUSES, VOLUME_TYPES, BULK_SET_FIELDS, isBlank, parsePrice, parsePages, parseYear, parsePriority, isValidDate, parseDate,
    parseWholeNumber, parseIdList, parseBulkSet, parseFlag, isValidReadAt
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

/** What the undo of a field edit needs: the fields a bulk edit may change, the owner rows and the reader's read row. */
function bulkSnapshot(ctx, vol, { readUser }) {
    const volume = Object.fromEntries(BULK_SNAPSHOT_COLUMNS.map((key) => [key, vol[key] ?? null]));
    const entry = { id: vol.id, deleted: false, volume, owners: ownerRows(ctx, vol.id) };
    if (readUser) {
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

// The undo data of a bulk edit stays on the host (ctx.undo); the client only gets a token bound to its user. The store
// is bounded by entries and by the approximate JSON size of the snapshots, oldest first.
const UNDO_TTL_MS = 10 * 60 * 1000;
const UNDO_PER_USER = 20;
const UNDO_TOTAL = 200;
const UNDO_BYTES_PER_USER = 8 * 1024 * 1024;
const UNDO_BYTES_TOTAL = 32 * 1024 * 1024;

function rememberUndo(ctx, previous) {
    const store = ctx.undo;
    const now = ctx.now().getTime();
    const bytes = JSON.stringify(previous).length;
    if (bytes > UNDO_BYTES_PER_USER) return {};
    for (const [token, entry] of store) {
        if (entry.expires <= now) store.delete(token);
    }
    const mine = [...store].filter(([, entry]) => entry.userId === ctx.user.id);
    let mineBytes = mine.reduce((sum, [, entry]) => sum + (entry.bytes || 0), 0);
    while (mine.length && (mine.length >= UNDO_PER_USER || mineBytes + bytes > UNDO_BYTES_PER_USER)) {
        const [token, entry] = mine.shift();
        mineBytes -= entry.bytes || 0;
        store.delete(token);
    }
    let totalBytes = 0;
    for (const entry of store.values()) totalBytes += entry.bytes || 0;
    while (store.size && (store.size >= UNDO_TOTAL || totalBytes + bytes > UNDO_BYTES_TOTAL)) {
        const [token, entry] = store.entries().next().value;
        totalBytes -= entry.bytes || 0;
        store.delete(token);
    }
    const token = ctx.randomId();
    const expires = now + UNDO_TTL_MS;
    store.set(token, { userId: ctx.user.id, expires, generation: ctx.db.generation(), previous, bytes });
    return { undo_token: token, undo_expires_at: new Date(expires).toISOString() };
}

// POST /volumes/bulk: one change for up to 500 volumes in one transaction.
// { ids, set?, owners?: { add, remove }, read?: { user_id, read, read_at }, delete?: true } or { revert: undo_token }.
// With owners.add, price/purchase_date/condition of `set` describe that purchase (see applyOwnerOps).
// Answers with the changed ids, the unknown ones (not_found) and `undo_token`, which a later { revert } takes.
function bulk(ctx, { body }) {
    if (body.revert !== undefined) return revertBulk(ctx, body.revert);
    const ids = parseIdList(body.ids, MAX_BULK_IDS);
    if (ids.error) throw badRequest(`Ungültige Auswahl (1 bis ${MAX_BULK_IDS} Band-IDs)`, 'BULK_IDS');
    const set = parseBulkSet(body.set);
    if (set.error) throw badRequest(Object.prototype.hasOwnProperty.call(BULK_FIELD_ERRORS, set.error) ? BULK_FIELD_ERRORS[set.error] : `Unbekanntes Feld: ${set.error}`, 'BULK_FIELD', { field: set.error });
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
            if (remove) {
                // the trash keeps the row, owners and reads; the undo only remembers where
                previous.push({ id: vol.id, deleted: true, trash_id: moveVolumeToTrash(ctx, vol.id) });
                continue;
            }
            previous.push(bulkSnapshot(ctx, vol, { readUser: read?.userId }));
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

    const answer = { success: true, updated: rows.length, ids: rows.map((v) => v.id), not_found: missing, ...rememberUndo(ctx, previous) };
    if (remove) answer.deleted = true;
    if (readSkipped.length) answer.read_skipped = readSkipped;
    return { body: answer };
}

/** The stored undo of this caller; a client-made snapshot is refused, an unknown, used or expired token is gone (410). */
function takeUndo(ctx, token) {
    if (typeof token !== 'string' || token.trim() === '' || token.length > 100) {
        throw badRequest('Ungültige Rückgängig-Daten (erwartet: undo_token der Sammelbearbeitung)', 'BULK_REVERT');
    }
    const entry = ctx.undo.get(token);
    if (!entry || entry.expires <= ctx.now().getTime() || entry.generation !== ctx.db.generation()) {
        if (entry) ctx.undo.delete(token);
        throw new HttpError(410, 'Rückgängig ist nicht mehr möglich (abgelaufen oder schon ausgeführt)', 'BULK_UNDO_EXPIRED');
    }
    if (entry.userId !== ctx.user.id) throw forbidden('Nur wer die Sammelbearbeitung gemacht hat, kann sie rückgängig machen', 'BULK_UNDO_FORBIDDEN');
    return entry;
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

// { revert: undo_token } restores exactly what that bulk edit changed: fields, owner rows, reads, and deleted volumes
// (from their trash entry). Volumes gone meanwhile or without trash entry are in not_found; a deleted volume whose
// type and number were taken again is a per-entry conflict, and the answer is 409 when nothing could be restored.
function revertBulk(ctx, token) {
    const { previous } = takeUndo(ctx, token);
    const current = ctx.db.prepare('SELECT * FROM volumes WHERE id = ?');
    const mangaExists = ctx.db.prepare('SELECT 1 FROM mangas WHERE id = ?');
    const userExists = ctx.db.prepare('SELECT 1 FROM users WHERE id = ?');
    const knownUsers = (rows) => (Array.isArray(rows) ? rows : []).filter((row) => userExists.get(row.user_id));
    const trashEntry = ctx.db.prepare("SELECT payload FROM trash WHERE id = ? AND kind = 'volume' AND ref_id = ?");
    // a deleted volume comes back from its trash entry; emptied or restored meanwhile means nothing to restore
    const trashedVolume = (snap) => {
        const entry = snap.trash_id ? trashEntry.get(snap.trash_id, snap.id) : null;
        if (!entry) return null;
        try {
            const payload = JSON.parse(entry.payload);
            return payload?.volume?.id === snap.id ? payload : null;
        } catch {
            return null;
        }
    };
    const volumeColumns = new Set(ctx.db.prepare('PRAGMA table_info(volumes)').all().map((c) => c.name));
    volumeColumns.delete('number_sort');

    const restored = [];
    const conflicts = [];
    const missing = [];
    ctx.db.transaction(() => {
        // a deleted volume only comes back with an id the table really handed out
        const sequence = Number(ctx.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'volumes'").get()?.seq ?? 0);
        for (const snap of previous) {
            const stored = current.get(snap.id);
            if (stored) {
                // a deleted volume that is back already (trash restore) stays as it is
                if (!snap.deleted) {
                    const keys = BULK_SET_FIELDS.filter((k) => (snap.volume[k] ?? null) !== (stored[k] ?? null));
                    if (keys.length) {
                        ctx.db.prepare(`UPDATE volumes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => snap.volume[k] ?? null), snap.id);
                    }
                    restoreOwners(ctx, snap.id, knownUsers(snap.owners));
                    if (snap.read_user) {
                        ctx.db.prepare('DELETE FROM volume_reads WHERE volume_id = ? AND user_id = ?').run(snap.id, snap.read_user);
                        restoreReads(ctx, snap.id, knownUsers(snap.reads).filter((r) => r.user_id === snap.read_user));
                    }
                }
                restored.push(snap.id);
                continue;
            }
            const trashed = snap.deleted ? trashedVolume(snap) : null;
            const row = trashed?.volume;
            if (!row || snap.id > sequence || !mangaExists.get(row.manga_id)) {
                missing.push(snap.id);
                continue;
            }
            const type = row.type || 'volume';
            const duplicate = findDuplicate(ctx, row.manga_id, row.volume_number, type);
            if (duplicate) {
                const err = duplicateError(type, row.volume_number, duplicate);
                conflicts.push({ id: snap.id, status: 409, code: err.code, error: err.message, existing_id: duplicate.id });
                continue;
            }
            const columns = Object.keys(row).filter((k) => volumeColumns.has(k));
            ctx.db.prepare(`INSERT INTO volumes (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...columns.map((k) => row[k]));
            restoreOwners(ctx, snap.id, knownUsers(trashed.owners));
            restoreReads(ctx, snap.id, knownUsers(trashed.reads));
            forgetTrashedVolume(ctx, snap.id);
            restored.push(snap.id);
        }
    });
    ctx.undo.delete(token);

    const answer = { success: restored.length > 0, restored, conflicts, not_found: missing };
    if (restored.length === 0 && conflicts.length > 0) return { status: 409, body: { ...answer, error: conflicts[0].error, code: 'VOLUME_DUPLICATE' } };
    return { body: answer };
}

module.exports = {
    create, createBatch, update, remove, bulk, parseStatus, findDuplicate, duplicateError, FIELD_ERRORS, DATE_ERROR, MAX_BULK_IDS, UNDO_TTL_MS, UNDO_PER_USER,
    UNDO_BYTES_PER_USER, UNDO_BYTES_TOTAL
};
