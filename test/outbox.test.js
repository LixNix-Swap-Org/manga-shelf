const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

// The frontend outbox (ESM): its pure parts and createOutbox over an in-memory storage and a stubbed sender.
const src = (...parts) => pathToFileURL(path.join(__dirname, '..', 'frontend', 'src', ...parts)).href;
const load = () => import(src('utils', 'outbox.js'));

function memoryStore(initial = []) {
    const rows = new Map(initial.map((e) => [e.key, e]));
    return {
        rows,
        failPut: false,
        async load() { return [...rows.values()].map((e) => structuredClone(e)); },
        async put(entries) {
            if (this.failPut) throw new Error('quota');
            for (const e of entries) rows.set(e.key, structuredClone(e));
        },
        async delete(keys) { for (const k of keys) rows.delete(k); }
    };
}

/** Like the IndexedDB store: settled entries only change the row that still holds them. */
function sharedStore() {
    const store = memoryStore();
    store.update = async (entries) => {
        for (const e of entries) if (store.rows.get(e.key)?.id === e.id) store.rows.set(e.key, structuredClone(e));
    };
    store.remove = async (entries) => {
        for (const e of entries) if (store.rows.get(e.key)?.id === e.id) store.rows.delete(e.key);
    };
    return store;
}

function memoryStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        map,
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        removeItem: (k) => { map.delete(k); }
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const response = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const scope = { userId: 1, serverId: 'web' };
const change = (volumeId, extra = {}) => ({ kind: 'read', volumeId, userId: 1, serverId: 'web', value: true, ...extra });

test('normalizeOutboxEntry validates and fills an entry; the key coalesces owned and purchase', async () => {
    const { normalizeOutboxEntry, outboxKey } = await load();
    const e = normalizeOutboxEntry({ kind: 'purchase', volumeId: '7', userId: 1, serverId: 'web', value: false, purchase_date: '2026-10-01' }, { now: 5 });
    assert.equal(e.value, true, 'a purchase always owns');
    assert.equal(e.volumeId, 7);
    assert.equal(e.targetUserId, 1);
    assert.equal(e.purchase_date, '2026-10-01');
    assert.equal(e.ts, 5);
    assert.equal(e.key, 'web|1|owned|7|1');
    assert.equal(outboxKey({ ...e, kind: 'owned' }), e.key);
    for (const bad of [null, { kind: 'delete', volumeId: 1, userId: 1, serverId: 'web' }, { kind: 'read', volumeId: 0, userId: 1, serverId: 'web' },
        { kind: 'read', volumeId: 1, serverId: 'web' }, { kind: 'read', volumeId: 1, userId: 1 }, { kind: 'status', volumeId: 1, userId: 1, serverId: 'web', value: ' ' }]) {
        assert.equal(normalizeOutboxEntry(bad), null, JSON.stringify(bad));
    }
    assert.equal(normalizeOutboxEntry({ ...change(1), purchase_date: '2026-10-01' }).purchase_date, undefined);
    assert.equal(normalizeOutboxEntry({ ...change(1), read_at: '2026-01-02 10:00:00' }).read_at, '2026-01-02 10:00:00');
    assert.equal(normalizeOutboxEntry({ ...change(1), value: false, read_at: '2026-01-02 10:00:00' }).read_at, undefined);
    assert.equal(normalizeOutboxEntry({ ...change(1), read_at: 'gestern' }).read_at, undefined);
});

test('coalesceEntries: a later toggle of the same volume and person replaces the earlier one', async () => {
    const { normalizeOutboxEntry, coalesceEntries } = await load();
    const a = normalizeOutboxEntry({ ...change(1), ts: 1 });
    const b = normalizeOutboxEntry({ ...change(2), ts: 2 });
    const c = normalizeOutboxEntry({ ...change(1), value: false, ts: 3 });
    const other = normalizeOutboxEntry({ ...change(1), targetUserId: 5, ts: 4 });
    const list = [a, b, c, other].reduce(coalesceEntries, []);
    assert.deepEqual(list.map((e) => [e.volumeId, e.value, e.targetUserId]), [[2, true, 1], [1, false, 1], [1, true, 5]]);
});

