// Besitz pro Benutzer (volume_owners). volumes.status = 'Vorhanden' bedeutet "mindestens ein Besitzer".
// Alle Funktionen laufen synchron und erwarten, dass der Aufrufer ggf. schon in einer Transaktion ist.
//
// 'Gelesen' ist kein eigener Status mehr: Lesen wird pro Benutzer in volume_reads geführt. Der alte Wert wird
// als 'Vorhanden' plus Lese-Eintrag verstanden und beim nächsten Abgleich umgeschrieben (nie Besitzer löschen).

const OWNED_STATUS = 'Vorhanden';
const LEGACY_READ_STATUS = 'Gelesen';

function isLegacyReadStatus(status) {
    return typeof status === 'string' && status.trim().toLowerCase() === LEGACY_READ_STATUS.toLowerCase();
}

/** Bildet den Altstatus 'Gelesen' auf 'Vorhanden' ab; alle anderen Werte bleiben unverändert. */
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

/**
 * Bringt Status und Besitzer eines Bandes in Einklang, nachdem Status oder Besitzer geändert wurden.
 * - Status 'Vorhanden' ohne Besitzer: der handelnde Benutzer wird Besitzer (Band wurde direkt als vorhanden gespeichert).
 * - Altstatus 'Gelesen': wird zu 'Vorhanden', Besitzer bleiben; gelesen markiert wird der handelnde Benutzer
 *   (ohne ihn alle Besitzer).
 * - Jeder andere Status: alle Besitzer entfallen.
 * Gibt den gespeicherten Status zurück (null, wenn der Band fehlt).
 */
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

/**
 * Stellt einen Band mit Altstatus 'Gelesen' um: ohne Besitzer wird `fallbackUserId` (sonst der älteste Admin, wie
 * Migration v11) Besitzer, dann wie syncOwnersWithStatus ('Vorhanden', alle Besitzer bekommen einen Lese-Eintrag).
 * Gibt true zurück, wenn der Band umgestellt wurde.
 */
function convertLegacyRead(db, volumeId, fallbackUserId) {
    const vol = db.prepare('SELECT id, status, price, purchase_date, condition FROM volumes WHERE id = ?').get(volumeId);
    if (!vol || !isLegacyReadStatus(vol.status)) return false;
    const has = db.prepare('SELECT 1 FROM volume_owners WHERE volume_id = ? LIMIT 1').get(volumeId);
    if (!has) {
        const owner = fallbackUserId ?? fallbackOwnerId(db);
        if (owner) addOwner(db, volumeId, owner, vol);
    }
    syncOwnersWithStatus(db, volumeId, null);
    return true;
}

/**
 * Nach einer Besitzänderung: ohne Besitzer 'Vorhanden' -> 'Fehlt', mit Besitzer -> 'Vorhanden'. Ein Altstatus
 * 'Gelesen' wird vorher umgestellt (convertLegacyRead), damit der Lese-Eintrag nie verloren geht. Fällt der letzte
 * Besitzer weg, entfällt auch volumes.purchase_date: das Datum gehörte zu diesem Kauf, und ein späterer Kauf füllt es neu.
 * Gibt den neuen Status zurück.
 */
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
 * Nachdem ein Besitzer abgegeben hat und andere bleiben: volumes.purchase_date wird das früheste Kaufdatum der
 * verbleibenden Besitzer. Hat keiner ein Datum (Altdaten), bleibt das Datum des Bands stehen.
 */
function purchaseDateFromRemainingOwners(db, volumeId) {
    const earliest = db.prepare(`
        SELECT MIN(purchase_date) AS d FROM volume_owners
        WHERE volume_id = ? AND purchase_date IS NOT NULL AND TRIM(purchase_date) <> ''
    `).get(volumeId)?.d;
    if (earliest) db.prepare('UPDATE volumes SET purchase_date = ? WHERE id = ?').run(earliest, volumeId);
}

/**
 * Einmalige Umstellung für Altdaten: jeder Band mit Status 'Gelesen' wird per convertLegacyRead umgestellt.
 * Gibt die Anzahl umgestellter Bände zurück.
 */
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
