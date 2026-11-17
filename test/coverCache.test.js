// Cover cache (services/coverCache.js, GET /api/covers): foreign covers are fetched once by the server and served from
// <DATA_DIR>/cache/covers; unknown URLs and failed downloads go to the cover host (image loads only).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startTestServer } = require('./helpers');

// 1x1 PNG
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a0d40000000049454e44ae426082', 'hex');

let ctx;
let admin;
let safeFetch;
let coverCache;
let downloads = [];
let failNext = false;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    safeFetch = require('../utils/safeFetch');
    coverCache = require('../services/coverCache');
    safeFetch.fetchRemoteImage = async (url) => {
        downloads.push(url);
        if (failNext) throw new Error('offline');
        return { buffer: PNG, ext: '.png' };
    };
});

test.after(async () => { await ctx.close(); });

test.beforeEach(() => {
    downloads = [];
    failNext = false;
    coverCache.reset();
});

const cover = (url, headers = {}) => fetch(`${ctx.base}/covers?url=${encodeURIComponent(url)}`, { redirect: 'manual', headers });

test('a cover a series names is fetched once and then served from the cache', async () => {
    const url = 'https://media.example.org/cover/frieren-1.png';
    assert.equal((await admin('POST', '/mangas', { title: 'Frieren', cover_image: url })).status, 200);

    const first = await cover(url, { 'Sec-Fetch-Dest': 'image' });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'image/png');
    assert.match(first.headers.get('cache-control'), /max-age=604800/);
    assert.match(first.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), PNG);

    const second = await cover(url);
    assert.equal(second.status, 200);
    await second.arrayBuffer();
    assert.deepEqual(downloads, [url], 'the host is asked only once');
    const stored = fs.readdirSync(path.join(ctx.dataDir, 'cache', 'covers'));
    assert.deepEqual(stored, [`${coverCache.keyOf(url)}.png`]);
});

test('a URL no row names is never fetched: image loads are sent to its host, links are not', async () => {
    const url = 'https://media.example.org/cover/search-result.jpg';
    const res = await cover(url, { 'Sec-Fetch-Dest': 'image' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), url);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await cover(url)).status, 302, 'clients without Sec-Fetch-Dest');
    const navigation = await cover(url, { 'Sec-Fetch-Dest': 'document' });
    assert.equal(navigation.status, 404, 'no open redirect for a link');
    assert.deepEqual(downloads, []);
});

test('only https addresses are accepted', async () => {
    for (const url of ['http://media.example.org/a.jpg', 'javascript:alert(1)', '/uploads/a.jpg', 'https://user:pw@example.org/a.jpg', '']) {
        const res = await cover(url, { 'Sec-Fetch-Dest': 'image' });
        assert.equal(res.status, 404, url);
    }
    assert.equal((await fetch(`${ctx.base}/covers`)).status, 404);
    assert.deepEqual(downloads, []);
});

test('a failed download goes to the host and is not retried at once', async () => {
    const url = 'https://media.example.org/cover/down.png';
    assert.equal((await admin('POST', '/mangas', { title: 'Down', cover_image: url })).status, 200);
    failNext = true;
    const res = await cover(url, { 'Sec-Fetch-Dest': 'image' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), url);
    failNext = false;
    assert.equal((await cover(url)).status, 302, 'remembered for a while');
    assert.equal(downloads.length, 1);
});

test('volume and anime covers count as known too', async () => {
    const { id } = (await admin('POST', '/mangas', { title: 'Bandreihe' })).body;
    const url = 'https://media.example.org/cover/band-2.png';
    assert.equal((await admin('POST', '/volumes', { manga_id: id, volume_number: '2', status: 'Vorhanden', cover_image: url })).status, 200);
    assert.equal((await cover(url)).status, 200);
    const photo = 'https://media.example.org/photo/band-2-ruecken.png';
    const volume = (await admin('POST', '/volumes', { manga_id: id, volume_number: '3', status: 'Vorhanden', images: JSON.stringify([photo]) })).body;
    assert.equal((await cover(photo)).status, 200, 'a photo added as an external link');
    require('../db').db.prepare("UPDATE volumes SET images = '[broken' WHERE id = ?").run(volume.id);
    assert.ok(coverCache.pruneUnused() >= 0, 'damaged JSON does not stop the clean-up');
});

test('the shared wishlist shows foreign covers through the cache', async () => {
    const url = 'https://media.example.org/cover/wish.png';
    const { id } = (await admin('POST', '/mangas', { title: 'Wunschreihe', cover_image: url })).body;
    assert.equal((await admin('PUT', `/mangas/${id}/wish`, { priority: 2 })).status, 200);
    const made = await admin('POST', '/wishlist/share-token');
    const text = await (await fetch(made.body.url.replace(/^https?:\/\/[^/]+/, ctx.root))).text();
    assert.ok(text.includes(`src="/api/covers?url=${encodeURIComponent(url)}"`), 'cover through the cache');
    assert.ok(!text.includes(`src="${url}"`), 'never the host itself');
});

test('the daily clean-up removes cached covers no row names any more', async () => {
    const url = 'https://media.example.org/cover/gone.png';
    const { id } = (await admin('POST', '/mangas', { title: 'Weg', cover_image: url })).body;
    assert.equal((await cover(url)).status, 200);
    const file = path.join(coverCache.cacheDir(), `${coverCache.keyOf(url)}.png`);
    assert.ok(fs.existsSync(file));
    assert.equal(coverCache.pruneUnused(), 0, 'still named');
    assert.equal((await admin('PUT', `/mangas/${id}`, { title: 'Weg', cover_image: null })).status, 200);
    assert.equal(coverCache.pruneUnused(), 0, 'young files stay a day');
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(file, old, old);
    const kept = path.join(coverCache.cacheDir(), `${coverCache.keyOf('https://media.example.org/cover/frieren-1.png')}.png`);
    assert.ok(fs.existsSync(kept), 'cached by the first test');
    fs.utimesSync(kept, old, old);
    assert.equal(coverCache.pruneUnused(), 1);
    assert.ok(!fs.existsSync(file));
    assert.ok(fs.existsSync(kept), 'a cover still named stays');
});
