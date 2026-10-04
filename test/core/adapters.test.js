// Adapter conformance (spec-standalone §6): node:sqlite and sql.js run the same schema, migrations, triggers and core
// operations, and answer the handler scenarios and a seeded collection identically.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createCtx, withUser, dbFromConnection } = require('../../core/ctx');
const { applySchema, LATEST_SCHEMA_VERSION } = require('../../core/schema');
const { dispatch } = require('../../core/routes');
const { errorAnswer } = require('../../core/errors');
const { connectionFromSqlJs } = require('../../core/adapters/sqljs');
const { runScenarios } = require('./runScenarios');
const { USERS, offlineHttp } = require('./harness');

// sql.js is a frontend dependency; the root install of the backend job may not have it
function sqlJsPath() {
    for (const candidate of ['sql.js', path.join(__dirname, '..', '..', 'frontend', 'node_modules', 'sql.js')]) {
        try { return require.resolve(candidate); } catch (e) { /* next */ }
    }
    return null;
}
const SQL_JS = sqlJsPath();
let sqlPromise = null;
const loadSqlJs = () => (sqlPromise ??= require(SQL_JS)());

const ADAPTERS = {
    'node:sqlite': async () => new DatabaseSync(':memory:'),
    'sql.js': async () => connectionFromSqlJs(new (await loadSqlJs()).Database())
};

function memoryFiles() {
    const files = new Map();
    return {
        write: async (name, bytes) => { files.set(name, bytes); },
        read: async (name) => files.get(name),
        stat: async (name) => (files.has(name) ? { size: files.get(name).length } : null),
        touch: async () => {},
        remove: async (name) => { files.delete(name); },
        list: async () => [...files.keys()]
    };
}