test('outboxRequest: idempotent set requests per kind', async () => {
    const { normalizeOutboxEntry, outboxRequest } = await load();
    const req = (raw) => outboxRequest(normalizeOutboxEntry({ userId: 1, serverId: 'web', ...raw }));
    assert.deepEqual(req({ kind: 'read', volumeId: 3, value: false }), { path: '/api/volumes/3/read', method: 'POST', body: { user_id: 1, read: false, is_read: false } });
    assert.deepEqual(req({ kind: 'read', volumeId: 3, value: true, targetUserId: 4, read_at: '2026-01-02 10:00:00' }).body,
        { user_id: 4, read: true, is_read: true, read_at: '2026-01-02 10:00:00' });
    assert.deepEqual(req({ kind: 'purchase', volumeId: 3, purchase_date: '2026-10-01' }), { path: '/api/volumes/3/owners', method: 'POST', body: { owned: true, purchase_date: '2026-10-01' } });
    assert.deepEqual(req({ kind: 'owned', volumeId: 3, value: false, purchase_date: '2026-10-01' }).body, { owned: false });
    assert.deepEqual(req({ kind: 'owned', volumeId: 3, value: true, targetUserId: 9 }).body, { owned: true, user_id: 9 });
    assert.deepEqual(req({ kind: 'status', volumeId: 3, value: 'Fehlt' }), { path: '/api/volumes/3', method: 'PUT', body: { status: 'Fehlt' } });
});

test('classifyOutboxResponse and retryDelay', async () => {
    const { classifyOutboxResponse, retryDelay } = await load();
    assert.equal(classifyOutboxResponse(null), 'retry');
    for (const s of [200, 204, 404]) assert.equal(classifyOutboxResponse(response(s)), 'done', String(s));
    assert.equal(classifyOutboxResponse(response(401)), 'auth');
    for (const s of [408, 429, 500, 502, 503, 504, 522]) assert.equal(classifyOutboxResponse(response(s)), 'retry', String(s));
    for (const s of [400, 403, 409, 413]) assert.equal(classifyOutboxResponse(response(s)), 'drop', String(s));
    assert.equal(retryDelay(1), 5000);
    assert.equal(retryDelay(2), 10000);
    assert.equal(retryDelay(20), 5 * 60 * 1000);
});

test('flush: 2xx and 404 leave, 400/403 are dropped, a 503 stays with a backoff and stops the run', async () => {
    const { createOutbox } = await load();
    const statuses = { 1: 200, 2: 404, 3: 403, 4: 503, 5: 200 };
    const sent = [];
    let clock = 1000;
    const store = memoryStore();
    const outbox = createOutbox({ storage: store, now: () => clock++, send: async (e) => { sent.push(e.volumeId); return response(statuses[e.volumeId]); } });
    for (const id of [1, 2, 3, 4, 5]) await outbox.add(change(id));
    const result = await outbox.flush(scope);
    assert.deepEqual(sent, [1, 2, 3, 4]);
    assert.deepEqual(result.synced.map((e) => e.volumeId), [1, 2]);
    assert.deepEqual(result.dropped.map((e) => [e.volumeId, e.status]), [[3, 403]]);
    assert.deepEqual(result.kept.map((e) => e.volumeId), [4]);
    const left = outbox.list(scope);
    assert.deepEqual(left.map((e) => e.volumeId), [4, 5]);
    assert.equal(left[0].attempts, 1);
    assert.equal(left[0].deferred, true);
    assert.ok(left[0].nextAt > clock);
    assert.deepEqual([...store.rows.values()].map((e) => e.volumeId).sort(), [4, 5]);

    // within the backoff a plain flush leaves volume 4 waiting and sends the others; a forced one (user action) sends it
    const plain = await outbox.flush(scope);
    assert.deepEqual(plain.synced.map((e) => e.volumeId), [5]);
    assert.deepEqual(plain.kept.map((e) => e.volumeId), [4]);
    statuses[4] = 200;
    const forced = await outbox.flush(scope, { force: true });
    assert.deepEqual(forced.synced.map((e) => e.volumeId), [4]);
    assert.deepEqual(outbox.list(scope), []);
});

