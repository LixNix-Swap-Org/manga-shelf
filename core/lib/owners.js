// Per-user ownership on top of the copies (core/lib/copies.js, migration 43): an owner is a person with a copy of the
// volume, volume_owners is the view of those copies. volumes.status = 'Vorhanden' follows the copies through triggers
// (a household copy counts too), so these functions only add what a trigger cannot know: who the acting user is.
// All functions are synchronous; the caller is expected to be in a transaction already if it needs one.
// 'Gelesen' is no longer a status: reading is kept per user in volume_reads (on the catalog, core/lib/marks.js). The old
// value is treated as 'Vorhanden' plus a read entry and rewritten on the next sync (owners are never deleted for it).
const { addRead } = require('./marks');
const { addCopy, hasOwner, hasAnyCopy, claimHouseholdCopy } = require('./copies');

const OWNED_STATUS = 'Vorhanden';
const LEGACY_READ_STATUS = 'Gelesen';

function isLegacyReadStatus(status) {
    return typeof status === 'string' && status.trim().toLowerCase() === LEGACY_READ_STATUS.toLowerCase();
}

/** Maps the legacy status 'Gelesen' to 'Vorhanden'; every other value stays unchanged. */
function normalizeVolumeStatus(status) {
    return isLegacyReadStatus(status) ? OWNED_STATUS : status;
}

/** A personal copy of `userId` (none added when there is one); it replaces a household copy. */
function addOwner(db, volumeId, userId, extra = {}) {
    addCopy(db, volumeId, userId, extra);
}

function listOwners(db, volumeId) {
    return db.prepare(`
        SELECT vo.user_id, u.username, vo.price, vo.purchase_date
        FROM volume_owners vo JOIN users u ON u.id = vo.user_id
        WHERE vo.volume_id = ? ORDER BY vo.created_at, vo.rowid
    `).all(volumeId);
}

function markRead(db, volumeId, userId) {
    addRead(db, volumeId, userId);
}

// Brings a volume's owners in line with its status after the status changed; returns the stored status (null if missing).
// 'Vorhanden' without owner: the acting user becomes owner (takes the household copy the trigger added). Legacy 'Gelesen':
// becomes 'Vorhanden', the acting user (else all owners) is marked as reader. Any other status: the trigger dropped the copies.
function syncOwnersWithStatus(db, volumeId, actingUserId) {
    const vol = db.prepare('SELECT id, status, price, purchase_date, condition FROM volumes WHERE id = ?').get(volumeId);
    if (!vol) return null;
    const legacyRead = isLegacyReadStatus(vol.status);
    if (legacyRead) db.prepare('UPDATE volumes SET status = ? WHERE id = ?').run(OWNED_STATUS, volumeId);
    if (vol.status === OWNED_STATUS || legacyRead) {
        if (!hasOwner(db, volumeId) && actingUserId && !claimHouseholdCopy(db, volumeId, actingUserId)) addOwner(db, volumeId, actingUserId, vol);
        if (legacyRead) {
            const readers = actingUserId ? [actingUserId] : listOwners(db, volumeId).map(o => o.user_id);
            for (const userId of readers) markRead(db, volumeId, userId);
        }
        return OWNED_STATUS;
    }
    db.prepare('DELETE FROM volume_copies WHERE volume_id = ?').run(volumeId);
    return vol.status;
}

function fallbackOwnerId(db) {
    return db.prepare("SELECT id FROM users ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, id LIMIT 1").get()?.id ?? null;
}

// Converts a volume with the legacy status 'Gelesen'; returns true when it was converted. Without owner,
// `fallbackUserId` (else the oldest admin, as in migration v11) becomes owner. Existing read entries are kept as they
// are; otherwise as in syncOwnersWithStatus.
function convertLegacyRead(db, volumeId, fallbackUserId) {
    const vol = db.prepare('SELECT id, status, price, purchase_date, condition FROM volumes WHERE id = ?').get(volumeId);
    if (!vol || !isLegacyReadStatus(vol.status)) return false;
    if (!hasOwner(db, volumeId)) {
        const owner = fallbackUserId ?? fallbackOwnerId(db);
        if (owner) addOwner(db, volumeId, owner, vol);
    }
    if (db.prepare('SELECT 1 FROM volume_reads WHERE catalog_volume_id = (SELECT catalog_volume_id FROM volumes WHERE id = ?) LIMIT 1').get(volumeId)) {
        db.prepare('UPDATE volumes SET status = ? WHERE id = ?').run(OWNED_STATUS, volumeId);
    } else {
        syncOwnersWithStatus(db, volumeId, null);
    }
    return true;
}

// After an owner change: converts a legacy 'Gelesen' first (so its read entry is never lost) and returns the status. The
// copy triggers keep the rest: no copy turns 'Vorhanden' into 'Fehlt' and clears purchase_date (it belonged to that
// purchase), a copy makes the volume 'Vorhanden'. The check below only repairs a state written without the triggers.
function syncStatusWithOwners(db, volumeId) {
    const vol = db.prepare('SELECT id, status FROM volumes WHERE id = ?').get(volumeId);
    if (!vol) return null;
    const stored = convertLegacyRead(db, volumeId) ? OWNED_STATUS : vol.status;
    const owned = hasAnyCopy(db, volumeId);
    let status = stored;
    if (owned && status !== OWNED_STATUS) status = OWNED_STATUS;
    else if (!owned && status === OWNED_STATUS) status = 'Fehlt';
    if (status === stored) return status;
    if (status === OWNED_STATUS) db.prepare('UPDATE volumes SET status = ? WHERE id = ?').run(status, volumeId);
    else db.prepare('UPDATE volumes SET status = ?, purchase_date = NULL WHERE id = ?').run(status, volumeId);
    return status;
}

/**
 * After one owner left and others remain: volumes.purchase_date becomes the earliest purchase date of the remaining
 * owners (unchanged when none has one).
 */
function purchaseDateFromRemainingOwners(db, volumeId) {
    const earliest = db.prepare(`
        SELECT MIN(purchase_date) AS d FROM volume_owners
        WHERE volume_id = ? AND purchase_date IS NOT NULL AND TRIM(purchase_date) <> ''
    `).get(volumeId)?.d;
    if (earliest) db.prepare('UPDATE volumes SET purchase_date = ? WHERE id = ?').run(earliest, volumeId);
}

/** One-off migration of legacy data: converts every 'Gelesen' volume via convertLegacyRead; returns the count. */
function migrateLegacyReadStatus(db, fallbackUserId) {
    const rows = db.prepare('SELECT id FROM volumes WHERE LOWER(TRIM(status)) = LOWER(?)').all(LEGACY_READ_STATUS);
    if (rows.length === 0) return 0;
    const fallback = fallbackUserId ?? fallbackOwnerId(db);
    for (const row of rows) convertLegacyRead(db, row.id, fallback);
    return rows.length;
}

module.exports = {
    OWNED_STATUS,
    LEGACY_READ_STATUS,
    isLegacyReadStatus,
    normalizeVolumeStatus,
    addOwner,
    listOwners,
    markRead,
    syncOwnersWithStatus,
    syncStatusWithOwners,
    purchaseDateFromRemainingOwners,
    convertLegacyRead,
    migrateLegacyReadStatus
};
