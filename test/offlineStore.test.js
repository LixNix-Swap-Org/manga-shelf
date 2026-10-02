const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

// Pure helper of the frontend's offline store (ESM); the IndexedDB parts are covered manually in a browser.
const load = () => import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'src', 'utils', 'offlineStore.js')).href);

test('formatAge: human readable German age labels', async () => {
    const { formatAge } = await load();
    const now = Date.now();
    assert.equal(formatAge(now - 10 * 1000), 'gerade eben');
    assert.equal(formatAge(now - 5 * 60 * 1000), 'vor 5 Min.');
    assert.equal(formatAge(now - 3 * 60 * 60 * 1000), 'vor 3 Std.');
    assert.equal(formatAge(now - 2 * 24 * 60 * 60 * 1000), 'vor 2 Tagen');
    assert.equal(formatAge(new Date(now - 7 * 60 * 1000).toISOString()), 'vor 7 Min.');
});

test('formatAge: unknown or invalid input does not throw', async () => {
    const { formatAge } = await load();
    assert.equal(formatAge(null), 'unbekannt');
    assert.equal(formatAge(undefined), 'unbekannt');
    assert.equal(formatAge('kein datum'), 'unbekannt');
});

test('store functions degrade gracefully when IndexedDB is unavailable', async () => {
    const store = await load();
    assert.deepEqual(await store.loadMangaList(), []);
    assert.equal(await store.loadUser(), null);
    assert.equal(await store.loadMangaDetail(1), null);
    await store.clearOfflineData(); // must not throw (also without localStorage)
    assert.equal(await store.syncOfflineCopy({ force: true }), false);
});
