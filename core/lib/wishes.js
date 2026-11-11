// Wishes per person (migration 57): series_wishes holds who wishes a series and how much (priority 0 to 3, like the old
// shared field). A row without user_id is the household wish that migration 57 made from the shared mangas.wish_priority
// (who set it is unknown); the first person who sets or clears their own wish on that series replaces it, like a
// household copy. Everybody in the shelf sees every wish with its name. mangas.wish_priority stays as the highest wish
// of the series, kept by triggers, so every reader of the old field (chip, filters, shopping list, radar, CSV) still
// works: a series counts as wished while anybody wishes it.

const SERIES_WISHES_SQL = `
    CREATE TABLE IF NOT EXISTS series_wishes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        manga_id INTEGER NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_series_wishes_person ON series_wishes (manga_id, user_id) WHERE user_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_series_wishes_household ON series_wishes (manga_id) WHERE user_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_series_wishes_user ON series_wishes (user_id);`;

// The wishes that count for a series: the household's and those of members of its shelf. A person who leaves the shelf
// keeps their wishes (like reading marks), but they neither show nor count until they come back.
const COUNTING = (mangaId) => `w.manga_id = ${mangaId} AND (w.user_id IS NULL OR EXISTS (
            SELECT 1 FROM shelf_members sm JOIN mangas sm_m ON sm_m.id = w.manga_id WHERE sm.shelf_id = sm_m.shelf_id AND sm.user_id = w.user_id))`;
const HIGHEST_SQL = (mangaId) => `(SELECT MAX(w.priority) FROM series_wishes w WHERE ${COUNTING(mangaId)})`;
const HIGHEST = (id) => `UPDATE mangas SET wish_priority = ${HIGHEST_SQL(id)} WHERE id = ${id} AND wish_priority IS NOT ${HIGHEST_SQL(id)};`;

const WISH_TRIGGERS_SQL = `
    CREATE TRIGGER IF NOT EXISTS trg_series_wishes_ins AFTER INSERT ON series_wishes BEGIN
        ${HIGHEST('NEW.manga_id')}
    END;
    CREATE TRIGGER IF NOT EXISTS trg_series_wishes_upd AFTER UPDATE ON series_wishes BEGIN
        ${HIGHEST('NEW.manga_id')}
        ${HIGHEST('OLD.manga_id')}
    END;
    CREATE TRIGGER IF NOT EXISTS trg_series_wishes_del AFTER DELETE ON series_wishes BEGIN
        ${HIGHEST('OLD.manga_id')}
    END;`;

/** mangas.wish_priority = the highest wish of the series (null: nobody wishes it). */
const syncSeriesWish = (db, mangaId) => db.prepare(`UPDATE mangas SET wish_priority = ${HIGHEST_SQL('?')} WHERE id = ?`).run(mangaId, mangaId);

/** After `userId` left or joined a shelf: the series there that they wish count their wish again, or no longer. */
function syncUserWishes(db, userId, shelfId) {
    if (!hasWishTable(db)) return;
    const ids = db.prepare('SELECT w.manga_id FROM series_wishes w JOIN mangas m ON m.id = w.manga_id WHERE w.user_id = ? AND m.shelf_id = ?')
        .all(userId, shelfId).map(r => r.manga_id);
    for (const id of ids) syncSeriesWish(db, id);
}

const hasWishTable = (db) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'series_wishes'").get());

/**
 * Sets the wish of `userId` on the series (`priority` 0 to 3) or removes it (null). The household wish goes in both
 * cases: the person decides now. Returns the series' highest wish afterwards (null: nobody wishes it).
 */
