const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'src', 'utils', 'shoppingQueue.js')).href);

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

const response = (status) => ({ ok: status >= 200 && status < 300, status, json: async () => ({}) });
const idOf = (url) => Number(url.match(/\/api\/volumes\/(\d+)\/owners$/)[1]);

test('localToday uses the local calendar day, also shortly after midnight', async () => {
    const { localToday } = await load();
    assert.equal(localToday(new Date(2026, 0, 1, 0, 30)), '2026-01-01');
    assert.equal(localToday(new Date(2025, 11, 31, 23, 59)), '2025-12-31');
    assert.match(localToday(), /^\d{4}-\d{2}-\d{2}$/);
});

test('enqueuePurchase: per user, deduplicated, with the purchase day', async () => {
    const { enqueuePurchase, readQueue, queueKey, pendingCount, pendingVolumeIds } = await load();
    const storage = memoryStorage();
    assert.equal(enqueuePurchase(1, 5, { storage, purchasedAt: '2026-09-15' }), true);
    assert.equal(enqueuePurchase(1, 5, { storage, purchasedAt: '2026-09-16' }), true);
    assert.equal(enqueuePurchase(2, 7, { storage, purchasedAt: '2026-09-16' }), true);
    assert.deepEqual(readQueue(1, storage), [{ volumeId: 5, userId: 1, purchasedAt: '2026-09-15' }]);
    assert.deepEqual([...pendingVolumeIds(2, storage)], [7]);
    assert.equal(pendingCount(3, storage), 0);
    assert.ok(storage.map.has(queueKey(1)) && storage.map.has(queueKey(2)));
});

test('enqueuePurchase reports failure instead of losing the purchase silently', async () => {
    const { enqueuePurchase } = await load();
    const full = memoryStorage();
    full.setItem = () => { throw new Error('QuotaExceededError'); };
    assert.equal(enqueuePurchase(1, 5, { storage: full }), false);
    assert.equal(enqueuePurchase(null, 5, { storage: memoryStorage() }), false);
    assert.equal(enqueuePurchase(1, 'abc', { storage: memoryStorage() }), false);
});

test('readQueue tolerates broken or foreign content', async () => {
    const { readQueue, queueKey } = await load();
    assert.deepEqual(readQueue(1, memoryStorage({ [queueKey(1)]: '{"a":1}' })), []);
    assert.deepEqual(readQueue(1, memoryStorage({ [queueKey(1)]: 'kaputt' })), []);
    assert.deepEqual(readQueue(1, memoryStorage({ [queueKey(1)]: '[3, {"volumeId": 4, "purchasedAt": "x"}]' })),
        [{ volumeId: 4, userId: 1, purchasedAt: null }]);
});

test('discardLegacyQueue drops the old queue without a user instead of replaying it', async () => {
    const { discardLegacyQueue, LEGACY_QUEUE_KEY } = await load();
    const storage = memoryStorage({ [LEGACY_QUEUE_KEY]: '[1,2,3]' });
    assert.equal(discardLegacyQueue(storage), 3);
    assert.equal(storage.getItem(LEGACY_QUEUE_KEY), null);
    assert.equal(discardLegacyQueue(storage), 0);
});

test('flush: 2xx and 404 leave the queue, 401/5xx stay, 400/403/409 are dropped as failed', async () => {
    const { enqueuePurchase, flushPurchaseQueue, readQueue } = await load();
    const storage = memoryStorage();
    const statuses = { 1: 200, 2: 404, 3: 401, 4: 500, 5: 403, 6: 400, 7: 409 };
    for (const id of Object.keys(statuses)) enqueuePurchase(9, Number(id), { storage, purchasedAt: '2026-10-01' });
    const bodies = [];
    const fetchImpl = async (url, opts) => {
        assert.equal(opts.method, 'POST');
        bodies.push(JSON.parse(opts.body));
        return response(statuses[idOf(url)]);
    };
    const result = await flushPurchaseQueue({ userId: 9, storage, fetchImpl });
    assert.deepEqual(result.synced.map(e => e.volumeId), [1, 2]);
    assert.deepEqual(result.dropped.map(e => e.volumeId), [5, 6, 7]);
    assert.deepEqual(result.kept.map(e => e.volumeId), [3, 4]);
    assert.deepEqual(readQueue(9, storage).map(e => e.volumeId), [3, 4]);
    assert.deepEqual(bodies[0], { owned: true, purchase_date: '2026-10-01' });
});

test('sendPurchase records the buyer as owner instead of writing the whole volume', async () => {
    const { sendPurchase, purchaseBody } = await load();
    const calls = [];
    const fetchImpl = async (url, opts) => { calls.push({ url, method: opts.method, body: JSON.parse(opts.body) }); return response(200); };
    await sendPurchase(42, '2026-10-02', { fetchImpl });
    assert.deepEqual(calls, [{ url: '/api/volumes/42/owners', method: 'POST', body: { owned: true, purchase_date: '2026-10-02' } }]);
    assert.deepEqual(JSON.parse(purchaseBody(null)), { owned: true });
});

test('flush: a network error stops the run and keeps everything not confirmed', async () => {
    const { enqueuePurchase, flushPurchaseQueue, readQueue } = await load();
    const storage = memoryStorage();
    for (const id of [1, 2, 3]) enqueuePurchase(9, id, { storage });
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(idOf(url));
        if (idOf(url) === 2) throw new TypeError('Failed to fetch');
        return response(200);
    };
    const result = await flushPurchaseQueue({ userId: 9, storage, fetchImpl });
    assert.deepEqual(calls, [1, 2]);
    assert.deepEqual(result.kept.map(e => e.volumeId), [2]);
    assert.deepEqual(readQueue(9, storage).map(e => e.volumeId), [2, 3]);
});

