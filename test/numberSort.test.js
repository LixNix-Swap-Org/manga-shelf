const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

// volumes.number_sort (migration 15) replaces the volume-number expressions the routes computed per query. The
// expressions below are the ones the routes used before (v2.19 / audit wave 4), kept here as the reference.
const OLD_NO = (col) => `TRIM(REPLACE(REPLACE(COALESCE(${col}, ''), 'Band ', ''), 'band ', ''))`;
const OLD_NUMBER_SORT = (col) => `CASE WHEN ${OLD_NO(col)} GLOB '[0-9]*' AND ${OLD_NO(col)} NOT GLOB '*[^0-9.]*' THEN CAST(${OLD_NO(col)} AS REAL) ELSE NULL END`;
const OLD_VOLUME_NO = OLD_NO('v.volume_number');
const OLD_IS_REGULAR = `(COALESCE(v.type, 'volume') = 'volume' AND ${OLD_VOLUME_NO} GLOB '[0-9]*'
    AND ${OLD_VOLUME_NO} NOT GLOB '*[^0-9]*' AND CAST(${OLD_VOLUME_NO} AS INTEGER) >= 1)`;
const OLD_LIST_AGGREGATES = `
    SELECT m.id,
           COUNT(DISTINCT CASE WHEN v.status = 'Vorhanden' AND ${OLD_IS_REGULAR} THEN CAST(${OLD_VOLUME_NO} AS INTEGER) END) as regular_owned,
           MAX(CASE WHEN v.status = 'Vorhanden' AND ${OLD_IS_REGULAR} THEN CAST(${OLD_VOLUME_NO} AS INTEGER) END) as max_regular_number,
           COUNT(DISTINCT CASE WHEN v.status = 'Vorhanden' AND NOT ${OLD_IS_REGULAR} THEN v.id END) as extras_owned
    FROM mangas m LEFT JOIN volumes v ON m.id = v.manga_id GROUP BY m.id`;
// spec A2 (review11-backend): complete = a stored total and at least that many distinct regular numbers owned
const SPEC_A2_COMPLETED = `
    SELECT count(*) AS count FROM mangas m
    WHERE COALESCE(m.total_volumes, 0) > 0
      AND (SELECT COUNT(DISTINCT CAST(${OLD_VOLUME_NO} AS INTEGER)) FROM volumes v
           WHERE v.manga_id = m.id AND v.status = 'Vorhanden' AND ${OLD_IS_REGULAR}) >= m.total_volumes`;
const OLD_VOLUME_ORDER = `
    CASE
        WHEN COALESCE(type, 'volume') = 'volume' AND (volume_number = '0' OR CAST(volume_number AS REAL) > 0) THEN 1
        WHEN COALESCE(type, 'volume') = 'special_edition' AND (volume_number = '0' OR CAST(volume_number AS REAL) > 0) THEN 1
        WHEN COALESCE(type, 'volume') = 'special_edition' THEN 1.5
        WHEN COALESCE(type, 'volume') = 'schuber' THEN 2
        WHEN COALESCE(type, 'volume') = 'special' THEN 3
        ELSE 2
    END ASC,
    CASE WHEN CAST(volume_number AS REAL) > 0 THEN CAST(volume_number AS REAL) WHEN volume_number = '0' THEN 0 ELSE 999999 END ASC,
    CASE WHEN COALESCE(type, 'volume') = 'volume' THEN 0 WHEN COALESCE(type, 'volume') = 'special_edition' THEN 1 ELSE 2 END ASC,
    volume_number ASC, id ASC`;

const CORPUS = ['1', 'Band 12', 'band 3', '12.5', ' 7 ', '01', 'Schuber 3', 'Special', 'Starter 1', '1e3', '-1', '', 'Band',
    'Band  4', '0', '1.0', '1.2.3', '12abc', '3 (Titel)', 'BAND 5', '007'];

let ctx;
let editor;
let db;
let dbm;

test.before(async () => {
    ctx = await startTestServer();
    const admin = ctx.client();
    editor = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'ed', password: 'password123', role: 'editor' })).status, 200);
    assert.equal((await editor('POST', '/auth/login', { username: 'ed', password: 'password123' })).status, 200);
    dbm = require('../db');
    db = dbm.db;
});

test.after(async () => { await ctx.close(); });

