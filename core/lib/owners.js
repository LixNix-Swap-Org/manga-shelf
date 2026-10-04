// Per-user ownership (volume_owners). volumes.status = 'Vorhanden' means "at least one owner".
// All functions are synchronous; the caller is expected to be in a transaction already if it needs one.
// 'Gelesen' is no longer a status: reading is kept per user in volume_reads. The old value is treated as
// 'Vorhanden' plus a read entry and rewritten on the next sync (owners are never deleted for it).

const OWNED_STATUS = 'Vorhanden';
const LEGACY_READ_STATUS = 'Gelesen';

function isLegacyReadStatus(status) {
    return typeof status === 'string' && status.trim().toLowerCase() === LEGACY_READ_STATUS.toLowerCase();
}

/** Maps the legacy status 'Gelesen' to 'Vorhanden'; every other value stays unchanged. */
function normalizeVolumeStatus(status) {
    return isLegacyReadStatus(status) ? OWNED_STATUS : status;
}

function addOwner(db, volumeId, userId, extra = {}) {
    db.prepare(`
        INSERT OR IGNORE INTO volume_owners (volume_id, user_id, price, purchase_date, condition)
        VALUES (?, ?, ?, ?, ?)
    `).run(volumeId, userId, extra.price ?? null, extra.purchase_date ?? null, extra.condition ?? null);
}

function listOwners(db, volumeId) {
    return db.prepare(`
        SELECT vo.user_id, u.username, vo.price, vo.purchase_date
        FROM volume_owners vo JOIN users u ON u.id = vo.user_id
        WHERE vo.volume_id = ? ORDER BY vo.created_at, vo.rowid
    `).all(volumeId);
}

function markRead(db, volumeId, userId) {
    db.prepare('INSERT OR IGNORE INTO volume_reads (volume_id, user_id) VALUES (?, ?)').run(volumeId, userId);
}

// Brings a volume's status and owners in line after either changed; returns the stored status (null if missing).
// 'Vorhanden' without owner: the acting user becomes owner. Legacy 'Gelesen': becomes 'Vorhanden', the acting user
// (else all owners) is marked as reader. Any other status: all owners are dropped.
function syncOwnersWithStatus(db, volumeId, actingUserId) {
    const vol = db.prepare('SELECT id, status, price, purchase_date, condition FROM volumes WHERE id = ?').get(volumeId);
    if (!vol) return null;
    const legacyRead = isLegacyReadStatus(vol.status);
    if (legacyRead) db.prepare('UPDATE volumes SET status = ? WHERE id = ?').run(OWNED_STATUS, volumeId);
    if (vol.status === OWNED_STATUS || legacyRead) {
        const has = db.prepare('SELECT 1 FROM volume_owners WHERE volume_id = ? LIMIT 1').get(volumeId);
        if (!has && actingUserId) addOwner(db, volumeId, actingUserId, vol);
        if (legacyRead) {
            const readers = actingUserId ? [actingUserId] : listOwners(db, volumeId).map(o => o.user_id);
            for (const userId of readers) markRead(db, volumeId, userId);
        }
        return OWNED_STATUS;
    }
    db.prepare('DELETE FROM volume_owners WHERE volume_id = ?').run(volumeId);
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
    const has = db.prepare('SELECT 1 FROM volume_owners WHERE volume_id = ? LIMIT 1').get(volumeId);
    if (!has) {
        const owner = fallbackUserId ?? fallbackOwnerId(db);
        if (owner) addOwner(db, volumeId, owner, vol);
    }
    if (db.prepare('SELECT 1 FROM volume_reads WHERE volume_id = ? LIMIT 1').get(volumeId)) {
        db.prepare('UPDATE volumes SET status = ? WHERE id = ?').run(OWNED_STATUS, volumeId);
    } else {
        syncOwnersWithStatus(db, volumeId, null);
    }
    return true;
}

// After an owner change: no owner turns 'Vorhanden' into 'Fehlt', an owner turns it into 'Vorhanden'; returns the status.
// A legacy 'Gelesen' is converted first so its read entry is never lost. When the last owner goes, purchase_date
// goes too: it belonged to that purchase.
function syncStatusWithOwners(db, volumeId) {
    const vol = db.prepare('SELECT id, status FROM volumes WHERE id = ?').get(volumeId);
    if (!vol) return null;
    const stored = convertLegacyRead(db, volumeId) ? OWNED_STATUS : vol.status;
    const count = db.prepare('SELECT count(*) as c FROM volume_owners WHERE volume_id = ?').get(volumeId).c;
    let status = stored;
    if (count > 0 && status !== OWNED_STATUS) status = OWNED_STATUS;
    else if (count === 0 && status === OWNED_STATUS) status = 'Fehlt';
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
