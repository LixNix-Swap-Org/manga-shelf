// Copies (migration 44): volume_copies is the one truth about ownership. A copy belongs to a person (owner_user_id) or
// to the household (NULL: owned, nobody named). volumes.status 'Vorhanden' follows the copies through triggers on every
// write path, so status and ownership can no longer disagree:
//   * a copy makes its volume 'Vorhanden'; a personal copy replaces a household one (the household placeholder);
//   * the last copy gone makes 'Vorhanden' 'Fehlt' and clears purchase_date (it belonged to that purchase);
//   * status 'Vorhanden' without a copy adds a household copy, any other status removes the copies.
// The legacy status 'Gelesen' is left to core/lib/owners.js (convertLegacyRead). volume_owners is a read-only view of the
// personal copies in the old shape (volume_id, user_id, price, purchase_date, condition, created_at, rowid = copy id).
// Since migration 56 a person may hold several copies of a volume ("Weiteres Exemplar"); volume_owners shows their
// first one (the lowest id), the helpers that take a person change that first copy.

const LEGACY_READ = "lower(trim(COALESCE({s}, ''))) = 'gelesen'";
const legacy = (col) => LEGACY_READ.replace('{s}', col);

const COPIES_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS volume_copies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        volume_id INTEGER NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
        owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        purchase_price REAL,
        purchase_date TEXT,
        condition TEXT,
        notes TEXT,
        client_uuid TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_volume_copies_volume ON volume_copies (volume_id);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_volume_copies_owner ON volume_copies (volume_id, owner_user_id) WHERE owner_user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_volume_copies_owner ON volume_copies (owner_user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_volume_copies_client ON volume_copies (client_uuid) WHERE client_uuid IS NOT NULL;`;

const OWNERS_VIEW_SQL = `
    CREATE VIEW IF NOT EXISTS volume_owners AS
        SELECT volume_id, owner_user_id AS user_id, purchase_price AS price, purchase_date, condition, created_at, id AS rowid
        FROM volume_copies WHERE owner_user_id IS NOT NULL;`;

// migration 47: the view also carries who borrowed the copy (a trash entry and a bulk undo keep the lending)
const OWNERS_VIEW_LENT_SQL = `
    CREATE VIEW IF NOT EXISTS volume_owners AS
        SELECT volume_id, owner_user_id AS user_id, purchase_price AS price, purchase_date, condition, created_at, id AS rowid,
               lent_to_user_id, lent_to_name, lent_at
        FROM volume_copies WHERE owner_user_id IS NOT NULL;`;

// migration 56: one row per person, their first copy (several copies per person are allowed from then on)
const OWNERS_VIEW_FIRST_SQL = `
    CREATE VIEW IF NOT EXISTS volume_owners AS
        SELECT volume_id, owner_user_id AS user_id, purchase_price AS price, purchase_date, condition, created_at, id AS rowid,
               lent_to_user_id, lent_to_name, lent_at
        FROM volume_copies c WHERE owner_user_id IS NOT NULL
          AND id = (SELECT MIN(f.id) FROM volume_copies f WHERE f.volume_id = c.volume_id AND f.owner_user_id = c.owner_user_id);`;

// the lending columns of migration 47; a restored row names an account only while it still exists
const LENT_COLUMNS = ['lent_to_user_id', 'lent_to_name', 'lent_at'];
const hasLending = (extra) => LENT_COLUMNS.some(c => extra[c] !== undefined);
const lentUser = (db, id) => (id === null || id === undefined ? null : (cached(db, 'SELECT id FROM users WHERE id = ?').get(id)?.id ?? null));

const COPY_TRIGGERS = ['trg_volume_copies_ins', 'trg_volume_copies_del', 'trg_volumes_copies_status', 'trg_volumes_copies_insert'];

const COPY_TRIGGERS_SQL = `
    CREATE TRIGGER trg_volume_copies_ins AFTER INSERT ON volume_copies BEGIN
        UPDATE volumes SET status = 'Vorhanden'
         WHERE id = NEW.volume_id AND status IS NOT 'Vorhanden' AND NOT ${legacy('status')};
        DELETE FROM volume_copies WHERE volume_id = NEW.volume_id AND owner_user_id IS NULL AND NEW.owner_user_id IS NOT NULL;
    END;
    CREATE TRIGGER trg_volume_copies_del AFTER DELETE ON volume_copies
    WHEN NOT EXISTS (SELECT 1 FROM volume_copies WHERE volume_id = OLD.volume_id) BEGIN
        UPDATE volumes SET status = 'Fehlt', purchase_date = NULL WHERE id = OLD.volume_id AND status = 'Vorhanden';
    END;
    CREATE TRIGGER trg_volumes_copies_status AFTER UPDATE OF status ON volumes BEGIN
        DELETE FROM volume_copies WHERE volume_id = NEW.id AND NEW.status IS NOT 'Vorhanden' AND NOT ${legacy('NEW.status')};
        INSERT INTO volume_copies (volume_id, purchase_price, purchase_date, condition)
        SELECT NEW.id, NEW.price, NEW.purchase_date, NEW.condition
         WHERE NEW.status = 'Vorhanden' AND NOT EXISTS (SELECT 1 FROM volume_copies WHERE volume_id = NEW.id);
    END;
    CREATE TRIGGER trg_volumes_copies_insert AFTER INSERT ON volumes WHEN NEW.status = 'Vorhanden' BEGIN
        INSERT INTO volume_copies (volume_id, purchase_price, purchase_date, condition)
        SELECT NEW.id, NEW.price, NEW.purchase_date, NEW.condition
         WHERE NOT EXISTS (SELECT 1 FROM volume_copies WHERE volume_id = NEW.id);
    END;`;

// A statement that writes volume_copies compiles the copy triggers (and the volume triggers they reach) each time it is
// prepared; the helpers run per volume in imports, so they keep their statements per connection. Keyed by the db object
// and its generation (a restore swaps the connection behind the same ctx.db); a sql.js statement is prepared per call
// by its adapter anyway, so there the cache only keeps the wrapper.
const statements = new WeakMap();
function cached(db, sql) {
    const generation = typeof db.generation === 'function' ? db.generation() : 0;
    let entry = statements.get(db);
    if (!entry || entry.generation !== generation) {
        entry = { generation, bySql: new Map() };
        statements.set(db, entry);
    }
    let stmt = entry.bySql.get(sql);
    if (!stmt) {
        stmt = db.prepare(sql);
        entry.bySql.set(sql, stmt);
    }
    return stmt;
}

/** Whether ownership lives in volume_copies already (migration 44 ran). */
const copiesInPlace = (d) => Boolean(d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'volume_copies'").get());

/**
 * A personal copy of `userId` (no-op when there is one); `extra` = { price, purchase_date, condition, created_at } and,
 * from a trash entry or an undo (migration 47), { lent_to_user_id, lent_to_name, lent_at }. Returns true when added.
 */
function addCopy(db, volumeId, userId, extra = {}) {
    // INSERT OR IGNORE once leaned on the unique index (gone with migration 56); a person's first copy is added once
    if (userId !== null && userId !== undefined && hasCopy(db, volumeId, userId)) return false;
    const base = [volumeId, userId, extra.price ?? null, extra.purchase_date ?? null, extra.condition ?? null, extra.created_at ?? null];
    if (hasLending(extra)) {
        return cached(db, `INSERT OR IGNORE INTO volume_copies (volume_id, owner_user_id, purchase_price, purchase_date, condition, created_at,
            lent_to_user_id, lent_to_name, lent_at) VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?)`)
            .run(...base, lentUser(db, extra.lent_to_user_id), extra.lent_to_name ?? null, extra.lent_at ?? null).changes > 0;
    }
    return cached(db, `INSERT OR IGNORE INTO volume_copies (volume_id, owner_user_id, purchase_price, purchase_date, condition, created_at)
        VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`)
        .run(...base).changes > 0;
}

/** Removes the personal copies of `userId` on the volume; true when there was one. */
const removeCopy = (db, volumeId, userId) => cached(db, 'DELETE FROM volume_copies WHERE volume_id = ? AND owner_user_id = ?').run(volumeId, userId).changes > 0;

/** Whether `userId` has a personal copy of the volume. */
const hasCopy = (db, volumeId, userId) => Boolean(cached(db, 'SELECT 1 FROM volume_copies WHERE volume_id = ? AND owner_user_id = ?').get(volumeId, userId));

/** Whether the volume has any copy (personal or household). */
const hasAnyCopy = (db, volumeId) => Boolean(cached(db, 'SELECT 1 FROM volume_copies WHERE volume_id = ? LIMIT 1').get(volumeId));

/** Whether somebody owns a personal copy of the volume. */
const hasOwner = (db, volumeId) => Boolean(cached(db, 'SELECT 1 FROM volume_copies WHERE volume_id = ? AND owner_user_id IS NOT NULL LIMIT 1').get(volumeId));

/** Gives the household copy of the volume to `userId` (the acting user of a status change); true when one was claimed. */
function claimHouseholdCopy(db, volumeId, userId) {
    if (!userId || hasCopy(db, volumeId, userId)) return false;
    const claimed = cached(db, `UPDATE volume_copies SET owner_user_id = ?
        WHERE id = (SELECT id FROM volume_copies WHERE volume_id = ? AND owner_user_id IS NULL ORDER BY id LIMIT 1)`).run(userId, volumeId).changes > 0;
    if (claimed) {
        cached(db, 'UPDATE volume_copies SET lent_to_user_id = NULL, lent_to_name = NULL, lent_at = NULL WHERE volume_id = ? AND owner_user_id = ? AND lent_to_user_id = ?')
            .run(volumeId, userId, userId);
    }
    return claimed;
}

/** Drops the household copies of the volume (the volume becomes 'Fehlt' when no personal copy is left). */
const dropHouseholdCopies = (db, volumeId) => cached(db, 'DELETE FROM volume_copies WHERE volume_id = ? AND owner_user_id IS NULL').run(volumeId).changes;

// the volume_owners columns a caller may change, as volume_copies columns
const COPY_COLUMN = { price: 'purchase_price', purchase_date: 'purchase_date', condition: 'condition', created_at: 'created_at' };

// the first copy of a person on a volume (params: volume_id, owner_user_id)
const FIRST_COPY = 'SELECT MIN(id) FROM volume_copies WHERE volume_id = ? AND owner_user_id = ?';

/** Sets fields of the (first) personal copy of `userId` ({ price, purchase_date, condition } in the old owner names). */
function updateCopy(db, volumeId, userId, fields) {
    const keys = Object.keys(fields).filter(k => COPY_COLUMN[k]);
    if (!keys.length) return;
    db.prepare(`UPDATE volume_copies SET ${keys.map(k => `${COPY_COLUMN[k]} = ?`).join(', ')} WHERE id = (${FIRST_COPY})`)
        .run(...keys.map(k => fields[k] ?? null), volumeId, userId);
}

/** Every copy of the volume whose `column` (old owner name) still holds the volume's `oldValue` takes `newValue`. */
function followVolumeValue(db, volumeId, column, oldValue, newValue) {
    const target = COPY_COLUMN[column];
    if (!target) return;
    db.prepare(`UPDATE volume_copies SET ${target} = ? WHERE volume_id = ? AND ${target} IS ?`).run(newValue, volumeId, oldValue);
}

/**
 * Makes the personal copies of the volume exactly `owners` (rows in the old owner shape: user_id, price, purchase_date,
 * condition, created_at), keeping the volume owned throughout: without owners a household copy stands in while the
 * volume is 'Vorhanden'. `household: false` (the owners were there but may not come back): no stand-in, the volume
 * without owners becomes 'Fehlt'.
 */
function setOwners(db, volumeId, owners, { household = true } = {}) {
    // a person's first copy takes the row; further copies of theirs stay as they are (migration 56)
    const insert = db.prepare(`INSERT INTO volume_copies (volume_id, owner_user_id, purchase_price, purchase_date, condition, created_at)
        VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`);
    const update = db.prepare(`UPDATE volume_copies SET purchase_price = ?, purchase_date = ?, condition = ?, created_at = COALESCE(?, CURRENT_TIMESTAMP)
        WHERE id = (${FIRST_COPY})`);
    for (const o of owners) {
        const row = [o.price ?? null, o.purchase_date ?? null, o.condition ?? null, o.created_at ?? null];
        if (update.run(...row, volumeId, o.user_id).changes === 0) insert.run(volumeId, o.user_id, ...row);
        // the lending of the snapshot comes back with the copy (rows of a snapshot from before migration 47 have none)
        if (hasLending(o)) {
            db.prepare(`UPDATE volume_copies SET lent_to_user_id = ?, lent_to_name = ?, lent_at = ? WHERE id = (${FIRST_COPY})`)
                .run(lentUser(db, o.lent_to_user_id), o.lent_to_name ?? null, o.lent_at ?? null, volumeId, o.user_id);
        }
    }
    const keep = owners.map(o => Number(o.user_id));
    const vol = db.prepare('SELECT status, price, purchase_date, condition FROM volumes WHERE id = ?').get(volumeId);
    if (!keep.length && !household) {
        db.prepare('DELETE FROM volume_copies WHERE volume_id = ?').run(volumeId);
        return;
    }
    if (!keep.length && vol?.status === 'Vorhanden' && !db.prepare('SELECT 1 FROM volume_copies WHERE volume_id = ? AND owner_user_id IS NULL').get(volumeId)) {
        db.prepare('INSERT INTO volume_copies (volume_id, purchase_price, purchase_date, condition) VALUES (?, ?, ?, ?)')
            .run(volumeId, vol.price ?? null, vol.purchase_date ?? null, vol.condition ?? null);
    }
    // NOT IN over an empty list would be NOT IN (NULL), which keeps every row
    const others = keep.length ? ` AND owner_user_id NOT IN (${keep.map(() => '?').join(',')})` : '';
    db.prepare(`DELETE FROM volume_copies WHERE volume_id = ? AND owner_user_id IS NOT NULL${others}`).run(volumeId, ...keep);
}

/**
 * One more personal copy of `userId` (migration 56: "Weiteres Exemplar"); `extra` as for addCopy. Returns the new id,
 * always a fresh one: it must stay above the person's first copy, which volume_owners finds by the lowest id.
 */
function addExtraCopy(db, volumeId, userId, extra = {}) {
    const result = db.prepare(`INSERT INTO volume_copies (volume_id, owner_user_id, purchase_price, purchase_date, condition, created_at,
        lent_to_user_id, lent_to_name, lent_at) VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?)`)
        .run(volumeId, userId, extra.price ?? extra.purchase_price ?? null, extra.purchase_date ?? null, extra.condition ?? null,
            extra.created_at ?? null, lentUser(db, extra.lent_to_user_id), extra.lent_to_name ?? null, extra.lent_at ?? null);
    return Number(result.lastInsertRowid);
}

/** The personal copies beyond each person's first on the given volumes (what volume_owners leaves out), oldest first. */
function extraCopies(db, volumeIds) {
    const ids = (Array.isArray(volumeIds) ? volumeIds : [volumeIds]).map(Number).filter(Number.isInteger);
    if (!ids.length) return [];
    return db.prepare(`
        SELECT c.id, c.volume_id, c.owner_user_id, c.purchase_price, c.purchase_date, c.condition, c.created_at,
               c.lent_to_user_id, c.lent_to_name, c.lent_at
        FROM volume_copies c
        WHERE c.volume_id IN (${ids.map(() => '?').join(',')}) AND c.owner_user_id IS NOT NULL
          AND c.id <> (SELECT MIN(f.id) FROM volume_copies f WHERE f.volume_id = c.volume_id AND f.owner_user_id = c.owner_user_id)
        ORDER BY c.volume_id, c.id`).all(...ids);
}

/**
 * Puts snapshot rows of extraCopies back for owners who have their first copy again; a row whose copy is still there
 * (same id, same owner) is skipped.
 */
function restoreExtraCopies(db, rows) {
    for (const r of Array.isArray(rows) ? rows : []) {
        if (r.id && db.prepare('SELECT 1 FROM volume_copies WHERE id = ? AND owner_user_id IS ?').get(r.id, r.owner_user_id)) continue;
        if (!hasCopy(db, r.volume_id, r.owner_user_id)) continue;
        addExtraCopy(db, r.volume_id, r.owner_user_id, r);
    }
}

/**
 * The copies matching `where` (over volume_copies c and volumes v) in the answer shape, by volume id, oldest first:
 * { id, owner_user_id, owner (null: the household's), price, purchase_date, condition, lent_to_user_id, lent_to
 * (the account's name, or the stored name of a person without one or of an account gone since), lent_at }.
 */
function copiesByVolume(db, where, params = []) {
    const byVolume = new Map();
    for (const c of db.prepare(`
        SELECT c.id, c.volume_id, c.owner_user_id, o.username AS owner, c.purchase_price, c.purchase_date, c.condition,
               b.id AS lent_to_user_id, COALESCE(b.username, c.lent_to_name) AS lent_to, c.lent_at
        FROM volume_copies c
        JOIN volumes v ON v.id = c.volume_id
        LEFT JOIN users o ON o.id = c.owner_user_id
        LEFT JOIN users b ON b.id = c.lent_to_user_id
        WHERE ${where}
        ORDER BY c.volume_id, c.created_at, c.id
    `).all(...params)) {
        if (!byVolume.has(c.volume_id)) byVolume.set(c.volume_id, []);
        byVolume.get(c.volume_id).push({
            id: c.id,
            owner_user_id: c.owner_user_id,
            owner: c.owner ?? null,
            price: c.purchase_price,
            purchase_date: c.purchase_date,
            condition: c.condition,
            lent_to_user_id: c.lent_to_user_id ?? null,
            lent_to: c.lent_to ?? null,
            lent_at: c.lent_to ? c.lent_at : null
        });
    }
    return byVolume;
}

/** Sets `copies` on every volume of a series detail (an empty list for a volume without one). */
function attachCopies(detail, byVolume) {
    for (const v of detail?.volumes || []) v.copies = byVolume.get(v.id) || [];
    return detail;
}

module.exports = {
    COPIES_TABLE_SQL,
    OWNERS_VIEW_SQL,
    OWNERS_VIEW_LENT_SQL,
    OWNERS_VIEW_FIRST_SQL,
    COPY_TRIGGERS,
    COPY_TRIGGERS_SQL,
    copiesInPlace,
    addCopy,
    addExtraCopy,
    extraCopies,
    restoreExtraCopies,
    removeCopy,
    hasCopy,
    hasAnyCopy,
    hasOwner,
    claimHouseholdCopy,
    dropHouseholdCopies,
    updateCopy,
    followVolumeValue,
    setOwners,
    copiesByVolume,
    attachCopies
};