test('flush: a 500 of one change holds back only the later changes of that volume', async () => {
    const { createOutbox } = await load();
    const sent = [];
    const outbox = createOutbox({ storage: memoryStore(), send: async (e) => { sent.push([e.kind, e.volumeId]); return response(e.volumeId === 1 && e.kind === 'read' ? 500 : 200); } });
    await outbox.add(change(1));
    await outbox.add({ kind: 'status', volumeId: 1, userId: 1, serverId: 'web', value: 'Fehlt' });
    await outbox.add(change(2));
    const result = await outbox.flush(scope);
    assert.deepEqual(sent, [['read', 1], ['read', 2]]);
    assert.deepEqual(result.kept.map((e) => [e.kind, e.volumeId]), [['read', 1], ['status', 1]]);
    assert.deepEqual(outbox.list(scope).map((e) => e.kind), ['read', 'status']);
    // within the backoff a plain flush leaves volume 1 alone
    assert.deepEqual((await outbox.flush(scope)).items, []);
});

test('flush: a 401 keeps the entry for the next login; a network error stops the run', async () => {
    const { createOutbox } = await load();
    let mode = '401';
    const sent = [];
    const outbox = createOutbox({
        storage: memoryStore(),
        send: async (e) => {
            sent.push(e.volumeId);
            if (mode === 'net') throw new TypeError('Failed to fetch');
            return response(401);
        }
    });
    await outbox.add(change(1));
    await outbox.add(change(2));
    const auth = await outbox.flush(scope);
    assert.equal(auth.unauthorized, true);
    assert.deepEqual(sent, [1]);
    assert.equal(outbox.count(scope), 2);
    assert.equal(outbox.list(scope)[0].nextAt, undefined, 'no backoff for a 401');
    mode = 'net';
    const net = await outbox.flush(scope);
    assert.equal(net.unauthorized, false);
    assert.deepEqual(sent, [1, 1]);
    assert.equal(outbox.count(scope), 2);
});

test('flush: a change made while a request hangs is sent in the same flush; a newer toggle survives an old answer', async () => {
    const { createOutbox } = await load();
    const gates = new Map();
    const sent = [];
    const outbox = createOutbox({
        storage: memoryStore(),
        send: (e) => { sent.push([e.volumeId, e.value]); const d = deferred(); gates.set(`${e.volumeId}:${e.value}`, d); return d.promise; }
    });
    await outbox.add(change(1));
    const running = outbox.flush(scope);
    await new Promise((r) => setImmediate(r));
    assert.equal(outbox.flush(scope), running, 'concurrent calls share one run');
    await outbox.add(change(2));
    await outbox.add(change(1, { value: false }));
    gates.get('1:true').resolve(response(200));
    await new Promise((r) => setImmediate(r));
    gates.get('2:true').resolve(response(200));
    await new Promise((r) => setImmediate(r));
    gates.get('1:false').resolve(response(200));
    const result = await running;
    assert.deepEqual(sent, [[1, true], [2, true], [1, false]]);
    assert.equal(result.synced.length, 3);
    assert.deepEqual(outbox.list(scope), []);
});

test('flush: the newer toggle is kept when the older request of the same key fails', async () => {
    const { createOutbox } = await load();
    const gate = deferred();
    const outbox = createOutbox({ storage: memoryStore(), send: (e) => (e.value ? gate.promise : Promise.resolve(response(503))) });
    await outbox.add(change(1));
    const running = outbox.flush(scope);
    await new Promise((r) => setImmediate(r));
    const { entry: newer } = await outbox.add(change(1, { value: false }));
    gate.resolve(response(400));
    const result = await running;
    assert.deepEqual(result.dropped.map((e) => e.value), [true]);
    assert.deepEqual(outbox.list(scope).map((e) => [e.id, e.value, e.attempts]), [[newer.id, false, 1]]);
});

