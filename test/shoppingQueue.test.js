// Frontend shopping queue helpers, loaded as ESM with an in-memory storage.
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

// Sending, retrying and the old per-user queue's migration live in the outbox now (test/outbox.test.js).

test('localToday uses the local calendar day, also shortly after midnight', async () => {
    const { localToday } = await load();
    assert.equal(localToday(new Date(2026, 0, 1, 0, 30)), '2026-01-01');
    assert.equal(localToday(new Date(2025, 11, 31, 23, 59)), '2025-12-31');
    assert.match(localToday(), /^\d{4}-\d{2}-\d{2}$/);
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
