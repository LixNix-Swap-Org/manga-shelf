// Reading marks and chapter progress on the catalog (migration 43, core/lib/marks.js): the merge of the shelf rows, the views
// that show a mark only to members of a row's shelf, the follow triggers, a replayed catalog backfill and deletions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const schema = require('../../core/schema');
const marks = require('../../core/lib/marks');

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const HELD = Array.from({ length: schema.LATEST_SCHEMA_VERSION - 42 }, (_, i) => 43 + i);

/**
 * Two shelves hold the same German edition (Manga Passion 87) and the same webtoon. bob reads volume 1 in both shelves,
 * alice in the household shelf without a date, carl (no member anywhere) volume 2; bob's chapters differ per shelf.
 */
function migratedFrom41() {
    const conn = new DatabaseSync(':memory:');
    conn.exec('PRAGMA foreign_keys = ON;');
    schema.ensureMigrationsTable(conn);
    const hold = conn.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, 'held back')");
    for (const v of HELD) hold.run(v);
    schema.applySchema(conn, { log: quiet });
    conn.exec(`
        INSERT INTO users (id, username, password_hash, role) VALUES (1, 'alice', 'x', 'admin'), (2, 'bob', 'x', 'editor'), (3, 'carl', 'x', 'editor');
        INSERT INTO shelves (id, name, owner_user_id) VALUES (2, 'Bob', 2);
        INSERT OR IGNORE INTO shelf_members (shelf_id, user_id, role) VALUES (1, 1, 'owner'), (1, 2, 'editor'), (2, 2, 'owner');
        INSERT INTO mangas (id, title, language, manga_passion_id, shelf_id) VALUES (1, 'One Piece', 'de', 87, 1), (2, 'One Piece', 'de', 87, 2);
        INSERT INTO mangas (id, title, language, format, total_chapters, shelf_id) VALUES (3, 'Tower', 'ko', 'webtoon', 600, 1), (4, 'Tower', 'ko', 'webtoon', 600, 2);
        INSERT INTO volumes (id, manga_id, volume_number, status) VALUES (11, 1, '1', 'Vorhanden'), (12, 1, '2', 'Vorhanden'), (21, 2, '1', 'Vorhanden');
        INSERT INTO volume_reads (volume_id, user_id, read_at) VALUES (11, 2, '2024-01-02 10:00:00'), (21, 2, '2023-05-05 09:00:00'), (11, 1, NULL), (12, 3, '2024-02-02 08:00:00');
        INSERT INTO chapter_progress (manga_id, user_id, chapters_read, updated_at) VALUES (3, 2, 10, '2024-01-01 00:00:00'), (4, 2, 25, '2023-01-01 00:00:00');
    `);
    conn.prepare(`DELETE FROM schema_migrations WHERE version IN (${HELD.join(', ')})`).run();
    const infos = [];
    const report = schema.runSequentialMigrations(conn, { log: { ...quiet, info: (line) => infos.push(line) } });
    assert.deepEqual(report.map(r => r.version), HELD);
    return { conn, infos };
}

const readers = (d, volumeId) => d.prepare('SELECT user_id, read_at FROM shelf_volume_reads WHERE volume_id = ? ORDER BY user_id').all(volumeId).map(r => [r.user_id, r.read_at]);
const chapters = (d, mangaId) => d.prepare('SELECT user_id, chapters_read FROM shelf_chapter_progress WHERE manga_id = ? ORDER BY user_id').all(mangaId).map(r => [r.user_id, r.chapters_read]);
const catalogVolume = (d, volumeId) => d.prepare('SELECT catalog_volume_id AS id FROM volumes WHERE id = ?').get(volumeId).id;