const createManga = (title, extra = {}) => db.prepare('INSERT INTO mangas (title, total_volumes) VALUES (?, ?)').run(title, extra.total_volumes ?? null).lastInsertRowid;
const insertVolume = (mangaId, number, type = 'volume', status = 'Vorhanden') =>
    Number(db.prepare('INSERT INTO volumes (manga_id, volume_number, type, status) VALUES (?, ?, ?, ?)').run(mangaId, number, type, status).lastInsertRowid);
const numberSortOf = (id) => db.prepare('SELECT number_sort FROM volumes WHERE id = ?').get(id).number_sort;
const oldValue = (number) => db.prepare(`SELECT ${OLD_NUMBER_SORT('x')} AS n FROM (SELECT ? AS x)`).get(number).n;

test('number_sort equals the old SQL expression for odd volume numbers, set on insert', () => {
    const m = createManga('Korpus');
    for (const number of CORPUS) {
        const id = insertVolume(m, number);
        assert.equal(numberSortOf(id), oldValue(number), `number_sort of "${number}"`);
    }
    assert.equal(oldValue('Band 12'), 12);
    assert.equal(oldValue('12.5'), 12.5);
    assert.equal(oldValue('Schuber 3'), null);
});

test('regular volumes and progress values match the old list expressions for every type', () => {
    const m = createManga('Typen');
    for (const type of ['volume', 'special_edition', 'schuber', 'special']) {
        for (const number of CORPUS) insertVolume(m, number, type);
    }
    db.prepare("UPDATE volumes SET type = NULL WHERE manga_id = ? AND type = 'special' AND volume_number = '5'").run(m);
    const { regularNumberedSql } = require('../utils/volumeNumber');
    const rows = db.prepare(`SELECT v.volume_number, v.type, ${OLD_IS_REGULAR} AS old_regular, ${regularNumberedSql('v')} AS regular,
        CASE WHEN ${OLD_IS_REGULAR} THEN CAST(${OLD_VOLUME_NO} AS INTEGER) END AS old_n,
        CASE WHEN ${regularNumberedSql('v')} THEN v.number_sort END AS n
        FROM volumes v WHERE v.manga_id = ?`).all(m);
    for (const r of rows) {
        assert.equal(r.regular, r.old_regular, `regular "${r.volume_number}" (${r.type})`);
        assert.equal(r.n, r.old_n, `number of "${r.volume_number}" (${r.type})`);
    }
});

test('triggers: changing volume_number updates number_sort, other columns leave it alone', () => {
    const m = createManga('Trigger');
    const id = insertVolume(m, '4');
    assert.equal(numberSortOf(id), 4);
    db.prepare("UPDATE volumes SET volume_number = 'Band 9' WHERE id = ?").run(id);
    assert.equal(numberSortOf(id), 9);
    db.prepare("UPDATE volumes SET volume_number = 'Schuber 1' WHERE id = ?").run(id);
    assert.equal(numberSortOf(id), null);
    db.prepare("UPDATE volumes SET volume_number = '2', number_sort = 99 WHERE id = ?").run(id);
    assert.equal(numberSortOf(id), 2, 'the trigger wins over a hand-written value');
    db.prepare('UPDATE volumes SET number_sort = 77 WHERE id = ?').run(id);
    db.prepare("UPDATE volumes SET price = 7.5, status = 'Fehlt', notes = 'x' WHERE id = ?").run(id);
    assert.equal(numberSortOf(id), 77);
});