test("flush: another user's or another server's entries are neither sent nor removed", async () => {
    const { createOutbox } = await load();
    const sent = [];
    const outbox = createOutbox({ storage: memoryStore(), send: async (e) => { sent.push(e.volumeId); return response(200); } });
    await outbox.add(change(1, { userId: 2 }));
    await outbox.add(change(2, { serverId: 'srv-b' }));
    await outbox.add(change(3));
    await outbox.flush(scope);
    assert.deepEqual(sent, [3]);
    assert.equal(outbox.count({ userId: 2, serverId: 'web' }), 1);
    assert.equal(outbox.count({ userId: 1, serverId: 'srv-b' }), 1);
    assert.equal(await outbox.dropServer('srv-b'), 1);
    assert.equal(outbox.count({ userId: 1, serverId: 'srv-b' }), 0);
    assert.deepEqual((await outbox.flush({ userId: null, serverId: 'web' })).items, []);
});

test('the outbox survives a reload: entries come back from the storage in time order', async () => {
    const { createOutbox } = await load();
    const store = memoryStore();
    let clock = 1;
    const first = createOutbox({ storage: store, now: () => clock++, send: async () => null });
    await first.add(change(2));
    await first.add(change(1));
    const second = createOutbox({ storage: store, send: async () => null });
    await second.load();
    assert.deepEqual(second.list(scope).map((e) => e.volumeId), [2, 1]);
});

test('migrateLegacy moves the old purchase queue of the user once and keeps newer outbox changes', async () => {
    const { createOutbox } = await load();
    const { queueKey } = await import(src('utils', 'shoppingQueue.js'));
    const storage = memoryStorage({
        [queueKey(1)]: JSON.stringify([{ volumeId: 4, purchasedAt: '2026-10-01' }, { volumeId: 5 }]),
        [queueKey(2)]: JSON.stringify([{ volumeId: 6 }])
    });
    const outbox = createOutbox({ storage: memoryStore(), send: async () => response(200) });
    await outbox.add({ kind: 'owned', volumeId: 5, userId: 1, serverId: 'web', value: false });
    assert.equal(await outbox.migrateLegacy(scope, storage), 1);
    assert.equal(storage.getItem(queueKey(1)), null);
    assert.ok(storage.getItem(queueKey(2)), "another user's queue stays");
    const list = outbox.list(scope);
    assert.deepEqual(list.map((e) => [e.kind, e.volumeId, e.value, e.purchase_date, e.deferred]), [
        ['owned', 5, false, undefined, false],
        ['purchase', 4, true, '2026-10-01', true]
    ]);
    assert.equal(await outbox.migrateLegacy(scope, storage), 0);
});

test('submitChange: sent, queued offline, refused, kept on 401, and dropped when it could not be stored', async () => {
    const { createOutbox, submitChange } = await load();
    let answer = () => response(200, { ok: 1 });
    const store = memoryStore();
    const outbox = createOutbox({ storage: store, send: async () => answer() });
    const submit = (c, opts = {}) => submitChange(c, { userId: 1, outbox, ...opts });

    const sent = await submit({ kind: 'read', volumeId: 1, value: true });
    assert.equal(sent.status, 'sent');
    assert.deepEqual(await sent.res.json(), { ok: 1 });

    const offline = await submit({ kind: 'read', volumeId: 2, value: true }, { offline: true });
    assert.equal(offline.status, 'queued');
    assert.equal(offline.entry.deferred, true);

    answer = () => response(409);
    const refused = await submit({ kind: 'status', volumeId: 3, value: 'Fehlt' });
    assert.equal(refused.status, 'failed');
    assert.equal(refused.res.status, 409);
    // the queued read of volume 2 was sent first in that flush and refused too
    assert.deepEqual(outbox.list(scope), []);

    answer = () => response(401);
    assert.equal((await submit({ kind: 'read', volumeId: 4, value: true })).status, 'auth');
    assert.equal(outbox.count(scope), 1);

    answer = () => { throw new TypeError('offline'); };
    store.failPut = true;
    const notStored = await submit({ kind: 'read', volumeId: 5, value: true });
    assert.deepEqual([notStored.status, notStored.reason], ['failed', 'storage']);
    assert.deepEqual(outbox.list(scope).map((e) => e.volumeId), [4]);
});

