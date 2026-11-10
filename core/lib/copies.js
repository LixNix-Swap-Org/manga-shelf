// Copies (migration 44): volume_copies is the one truth about ownership. A copy belongs to a person (owner_user_id) or
// to the household (NULL: owned, nobody named). volumes.status 'Vorhanden' follows the copies through triggers on every
// write path, so status and ownership can no longer disagree:
//   * a copy makes its volume 'Vorhanden'; a personal copy replaces a household one (the household placeholder);
//   * the last copy gone makes 'Vorhanden' 'Fehlt' and clears purchase_date (it belonged to that purchase);
//   * status 'Vorhanden' without a copy adds a household copy, any other status removes the copies.
// The legacy status 'Gelesen' is left to core/lib/owners.js (convertLegacyRead). volume_owners is a read-only view of the
// personal copies in the old shape (volume_id, user_id, price, purchase_date, condition, created_at, rowid = copy id).
// Until the UI knows several copies per person, ux_volume_copies_owner allows one personal copy per volume and person.

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

/** A personal copy of `userId` (no-op when there is one); `extra` = { price, purchase_date, condition, created_at }. Returns true when added. */
function addCopy(db, volumeId, userId, extra = {}) {
    return cached(db, `INSERT OR IGNORE INTO volume_copies (volume_id, owner_user_id, purchase_price, purchase_date, condition, created_at)
        VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`)
        .run(volumeId, userId, extra.price ?? null, extra.purchase_date ?? null, extra.condition ?? null, extra.created_at ?? null).changes > 0;
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
    return cached(db, `UPDATE volume_copies SET owner_user_id = ?
        WHERE id = (SELECT id FROM volume_copies WHERE volume_id = ? AND owner_user_id IS NULL ORDER BY id LIMIT 1)`).run(userId, volumeId).changes > 0;
}

/** Drops the household copies of the volume (the volume becomes 'Fehlt' when no personal copy is left). */
const dropHouseholdCopies = (db, volumeId) => cached(db, 'DELETE FROM volume_copies WHERE volume_id = ? AND owner_user_id IS NULL').run(volumeId).changes;

// the volume_owners columns a caller may change, as volume_copies columns
const COPY_COLUMN = { price: 'purchase_price', purchase_date: 'purchase_date', condition: 'condition', created_at: 'created_at' };

/** Sets fields of the personal copy of `userId` ({ price, purchase_date, condition } in the old owner names). */
function updateCopy(db, volumeId, userId, fields) {
    const keys = Object.keys(fields).filter(k => COPY_COLUMN[k]);
    if (!keys.length) return;
    db.prepare(`UPDATE volume_copies SET ${keys.map(k => `${COPY_COLUMN[k]} = ?`).join(', ')} WHERE volume_id = ? AND owner_user_id = ?`)
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
    const upsert = db.prepare(`INSERT INTO volume_copies (volume_id, owner_user_id, purchase_price, purchase_date, condition, created_at)
        VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
        ON CONFLICT (volume_id, owner_user_id) WHERE owner_user_id IS NOT NULL DO UPDATE SET purchase_price = excluded.purchase_price,
            purchase_date = excluded.purchase_date, condition = excluded.condition, created_at = excluded.created_at`);
    for (const o of owners) upsert.run(volumeId, o.user_id, o.price ?? null, o.purchase_date ?? null, o.condition ?? null, o.created_at ?? null);
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

module.exports = {
    COPIES_TABLE_SQL,
    OWNERS_VIEW_SQL,
    COPY_TRIGGERS,
    COPY_TRIGGERS_SQL,
    copiesInPlace,
    addCopy,
    removeCopy,
    hasCopy,
    hasAnyCopy,
    hasOwner,
    claimHouseholdCopy,
    dropHouseholdCopies,
    updateCopy,
    followVolumeValue,
    setOwners
};
