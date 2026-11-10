// Shelf helpers of core/lib/access.js on their own: id parsing, statements scopedCtx refuses, reads of an account
// without users row (the pending profile of a local follower window) on both adapters, and the seeded household shelf.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createCtx, withUser, dbFromConnection } = require('../core/ctx');
const { applySchema } = require('../core/schema');
const { dispatch } = require('../core/routes');
const { errorAnswer } = require('../core/errors');
const { connectionFromSqlJs } = require('../core/adapters/sqljs');
const access = require('../core/lib/access');
const { seedDatabase, DEMO_USERS } = require('../scripts/seed');

function sqlJsPath() {
    for (const candidate of ['sql.js', path.join(__dirname, '..', 'frontend', 'node_modules', 'sql.js')]) {
        try { return require.resolve(candidate); } catch (e) { /* next */ }
    }
    return null;
}
const SQL_JS = sqlJsPath();

const ADAPTERS = {
    'node:sqlite': async () => {
        const conn = new DatabaseSync(':memory:');
        conn.exec('PRAGMA foreign_keys = ON;');
        return conn;
    },
    'sql.js': async () => connectionFromSqlJs(new (await require(SQL_JS)()).Database())
};

test('parseId takes a safe positive integer or a plain digit string, nothing else', () => {
    for (const [raw, id] of [[7, 7], ['7', 7], ['007', 7], [1.0, 1]]) assert.equal(access.parseId(raw), id, JSON.stringify(raw));
    for (const raw of ['1e1', '0x1', ' 1', '1 ', '1.0', '+1', '-1', '', '0', 0, -3, 1.5, NaN, Infinity, 2 ** 53, '9007199254740993', null, undefined, true, [1], { id: 1 }]) {
        assert.equal(access.parseId(raw), null, String(raw));
    }
});

test('scopedCtx: only reads, protected tables only as {tokens} (bare, quoted, main., comma joins refused)', () => {
    const conn = new DatabaseSync(':memory:');
    applySchema(conn);
    conn.exec(`
        INSERT INTO shelves (id, name) VALUES (2, 'Zwei');
        INSERT INTO users (id, username, password_hash) VALUES (1, 'u', 'x');
        INSERT INTO mangas (id, title, shelf_id) VALUES (1, 'Eins', 1), (2, 'Zwei', 2);
        INSERT INTO volumes (id, manga_id, volume_number) VALUES (1, 1, '1'), (2, 2, '1');
        INSERT OR IGNORE INTO shelf_members (shelf_id, user_id, role) VALUES (1, 1, 'owner'), (2, 1, 'owner');
        INSERT INTO volume_reads (catalog_volume_id, user_id) SELECT catalog_volume_id, 1 FROM volumes WHERE id IN (1, 2);
        INSERT INTO chapter_progress (catalog_series_id, user_id, chapters_read) SELECT catalog_series_id, 1, id * 10 FROM mangas WHERE id IN (1, 2);
    `);
    const scoped = access.scopedCtx(createCtx({ db: dbFromConnection(conn) }), [2]).db;
    for (const sql of [
        // writes
        "UPDATE volumes SET status = 'Vorhanden'",
        "UPDATE {volumes} SET status = 'Vorhanden' WHERE id = 1",
        'DELETE FROM volumes WHERE id = ?',
        "INSERT INTO volumes (manga_id, volume_number) VALUES (1, '2')",
        // a protected table named any other way than as its token
        'SELECT count(*) AS n FROM volume_reads WHERE user_id = ?',
        'SELECT 1 FROM volume_owners WHERE volume_id = ? LIMIT 1',
        'SELECT count(*) AS n FROM chapter_progress WHERE user_id = ?',
        'SELECT count(*) AS n FROM shelf_volume_reads WHERE user_id = ?',
        'SELECT count(*) AS n FROM shelf_chapter_progress WHERE user_id = ?',
        'SELECT count(*) AS n FROM trash',
        'SELECT id FROM mangas',
        'SELECT count(*) AS n FROM {volume_reads} vr JOIN volumes v ON v.id = vr.volume_id',
        'SELECT m.id FROM {mangas} m, volumes v WHERE v.manga_id = m.id',
        'SELECT id FROM "mangas"',
        'SELECT id FROM `mangas`',
        'SELECT id FROM [mangas]',
        'SELECT id FROM main.mangas',
        "SELECT name FROM sqlite_master WHERE name = 'mangas'",
        'SELECT 1 AS volumes FROM {mangas}'
    ]) {
        assert.throws(() => scoped.prepare(sql), /scopedCtx/, sql);
    }
    assert.equal(scoped.prepare('SELECT count(*) AS n FROM {volume_reads} WHERE user_id = ?').get(1).n, 1);
    assert.equal(scoped.prepare('SELECT count(*) AS n FROM {volume_reads} vr JOIN {volumes} v ON v.id = vr.volume_id WHERE vr.user_id = ?').get(1).n, 1);
    assert.equal(scoped.prepare('SELECT SUM(chapters_read) AS n FROM {chapter_progress} WHERE user_id = ?').get(1).n, 20,
        'chapter progress only of the series of the shelves');
    assert.deepEqual(scoped.prepare('SELECT id FROM {mangas}').all().map(r => r.id), [2]);
    // columns and aliases that merely contain a table name are fine
    assert.equal(scoped.prepare('SELECT count(*) AS owned_volumes, MAX(m.total_volumes) AS total_volumes FROM {mangas} m').get().owned_volumes, 1);
    // no shelf at all: every token matches nothing
    assert.equal(access.scopedCtx(createCtx({ db: dbFromConnection(conn) }), []).db.prepare('SELECT count(*) AS n FROM {volumes}').get().n, 0);
});