test('submitChange resolves as soon as its own request is answered, not when the whole flush ends', async () => {
    const { createOutbox, submitChange } = await load();
    const gates = new Map();
    const outbox = createOutbox({ storage: memoryStore(), send: (e) => { const d = deferred(); gates.set(e.volumeId, d); return d.promise; } });
    const first = submitChange({ kind: 'purchase', volumeId: 1 }, { userId: 1, outbox });
    const second = submitChange({ kind: 'purchase', volumeId: 2 }, { userId: 1, outbox });
    while (!gates.has(1)) await new Promise((r) => setImmediate(r));
    gates.get(1).resolve(response(200));
    assert.equal((await first).status, 'sent');
    while (!gates.has(2)) await new Promise((r) => setImmediate(r));
    gates.get(2).resolve(response(200));
    assert.equal((await second).status, 'sent');
});

test('reportFlush announces replayed changes only; immediate ones stay quiet', async () => {
    const { reportFlush, OUTBOX_SYNCED_EVENT } = await load();
    const { subscribe } = await import(src('utils', 'notify.js'));
    const shown = [];
    const stop = subscribe((e) => { if (e.type === 'show') shown.push([e.toast.kind, e.toast.message]); });
    const events = [];
    const target = { dispatchEvent: (e) => events.push([e.type, e.detail.synced.length, e.detail.dropped.length]) };
    reportFlush({ synced: [{ deferred: false }], dropped: [{ deferred: false }] }, target);
    assert.deepEqual(shown, []);
    assert.deepEqual(events, []);
    reportFlush({ synced: [{ deferred: true }, { deferred: true }, { deferred: false }], dropped: [{ deferred: true }] }, target);
    stop();
    assert.deepEqual(shown, [['success', '2 Änderungen übertragen'], ['error', '1 vorgemerkte Änderung vom Server abgelehnt']]);
    assert.deepEqual(events, [[OUTBOX_SYNCED_EVENT, 2, 1]]);
});

test('startOutboxSync replays after the start, on online, on visibility and on reconnect; stop removes the listeners', async () => {
    const { createOutbox, startOutboxSync } = await load();
    const sent = [];
    let online = true;
    const outbox = createOutbox({ storage: memoryStore(), send: async (e) => { sent.push(e.volumeId); return response(503); } });
    const listeners = {};
    const fakeTarget = () => ({
        addEventListener: (type, fn) => { listeners[type] = fn; },
        removeEventListener: (type) => { delete listeners[type]; }
    });
    const win = fakeTarget();
    const doc = { ...fakeTarget(), visibilityState: 'visible' };
    let reconnect = null;
    await outbox.add(change(1, { deferred: true }));
    const stop = startOutboxSync({
        userId: 1, outbox, win, doc, isOnline: () => online, legacyStorage: memoryStorage(), confirmUser: async () => 1,
        subscribe: (fn) => { reconnect = fn; return () => { reconnect = null; }; }
    });
    while (sent.length < 1) await new Promise((r) => setImmediate(r));
    // the 503 set a backoff: the triggers flush, but the entry waits
    listeners.online();
    listeners.visibilitychange();
    reconnect();
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 1);
    online = false;
    stop();
    assert.equal(listeners.online, undefined);
    assert.equal(listeners.visibilitychange, undefined);
    assert.equal(reconnect, null);
});

