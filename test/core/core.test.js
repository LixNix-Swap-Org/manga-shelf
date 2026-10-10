// Building blocks of core/: ctx, route table and dispatch, errors, schema, the pure helpers that replaced Node APIs.
const test = require('node:test');
// signals.js timers are unref'd; Node 22's runner otherwise drops an awaiting test once the loop drains
const keepAlive = setInterval(() => {}, 1000);
test.after(() => clearInterval(keepAlive));
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { once, getEventListeners } = require('events');
const { DatabaseSync } = require('node:sqlite');
const { createCtx, withUser, dbFromConnection, ANSWERED } = require('../../core/ctx');
const { routes, matchRoute, parseQuery, roleError, dispatch } = require('../../core/routes');
const { HttpError, errorAnswer } = require('../../core/errors');
const schema = require('../../core/schema');
const { md5Hex } = require('../../core/lib/md5');
const { detectImageExt, fetchImage } = require('../../core/lib/imageCheck');

const memoryDb = () => {
    const conn = new DatabaseSync(':memory:');
    schema.applySchema(conn);
    return conn;
};

test('md5Hex matches node:crypto for ASCII, umlauts, emoji and block boundaries', () => {
    for (const text of ['', 'a', 'https://cdn.manga-passion.de/cover/1.jpg', 'Ärger über Öl', '😀'.repeat(20), 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(1000)]) {
        assert.equal(md5Hex(text), crypto.createHash('md5').update(text).digest('hex'), `length ${text.length}`);
    }
});

test('detectImageExt works on plain Uint8Arrays like on Buffers', () => {
    const bytes = (...parts) => {
        const out = new Uint8Array(64);
        let at = 0;
        for (const p of parts) for (const b of (typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : p)) out[at++] = b;
        return out;
    };
    const samples = {
        '.jpg': bytes([0xff, 0xd8, 0xff, 0xe0]),
        '.png': bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        '.gif': bytes('GIF89a'),
        '.webp': bytes('RIFF', [0, 0, 0, 0], 'WEBP'),
        '.avif': bytes([0, 0, 0, 24], 'ftyp', 'mif1', [0, 0, 0, 0], 'miaf', 'avif')
    };
    for (const [ext, data] of Object.entries(samples)) {
        assert.equal(detectImageExt(data), ext);
        assert.equal(detectImageExt(Buffer.from(data)), ext);
    }
    assert.equal(detectImageExt(bytes('<svg')), null);
    assert.equal(detectImageExt(new Uint8Array(5)), null);
});

test('fetchImage checks the magic bytes itself, whatever the host download returned', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const host = (buffer, ext) => ({ http: { fetchImage: async () => ({ buffer, ext }) } });
    assert.deepEqual(await fetchImage(host(png, '.png'), 'https://x/a.png'), { buffer: png, ext: '.png' });
    assert.equal((await fetchImage(host(png, '.jpg'), 'https://x/a.jpg')).ext, '.png', 'the bytes decide');
    await assert.rejects(fetchImage(host(new TextEncoder().encode('<html>not an image</html>'), '.jpg'), 'https://x/a.jpg'), /kein gültiges Bild/);
});

test('createCtx: db is required, missing host parts fail with a clear message, withUser keeps the host', async () => {
    assert.throws(() => createCtx({}), /db fehlt/);
    const ctx = createCtx({ db: dbFromConnection(memoryDb()) });
    await assert.rejects(async () => ctx.http.fetch('https://example.com'), /ctx\.http\.fetch ist in dieser Umgebung nicht verfügbar/);
    assert.throws(() => ctx.files.write('a.jpg', new Uint8Array(1)), /ctx\.files\.write/);
    assert.equal(ctx.files.url('a.jpg'), '/uploads/a.jpg');
    assert.match(ctx.randomId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(ctx.db.generation(), 1);
    const user = { id: 1, username: 'a', role: 'admin' };
    const mine = withUser(ctx, user, { signal: AbortSignal.abort() });
    assert.deepEqual([mine.user, mine.db, ctx.user, mine.signal.aborted], [user, ctx.db, null, true]);
    await ctx.yield();
});

test('ctx.db.transaction commits, rolls back on an error and refuses async callbacks', () => {
    const conn = memoryDb();
    const { db } = createCtx({ db: dbFromConnection(conn) });
    const count = () => conn.prepare('SELECT count(*) AS n FROM mangas').get().n;
    assert.equal(db.transaction(() => { db.prepare("INSERT INTO mangas (title) VALUES ('a')").run(); return 'ok'; }), 'ok');
    assert.throws(() => db.transaction(() => { db.prepare("INSERT INTO mangas (title) VALUES ('b')").run(); throw new Error('nein'); }), /nein/);
    assert.throws(() => db.transaction(async () => { db.prepare("INSERT INTO mangas (title) VALUES ('c')").run(); }), /asynchrone Callbacks/);
    assert.equal(count(), 1);
});

test('schema: a fresh database gets every migration once; beforeMigrations sees the pending list', () => {
    const conn = new DatabaseSync(':memory:');
    const seen = [];
    const report = schema.applySchema(conn, { beforeMigrations: (d, pending) => seen.push(pending.map(m => m.version)) });
    assert.equal(report.length, schema.LATEST_SCHEMA_VERSION);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].at(-1), schema.LATEST_SCHEMA_VERSION);
    assert.equal(schema.appliedSchemaVersion(conn), schema.LATEST_SCHEMA_VERSION);
    assert.deepEqual(schema.applySchema(conn, { beforeMigrations: () => assert.fail('nothing pending') }), []);
    assert.equal(conn.prepare("SELECT value FROM app_settings WHERE key = 'collection_start_date'").get(), undefined, 'derived from the data, never seeded');
});

