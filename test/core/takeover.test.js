// Takeover paths of the standalone mode (spec-standalone §4, §6): the app's ZIP restores on a fresh server and a
// server backup restores in the app; the non-admin pull goes through the offline snapshot; the CSV merge is idempotent.
// Uses the frontend modules (frontend/src/local, frontend/src/app/takeover.js) with sql.js and fflate from frontend/.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startTestServer } = require('../helpers');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
function frontendDeps() {
    try {
        require.resolve('sql.js', { paths: [FRONTEND] });
        require.resolve('fflate', { paths: [FRONTEND] });
        require.resolve('bcryptjs', { paths: [FRONTEND] });
        return true;
    } catch (e) {
        return false;
    }
}
const READY = frontendDeps();
const PASSWORD = 'password123';
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

const load = (rel) => import(pathToFileURL(path.join(FRONTEND, 'src', rel)).href);
const offlineHttp = {
    fetch: async (url) => { throw new TypeError(`offline: ${url}`); },
    fetchText: async (url) => { throw new Error(`offline: ${url}`); },
    fetchImage: async (url) => { throw new Error(`offline: ${url}`); }
};

let server;
let mods;
let SQL;

async function newRuntime(name) {
    const { createLocalRuntime } = mods.runtime;
    return createLocalRuntime({ SQL, store: mods.store.memoryStore(), http: offlineHttp, profile: { name }, persistDelayMs: 0 });
}

async function local(rt, method, url, body) {
    const res = await rt.request(method, url, body);
    assert.ok(res.status < 300, `${method} ${url}: ${JSON.stringify(res.body)}`);
    return res.body;
}

const bearer = (session) => ({ Authorization: `Bearer ${session.token}`, 'X-Client': 'app' });
async function remote(session, url) {
    const res = await fetch(`${session.base}/api${url}`, { headers: bearer(session) });
    return { status: res.status, body: await res.json().catch(() => null) };
}

test.before(async () => {
    if (!READY) return;
    server = await startTestServer();
    const admin = server.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: PASSWORD })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'kim', password: PASSWORD, role: 'editor' })).status, 200);
    mods = {
        runtime: await load('local/runtime.js'),
        store: await load('local/store.js'),
        takeover: await load('app/takeover.js'),
        zip: await load('local/backupZip.js')
    };
    SQL = await require(require.resolve('sql.js', { paths: [FRONTEND] }))();
});

test.after(async () => {
    if (server) await server.close();
});

const opts = { skip: READY ? false : 'Frontend-Abhängigkeiten fehlen (cd frontend && npm install)' };

test('the app ZIP restores on a fresh server, the local profile becomes the admin account', opts, async () => {
    const { remoteLogin, inspectTransfer, finishTransfer, serverHasData } = mods.takeover;
    const rt = await newRuntime('Felix');
    const form = new FormData();
    form.append('image', new Blob([PNG], { type: 'image/png' }), 'cover.png');
    const { url } = await local(rt, 'POST', '/api/upload', form);
    const id = (await local(rt, 'POST', '/api/mangas', { title: 'Lokale Reihe', cover_image: url })).id;
    await local(rt, 'POST', '/api/volumes/batch', { manga_id: id, from: 1, to: 3, status: 'Vorhanden' });
    const vol = (await local(rt, 'GET', `/api/mangas/${id}`)).volumes[0].id;
    await local(rt, 'POST', `/api/volumes/${vol}/read`, {});

    const session = await remoteLogin({ url: server.root, username: 'admin', password: PASSWORD });
    const inspect = await inspectTransfer(session, rt, { password: PASSWORD });
    assert.deepEqual([inspect.counts.mangas, inspect.counts.volumes, inspect.counts.uploads], [1, 3, 1]);
    assert.equal(inspect.relogin, false);
    // the editor kim counts as data: the server is not fresh
    assert.equal(serverHasData(inspect), true);
    assert.equal(serverHasData({ current_counts: { mangas: 0, volumes: 0, users: 1 } }), false);

    const done = await finishTransfer(session, inspect.staging_id, { username: 'admin', password: PASSWORD });
    assert.equal(done.result.success, true);
    const list = await remote(done.session, '/mangas');
    assert.deepEqual(list.body.map((m) => m.title), ['Lokale Reihe']);
    const detail = (await remote(done.session, `/mangas/${list.body[0].id}`)).body;
    assert.deepEqual(detail.volumes[0].read_by, [done.session.user.id]);
    assert.equal(done.session.user.username, 'admin');
    assert.equal((await fetch(server.root + detail.cover_image)).status, 200);
    // the local database itself is unchanged
    assert.equal(rt.getProfile().username, 'Felix');
    await rt.close();
});