test('two tabs: a replay never sends or deletes the newer change another tab stored under the same key', async () => {
    const { createOutbox } = await load();
    const store = sharedStore();
    const sent = [];
    const send = async (e) => { sent.push(`${e.kind}:${e.value}`); return response(200); };
    let clock = 1;
    const tabA = createOutbox({ storage: store, send, now: () => clock++ });
    const tabB = createOutbox({ storage: store, send, now: () => clock++ });
    const owned = (value) => ({ kind: 'owned', volumeId: 5, userId: 1, serverId: 'web', value, deferred: true });
    await tabA.add(owned(true));
    await tabB.add(owned(false));
    assert.equal([...store.rows.values()][0].value, false);

    // tab A still holds its older value in memory; the replay reloads the scope first
    await tabA.flush(scope);
    assert.deepEqual(sent, ['owned:false']);
    assert.equal(store.rows.size, 0);
    assert.deepEqual(tabA.list(scope), []);
});

test('two tabs: a forced send of an older entry leaves the newer stored row for the next replay', async () => {
    const { createOutbox } = await load();
    const store = sharedStore();
    const sent = [];
    const send = async (e) => { sent.push(`${e.kind}:${e.value}`); return response(200); };
    let clock = 1;
    const tabA = createOutbox({ storage: store, send, now: () => clock++ });
    const tabB = createOutbox({ storage: store, send, now: () => clock++ });
    await tabA.add({ kind: 'read', volumeId: 5, userId: 1, serverId: 'web', value: true });
    await tabB.add({ kind: 'read', volumeId: 5, userId: 1, serverId: 'web', value: false });
    await tabA.flush(scope, { force: true });
    assert.deepEqual(sent, ['read:true']);
    assert.equal([...store.rows.values()][0].value, false, "tab B's change is still stored");
    await tabA.flush(scope);
    assert.deepEqual(sent, ['read:true', 'read:false']);
    assert.equal(store.rows.size, 0);
});

test('a backoff written by one tab does not overwrite a newer change of another tab', async () => {
    const { createOutbox } = await load();
    const store = sharedStore();
    let clock = 1;
    const tabA = createOutbox({ storage: store, send: async () => response(503), now: () => clock++ });
    const tabB = createOutbox({ storage: store, send: async () => response(200), now: () => clock++ });
    await tabA.add(change(1));
    await tabB.add(change(1, { value: false }));
    await tabA.flush(scope, { force: true });
    const [row] = [...store.rows.values()];
    assert.deepEqual([row.value, row.attempts], [false, 0]);
});

test('replays take the lock of their scope; a forced flush starts without waiting for it', async () => {
    const { createOutbox, OUTBOX_LOCK } = await load();
    const names = [];
    const lock = (name, fn) => { names.push(name); return fn(); };
    const outbox = createOutbox({ storage: memoryStore(), send: async () => response(200), lock });
    await outbox.add(change(1));
    await outbox.flush(scope);
    assert.deepEqual(names, [`${OUTBOX_LOCK}:web|1`]);
    await outbox.add(change(2));
    await outbox.flush(scope, { force: true });
    assert.equal(names.length, 1);
});

test('localOutboxStorage: update and remove only touch rows that still hold the same entry', async () => {
    const { localOutboxStorage, normalizeOutboxEntry, FALLBACK_KEY } = await load();
    const storage = memoryStorage();
    const local = localOutboxStorage(() => storage);
    const older = normalizeOutboxEntry(change(1));
    const newer = normalizeOutboxEntry(change(1, { value: false }));
    await local.put([newer]);
    await local.update([{ ...older, attempts: 3 }]);
    await local.remove([older]);
    assert.deepEqual(JSON.parse(storage.getItem(FALLBACK_KEY)), [newer]);
    await local.update([{ ...newer, attempts: 1 }]);
    assert.equal((await local.load())[0].attempts, 1);
    await local.remove([newer]);
    assert.equal(storage.getItem(FALLBACK_KEY), null);
});