test('route table: known roles, a handler per row, no method + path twice', () => {
    const seen = new Set();
    for (const row of routes) {
        assert.ok(['public', 'auth', 'editor', 'admin'].includes(row.role), `${row.method} ${row.path}`);
        assert.equal(typeof row.handler, 'function', `${row.method} ${row.path}`);
        const key = `${row.method} ${row.path}`;
        assert.ok(!seen.has(key), key);
        seen.add(key);
    }
});

test('matchRoute and parseQuery read paths and queries like Express', () => {
    assert.deepEqual(matchRoute('GET', '/mangas/12').params, { id: '12' });
    assert.equal(matchRoute('GET', '/Mangas/12/').row.path, '/mangas/:id');
    assert.equal(matchRoute('HEAD', '/stats').row.path, '/stats');
    assert.equal(matchRoute('POST', '/volumes/batch').row.path, '/volumes/batch');
    assert.equal(matchRoute('POST', '/volumes/7/owners').row.path, '/volumes/:id/owners');
    assert.equal(matchRoute('PATCH', '/mangas/1'), null);
    assert.equal(matchRoute('GET', '/mangas/1/unknown'), null);
    assert.deepEqual(parseQuery('?a=1&a=2&b=x%20y&c'), { a: ['1', '2'], b: 'x y', c: '' });
});

test('roleError matches the server guards; dispatch answers 404 for unknown paths', async () => {
    const as = (role) => ({ id: 1, username: 'u', role });
    assert.equal(roleError('auth', null).status, 401);
    assert.equal(roleError('public', null), null);
    assert.deepEqual([roleError('editor', as('guest')).code, roleError('editor', as('visitor')).status], ['READ_ONLY', 403]);
    assert.equal(roleError('editor', as('editor')), null);
    assert.equal(roleError('admin', as('editor')).code, 'FORBIDDEN');
    const ctx = createCtx({ db: dbFromConnection(memoryDb()) });
    await assert.rejects(dispatch(withUser(ctx, as('admin')), { method: 'GET', url: '/nope' }), (err) => err.status === 404);
});

test('a limit hook that answered the request stops the dispatch', async () => {
    const ctx = withUser(createCtx({ db: dbFromConnection(memoryDb()), limit: () => { throw ANSWERED; } }), { id: 1, role: 'admin' });
    await assert.rejects(dispatch(ctx, { method: 'GET', url: '/lookup/manga?q=x' }), (err) => err === ANSWERED);
});

test('the default limit allows everything and answers true (device runtime, memory harness)', () => {
    const ctx = createCtx({ db: dbFromConnection(memoryDb()) });
    assert.deepEqual([ctx.limit('lookup'), ctx.limit('lookup', { soft: true })], [true, true]);
});

test('errorAnswer follows the server error handler', () => {
    assert.deepEqual(errorAnswer(new HttpError(409, 'Doppelt', 'VOLUME_DUPLICATE', { existing_id: 4 })),
        { status: 409, body: { error: 'Doppelt', code: 'VOLUME_DUPLICATE', existing_id: 4 } });
    assert.deepEqual(errorAnswer(Object.assign(new Error('Manga nicht gefunden'), { status: 404 })),
        { status: 404, body: { error: 'Manga nicht gefunden', code: 'NOT_FOUND' } });
    assert.deepEqual(errorAnswer(Object.assign(new Error('neu geöffnet'), { status: 503 }), 'ab12'),
        { status: 503, body: { error: 'neu geöffnet', code: 'SERVICE_UNAVAILABLE', ref: 'ab12' } });
    assert.deepEqual(errorAnswer(Object.assign(new Error('SQLITE_BUSY: locked /secret'), { code: 'SQLITE_BUSY' })),
        { status: 500, body: { error: 'Interner Serverfehler', code: 'INTERNAL_ERROR' } });
});

