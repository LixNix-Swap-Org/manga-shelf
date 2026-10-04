// Weak ETag / 304 handling of the data endpoints and when the tag changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let ctx;
let admin;
let editor;
let mangaId;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'ed', password: 'password123', role: 'editor' })).status, 200);
    editor = ctx.client();
    assert.equal((await editor('POST', '/auth/login', { username: 'ed', password: 'password123' })).status, 200);
    mangaId = (await admin('POST', '/mangas', { title: 'ETag Reihe' })).body.id;
    assert.equal((await admin('POST', '/volumes/batch', { manga_id: mangaId, from: 1, to: 3, status: 'Fehlt' })).status, 200);
});

test.after(async () => { await ctx.close(); });

const get = (client, route, etag) => fetch(ctx.base + route, {
    headers: { Cookie: client.cookie, ...(etag ? { 'If-None-Match': etag } : {}) }
});

const ENDPOINTS = ['/mangas', () => `/mangas/${mangaId}`, '/offline-snapshot', '/stats', '/shopping-list', '/shopping-list?include_others=1', '/release-radar', '/dashboard-summary'];
const routeOf = (e) => (typeof e === 'function' ? e() : e);

test('every data endpoint sends a weak ETag and answers 304 with an empty body while nothing changed', async () => {
    for (const endpoint of ENDPOINTS) {
        const route = routeOf(endpoint);
        const first = await get(admin, route);
        assert.equal(first.status, 200, route);
        const etag = first.headers.get('etag');
        assert.match(etag, /^W\/".+"$/, route);
        assert.equal(first.headers.get('cache-control'), route === '/offline-snapshot' ? 'private, no-store' : 'private, no-cache', route);
        await first.arrayBuffer();

        const again = await get(admin, route, etag);
        assert.equal(again.status, 304, route);
        assert.equal(again.headers.get('etag'), etag, route);
        assert.equal(await again.text(), '', route);
        assert.equal((await get(admin, route, `"other", ${etag}`)).status, 304, `${route}: list form`);
    }
});

test('a 304 skips the handler: the list and snapshot builders are not called', async (t) => {
    const snapshot = require('../core/snapshot');
    const list = t.mock.method(snapshot, 'listMangas');
    const offline = t.mock.method(snapshot, 'buildOfflineSnapshot');
    const detail = t.mock.method(snapshot, 'loadMangaDetail');
    for (const [route, spy] of [['/mangas', list], ['/offline-snapshot', offline], [`/mangas/${mangaId}`, detail]]) {
        const first = await get(admin, route);
        assert.equal(first.status, 200);
        await first.arrayBuffer();
        assert.equal(spy.mock.callCount(), 1, route);
        assert.equal((await get(admin, route, first.headers.get('etag'))).status, 304);
        assert.equal(spy.mock.callCount(), 1, `${route}: no second build`);
    }
});

test('a write, another user, another query or a restore changes the tag', async () => {
    const tag = async (client, route) => {
        const res = await get(client, route);
        await res.arrayBuffer();
        return res.headers.get('etag');
    };
    const before = await tag(admin, '/mangas');
    assert.equal(await tag(admin, '/mangas'), before);
    assert.notEqual(await tag(editor, '/mangas'), before, 'per user');
    assert.notEqual(await tag(admin, '/shopping-list?include_others=1'), await tag(admin, '/shopping-list'), 'per query');

    const volumes = (await admin('GET', `/mangas/${mangaId}`)).body.volumes;
    assert.equal((await admin('PUT', `/volumes/${volumes[0].id}`, { status: 'Vorhanden' })).status, 200);
    const afterWrite = await tag(admin, '/mangas');
    assert.notEqual(afterWrite, before);
    const stale = await get(admin, '/mangas', before);
    assert.equal(stale.status, 200);
    assert.ok((await stale.json()).some(m => m.id === mangaId && m.owned_volumes === 1));

    require('../db').initDb();
    assert.notEqual(await tag(admin, '/mangas'), afterWrite, 'a reopened database (restore) gets a new tag');
});