test('startOutboxSync: a replay on visibility, online or reconnect first checks whose session it is', async () => {
    const { createOutbox, startOutboxSync } = await load();
    const sent = [];
    const outbox = createOutbox({ storage: memoryStore(), send: async (e) => { sent.push(e.volumeId); return response(200); } });
    const listeners = {};
    const target = () => ({
        addEventListener: (type, fn) => { listeners[type] = fn; },
        removeEventListener: (type) => { delete listeners[type]; }
    });
    let sessionUser = 2;
    const confirmUser = async () => sessionUser;
    const stop = startOutboxSync({
        userId: 1, outbox, win: target(), doc: { ...target(), visibilityState: 'visible' }, legacyStorage: memoryStorage(), confirmUser
    });
    // the start (right after the login) needs no check
    await new Promise((r) => setImmediate(r));
    await outbox.add(change(7, { deferred: true }));
    listeners.visibilitychange();
    listeners.online();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent, [], "another user's session: nothing is sent");
    assert.equal(outbox.count(scope), 1);
    sessionUser = null;
    listeners.online();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent, []);
    sessionUser = 1;
    listeners.online();
    while (!sent.length) await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent, [7]);
    stop();
});

test('startOutboxSync: the replay right after the login sends without asking', async () => {
    const { createOutbox, startOutboxSync } = await load();
    const sent = [];
    const outbox = createOutbox({ storage: memoryStore(), send: async (e) => { sent.push(e.volumeId); return response(200); } });
    await outbox.add(change(3, { deferred: true }));
    let asked = 0;
    const stop = startOutboxSync({ userId: 1, outbox, win: null, doc: null, legacyStorage: memoryStorage(), confirmUser: async () => { asked++; return 2; } });
    while (!sent.length) await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent, [3]);
    assert.equal(asked, 0);
    stop();
});

test('moveServer re-keys the entries of a removed server to the server added again; a newer change there wins', async () => {
    const { createOutbox, retiredServerId } = await load();
    const store = memoryStore();
    let clock = 1;
    const outbox = createOutbox({ storage: store, send: async () => response(200), now: () => clock++ });
    const old = retiredServerId('inst-1');
    await outbox.add({ kind: 'purchase', volumeId: 1, userId: 1, serverId: old });
    await outbox.add({ kind: 'read', volumeId: 2, userId: 2, serverId: old, value: true });
    await outbox.add({ kind: 'read', volumeId: 2, userId: 2, serverId: 'srv-new', value: false });
    assert.equal(outbox.countServer(old), 2);
    assert.equal(await outbox.moveServer(old, 'srv-new'), 1);
    assert.equal(outbox.countServer(old), 0);
    assert.deepEqual(outbox.list({ userId: 1, serverId: 'srv-new' }).map((e) => [e.kind, e.volumeId, e.key]), [['purchase', 1, 'srv-new|1|owned|1|1']]);
    assert.deepEqual(outbox.list({ userId: 2, serverId: 'srv-new' }).map((e) => e.value), [false]);
    assert.deepEqual([...store.rows.keys()].sort(), ['srv-new|1|owned|1|1', 'srv-new|2|read|2|2']);
    assert.equal(await outbox.moveServer(old, 'srv-new'), 0);
});

test('startOutboxSync: a failed session check keeps the backoff chain alive until the server answers again', async (t) => {
    const { createOutbox, startOutboxSync } = await load();
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    let up = false;
    let checks = 0;
    const sent = [];
    const outbox = createOutbox({ storage: memoryStore(), send: async () => { sent.push(up); return response(up ? 200 : 503); } });
    await outbox.add(change(1, { deferred: true }));
    const stop = startOutboxSync({
        userId: 1, outbox, win: null, doc: null, legacyStorage: memoryStorage(),
        confirmUser: async () => { checks++; return up ? 1 : null; }
    });
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
    await settle();
    assert.deepEqual(sent, [false], 'the replay after the login meets the restarting server');
    t.mock.timers.tick(5000);
    await settle();
    assert.equal(checks, 1, 'the backoff replay asks for the session, which fails too');
    assert.deepEqual(sent, [false]);
    up = true;
    t.mock.timers.tick(5000);
    await settle();
    assert.equal(checks, 2, 'the failed check rearmed the timer');
    assert.deepEqual(sent, [false, true]);
    assert.equal(outbox.count(scope), 0);
    stop();
});

