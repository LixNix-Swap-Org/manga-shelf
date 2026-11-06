// Copies instead of an owner flag (migration 44, core/lib/copies.js): the conversion of volume_owners, the triggers that
// keep volumes.status on the copies, the household copy, setOwners and a replay of the older migrations.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const schema = require('../../core/schema');
const copies = require('../../core/lib/copies');
const owners = require('../../core/lib/owners');

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const HELD = Array.from({ length: schema.LATEST_SCHEMA_VERSION - 43 }, (_, i) => 44 + i);

/**
 * Before 44: volume 1 owned by bob, 2 'Vorhanden' without owner, 3 'Fehlt' with an owner row (raw SQL), 4 legacy 'Gelesen'
 * with an owner, 5 'Fehlt' without one.
 */
function migratedFrom42() {
    const conn = new DatabaseSync(':memory:');
    conn.exec('PRAGMA foreign_keys = ON;');
    schema.ensureMigrationsTable(conn);
    const hold = conn.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, 'held back')");
    for (const v of HELD) hold.run(v);
    schema.applySchema(conn, { log: quiet });
    conn.exec(`
        INSERT INTO users (id, username, password_hash, role) VALUES (1, 'alice', 'x', 'admin'), (2, 'bob', 'x', 'editor');
        INSERT OR IGNORE INTO shelf_members (shelf_id, user_id, role) VALUES (1, 1, 'owner'), (1, 2, 'editor');
        INSERT INTO mangas (id, title) VALUES (1, 'Kopien');
        INSERT INTO volumes (id, manga_id, volume_number, status, price, purchase_date, condition) VALUES
            (1, 1, '1', 'Vorhanden', 7, '2024-01-01', 'neu'), (2, 1, '2', 'Vorhanden', 8, '2024-02-02', 'gut'),
            (3, 1, '3', 'Fehlt', 9, NULL, NULL), (4, 1, '4', 'Gelesen', NULL, NULL, NULL), (5, 1, '5', 'Fehlt', NULL, NULL, NULL);
        INSERT INTO volume_owners (volume_id, user_id, price, purchase_date, condition, created_at) VALUES
            (1, 2, 6.5, '2024-01-01', 'neu', '2024-01-01 10:00:00'), (3, 1, 9, '2024-03-03', NULL, '2024-03-03 10:00:00'), (4, 2, NULL, NULL, NULL, '2023-01-01 00:00:00');
    `);
    conn.prepare(`DELETE FROM schema_migrations WHERE version IN (${HELD.join(', ')})`).run();
    const infos = [];
    schema.runSequentialMigrations(conn, { log: { ...quiet, info: (line) => infos.push(line) } });
    return { conn, infos };
}

const copiesOf = (d, volumeId) => d.prepare('SELECT owner_user_id AS owner, purchase_price AS price, purchase_date, condition FROM volume_copies WHERE volume_id = ? ORDER BY id')
    .all(volumeId).map(r => ({ ...r }));
const statusOf = (d, volumeId) => ({ ...d.prepare('SELECT status, purchase_date FROM volumes WHERE id = ?').get(volumeId) });

test('migration 44 turns owner rows into personal copies and owned volumes without owner into household copies', () => {
    const { conn: d, infos } = migratedFrom42();
    assert.deepEqual(copiesOf(d, 1), [{ owner: 2, price: 6.5, purchase_date: '2024-01-01', condition: 'neu' }]);
    assert.deepEqual(copiesOf(d, 2), [{ owner: null, price: 8, purchase_date: '2024-02-02', condition: 'gut' }], 'a household copy');
    assert.equal(statusOf(d, 3).status, 'Vorhanden', 'owners on a missing volume make it owned');
    assert.deepEqual([statusOf(d, 4).status, copiesOf(d, 4).length], ['Gelesen', 1], 'a legacy Gelesen is left to owners.js');
    assert.deepEqual(copiesOf(d, 5), []);
    assert.equal(d.prepare("SELECT type FROM sqlite_master WHERE name = 'volume_owners'").get().type, 'view');
    assert.deepEqual(d.prepare('SELECT volume_id, user_id, price, created_at FROM volume_owners ORDER BY volume_id').all().map(r => ({ ...r })), [
        { volume_id: 1, user_id: 2, price: 6.5, created_at: '2024-01-01 10:00:00' },
        { volume_id: 3, user_id: 1, price: 9, created_at: '2024-03-03 10:00:00' },
        { volume_id: 4, user_id: 2, price: null, created_at: '2023-01-01 00:00:00' }
    ], 'the view keeps the old owner shape');
    assert.ok(infos.some(line => /v44: 3 owner rows -> personal copies, 1 owned volumes without owner -> household copies, 1 volumes with owners/.test(line)), infos.join('\n'));
    const triggers = new Set(d.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map(r => r.name));
    for (const name of ['trg_dv_volume_copies_ins', ...copies.COPY_TRIGGERS]) assert.ok(triggers.has(name), name);
    assert.deepEqual(d.prepare('PRAGMA foreign_key_check').all(), []);
    assert.throws(() => d.prepare('INSERT INTO volume_owners (volume_id, user_id) VALUES (5, 1)').run(), /view/);
});