test('a server backup restores in the app, covers included', opts, async () => {
    const { remoteLogin, pullFromServer } = mods.takeover;
    const session = await remoteLogin({ url: server.root, username: 'admin', password: PASSWORD });
    const rt = await newRuntime('Neu');
    const result = await pullFromServer(session, rt);
    assert.equal(result.kind, 'backup');
    assert.equal(result.profile.username, 'admin');
    assert.equal(result.counts.mangas, 1);
    const [manga] = await local(rt, 'GET', '/api/mangas');
    assert.equal(manga.title, 'Lokale Reihe');
    const name = manga.cover_image.slice('/uploads/'.length);
    assert.deepEqual(await rt.files.read(name), PNG);
    // the restored collection takes the app's own ZIP layout again
    const zip = mods.zip.readBackupZip(await mods.zip.buildBackupZip(rt));
    assert.equal(zip.manifest.counts.mangas, 1);
    assert.equal(zip.uploads.size, 1);
    await rt.close();
});

test('a non-admin pulls the offline snapshot: series, volumes and only the own ownership', opts, async () => {
    const { remoteLogin, pullFromServer } = mods.takeover;
    const admin = await remoteLogin({ url: server.root, username: 'admin', password: PASSWORD });
    const res = await fetch(`${admin.base}/api/users`, {
        method: 'POST', headers: { ...bearer(admin), 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'lea', password: PASSWORD, role: 'editor' })
    });
    assert.equal(res.status, 200);
    const lea = await remoteLogin({ url: server.root, username: 'lea', password: PASSWORD });
    const [manga] = (await remote(lea, '/mangas')).body;
    const detail = (await remote(lea, `/mangas/${manga.id}`)).body;
    await fetch(`${lea.base}/api/volumes/${detail.volumes[1].id}/owners`, {
        method: 'POST', headers: { ...bearer(lea), 'Content-Type': 'application/json' }, body: JSON.stringify({ owned: true })
    });

    const rt = await newRuntime('Lea');
    const result = await pullFromServer(lea, rt);
    assert.equal(result.kind, 'snapshot');
    assert.equal(result.profile.username, 'lea');
    const copy = await local(rt, 'GET', `/api/mangas/${manga.id}`);
    assert.equal(copy.volumes.length, 3);
    assert.deepEqual(copy.volumes.map((v) => v.owners.map((o) => o.username)), [[], ['lea'], []]);
    assert.equal(copy.cover_image, detail.cover_image);
    assert.ok(await rt.files.read(copy.cover_image.slice('/uploads/'.length)), 'cover loaded');
    await rt.close();
});

test('the CSV merge into an existing server is idempotent', opts, async () => {
    const { remoteLogin, mergeCsv } = mods.takeover;
    const rt = await newRuntime('Lea');
    const id = (await local(rt, 'POST', '/api/mangas', { title: 'Zusammengeführt', publisher: 'Carlsen' })).id;
    await local(rt, 'POST', '/api/volumes/batch', { manga_id: id, from: 1, to: 2, status: 'Vorhanden' });
    // kim left with the restore of the first test; lea was added after it
    const lea = await remoteLogin({ url: server.root, username: 'lea', password: PASSWORD });

    const preview = await mergeCsv(lea, rt, { dryRun: true });
    assert.deepEqual([preview.dry_run, preview.created_series, preview.created_volumes], [true, 1, 2]);
    assert.equal((await remote(lea, '/mangas')).body.some((m) => m.title === 'Zusammengeführt'), false);
    const first = await mergeCsv(lea, rt, { dryRun: false });
    assert.deepEqual([first.created_series, first.created_volumes], [1, 2]);
    const again = await mergeCsv(lea, rt, { dryRun: false });
    assert.deepEqual([again.created_series, again.created_volumes, again.skipped_existing], [0, 0, 2]);
    const merged = (await remote(lea, '/mangas')).body.filter((m) => m.title === 'Zusammengeführt');
    assert.equal(merged.length, 1);
    await rt.close();
});

test('an insecure server address is refused before any request', opts, async () => {
    const { remoteLogin } = mods.takeover;
    await assert.rejects(remoteLogin({ url: 'http://example.org', username: 'a', password: 'b', fetchImpl: () => assert.fail('no request') }), /Heimnetz/);
});