test('GET /mangas, /stats and the detail order are unchanged against the old expressions', async () => {
    const a = createManga('Fixture A', { total_volumes: 14 });
    for (let n = 1; n <= 13; n++) insertVolume(a, String(n));
    insertVolume(a, 'Band 14');
    insertVolume(a, '14');
    insertVolume(a, '12.5');
    insertVolume(a, 'Schuber 1', 'schuber');
    insertVolume(a, '3', 'special_edition');
    insertVolume(a, 'Collectors Edition', 'special_edition');
    insertVolume(a, 'Fanbook', 'special');
    insertVolume(a, '0');
    insertVolume(a, '15', 'volume', 'Fehlt');
    const b = createManga('Fixture B', { total_volumes: 3 });
    for (const n of ['1', 'band 2', 'Starter 1']) insertVolume(b, n);
    const c = createManga('Fixture C');
    insertVolume(c, '0');
    // the old max-target rule disagrees on both: no stored total, and a stale total below the highest number
    const noTotal = createManga('Fixture D');
    for (const n of ['1', '2', '3']) insertVolume(noTotal, n);
    const staleTotal = createManga('Fixture E', { total_volumes: 3 });
    for (const n of ['1', '2', '5']) insertVolume(staleTotal, n);

    const old = new Map(db.prepare(OLD_LIST_AGGREGATES).all().map(r => [r.id, r]));
    const list = (await editor('GET', '/mangas')).body;
    assert.ok(list.length >= 3);
    for (const row of list) {
        const ref = old.get(row.id);
        assert.deepEqual([row.regular_owned, row.max_regular_number, row.extras_owned],
            [ref.regular_owned, ref.max_regular_number, ref.extras_owned], `list row ${row.title}`);
    }
    const rowA = list.find(r => r.id === Number(a));
    assert.deepEqual([rowA.regular_owned, rowA.max_regular_number, rowA.extras_owned], [14, 14, 6]);

    const stats = (await editor('GET', '/stats')).body.summary;
    assert.equal(stats.completed_series, db.prepare(SPEC_A2_COMPLETED).get().count);
    assert.ok(stats.completed_series >= 2);

    for (const id of [a, b, c]) {
        const detail = (await editor('GET', `/mangas/${id}`)).body;
        const oldOrder = db.prepare(`SELECT id FROM volumes WHERE manga_id = ? ORDER BY ${OLD_VOLUME_ORDER}`).all(id).map(r => r.id);
        const newOrder = detail.volumes.map(v => v.id);
        // "Band 14" / "band 2" sorted as labels before (CAST of "Band 14" is 0); with number_sort they sit at their number
        const idOf = (n) => db.prepare('SELECT id FROM volumes WHERE manga_id = ? AND volume_number = ?').get(id, n).id;
        const prefixed = new Set(db.prepare("SELECT id FROM volumes WHERE manga_id = ? AND lower(volume_number) LIKE 'band %'").all(id).map(r => r.id));
        assert.deepEqual(newOrder.filter(v => !prefixed.has(v)), oldOrder.filter(v => !prefixed.has(v)), `detail order of ${id}`);
        if (id === a) assert.equal(newOrder.indexOf(idOf('Band 14')), newOrder.indexOf(idOf('14')) + 1);
        if (id === b) assert.deepEqual(newOrder, [idOf('1'), idOf('band 2'), idOf('Starter 1')]);
        assert.ok(detail.volumes.every(v => !('number_sort' in v)), 'number_sort stays internal');
    }
});

test('migration 15 backfills number_sort on a database from before it', () => {
    const m = createManga('Backfill');
    const ids = CORPUS.map(n => insertVolume(m, n));
    db.exec(`
        DROP TRIGGER trg_volumes_number_sort_ins;
        DROP TRIGGER trg_volumes_number_sort_upd;
        DROP INDEX idx_volumes_manga_number;
        ALTER TABLE volumes DROP COLUMN number_sort;
        DELETE FROM schema_migrations WHERE version = 15;
    `);
    assert.equal(db.prepare('PRAGMA table_info(volumes)').all().some(c => c.name === 'number_sort'), false);
    dbm.initDb();
    const conn = dbm.db;
    CORPUS.forEach((number, i) => {
        assert.equal(conn.prepare('SELECT number_sort FROM volumes WHERE id = ?').get(ids[i]).number_sort, oldValue(number), `"${number}"`);
    });
    assert.ok(conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_volumes_manga_number'").get());
    assert.equal(conn.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_volumes_number_sort_%'").get().n, 2);
});

test('canonicalVolumeNumber: one helper for routes and CSV ("Band 14" / "Bd. 14" = 14 only for regular volumes)', () => {
    const { canonicalVolumeNumber } = require('../utils/volumeNumber');
    const csv = require('../services/csvExchange');
    const cases = [
        [' Band 14 ', 'volume', '14'], ['bd. 3', 'volume', '3'], ['Bd 7', 'volume', '7'], ['band12', 'volume', '12'],
        ['Band 14', 'schuber', 'Band 14'], ['Band 1.5', 'volume', 'Band 1.5'], ['Schuber 2', 'volume', 'Schuber 2'],
        [14, 'volume', '14'], [null, 'volume', ''], [undefined, 'special', '']
    ];
    for (const [input, type, expected] of cases) {
        assert.equal(canonicalVolumeNumber(input, type), expected, `${input} (${type})`);
        assert.equal(csv.canonicalVolumeNumber(input, type), expected, `csvExchange copy: ${input} (${type})`);
    }
});