test('startOutboxSync: a session of another user ends the chain without a new timer', async (t) => {
    const { createOutbox, startOutboxSync } = await load();
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    let checks = 0;
    const outbox = createOutbox({ storage: memoryStore(), send: async () => response(503) });
    await outbox.add(change(1, { deferred: true }));
    const stop = startOutboxSync({
        userId: 1, outbox, win: null, doc: null, legacyStorage: memoryStorage(), confirmUser: async () => { checks++; return 2; }
    });
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
    await settle();
    t.mock.timers.tick(5000);
    await settle();
    assert.equal(checks, 1);
    t.mock.timers.tick(10 * 60 * 1000);
    await settle();
    assert.equal(checks, 1);
    stop();
});

test('two tabs: a replay skips an entry whose stored row another tab replaced and sent while the replay ran', async () => {
    const { createOutbox } = await load();
    const store = sharedStore();
    const log = [];
    const server = new Map();
    const gate = deferred();
    let clock = 1;
    const tabA = createOutbox({
        storage: store,
        now: () => clock++,
        send: async (e) => {
            if (e.volumeId === 1) await gate.promise;
            log.push(`A:${e.volumeId}:${e.value}`);
            server.set(e.volumeId, e.value);
            return response(200);
        }
    });
    const tabB = createOutbox({
        storage: store,
        now: () => clock++,
        send: async (e) => { log.push(`B:${e.volumeId}:${e.value}`); server.set(e.volumeId, e.value); return response(200); }
    });
    await tabB.load();
    for (const id of [1, 2, 5]) await tabA.add(change(id, { deferred: true }));
    const replay = tabA.flush(scope);
    await new Promise((r) => setImmediate(r));
    await tabB.add(change(5, { value: false }));
    await tabB.flush(scope, { force: true });
    gate.resolve();
    const result = await replay;
    assert.deepEqual(log, ['B:5:false', 'A:1:true', 'A:2:true']);
    assert.equal(server.get(5), false, 'the older value never follows the newer one');
    assert.deepEqual(result.synced.map((e) => e.volumeId), [1, 2]);
    assert.equal(store.rows.size, 0);
    assert.deepEqual(tabA.list(scope), []);
});

test('two tabs: a replay leaves a newer change another tab could not send for that tab or the next replay', async () => {
    const { createOutbox } = await load();
    const store = sharedStore();
    const log = [];
    const gate = deferred();
    let clock = 1;
    const tabA = createOutbox({
        storage: store,
        now: () => clock++,
        send: async (e) => {
            if (e.volumeId === 1) await gate.promise;
            log.push(`A:${e.volumeId}:${e.value}`);
            return response(200);
        }
    });
    const tabB = createOutbox({ storage: store, now: () => clock++, send: async (e) => { log.push(`B:${e.volumeId}:${e.value}`); return response(503); } });
    await tabB.load();
    for (const id of [1, 5]) await tabA.add(change(id, { deferred: true }));
    const replay = tabA.flush(scope);
    await new Promise((r) => setImmediate(r));
    await tabB.add(change(5, { value: false }));
    await tabB.flush(scope, { force: true });
    gate.resolve();
    await replay;
    assert.deepEqual(log, ['B:5:false', 'A:1:true']);
    assert.deepEqual(tabA.list(scope).map((e) => [e.volumeId, e.value]), [[5, false]], "tab A now holds tab B's change");
    assert.equal([...store.rows.values()][0].attempts, 1);
});
