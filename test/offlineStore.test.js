const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

// The frontend's offline store (ESM) against an in-memory IndexedDB, localStorage and fetch. Every load gets a fresh
// module instance, because the store keeps its database handle, the logout generation and the running sync.
const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'frontend', 'src', 'utils', 'offlineStore.js')).href;
let loads = 0;
const load = () => import(`${moduleUrl}?t=${++loads}`);

function fakeIndexedDB({ existingStores = [] } = {}) {
    const stores = new Map([['kv', new Map()], ['outbox', new Map()]]);
    const created = new Set(existingStores);
    const db = {
        objectStoreNames: { contains: (name) => created.has(name) },
        createObjectStore(name) { created.add(name); },
        transaction(name) {
            const data = stores.get(name);
            const ops = [];
            // requests run in order and call their onsuccess; requests made there join the same transaction
            const request = (op) => { const req = {}; ops.push(() => { req.result = op(); req.onsuccess?.(); }); return req; };
            const store = {
                get(key) { return request(() => structuredClone(data.get(key))); },
                getAll() { return request(() => [...data.values()].map((v) => structuredClone(v))); },
                put(value, key) { return request(() => { data.set(key, structuredClone(value)); }); },
                delete(key) { return request(() => { data.delete(key); }); },
                clear() { return request(() => { data.clear(); }); }
            };
            const tx = { objectStore: () => store, oncomplete: null, onerror: null, onabort: null };
            setTimeout(() => { for (let i = 0; i < ops.length; i++) ops[i](); if (tx.oncomplete) tx.oncomplete(); }, 0);
            return tx;
        }
    };
    const fake = {
        data: stores.get('kv'),
        stores,
        created,
        versions: [],
        open(name, version) {
            fake.versions.push(version);
            const req = { result: db };
            setTimeout(() => { if (req.onupgradeneeded) req.onupgradeneeded(); req.onsuccess(); }, 0);
            return req;
        }
    };
    return fake;
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

/** Polls until `condition()` holds; fails after `timeoutMs` instead of guessing a fixed delay. */
async function waitUntil(condition, message, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${message}`);
        await new Promise(r => setTimeout(r, 1));
    }
}

/** Lets syncs a failed test left running finish before the globals they call are swapped for the next test. */
async function drain(promises) {
    await Promise.race([Promise.allSettled(promises), new Promise(r => setTimeout(r, 2000))]);
}

const snapshot = {
    generated_at: '2026-10-03T10:00:00Z',
    user: { id: 1, username: 'anna', role: 'editor' },
    mangas: [{ id: 3, title: 'Berserk', cover_image: 'https://example.com/a.jpg' }],
    details: { 3: { id: 3, title: 'Berserk', volumes: [] } }
};
const okResponse = (body) => ({ ok: true, status: 200, json: async () => structuredClone(body) });

const GLOBALS = ['indexedDB', 'fetch', 'localStorage', 'window', 'requestIdleCallback'];
function withGlobals(values) {
    const saved = GLOBALS.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    for (const name of GLOBALS) {
        Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
    }
    return () => {
        for (const [name, desc] of saved) {
            if (desc) Object.defineProperty(globalThis, name, desc);
            else delete globalThis[name];
        }
    };
}

/** Fresh store with fake IndexedDB/localStorage, a counting fetch and a window that records sync events. */
async function setup(fetchImpl) {
    const idb = fakeIndexedDB();
    const storage = memoryStorage();
    const events = [];
    const win = new EventTarget();
    const calls = { fetch: 0 };
    const restore = withGlobals({
        indexedDB: idb,
        localStorage: storage,
        window: win,
        requestIdleCallback: () => {},
        fetch: (...args) => { calls.fetch++; return fetchImpl(...args); }
    });
    const store = await load();
    win.addEventListener(store.OFFLINE_SYNCED_EVENT, (e) => events.push(e.detail.synced_at));
    return { store, idb, storage, events, calls, restore };
}

test('formatAge: human readable German age labels', async () => {
    const { formatAge } = await load();
    const now = Date.now();
    const hours = (h) => now - h * 60 * 60 * 1000;
    assert.equal(formatAge(now - 10 * 1000), 'gerade eben');
    assert.equal(formatAge(now - 5 * 60 * 1000), 'vor 5 Min.');
    assert.equal(formatAge(hours(3)), 'vor 3 Std.');
    assert.equal(formatAge(hours(23.6)), 'vor 23 Std.');
    assert.equal(formatAge(hours(24)), 'vor 1 Tag');
    assert.equal(formatAge(hours(30)), 'vor 1 Tag');
    assert.equal(formatAge(hours(47)), 'vor 1 Tag');
    assert.equal(formatAge(hours(48)), 'vor 2 Tagen');
    assert.equal(formatAge(new Date(now - 7 * 60 * 1000).toISOString()), 'vor 7 Min.');
});

test('formatAge: unknown or invalid input does not throw', async () => {
    const { formatAge } = await load();
    assert.equal(formatAge(null), 'unbekannt');
    assert.equal(formatAge(undefined), 'unbekannt');
    assert.equal(formatAge('kein datum'), 'unbekannt');
});

test('store functions degrade gracefully when IndexedDB is unavailable', async () => {
    const restore = withGlobals({ fetch: async () => okResponse(snapshot) });
    try {
        const store = await load();
        assert.deepEqual(await store.loadMangaList(), []);
        assert.equal(await store.loadUser(), null);
        assert.equal(await store.loadMangaDetail(1), null);
        await store.clearOfflineData(); // must not throw (also without localStorage)
        assert.equal(await store.syncOfflineCopy({ force: true }), false, 'nothing could be stored');
    } finally {
        restore();
    }
});

test('syncOfflineCopy stores the snapshot, reports it once and is throttled afterwards', async () => {
    const ctx = await setup(async () => okResponse(snapshot));
    try {
        assert.equal(await ctx.store.syncOfflineCopy(), true);
        assert.deepEqual(await ctx.store.loadMangaList(), snapshot.mangas);
        assert.deepEqual(await ctx.store.loadMangaDetail(3), snapshot.details[3]);
        const meta = await ctx.store.loadMeta();
        assert.equal(typeof meta.synced_at, 'number');
        assert.deepEqual(ctx.events, [meta.synced_at]);

        assert.equal(await ctx.store.syncOfflineCopy(), false, 'throttled');
        assert.equal(ctx.calls.fetch, 1);
        assert.equal(await ctx.store.syncOfflineCopy({ force: true }), true);
        assert.equal(ctx.calls.fetch, 2);
    } finally {
        ctx.restore();
    }
});

test('syncOfflineCopy: overlapping calls never download in parallel', async () => {
    const gates = [];
    const started = [];
    let active = 0;
    let maxActive = 0;
    let closing = false;
    const ctx = await setup(() => {
        if (closing) return Promise.resolve(okResponse(snapshot));
        active++;
        maxActive = Math.max(maxActive, active);
        const gate = deferred();
        gates.push(gate);
        return gate.promise.then((res) => { active--; return res; });
    });
    const sync = (opts) => { const p = ctx.store.syncOfflineCopy(opts); started.push(p); return p; };
    try {
        const plain = [sync(), sync()];
        await waitUntil(() => ctx.calls.fetch >= 1, 'the first download starts');
        assert.equal(ctx.calls.fetch, 1, 'background syncs share one download');

        // a forced refresh (data changed) waits for the running download and then fetches once more
        const forced = [sync({ force: true }), sync({ force: true })];
        const later = sync();
        assert.equal(forced[0], forced[1]);
        assert.equal(later, forced[0]);
        assert.equal(ctx.calls.fetch, 1, 'the forced refresh does not start while the first download runs');
        gates[0].resolve(okResponse(snapshot));
        assert.deepEqual(await Promise.all(plain), [true, true]);
        await waitUntil(() => ctx.calls.fetch >= 2, 'the forced download starts');
        assert.equal(ctx.calls.fetch, 2);
        gates[1].resolve(okResponse(snapshot));
        assert.deepEqual(await Promise.all([...forced, later]), [true, true, true]);
        assert.equal(maxActive, 1);
        assert.equal(ctx.events.length, 2);
    } finally {
        closing = true;
        for (const gate of gates) gate.resolve(okResponse(snapshot));
        await drain(started);
        ctx.restore();
    }
});

test('syncOfflineCopy: a failed download does not block the next sync', async () => {
    let fail = true;
    const ctx = await setup(async () => {
        if (fail) throw new TypeError('Failed to fetch');
        return okResponse(snapshot);
    });
    try {
        assert.equal(await ctx.store.syncOfflineCopy(), false);
        fail = false;
        assert.equal(await ctx.store.syncOfflineCopy(), true);
        assert.equal(ctx.calls.fetch, 2);
    } finally {
        ctx.restore();
    }
});

test('syncOfflineCopy: a logout during the download stores nothing and does not hold back the next login', async () => {
    const first = deferred();
    let call = 0;
    let stale;
    let next;
    const ctx = await setup(() => (++call === 1 ? first.promise : Promise.resolve(okResponse(snapshot))));
    try {
        stale = ctx.store.syncOfflineCopy();
        await waitUntil(() => ctx.calls.fetch === 1, 'the first download starts');
        await ctx.store.clearOfflineData();
        next = ctx.store.syncOfflineCopy();
        await waitUntil(() => ctx.calls.fetch === 2, 'the new session does not join the old download');
        first.resolve(okResponse({ ...snapshot, mangas: [{ id: 99, title: 'Alt' }] }));
        assert.equal(await stale, false);
        assert.equal(await next, true);
        assert.deepEqual((await ctx.store.loadMangaList()).map(m => m.id), [3]);
        assert.deepEqual(ctx.events.slice(0, 1), [null], 'logout clears the footer age');
        assert.equal(ctx.events.length, 2);
    } finally {
        first.resolve(okResponse(snapshot));
        await drain([stale, next]);
        ctx.restore();
    }
});

test('syncOfflineCopy: a logout before the download finishes leaves the store empty', async () => {
    const pending = deferred();
    const ctx = await setup(() => pending.promise);
    let run;
    try {
        run = ctx.store.syncOfflineCopy({ force: true });
        await waitUntil(() => ctx.calls.fetch === 1, 'the download starts');
        await ctx.store.clearOfflineData();
        pending.resolve(okResponse(snapshot));
        assert.equal(await run, false);
        assert.deepEqual(await ctx.store.loadMangaList(), []);
        assert.equal(await ctx.store.loadMeta(), null);
        assert.deepEqual(ctx.events, [null]);
    } finally {
        pending.resolve(okResponse(snapshot));
        await drain([run]);
        ctx.restore();
    }
});

test('clearOfflineData removes the offline copy, the shopping cache and the old unassigned purchase queue', async () => {
    const ctx = await setup(async () => okResponse(snapshot));
    try {
        await ctx.store.syncOfflineCopy();
        ctx.storage.setItem('mangashelf_shopping_cache', '{"items":[]}');
        ctx.storage.setItem('mangashelf_shopping_meta', '{"timestamp":"x"}');
        ctx.storage.setItem('mangashelf_pending_purchases', '[1,2]');
        ctx.storage.setItem('mangashelf_pending_purchases:1', '[{"volumeId":4}]');
        ctx.storage.setItem('mangashelf_shop_session', '{"entries":[]}');
        await ctx.store.clearOfflineData();
        assert.equal(ctx.idb.data.size, 0);
        assert.deepEqual([...ctx.storage.map.keys()], ['mangashelf_pending_purchases:1']);
    } finally {
        ctx.restore();
    }
});

test('shopping cache: slim copy without others, skipped after a logout, quota errors reported', async () => {
    const ctx = await setup(async () => okResponse(snapshot));
    try {
        const { store, storage } = ctx;
        const data = {
            total_missing: 1, total_cost: 7, publishers: [{ publisher: 'Carlsen', count: 1, total_price: 7 }],
            items: [{ id: 1, manga_id: 2, manga_title: 'A', volume_number: '3', price: 7, isbn: '978', condition: 'neu', release_year: 2020 }],
            others: [{ id: 5, owned_by_others: 'ben' }]
        };
        const generation = store.getClearGeneration();
        const savedAt = store.writeShoppingCache(data, generation);
        assert.ok(savedAt);
        const cached = store.readShoppingCache();
        assert.equal(cached.others, undefined);
        assert.deepEqual(cached.items, [{ id: 1, manga_id: 2, volume_number: '3', isbn: '978', price: 7, manga_title: 'A' }]);
        assert.equal(store.readShoppingCacheTimestamp(), savedAt);

        await store.clearOfflineData();
        assert.equal(store.writeShoppingCache(data, generation), null, 'a request from before the logout writes nothing');
        assert.equal(storage.getItem('mangashelf_shopping_cache'), null);

        store.writeShoppingCache(data);
        const before = storage.getItem('mangashelf_shopping_meta');
        storage.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
        assert.equal(store.writeShoppingCache(data), null);
        assert.equal(storage.getItem('mangashelf_shopping_meta'), before, 'timestamp not advanced');
        assert.equal(store.updateShoppingCache((c) => c), false);
    } finally {
        ctx.restore();
    }
});

test('warmCovers: skipped on mobile data, slow links and data saver', async () => {
    const { warmCovers } = await load();
    const urls = ['/uploads/a.jpg', '/uploads/b.jpg'];
    for (const connection of [{ saveData: true }, { type: 'cellular' }, { effectiveType: '3g' }, { effectiveType: '2g' }]) {
        let calls = 0;
        const n = await warmCovers(urls, { connection, caches: null, storage: null, fetchImpl: async () => { calls++; return {}; } });
        assert.equal(n, 0, JSON.stringify(connection));
        assert.equal(calls, 0);
    }
    let calls = 0;
    const nearlyFull = { estimate: async () => ({ usage: 90, quota: 100 }) };
    assert.equal(await warmCovers(urls, { connection: undefined, caches: null, storage: nearlyFull, fetchImpl: async () => { calls++; } }), 0);
    assert.equal(calls, 0);
});

test('warmCovers: only uncached /uploads covers, within the count and byte budget', async () => {
    const { warmCovers } = await load();
    const fetched = [];
    const fetchImpl = async (url) => { fetched.push(url); return { headers: { get: () => String(10 * 1024 * 1024) } }; };
    const cached = { match: async (url) => url === '/uploads/cached.jpg' };
    const urls = ['https://example.com/x.jpg', null, '/uploads/cached.jpg', '/uploads/1.jpg', '/uploads/1.jpg',
        ...Array.from({ length: 20 }, (_, i) => `/uploads/n${i}.jpg`)];

    const n = await warmCovers(urls, { connection: { effectiveType: '4g' }, caches: cached, storage: null, fetchImpl, maxBytes: 30 * 1024 * 1024 });
    assert.equal(n, fetched.length);
    assert.ok(fetched.length >= 3 && fetched.length <= 5, `stops at the byte budget (${fetched.length})`);
    assert.ok(!fetched.includes('/uploads/cached.jpg') && !fetched.includes('https://example.com/x.jpg'));

    fetched.length = 0;
    await warmCovers(urls, { connection: undefined, caches: null, storage: null, fetchImpl, maxCovers: 4, maxBytes: Infinity });
    assert.equal(fetched.length, 4);
    assert.equal(new Set(fetched).size, 4);
});

const isbnSnapshot = {
    ...snapshot,
    mangas: [{ id: 3, title: 'Naruto' }, { id: 4, title: 'Berserk' }],
    details: {
        3: { id: 3, title: 'Naruto', volumes: [
            { id: 31, volume_number: '1', type: 'volume', isbn: '978-3-551-76293-1', status: 'Vorhanden', owned_by_me: true, owners: [{ user_id: 1, username: 'anna' }] },
            { id: 32, volume_number: '2', type: 'volume', isbn: '3-551-76294-5', status: 'Fehlt', owned_by_me: false, owners: [] },
            { id: 33, volume_number: '3', type: 'volume', isbn: null, status: 'Fehlt' }
        ] },
        4: { id: 4, title: 'Berserk', volumes: [
            { id: 41, volume_number: '1', type: 'special_edition', notes: 'Collectors Edition', isbn: '9783551000011', status: 'Vorhanden', owned_by_me: false, owners: [{ user_id: 2, username: 'ed' }] }
        ] }
    }
};

test('saveSnapshot writes a compact ISBN index that lookupLocalIsbn answers from', async () => {
    const ctx = await setup(async () => okResponse(isbnSnapshot));
    try {
        assert.equal(await ctx.store.syncOfflineCopy(), true);
        const record = ctx.idb.data.get('isbn-index');
        assert.deepEqual(record.titles, { 3: 'Naruto', 4: 'Berserk' });
        assert.equal(record.entries.length, 3);
        const meta = await ctx.store.loadMeta();

        const owned = await ctx.store.lookupLocalIsbn('9783551762931');
        assert.deepEqual(owned, {
            manga: { id: 3, title: 'Naruto' },
            volume: { id: 31, display_title: 'Band 1', status: 'Vorhanden', owners: ['anna'], owned_by_me: true },
            syncedAt: meta.synced_at
        });
        // stored as ISBN-10, scanned as EAN-13
        assert.equal((await ctx.store.lookupLocalIsbn('9783551762948')).volume.id, 32);
        const partner = await ctx.store.lookupLocalIsbn('978-3-551-00001-1');
        assert.deepEqual([partner.volume.display_title, partner.volume.owned_by_me, partner.volume.owners], ['Band 1 (Collectors Edition)', false, ['ed']]);
        assert.equal(await ctx.store.lookupLocalIsbn('9780000000002'), null);
        assert.equal(await ctx.store.lookupLocalIsbn(''), null);
    } finally {
        ctx.restore();
    }
});

test('loadOfflineVolumeSearch: the search text of the snapshot rows, for the shelf search without a server', async () => {
    const withSearch = {
        ...snapshot,
        mangas: [
            { id: 3, title: 'Berserk', volume_search: '9783899211234\nErstauflage' },
            { id: 4, title: 'Akira', volume_search: null },
            { id: 5, title: 'Monster', volume_search: '' }
        ]
    };
    const ctx = await setup(async () => okResponse(withSearch));
    try {
        assert.deepEqual(await ctx.store.loadOfflineVolumeSearch(), []);
        assert.equal(await ctx.store.syncOfflineCopy(), true);
        assert.deepEqual(await ctx.store.loadOfflineVolumeSearch(), [{ id: 3, volume_search: '9783899211234\nErstauflage' }]);
        await ctx.store.clearOfflineData();
        assert.deepEqual(await ctx.store.loadOfflineVolumeSearch(), []);
    } finally {
        ctx.restore();
    }
});

test('the ISBN index is read once, renewed after a sync and gone after a logout', async () => {
    let body = isbnSnapshot;
    const ctx = await setup(async () => okResponse(body));
    try {
        await ctx.store.syncOfflineCopy();
        assert.ok(await ctx.store.lookupLocalIsbn('9783551762931'));
        ctx.idb.data.delete('isbn-index');
        ctx.idb.data.delete('mangas');
        assert.ok(await ctx.store.lookupLocalIsbn('9783551762931'), 'answered from the index read before');

        body = { ...isbnSnapshot, details: { 4: isbnSnapshot.details[4] }, mangas: [isbnSnapshot.mangas[1]] };
        await ctx.store.syncOfflineCopy({ force: true });
        assert.equal(await ctx.store.lookupLocalIsbn('9783551762931'), null);
        assert.ok(await ctx.store.lookupLocalIsbn('9783551000011'));

        await ctx.store.clearOfflineData();
        assert.equal(await ctx.store.lookupLocalIsbn('9783551000011'), null);
    } finally {
        ctx.restore();
    }
});

test('a copy stored before the ISBN index existed is indexed from its series details', async () => {
    const ctx = await setup(async () => okResponse(isbnSnapshot));
    try {
        await ctx.store.syncOfflineCopy();
        const fresh = await load();
        ctx.idb.data.delete('isbn-index');
        assert.equal((await fresh.lookupLocalIsbn('9783551762931')).volume.id, 31);
    } finally {
        ctx.restore();
    }
});

test('requestPersistentStorage asks once and skips an origin that is already persistent', async () => {
    const store = await load();
    const calls = [];
    const manager = { persisted: async () => { calls.push('persisted'); return false; }, persist: async () => { calls.push('persist'); return true; } };
    assert.equal(await store.requestPersistentStorage(manager), true);
    assert.equal(await store.requestPersistentStorage(manager), false);
    assert.deepEqual(calls, ['persisted', 'persist']);

    const other = await load();
    const granted = { persisted: async () => true, persist: async () => { throw new Error('not called'); } };
    assert.equal(await other.requestPersistentStorage(granted), true);
    assert.equal(await (await load()).requestPersistentStorage({}), false);
    const failing = { persist: async () => { throw new Error('denied'); } };
    assert.equal(await (await load()).requestPersistentStorage(failing), false);
});

test('database version 2 adds the outbox store next to the offline copy; a logout keeps the outbox', async () => {
    const { store, idb, restore } = await setup(async () => okResponse(snapshot));
    try {
        await store.saveUser({ id: 1, username: 'anna', role: 'editor' });
        assert.deepEqual(idb.versions, [2]);
        assert.deepEqual([...idb.created].sort(), ['kv', 'outbox']);
        const entry = { key: 'web|1|read|4|1', kind: 'read', volumeId: 4, userId: 1, serverId: 'web', value: true };
        await store.putOutboxEntries([entry, { ...entry, key: 'web|1|read|5|1', volumeId: 5 }]);
        await store.deleteOutboxEntries(['web|1|read|5|1']);
        assert.deepEqual(await store.loadOutboxEntries(), [entry]);
        await store.clearOfflineData();
        assert.equal(idb.data.size, 0, 'the offline copy is gone');
        assert.deepEqual(await store.loadOutboxEntries(), [entry], 'queued changes stay for their user');
    } finally {
        restore();
    }
});

test('an existing version 1 database only gets the outbox store added', async () => {
    const idb = fakeIndexedDB({ existingStores: ['kv'] });
    const restore = withGlobals({ indexedDB: idb, localStorage: memoryStorage(), window: new EventTarget(), requestIdleCallback: () => {}, fetch: async () => okResponse(snapshot) });
    try {
        const store = await load();
        await store.saveUser({ id: 1, username: 'anna', role: 'editor' });
        assert.deepEqual([...idb.created].sort(), ['kv', 'outbox']);
        assert.deepEqual(await store.loadUser(), { id: 1, username: 'anna', role: 'editor' });
    } finally {
        restore();
    }
});

test('the outbox calls reject without IndexedDB (the outbox then uses localStorage)', async () => {
    const restore = withGlobals({});
    try {
        const store = await load();
        await assert.rejects(() => store.loadOutboxEntries(), /IndexedDB/);
        await assert.rejects(() => store.putOutboxEntries([]), /IndexedDB/);
    } finally {
        restore();
    }
});

test('patchCachedManga changes the stored detail and list row; clearOfflineData also empties the in-memory data cache', async () => {
    const { store, idb, restore } = await setup(async () => okResponse(snapshot));
    try {
        await store.saveSnapshot(snapshot);
        const changed = await store.patchCachedManga(3, (detail, list) => ({
            detail: { ...detail, title: 'Berserk (neu)' },
            list: list.map((m) => ({ ...m, owned_volumes: 1 }))
        }));
        assert.equal(changed, true);
        assert.equal((await store.loadMangaDetail(3)).title, 'Berserk (neu)');
        assert.equal((await store.loadMangaList())[0].owned_volumes, 1);
        assert.equal(await store.patchCachedManga(99, () => ({ detail: {} })), false, 'no stored detail: nothing written');
        assert.equal(idb.data.has('manga:99'), false);

        const dataCache = await import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'src', 'utils', 'dataCache.js')).href);
        dataCache.writeCache(1, 'mangas', [{ id: 3 }]);
        await store.clearOfflineData();
        assert.equal(dataCache.readCache(1, 'mangas'), null);
    } finally {
        restore();
    }
});

test('patchCachedManga: concurrent patches of one series both land (get and put in one transaction)', async () => {
    const { store, restore } = await setup(async () => okResponse(snapshot));
    try {
        const vols = [{ id: 10, status: 'Fehlt' }, { id: 11, status: 'Fehlt' }];
        await store.saveSnapshot({ ...snapshot, details: { 3: { id: 3, title: 'Berserk', volumes: vols } } });
        const own = (volumeId) => (detail) => ({
            detail: { ...detail, volumes: detail.volumes.map((v) => (v.id === volumeId ? { ...v, status: 'Vorhanden' } : v)) }
        });
        const results = await Promise.all([store.patchCachedManga(3, own(10)), store.patchCachedManga(3, own(11))]);
        assert.deepEqual(results, [true, true]);
        assert.deepEqual((await store.loadMangaDetail(3)).volumes, [{ id: 10, status: 'Vorhanden' }, { id: 11, status: 'Vorhanden' }]);
    } finally {
        restore();
    }
});

test('outbox rows are only replaced or deleted while they still hold the same entry (another tab may have a newer one)', async () => {
    const { store, restore } = await setup(async () => okResponse(snapshot));
    try {
        const older = { key: 'web|1|owned|5|1', id: 'a', kind: 'owned', volumeId: 5, userId: 1, serverId: 'web', value: true };
        const newer = { ...older, id: 'b', value: false };
        await store.putOutboxEntries([newer]);
        await store.updateOutboxEntriesById([{ ...older, attempts: 1 }]);
        await store.deleteOutboxEntriesById([older]);
        assert.deepEqual(await store.loadOutboxEntries(), [newer]);
        await store.updateOutboxEntriesById([{ ...newer, attempts: 2 }]);
        assert.equal((await store.loadOutboxEntries())[0].attempts, 2);
        await store.deleteOutboxEntriesById([newer]);
        assert.deepEqual(await store.loadOutboxEntries(), []);
    } finally {
        restore();
    }
});