test('flush: a purchase queued while a PUT hangs survives and is sent in the same flush', async () => {
    const { enqueuePurchase, flushPurchaseQueue, readQueue, queueKey } = await load();
    const storage = memoryStorage();
    enqueuePurchase(9, 1, { storage });
    const first = deferred();
    const calls = [];
    const fetchImpl = (url) => {
        calls.push(idOf(url));
        return idOf(url) === 1 ? first.promise : Promise.resolve(response(200));
    };
    const flushing = flushPurchaseQueue({ userId: 9, storage, fetchImpl });
    await new Promise(r => setImmediate(r));
    enqueuePurchase(9, 2, { storage });
    assert.deepEqual(readQueue(9, storage).map(e => e.volumeId), [1, 2]);
    first.resolve(response(200));
    const result = await flushing;
    assert.deepEqual(calls, [1, 2]);
    assert.deepEqual(result.synced.map(e => e.volumeId), [1, 2]);
    assert.equal(storage.getItem(queueKey(9)), null);
});

test('flush: a purchase queued during a failing PUT is not overwritten by the end of the flush', async () => {
    const { enqueuePurchase, flushPurchaseQueue, readQueue } = await load();
    const storage = memoryStorage();
    enqueuePurchase(9, 1, { storage });
    const first = deferred();
    const fetchImpl = () => first.promise;
    const flushing = flushPurchaseQueue({ userId: 9, storage, fetchImpl });
    await new Promise(r => setImmediate(r));
    enqueuePurchase(9, 2, { storage });
    first.reject(new TypeError('Failed to fetch'));
    await flushing;
    assert.deepEqual(readQueue(9, storage).map(e => e.volumeId), [1, 2]);
});

test('flush: concurrent calls share one run, so every PUT is sent once', async () => {
    const { enqueuePurchase, flushPurchaseQueue } = await load();
    const storage = memoryStorage();
    for (const id of [1, 2]) enqueuePurchase(9, id, { storage });
    const calls = [];
    const fetchImpl = async (url) => { calls.push(idOf(url)); await new Promise(r => setTimeout(r, 5)); return response(200); };
    const [a, b] = await Promise.all([
        flushPurchaseQueue({ userId: 9, storage, fetchImpl }),
        flushPurchaseQueue({ userId: 9, storage, fetchImpl })
    ]);
    assert.equal(a, b);
    assert.deepEqual(calls, [1, 2]);
    await flushPurchaseQueue({ userId: 9, storage, fetchImpl });
    assert.deepEqual(calls, [1, 2], 'an empty queue sends nothing');
});

test('flush: another user\'s purchases are neither sent nor removed', async () => {
    const { enqueuePurchase, flushPurchaseQueue, readQueue } = await load();
    const storage = memoryStorage();
    enqueuePurchase(1, 11, { storage });
    const calls = [];
    const result = await flushPurchaseQueue({ userId: 2, storage, fetchImpl: async (url) => { calls.push(url); return response(200); } });
    assert.deepEqual(calls, []);
    assert.deepEqual(result, { synced: [], dropped: [], kept: [] });
    assert.deepEqual(readQueue(1, storage).map(e => e.volumeId), [11]);
    assert.deepEqual(await flushPurchaseQueue({ userId: null, storage }), { synced: [], dropped: [], kept: [] });
});

test('flush: a hanging PUT times out and stays queued', async () => {
    const { enqueuePurchase, flushPurchaseQueue, readQueue } = await load();
    const storage = memoryStorage();
    enqueuePurchase(9, 1, { storage });
    const fetchImpl = (url, opts) => new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const result = await flushPurchaseQueue({ userId: 9, storage, fetchImpl, timeoutMs: 10 });
    assert.deepEqual(result.kept.map(e => e.volumeId), [1]);
    assert.deepEqual(readQueue(9, storage).map(e => e.volumeId), [1]);
});

test('classifyQuickBuy / classifyPurchaseResponse map statuses', async () => {
    const { classifyQuickBuy, classifyPurchaseResponse } = await load();
    assert.equal(classifyQuickBuy(response(200)), 'ok');
    for (const s of [500, 502, 503, 504, 522, 429]) assert.equal(classifyQuickBuy(response(s)), 'queue', String(s));
    assert.equal(classifyQuickBuy(response(401)), 'auth');
    for (const s of [400, 403, 404, 409]) assert.equal(classifyQuickBuy(response(s)), 'error', String(s));
    assert.equal(classifyQuickBuy(null), 'queue');
    assert.equal(classifyPurchaseResponse(response(204)), 'done');
    assert.equal(classifyPurchaseResponse(response(404)), 'done');
    assert.equal(classifyPurchaseResponse(response(401)), 'keep');
    assert.equal(classifyPurchaseResponse(response(503)), 'keep');
    assert.equal(classifyPurchaseResponse(response(403)), 'drop');
});

test('withoutVolumes hides queued purchases and fixes the totals', async () => {
    const { withoutVolumes } = await load();
    const data = { total_missing: 3, total_cost: 21.5, publishers: [{ publisher: 'Carlsen', count: 3 }], items: [
        { id: 1, price: 7 }, { id: 2, price: 7.25 }, { id: 3, price: null }
    ] };
    const out = withoutVolumes(data, new Set([2, 3, 99]));
    assert.deepEqual(out.items.map(i => i.id), [1]);
    assert.equal(out.total_missing, 1);
    assert.equal(out.total_cost, 14.25);
    assert.equal(withoutVolumes(data, new Set([99])), data);
    assert.equal(withoutVolumes(null, new Set([1])), null);
});