test('the tag check runs after the login check: no session, no 304', async () => {
    const first = await get(admin, '/mangas');
    await first.arrayBuffer();
    const anonymous = await fetch(ctx.base + '/mangas', { headers: { 'If-None-Match': first.headers.get('etag') } });
    assert.equal(anonymous.status, 401);
});

test('dashboard-summary: the badge numbers equal those of the shopping list and the radar', async () => {
    const m = (await admin('POST', '/mangas', { title: 'Zähl Reihe' })).body.id;
    const next = new Date().getFullYear() + 1;
    for (const [n, status, date] of [['1', 'Vorbestellt', `${next}-02-01`], ['2', 'Bestellt', null], ['3', 'Erscheint bald', `${next}-03`], ['4', 'Fehlt', `${next}-04-01`], ['5', 'Fehlt', '2001-01-01']]) {
        assert.equal((await admin('POST', '/volumes', { manga_id: m, volume_number: n, status, release_date: date })).status, 200);
    }
    const summary = (await admin('GET', '/dashboard-summary')).body;
    const shopping = (await admin('GET', '/shopping-list')).body;
    const radar = (await admin('GET', '/release-radar')).body;
    assert.deepEqual(summary, {
        total_missing: shopping.total_missing,
        total_releases: radar.total_releases,
        preordered_count: radar.preordered_count
    });
    assert.equal(summary.preordered_count, 2);
    assert.ok(summary.total_releases >= 4);
    assert.equal((await fetch(ctx.base + '/dashboard-summary')).status, 401);
});

test('offline snapshot: a restore during the build still answers 503 with its German message', async (t) => {
    const snapshot = require('../core/snapshot');
    t.mock.method(snapshot, 'buildOfflineSnapshot', async () => {
        const err = new Error('Die Datenbank wurde während der Offline-Kopie neu geöffnet. Bitte erneut versuchen.');
        err.status = 503;
        throw err;
    });
    const res = await get(admin, '/offline-snapshot');
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, 'Die Datenbank wurde während der Offline-Kopie neu geöffnet. Bitte erneut versuchen.');
    assert.equal(body.code, 'SERVICE_UNAVAILABLE');
    assert.equal(body.ref, res.headers.get('x-request-id'));
});

test('error answers of the data endpoints carry no ETag and are not stored', async (t) => {
    const snapshot = require('../core/snapshot');
    const ok = await get(admin, '/mangas');
    await ok.arrayBuffer();
    const goodTag = ok.headers.get('etag');
    const busy = t.mock.method(snapshot, 'listMangas', () => { throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }); });
    const failed = await get(admin, '/mangas');
    assert.equal(failed.status, 500);
    assert.equal(failed.headers.get('etag'), null);
    assert.equal(failed.headers.get('cache-control'), 'no-store');
    assert.equal((await failed.json()).code, 'INTERNAL_ERROR');
    busy.mock.restore();
    const missing = await get(admin, '/mangas/987654');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('etag'), null);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
    assert.equal((await get(admin, '/mangas', goodTag)).status, 304, 'the success tag still revalidates');
});

test('the day part of the tag turns with the app zone, the server zone and UTC', () => {
    const { dataEtag } = require('../utils/dataVersion');
    const req = { originalUrl: '/api/stats', user: { id: 1, role: 'admin' } };
    // 00:30 in Berlin on both sides, but /stats collection_days counts from UTC midnight
    assert.notEqual(dataEtag(req, new Date('2026-10-03T22:30:00Z')), dataEtag(req, new Date('2026-10-04T00:30:00Z')));
    assert.equal(dataEtag(req, new Date('2026-10-04T08:00:00Z')), dataEtag(req, new Date('2026-10-04T09:00:00Z')));
    assert.match(dataEtag(req, new Date('2026-10-04T00:30:00Z')), /\.20261004(-\d{8})*\./);
});