/** The in-memory core of harness.js on any connection. */
async function createCore(kind) {
    const conn = await ADAPTERS[kind]();
    if (kind === 'node:sqlite') conn.exec('PRAGMA foreign_keys = ON;');
    applySchema(conn);
    const insert = conn.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)');
    for (const u of USERS) insert.run(u.id, u.username, 'not-a-hash', u.role);
    const ctx = createCtx({ db: dbFromConnection(conn), files: memoryFiles(), http: offlineHttp(), config: { appTimeZone: 'Europe/Berlin', appVersion: 'test' } });
    async function request(user, method, url, body) {
        try {
            const res = await dispatch(withUser(ctx, user), { method, url, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
            const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
            return { status: res.status, body: typeof res.body === 'string' ? null : JSON.parse(text), text, headers: res.headers };
        } catch (err) {
            const answer = errorAnswer(err);
            return { status: answer.status, body: answer.body, text: JSON.stringify(answer.body), headers: {} };
        }
    }
    const client = (username) => {
        const user = username ? USERS.find(u => u.username === username) : null;
        const api = async (method, url, body) => {
            const res = await request(user, method, url, body);
            return { status: res.status, body: res.body };
        };
        api.raw = (method, url, body) => request(user, method, url, body);
        return api;
    };
    return { kind, conn, ctx, client, users: USERS, close: async () => conn.close() };
}

const kinds = SQL_JS ? Object.keys(ADAPTERS) : ['node:sqlite'];
if (!SQL_JS) test('sql.js adapter', { skip: 'sql.js nicht installiert (cd frontend && npm install)' }, () => {});

for (const kind of kinds) {
    test(`${kind}: schema, migrations and triggers`, async () => {
        const core = await createCore(kind);
        const { conn } = core;
        assert.equal(conn.prepare('SELECT max(version) AS v FROM schema_migrations').get().v, LATEST_SCHEMA_VERSION);
        const tables = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(r => r.name);
        for (const t of ['animes', 'api_cache', 'mangas', 'user_api_credentials', 'users', 'volume_owners', 'volume_reads', 'volumes']) {
            assert.ok(tables.includes(t), `${kind}: ${t} fehlt (${tables.join(', ')})`);
        }
        const manga = conn.prepare('INSERT INTO mangas (title) VALUES (?)').run('Trigger');
        assert.deepEqual([manga.changes, typeof manga.lastInsertRowid], [1, 'number']);
        const ins = conn.prepare('INSERT INTO volumes (manga_id, volume_number) VALUES (?, ?)');
        ins.run(manga.lastInsertRowid, '12');
        ins.run(manga.lastInsertRowid, '3.5');
        assert.deepEqual(conn.prepare('SELECT volume_number, number_sort FROM volumes ORDER BY number_sort').all().map(r => [r.volume_number, r.number_sort]), [['3.5', 3.5], ['12', 12]]);
        conn.prepare('UPDATE volumes SET volume_number = ? WHERE volume_number = ?').run('Band 7', '12');
        assert.equal(conn.prepare('SELECT number_sort FROM volumes WHERE volume_number = ?').get('Band 7').number_sort, 7);
        assert.equal(conn.prepare('SELECT 1 FROM volumes WHERE id = ?').get(-1), undefined);
        assert.throws(() => conn.prepare('SELECT ?').get(undefined));
        // foreign keys on: deleting the series removes its volumes
        conn.prepare('DELETE FROM mangas WHERE id = ?').run(manga.lastInsertRowid);
        assert.equal(conn.prepare('SELECT count(*) AS n FROM volumes').get().n, 0);
        await core.close();
    });

    test(`${kind}: ctx.db.transaction commits, rolls back and refuses async callbacks`, async () => {
        const core = await createCore(kind);
        const { db } = core.ctx;
        db.transaction(() => db.prepare('INSERT INTO mangas (title) VALUES (?)').run('A'));
        assert.throws(() => db.transaction(() => {
            db.prepare('INSERT INTO mangas (title) VALUES (?)').run('B');
            throw new Error('abbrechen');
        }), /abbrechen/);
        assert.throws(() => db.transaction(async () => {}), /asynchrone Callbacks/);
        assert.deepEqual(db.prepare('SELECT title FROM mangas ORDER BY id').all().map(r => r.title), ['A']);
        await core.close();
    });
}

if (SQL_JS) {
    test('sql.js: export keeps the data and foreign keys stay on', async () => {
        const SQL = await loadSqlJs();
        const conn = connectionFromSqlJs(new SQL.Database());
        applySchema(conn);
        const id = conn.prepare('INSERT INTO mangas (title) VALUES (?)').run('Export').lastInsertRowid;
        conn.prepare('INSERT INTO volumes (manga_id, volume_number) VALUES (?, ?)').run(id, '1');
        const bytes = conn.export();
        assert.equal(conn.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
        const copy = connectionFromSqlJs(new SQL.Database(bytes));
        assert.equal(copy.prepare('SELECT count(*) AS n FROM volumes').get().n, 1);
        // the export is a SQLite file node:sqlite opens as well
        const file = path.join(require('node:os').tmpdir(), `adapter-${process.pid}-${Date.now()}.db`);
        require('node:fs').writeFileSync(file, bytes);
        const node = new DatabaseSync(file);
        assert.equal(node.prepare('SELECT title FROM mangas').get().title, 'Export');
        node.close();
        require('node:fs').unlinkSync(file);
        conn.close();
        copy.close();
    });

    runScenarios('sql.js', () => createCore('sql.js'));

    test('node:sqlite and sql.js answer a seeded collection identically', async () => {
        const a = await createCore('node:sqlite');
        const b = await createCore('sql.js');
        const TIME_KEY = /(^|_)at$/;
        const normalize = (value) => {
            if (Array.isArray(value)) return value.map(normalize);
            if (value && typeof value === 'object') {
                return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, TIME_KEY.test(k) && v !== null ? '<time>' : normalize(v)]));
            }
            return value;
        };
        const both = async (user, method, url, body) => {
            const [x, y] = await Promise.all([a.client(user).raw(method, url, body), b.client(user).raw(method, url, body)]);
            assert.equal(x.status, y.status, `${method} ${url}: ${x.text} | ${y.text}`);
            if (x.body === null || y.body === null) assert.equal(x.text, y.text);
            else assert.deepEqual(normalize(x.body), normalize(y.body), `${method} ${url}`);
            return x.body;
        };
        const naruto = (await both('ed', 'POST', '/mangas', { title: 'Naruto', publisher: 'carlsen manga', total_volumes: 72 })).id;
        await both('ed', 'POST', '/volumes/batch', { manga_id: naruto, from: 1, to: 5, default_price: '6,95', status: 'Vorhanden' });
        await both('ed', 'POST', '/volumes', { manga_id: naruto, volume_number: '6', status: 'Fehlt', price: 7.5, priority: 3 });
        const detail = await both('ed', 'GET', `/mangas/${naruto}`);
        await both('admin', 'POST', `/volumes/${detail.volumes[0].id}/owners`, { owned: true, purchase_date: '2024-01-02' });
        await both('admin', 'POST', '/volumes/batch-read', { manga_id: naruto, up_to_volume: 3 });
        await both('ed', 'POST', '/import/csv', { csv: 'Reihe;Verlag;Bandnummer;Status;Preis;Besitzer\nCSV-Reihe;Kazé;1;Vorhanden;8,00;ed\n' });
        await both('ed', 'POST', '/volumes', { manga_id: naruto, volume_number: '1', type: 'special_edition' });
        for (const url of ['/mangas', `/mangas/${naruto}`, '/offline-snapshot', '/stats', '/shopping-list', '/release-radar', '/dashboard-summary', '/export/csv', '/anime']) {
            await both('admin', 'GET', url);
        }
        await a.close();
        await b.close();
    });
}