test('migration 43 merges the marks of rows sharing a catalog entry and shows them to members of each shelf', () => {
    const { conn: d, infos } = migratedFrom41();
    assert.equal(catalogVolume(d, 11), catalogVolume(d, 21), 'one edition in two shelves');
    assert.equal(d.prepare('SELECT count(*) AS n FROM volume_reads').get().n, 3, "bob's two reads of volume 1 became one");
    assert.deepEqual(readers(d, 11), [[1, null], [2, '2023-05-05 09:00:00']], 'the earliest read wins, an unknown date stays unknown');
    assert.deepEqual(readers(d, 21), [[2, '2023-05-05 09:00:00']], 'alice is no member of shelf 2');
    assert.deepEqual(readers(d, 12), [], "carl's mark is kept but hidden: he is in no shelf");
    assert.deepEqual([chapters(d, 3), chapters(d, 4)], [[[2, 25]], [[2, 25]]], 'the highest chapter wins');
    assert.ok(infos.some(line => /v43: volume_reads 4 -> 3 rows on the catalog \(1 of users outside the shelf/.test(line)), infos.join('\n'));
    const triggers = new Set(d.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map(r => r.name));
    for (const name of ['trg_dv_volume_reads_ins', 'trg_dv_chapter_progress_del', ...marks.MARK_FOLLOW_TRIGGERS]) assert.ok(triggers.has(name), name);
    assert.deepEqual(d.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(d.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.throws(() => d.prepare("INSERT INTO shelf_volume_reads (volume_id, user_id) VALUES (11, 3)").run(), /view/, 'the views are read-only');
});

test('joining a shelf shows the marks again, a changed volume number takes the marks of the shelf members along', () => {
    const { conn: d } = migratedFrom41();
    d.exec("INSERT INTO shelf_members (shelf_id, user_id, role) VALUES (1, 3, 'viewer')");
    assert.deepEqual(readers(d, 12), [[3, '2024-02-02 08:00:00']], 'carl joined the household shelf');

    const before = catalogVolume(d, 12);
    d.exec("UPDATE volumes SET volume_number = '3' WHERE id = 12");
    assert.notEqual(catalogVolume(d, 12), before);
    assert.deepEqual(readers(d, 12), [[3, '2024-02-02 08:00:00']], 'the read moved with the corrected number');
    assert.equal(d.prepare('SELECT count(*) AS n FROM volume_reads WHERE catalog_volume_id = ?').get(before).n, 0, 'nobody sees the old entry any more');

    // shelf 2 renumbers its volume 1: bob still sees volume 1 in the household shelf, so the old entry keeps his read too
    const shared = catalogVolume(d, 11);
    d.exec("UPDATE volumes SET volume_number = '5' WHERE id = 21");
    assert.deepEqual([readers(d, 11), readers(d, 21)], [[[1, null], [2, '2023-05-05 09:00:00']], [[2, '2023-05-05 09:00:00']]]);
    assert.equal(catalogVolume(d, 11), shared);

    // a webtoon that becomes another edition (language corrected) takes bob's chapter along; the old one stays for shelf 2
    d.exec("UPDATE mangas SET language = 'en' WHERE id = 3");
    assert.deepEqual([chapters(d, 3), chapters(d, 4)], [[[2, 25]], [[2, 25]]]);
});

test('a replayed migration 41 rebuilds the catalog and keeps every mark a row shows', () => {
    const { conn: d } = migratedFrom41();
    const shown = () => [readers(d, 11), readers(d, 12), readers(d, 21), chapters(d, 3), chapters(d, 4)];
    const before = shown();
    d.exec('DELETE FROM schema_migrations WHERE version >= 41');
    assert.deepEqual(schema.runSequentialMigrations(d, { log: quiet }).map(r => r.version), Array.from({ length: schema.LATEST_SCHEMA_VERSION - 40 }, (_, i) => 41 + i));
    assert.deepEqual(shown(), before);
    assert.deepEqual(d.prepare('PRAGMA foreign_key_check').all(), []);
});

test('deleting a volume or series keeps its marks for the same edition; deleting the account takes them', () => {
    const { conn: d } = migratedFrom41();
    d.exec('DELETE FROM volumes WHERE id = 11');
    assert.deepEqual(readers(d, 21), [[2, '2023-05-05 09:00:00']], 'the other shelf still shows the read');
    d.exec("INSERT INTO volumes (id, manga_id, volume_number, status) VALUES (13, 1, '1', 'Vorhanden')");
    assert.deepEqual(readers(d, 13), [[1, null], [2, '2023-05-05 09:00:00']], 'the volume added again shows them again');

    d.exec('DELETE FROM volumes WHERE manga_id = 3; DELETE FROM mangas WHERE id = 3');
    assert.deepEqual(chapters(d, 4), [[2, 25]]);

    d.exec('UPDATE shelves SET owner_user_id = NULL WHERE owner_user_id = 2; DELETE FROM users WHERE id = 2');
    assert.deepEqual([readers(d, 13), readers(d, 21), chapters(d, 4)], [[[1, null]], [], []]);
    assert.equal(d.prepare('SELECT count(*) AS n FROM volume_reads WHERE user_id = 2').get().n, 0);
});

test('the helpers write by catalog entry: add, replace, remove, read and chapters', () => {
    const { conn: d } = migratedFrom41();
    assert.equal(marks.addRead(d, 21, 2), false, 'bob has read this edition already');
    assert.equal(marks.addRead(d, 21, 2, '2020-01-01 00:00:00', { replace: true }), true);
    assert.deepEqual(readers(d, 11).find(r => r[0] === 2), [2, '2020-01-01 00:00:00'], 'one mark for both shelves');
    assert.deepEqual({ ...marks.removeRead(d, 11, 2) }, { read_at: '2020-01-01 00:00:00' });
    assert.equal(marks.readOf(d, 21, 2), null);
    assert.equal(marks.removeRead(d, 11, 2), null);
    assert.equal(marks.addRead(d, 21, 2, null), true);
    assert.deepEqual({ ...marks.readOf(d, 11, 2) }, { read_at: null }, 'read, date unknown');
    assert.equal(marks.addRead(d, 999, 2), false, 'an unknown volume writes nothing');

    marks.setChapterProgress(d, 4, 2, 30);
    assert.deepEqual(chapters(d, 3), [[2, 30]]);
    marks.setChapterProgress(d, 3, 2, 99, { ifMissing: true });
    assert.deepEqual(chapters(d, 4), [[2, 30]], 'ifMissing keeps the stored chapter');
    marks.clearChapterProgress(d, 3, 2);
    assert.deepEqual([chapters(d, 3), chapters(d, 4)], [[], []]);
});

test('an edition in two of the reader\'s shelves counts once in the reading history, "Weiterlesen" and the chapters', async () => {
    const { conn: d } = migratedFrom41();
    const { createCtx, dbFromConnection } = require('../../core/ctx');
    const { dispatch } = require('../../core/routes');
    d.exec(`
        UPDATE volumes SET pages = 200 WHERE id IN (11, 21);
        INSERT INTO volumes (id, manga_id, volume_number, status) VALUES (22, 2, '2', 'Vorhanden');
    `);
    const ctx = createCtx({ db: dbFromConnection(d), user: { id: 2, username: 'bob', role: 'editor' }, now: () => new Date('2024-06-15T12:00:00Z') });
    const get = async (url) => (await dispatch(ctx, { method: 'GET', url })).body;

    const reading = await get('/stats/reading');
    const may = reading.by_month.find(m => m.month === '2023-05');
    assert.deepEqual({ ...may }, { month: '2023-05', volumes: 1, pages: 200, series: 1 }, 'volume 1 is read once, not once per shelf');
    assert.deepEqual(reading.last_year, { year: 2023, volumes: 1, pages: 200 });
    assert.equal(reading.continue_reading.length, 1, 'One Piece is listed once');
    assert.equal(reading.continue_reading[0].manga_id, 1, 'under the row with the lowest id');
    assert.deepEqual({ ...reading.chapters }, { series: 1, read: 25, finished: 0 }, 'the webtoon counts once');

    const stats = (await get('/users/2/stats')).stats;
    assert.equal(stats.totalVolumes, 1);
    assert.equal(stats.totalPages, 200);
    assert.equal(stats.readMangas.length, 1);
    assert.equal(stats.recentVolumes.length, 1);
    assert.deepEqual(Object.keys(stats.recentVolumes[0]).sort(), ['id', 'manga_cover', 'manga_id', 'manga_title', 'notes', 'pages', 'read_at', 'type', 'volume_number']);
});
