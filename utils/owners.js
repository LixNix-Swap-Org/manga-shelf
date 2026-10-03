// Besitz pro Benutzer (volume_owners). volumes.status = 'Vorhanden' bedeutet "mindestens ein Besitzer".
// Alle Funktionen laufen synchron und erwarten, dass der Aufrufer ggf. schon in einer Transaktion ist.

function recountOwned(db, mangaId) {
    const row = db.prepare("SELECT count(*) as count FROM volumes WHERE manga_id = ? AND status = 'Vorhanden'").get(mangaId);
    db.prepare('UPDATE mangas SET owned_volumes = ? WHERE id = ?').run(row.count, mangaId);
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
        WHERE vo.volume_id = ? ORDER BY vo.created_at, vo.user_id
    `).all(volumeId);
}

/**
 * Bringt Status und Besitzer eines Bandes in Einklang, nachdem Status oder Besitzer geändert wurden.
 * - Status 'Vorhanden' ohne Besitzer: der handelnde Benutzer wird Besitzer (Band wurde direkt als vorhanden gespeichert).
 * - Status nicht mehr 'Vorhanden': alle Besitzer entfallen.
 */
function syncOwnersWithStatus(db, volumeId, actingUserId) {
    const vol = db.prepare('SELECT id, status, price, purchase_date, condition FROM volumes WHERE id = ?').get(volumeId);
    if (!vol) return;
    if (vol.status === 'Vorhanden') {
        const has = db.prepare('SELECT 1 FROM volume_owners WHERE volume_id = ? LIMIT 1').get(volumeId);
        if (!has && actingUserId) addOwner(db, volumeId, actingUserId, vol);
    } else {
        db.prepare('DELETE FROM volume_owners WHERE volume_id = ?').run(volumeId);
    }
}

/** Nach einer Besitzänderung: ohne Besitzer 'Vorhanden' -> 'Fehlt', mit Besitzer -> 'Vorhanden'. Gibt den neuen Status zurück. */
function syncStatusWithOwners(db, volumeId) {
    const vol = db.prepare('SELECT id, manga_id, status FROM volumes WHERE id = ?').get(volumeId);
    if (!vol) return null;
    const count = db.prepare('SELECT count(*) as c FROM volume_owners WHERE volume_id = ?').get(volumeId).c;
    let status = vol.status;
    if (count > 0 && status !== 'Vorhanden') status = 'Vorhanden';
    else if (count === 0 && status === 'Vorhanden') status = 'Fehlt';
    if (status !== vol.status) {
        db.prepare('UPDATE volumes SET status = ? WHERE id = ?').run(status, volumeId);
        recountOwned(db, vol.manga_id);
    }
    return status;
}

module.exports = { recountOwned, addOwner, listOwners, syncOwnersWithStatus, syncStatusWithOwners };