const kinds = SQL_JS ? Object.keys(ADAPTERS) : ['node:sqlite'];
if (!SQL_JS) test('sql.js adapter', { skip: 'sql.js nicht installiert (cd frontend && npm install)' }, () => {});

for (const kind of kinds) {
    test(`${kind}: an account without users row reads without writing (pending local profile, deleted account)`, async () => {
        const conn = await ADAPTERS[kind]();
        applySchema(conn);
        conn.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'ich', 'x', 'admin')").run();
        const ctx = createCtx({ db: dbFromConnection(conn), config: { appTimeZone: 'Europe/Berlin', appVersion: 'test' } });
        const request = async (user, method, url, body) => {
            try {
                return await dispatch(withUser(ctx, user), { method, url, body });
            } catch (err) {
                return errorAnswer(err);
            }
        };
        const owner = { id: 1, username: 'ich', role: 'admin' };
        const created = await request(owner, 'POST', '/mangas', { title: 'Hausreihe' });
        assert.equal(created.status ?? 200, 200, JSON.stringify(created.body));

        const pending = { id: -1, username: 'Neu', role: 'admin' };
        for (const url of ['/mangas', '/shelves', '/stats', '/shopping-list', '/trash']) {
            const res = await request(pending, 'GET', url);
            assert.equal(res.status ?? 200, 200, `${kind} ${url}: ${JSON.stringify(res.body)}`);
        }
        assert.deepEqual((await request(pending, 'GET', '/mangas')).body.map(m => m.title), ['Hausreihe'], 'the pending profile reads the household shelf');
        assert.deepEqual((await request(pending, 'GET', '/shelves')).body.shelves.map(s => [s.id, s.role]), [[1, 'viewer']]);
        assert.equal((await request(pending, 'PUT', `/mangas/${created.body.id}`, { title: 'x' })).status, 403, 'and writes nowhere');

        const gone = { id: 99, username: 'weg', role: 'editor' };
        assert.deepEqual((await request(gone, 'GET', '/mangas')).body, []);
        assert.deepEqual(conn.prepare('SELECT user_id FROM shelf_members ORDER BY user_id').all().map(r => r.user_id), [1], 'no membership was written');
        assert.equal(conn.prepare('SELECT owner_user_id FROM shelves WHERE id = 1').get().owner_user_id, 1);
        conn.close();
    });
}

test('the seeder makes the first admin owner of the household shelf, as /setup does', () => {
    const conn = new DatabaseSync(':memory:');
    conn.exec('PRAGMA foreign_keys = ON;');
    applySchema(conn);
    const runTransaction = (fn) => {
        conn.exec('BEGIN');
        try {
            const result = fn();
            conn.exec('COMMIT');
            return result;
        } catch (err) {
            conn.exec('ROLLBACK');
            throw err;
        }
    };
    const passwordHashes = Object.fromEntries(DEMO_USERS.map(([name]) => [name, 'x']));
    seedDatabase({ db: conn, runTransaction }, { series: 2, volumes: 3, seed: 1, passwordHashes });
    const adminId = conn.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get().id;
    assert.equal(conn.prepare('SELECT owner_user_id FROM shelves WHERE id = 1').get().owner_user_id, adminId);
    assert.equal(conn.prepare('SELECT role FROM shelf_members WHERE shelf_id = 1 AND user_id = ?').get(adminId).role, 'owner');
    conn.close();
});