test('the status follows the copies on every write path', () => {
    const { conn: d } = migratedFrom42();
    d.exec("UPDATE volumes SET status = 'Fehlt' WHERE id = 1");
    assert.deepEqual(copiesOf(d, 1), [], 'another status drops the copies');
    d.exec("UPDATE volumes SET status = 'Vorhanden' WHERE id = 1");
    assert.deepEqual(copiesOf(d, 1).map(c => c.owner), [null], "'Vorhanden' without a copy gets a household copy");
    d.exec("INSERT INTO volumes (id, manga_id, volume_number, status) VALUES (6, 1, '6', 'Vorhanden')");
    assert.deepEqual(copiesOf(d, 6).map(c => c.owner), [null], 'also on insert');

    assert.equal(copies.addCopy(d, 6, 2, { price: 5, purchase_date: '2024-06-06' }), true);
    assert.deepEqual(copiesOf(d, 6).map(c => c.owner), [2], 'a personal copy replaces the household one');
    assert.equal(copies.addCopy(d, 6, 2), false, 'one personal copy per person until the UI knows more');
    d.exec("UPDATE volumes SET purchase_date = '2024-06-06' WHERE id = 6");
    assert.equal(copies.removeCopy(d, 6, 2), true);
    assert.deepEqual(statusOf(d, 6), { status: 'Fehlt', purchase_date: null }, 'the last copy gone: missing, the purchase date goes with it');

    d.exec('INSERT INTO volume_copies (volume_id, owner_user_id) VALUES (5, 1)');
    assert.equal(statusOf(d, 5).status, 'Vorhanden', 'raw SQL cannot leave owners on a missing volume');
    d.exec("UPDATE volumes SET status = 'Gelesen' WHERE id = 5");
    assert.deepEqual(copiesOf(d, 5).map(c => c.owner), [1], 'the legacy status keeps its owners for convertLegacyRead');
    owners.syncStatusWithOwners(d, 5);
    assert.equal(statusOf(d, 5).status, 'Vorhanden');

    d.exec('UPDATE shelves SET owner_user_id = NULL WHERE owner_user_id = 2; DELETE FROM users WHERE id = 2');
    assert.deepEqual(copiesOf(d, 1).map(c => c.owner).concat(copiesOf(d, 3).map(c => c.owner)), [null, 1], 'a deleted owner leaves a household copy');
});

test('the acting user takes the household copy; setOwners never passes through "no copy"', () => {
    const { conn: d } = migratedFrom42();
    assert.equal(owners.syncOwnersWithStatus(d, 2, 1), 'Vorhanden');
    assert.deepEqual(copiesOf(d, 2), [{ owner: 1, price: 8, purchase_date: '2024-02-02', condition: 'gut' }], 'claimed with the values of the household copy');

    copies.setOwners(d, 1, [{ user_id: 1, price: 4, purchase_date: '2020-01-01', condition: 'alt', created_at: '2020-01-01 00:00:00' }]);
    assert.deepEqual([copiesOf(d, 1), statusOf(d, 1)], [[{ owner: 1, price: 4, purchase_date: '2020-01-01', condition: 'alt' }], { status: 'Vorhanden', purchase_date: '2024-01-01' }]);
    copies.setOwners(d, 1, []);
    assert.deepEqual([copiesOf(d, 1).map(c => c.owner), statusOf(d, 1)], [[null], { status: 'Vorhanden', purchase_date: '2024-01-01' }], 'a household copy stands in');
    copies.setOwners(d, 1, [], { household: false });
    assert.deepEqual([copiesOf(d, 1), statusOf(d, 1)], [[], { status: 'Fehlt', purchase_date: null }]);
});

test('replayed migrations 11 to 44 leave the copies alone', () => {
    const { conn: d } = migratedFrom42();
    const all = () => d.prepare('SELECT volume_id, owner_user_id, purchase_price, purchase_date FROM volume_copies ORDER BY id').all().map(r => ({ ...r }));
    const before = all();
    d.exec('DELETE FROM schema_migrations WHERE version >= 11');
    schema.runSequentialMigrations(d, { log: quiet });
    assert.equal(schema.appliedSchemaVersion(d), schema.LATEST_SCHEMA_VERSION);
    assert.deepEqual(all(), before, 'migration 11 does not hand every owned volume to the admin again');
    assert.equal(d.prepare("SELECT type FROM sqlite_master WHERE name = 'volume_owners'").get().type, 'view');
    assert.deepEqual(d.prepare('PRAGMA foreign_key_check').all(), []);
});