test('timeoutSignal aborts with a TimeoutError after the delay, not before', async () => {
    const { timeoutSignal } = require('../../core/lib/signals');
    const signal = timeoutSignal(30);
    assert.equal(signal.aborted, false);
    await once(signal, 'abort');
    assert.equal(signal.reason.name, 'TimeoutError');
    await assert.rejects(fetch('http://127.0.0.1:9/', { signal }), { name: 'TimeoutError' });
});

test('anySignal aborts on the first signal with its reason and then drops its listeners', async () => {
    const { anySignal, timeoutSignal } = require('../../core/lib/signals');
    const a = new AbortController();
    const b = new AbortController();
    const combined = anySignal([a.signal, null, b.signal]);
    assert.equal(getEventListeners(a.signal, 'abort').length, 1);
    b.abort('weg');
    assert.equal(combined.aborted, true);
    assert.equal(combined.reason, 'weg');
    assert.equal(getEventListeners(a.signal, 'abort').length, 0, 'no listener left on the signal that stayed open');
    a.abort('später');
    assert.equal(combined.reason, 'weg');

    const done = new AbortController();
    done.abort('schon');
    assert.equal(anySignal([new AbortController().signal, done.signal]).reason, 'schon');
    const only = new AbortController().signal;
    assert.equal(anySignal([only, undefined]), only);

    const open = new AbortController();
    const withTimeout = anySignal([open.signal, timeoutSignal(20)]);
    await once(withTimeout, 'abort');
    assert.equal(withTimeout.reason.name, 'TimeoutError');
    assert.equal(getEventListeners(open.signal, 'abort').length, 0);
});

test('a client timeout still works where AbortSignal.any and AbortSignal.timeout are missing (iOS 14/15)', async (t) => {
    const client = require('../../core/mangaPassion/client');
    t.mock.method(AbortSignal, 'any', () => { throw new TypeError('AbortSignal.any is not a function'); });
    t.mock.method(AbortSignal, 'timeout', () => { throw new TypeError('AbortSignal.timeout is not a function'); });
    const conn = memoryDb();
    const http = {
        fetch: (url, init) => new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason));
        })
    };
    const ctx = createCtx({ db: dbFromConnection(conn), http });
    const started = Date.now();
    const result = await client.searchMangaPassionEditions(ctx, 'Berserk', '', null, { requestTimeoutMs: 30, deadlineMs: 200 });
    assert.equal(result.unavailable, true);
    assert.ok(Date.now() - started < 2000);
    conn.close();
});

test('bulk undo store: 10 minutes, 20 per user, one store per database, gone after a restore', async () => {
    const { createMemoryCore } = require('./harness');
    let clock = Date.parse('2026-10-04T10:00:00Z');
    const core = createMemoryCore({ now: () => new Date(clock) });
    const ed = core.client('ed');
    const series = (await ed('POST', '/mangas', { title: 'Undo Uhr' })).body.id;
    const vid = (await ed('POST', '/volumes', { manga_id: series, volume_number: '1', status: 'Fehlt' })).body.id;
    const edit = async () => (await ed('POST', '/volumes/bulk', { ids: [vid], set: { priority: 1 } })).body;
    const revert = (token) => ed('POST', '/volumes/bulk', { revert: token });

    const first = await edit();
    assert.equal(first.undo_expires_at, '2026-10-04T10:10:00.000Z');
    clock += 10 * 60 * 1000 - 1;
    const late = await edit();
    clock += 1;
    assert.deepEqual([(await revert(first.undo_token)).status, (await revert(first.undo_token)).body.code], [410, 'BULK_UNDO_EXPIRED']);
    assert.equal((await revert(late.undo_token)).status, 200);

    const tokens = [];
    for (let i = 0; i < 21; i++) tokens.push((await edit()).undo_token);
    assert.equal((await revert(tokens[0])).status, 410, 'the 21st undo pushes out the oldest of that user');
    assert.equal((await revert(tokens[1])).status, 200);
    assert.equal(core.ctx.undo.size, 19);

    const other = createMemoryCore();
    assert.equal((await other.client('ed')('POST', '/volumes/bulk', { revert: tokens[2] })).status, 410, 'another database knows no token');
    await other.close();

    const generation = core.ctx.db.generation;
    core.ctx.db.generation = () => 2;
    assert.equal((await revert(tokens[2])).status, 410, 'a restored database drops the undo data');
    core.ctx.db.generation = generation;
    await core.close();
});