function setWish(db, mangaId, userId, priority) {
    db.prepare('DELETE FROM series_wishes WHERE manga_id = ? AND user_id IS NULL').run(mangaId);
    if (priority === null || priority === undefined) {
        db.prepare('DELETE FROM series_wishes WHERE manga_id = ? AND user_id = ?').run(mangaId, userId);
    } else {
        const changed = db.prepare('UPDATE series_wishes SET priority = ? WHERE manga_id = ? AND user_id = ?').run(priority, mangaId, userId).changes;
        if (!changed) db.prepare('INSERT INTO series_wishes (manga_id, user_id, priority) VALUES (?, ?, ?)').run(mangaId, userId, priority);
    }
    // the series' value follows even when no row changed (a caller may have written the column itself before)
    syncSeriesWish(db, mangaId);
    return db.prepare('SELECT wish_priority FROM mangas WHERE id = ?').get(mangaId)?.wish_priority ?? null;
}

/**
 * A series row written with mangas.wish_priority by an older path (a new series, a CSV import, a trash entry from before
 * migration 57) gets that wish as `userId`'s own (null: the household's) while it has no wish row yet.
 */
function adoptColumnWish(db, mangaId, userId = null) {
    const row = db.prepare('SELECT wish_priority FROM mangas WHERE id = ?').get(mangaId);
    if (!row || row.wish_priority === null || row.wish_priority === undefined) return;
    if (db.prepare('SELECT 1 FROM series_wishes WHERE manga_id = ? LIMIT 1').get(mangaId)) return;
    db.prepare('INSERT INTO series_wishes (manga_id, user_id, priority) VALUES (?, ?, ?)').run(mangaId, userId ?? null, row.wish_priority);
}

/** The wishes of the given series by series id, highest first: { user_id (null: household), username, priority }. */
function wishesBySeries(db, mangaIds) {
    const ids = (Array.isArray(mangaIds) ? mangaIds : [mangaIds]).map(Number).filter(Number.isInteger);
    const bySeries = new Map();
    if (!ids.length || !hasWishTable(db)) return bySeries;
    const rows = db.prepare(`
        SELECT w.manga_id, w.user_id, u.username, w.priority, w.created_at
        FROM series_wishes w LEFT JOIN users u ON u.id = w.user_id
        WHERE w.manga_id IN (${ids.map(() => '?').join(',')})
          AND ${COUNTING('w.manga_id')}
        ORDER BY w.manga_id, w.priority DESC, w.user_id IS NULL, u.username COLLATE NOCASE`).all(...ids);
    for (const r of rows) {
        if (!bySeries.has(r.manga_id)) bySeries.set(r.manga_id, []);
        bySeries.get(r.manga_id).push({ user_id: r.user_id ?? null, username: r.username ?? null, priority: r.priority });
    }
    return bySeries;
}

/** Rows to keep in a trash entry; restoreWishes puts them back for accounts that still exist. */
const wishRows = (db, mangaId) => (hasWishTable(db)
    ? db.prepare('SELECT user_id, priority, created_at FROM series_wishes WHERE manga_id = ? ORDER BY id').all(mangaId)
    : []);

function restoreWishes(db, mangaId, rows) {
    const exists = db.prepare('SELECT 1 FROM users WHERE id = ?');
    for (const r of Array.isArray(rows) ? rows : []) {
        const userId = r.user_id ?? null;
        if (userId !== null && !exists.get(userId)) continue;
        const priority = Number(r.priority);
        if (!Number.isInteger(priority) || priority < 0 || priority > 3) continue;
        const taken = userId === null
            ? db.prepare('SELECT 1 FROM series_wishes WHERE manga_id = ? AND user_id IS NULL').get(mangaId)
            : db.prepare('SELECT 1 FROM series_wishes WHERE manga_id = ? AND user_id = ?').get(mangaId, userId);
        if (taken) continue;
        db.prepare('INSERT INTO series_wishes (manga_id, user_id, priority, created_at) VALUES (?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))')
            .run(mangaId, userId, priority, r.created_at ?? null);
    }
}

module.exports = { SERIES_WISHES_SQL, WISH_TRIGGERS_SQL, hasWishTable, syncSeriesWish, syncUserWishes, setWish, adoptColumnWish, wishesBySeries, wishRows, restoreWishes };
