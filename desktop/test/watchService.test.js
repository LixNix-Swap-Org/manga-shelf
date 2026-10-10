// Covers the desktop watch service: one run at a time, the 30 s token gap, the secret file and the answer codes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createWatchService } = require('../lib/watchService');
const { createWatchSecret } = require('../lib/watchSecret');
const { crunchyroll, createFlow, FlowError, SECRET, NEW_LOGIN, answer, tempDir, fakeSafeStorage, fakeTransport, fakeApiSession } = require('./watchFakes');

function setup(t, { secret = SECRET, foreground = true } = {}) {
    const dir = tempDir(t);
    const safe = fakeSafeStorage();
    const store = createWatchSecret({ file: path.join(dir, 'watch-secret.json'), safeStorage: safe, platform: 'darwin' });
    if (secret) store.write(secret);
    const transport = fakeTransport();
    const apiSession = fakeApiSession();
    const clock = { now: 5_000_000 };
    const h = { dir, safe, store, transport, apiSession, clock, foreground };
    h.service = createWatchService({
        createFlow, FlowError, crunchyroll, secret: store, transport: transport.send, apiSession,
        randomUUID: () => '99999999-8888-4777-8666-555555555555', now: () => clock.now, isForeground: () => h.foreground
    });
    h.saved = () => (fs.existsSync(store.file) ? store.read() : null);
    return h;
}

test('two parallel sync() calls make one token request and get the same answer', async (t) => {
    const h = setup(t);
    const [a, b] = await Promise.all([h.service.sync({ force: false }), h.service.sync({ force: true })]);
    assert.equal(h.transport.tokenCalls(), 1);
    assert.equal(a, b);
    assert.equal(a.ok, true);
    assert.ok(Array.isArray(a.items) && a.items.length > 0);
    assert.equal(h.apiSession.closed, 1);
    assert.equal(h.apiSession.cleared, 1);
});

test('a refresh during a run joins it; afterwards the 30 s gap answers too_soon without a request', async (t) => {
    const h = setup(t);
    const gate = h.transport.hold('token');
    const first = h.service.sync({ force: false });
    await gate.reached;
    const refresh = h.service.sync({ force: true });
    assert.equal(refresh, first);
    gate.release();
    assert.equal((await refresh).ok, true);
    assert.equal(h.transport.tokenCalls(), 1);

    h.clock.now += 10_400;
    assert.deepEqual(await h.service.sync({ force: true }), { ok: false, code: 'too_soon', retryIn: 20 });
    h.clock.now += 19_000;
    assert.deepEqual(await h.service.sync({ force: true }), { ok: false, code: 'too_soon', retryIn: 1 });
    assert.equal(h.transport.tokenCalls(), 1);
    h.clock.now += 600;
    assert.equal((await h.service.sync({ force: false })).ok, true);
    assert.equal(h.transport.tokenCalls(), 2);
});

test('hidden or minimized: background before anything else', async (t) => {
    const h = setup(t);
    h.foreground = false;
    assert.deepEqual(await h.service.sync({}), { ok: false, code: 'background' });
    assert.equal(h.transport.requests.length, 0);
    assert.equal(h.apiSession.closed, 0);
});

test('logout() during an in-flight sync() leaves no watch-secret.json', async (t) => {
    const h = setup(t);
    const gate = h.transport.hold('token');
    const run = h.service.sync({});
    await gate.reached;
    assert.deepEqual(await h.service.logout(), { ok: true });
    assert.equal(fs.existsSync(h.store.file), false);
    gate.release();
    assert.deepEqual(await run, { ok: false, code: 'stale' });
    assert.equal(fs.existsSync(h.store.file), false);
    assert.deepEqual(h.service.status(), { ok: true, available: true, connected: false });
});

test('a login that completes during a sync whose token grant then answers 401 keeps the new secret', async (t) => {
    const h = setup(t);
    const gate = h.transport.hold('token');
    const run = h.service.sync({});
    await gate.reached;
    await h.service.connect({ etpRt: NEW_LOGIN, scriptResult: null, isCancelled: () => false });
    gate.release(answer(401, '{}'));
    assert.deepEqual(await run, { ok: false, code: 'stale' });
    assert.equal(h.saved().etp_rt, NEW_LOGIN);
    assert.equal(h.saved().device_id, SECRET.device_id);
});

test('401 without a race: reconnect, and the file is already gone', async (t) => {
    const h = setup(t);
    h.transport.answers.token = () => answer(401, '{}');
    assert.deepEqual(await h.service.sync({}), { ok: false, code: 'reconnect' });
    assert.equal(fs.existsSync(h.store.file), false);
});

test('codes: not_connected without a file, network for a failed request, locked and unreadable from the store', async (t) => {
    const empty = setup(t, { secret: null });
    assert.deepEqual(await empty.service.sync({}), { ok: false, code: 'not_connected' });
    assert.equal(empty.transport.requests.length, 0);

    const offline = setup(t);
    offline.transport.answers.token = () => { throw Object.assign(new Error('network'), { code: 'network' }); };
    assert.deepEqual(await offline.service.sync({}), { ok: false, code: 'network' });

    const locked = setup(t);
    locked.safe.available = false;
    assert.deepEqual(await locked.service.sync({}), { ok: false, code: 'locked' });
    assert.deepEqual(locked.service.status(), { ok: true, available: false, reason: 'locked', connected: true });
    assert.deepEqual(await locked.service.logout(), { ok: true });
    assert.equal(fs.existsSync(locked.store.file), false);
    assert.deepEqual(locked.service.status(), { ok: true, available: false, reason: 'unavailable', connected: false });

    const unreadable = setup(t);
    unreadable.safe.decryptThrows = true;
    assert.deepEqual(await unreadable.service.sync({}), { ok: false, code: 'unreadable' });
    assert.deepEqual(unreadable.service.status(), { ok: true, available: false, reason: 'unreadable', connected: true });
    assert.equal(unreadable.transport.requests.length, 0);

    const encrypt = setup(t);
    encrypt.safe.encryptThrows = true;
    assert.deepEqual(await encrypt.service.sync({}), { ok: false, code: 'unreadable' });
});

test('status: connected only with a usable secret', async (t) => {
    const h = setup(t);
    assert.deepEqual(h.service.status(), { ok: true, available: true, connected: true });
    h.store.write({ etp_rt: 'kurz' });
    assert.deepEqual(h.service.status(), { ok: true, available: true, connected: false });
});
