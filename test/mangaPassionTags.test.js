// Genre backfill ("Genres nachladen") from cached or fetched Manga Passion editions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let ctx;
let editor;
let visitor;
let db;

test.before(async () => {
    ctx = await startTestServer();
    const admin = ctx.client();
    editor = ctx.client();
    visitor = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'ed', password: 'password123', role: 'editor' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'gast', password: 'password123', role: 'visitor' })).status, 200);
    assert.equal((await editor('POST', '/auth/login', { username: 'ed', password: 'password123' })).status, 200);
    assert.equal((await visitor('POST', '/auth/login', { username: 'gast', password: 'password123' })).status, 200);
    db = require('../db').db;
});

test.after(async () => { await ctx.close(); });

function withFakeMangaPassion(handler) {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => {
        const u = String(url);
        if (u.startsWith(ctx.base)) return realFetch(url, opts);
        calls.push(u);
        return handler(u);
    };
    return { calls, restore: () => { global.fetch = realFetch; } };
}

let nextEdition = 990100;
const createSeries = (editionId, { tags = null, editionData = null } = {}) => Number(db.prepare(
    'INSERT INTO mangas (title, tags, manga_passion_id, manga_passion_edition_data) VALUES (?, ?, ?, ?)'
).run(`Genres ${editionId}`, tags, editionId, editionData ? JSON.stringify(editionData) : null).lastInsertRowid);
const seedCache = (key, data) => db.prepare('INSERT INTO manga_passion_cache (cache_key, json_data, created_at) VALUES (?, ?, ?)')
    .run(key, JSON.stringify(data), Date.now());
const tagsOf = (id) => db.prepare('SELECT tags FROM mangas WHERE id = ?').get(id).tags;
const fillTags = (id, client = editor) => client('POST', `/mangas/${id}/sync-edition`, { tags_only: true });

test('Genres nachladen: the stored edition answers without a request; tags come in German', async () => {
    const editionId = nextEdition++;
    const id = createSeries(editionId, { editionData: { id: editionId, title: 'X', tags: 'Shounen, Adventure, Slice of Life' } });
    const fake = withFakeMangaPassion(() => { throw new Error('no network expected'); });
    try {
        const res = await fillTags(id);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.updated, true);
        assert.equal(res.body.source, 'edition_data');
        assert.equal(res.body.tags, 'Shounen, Abenteuer, Alltag');
        assert.equal(res.body.manga.tags, 'Shounen, Abenteuer, Alltag');
        assert.equal(tagsOf(id), 'Shounen, Abenteuer, Alltag');
        assert.equal(fake.calls.length, 0);
    } finally { fake.restore(); }
});

test('Genres nachladen: a cached edition (any age) is used before the API', async () => {
    const editionId = nextEdition++;
    const id = createSeries(editionId);
    db.prepare('INSERT INTO manga_passion_cache (cache_key, json_data, created_at) VALUES (?, ?, ?)').run(
        `mp_edition_vols_${editionId}`, JSON.stringify({ edition: { id: editionId, tags: 'Romance, Drama' }, volumes: [] }), 1
    );
    const fake = withFakeMangaPassion(() => { throw new Error('no network expected'); });
    try {
        const res = await fillTags(id);
        assert.equal(res.status, 200);
        assert.equal(res.body.source, 'cache');
        assert.equal(tagsOf(id), 'Romantik, Drama');
        assert.equal(fake.calls.length, 0);
    } finally { fake.restore(); }
});

test('Genres nachladen: a cached edition without genres ends without a request and without a change', async () => {
    const editionId = nextEdition++;
    const id = createSeries(editionId);
    seedCache(`mp_edition_info_${editionId}`, { edition: { id: editionId, tags: null } });
    const fake = withFakeMangaPassion(() => { throw new Error('no network expected'); });
    try {
        const res = await fillTags(id);
        assert.equal(res.status, 200);
        assert.equal(res.body.updated, false);
        assert.equal(res.body.tags, null);
        assert.equal(tagsOf(id), null);
        assert.equal(fake.calls.length, 0);
    } finally { fake.restore(); }
});

test('Genres nachladen: nothing cached asks Manga Passion once and caches the edition', async () => {
    const editionId = nextEdition++;
    const id = createSeries(editionId, { tags: '  ' });
    const fake = withFakeMangaPassion((url) => {
        assert.match(url, new RegExp(`/editions/${editionId}$`));
        return {
            ok: true,
            status: 200,
            json: async () => ({ id: editionId, title: 'Live', sources: [{ tags: [{ name: 'Fantasy' }, { name: 'Supernatural' }] }] })
        };
    });
    try {
        const res = await fillTags(id);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.source, 'manga_passion');
        assert.equal(tagsOf(id), 'Fantasy, Übernatürlich');
        assert.equal(fake.calls.length, 1);
        assert.ok(db.prepare('SELECT 1 FROM manga_passion_cache WHERE cache_key = ?').get(`mp_edition_info_${editionId}`));
    } finally { fake.restore(); }
});

test('Genres nachladen: existing tags stay, an unlinked series is a 409, visitors are refused', async () => {
    const editionId = nextEdition++;
    const tagged = createSeries(editionId, { tags: 'Eigene', editionData: { id: editionId, tags: 'Action' } });
    const unlinked = createSeries(null);
    const fake = withFakeMangaPassion(() => { throw new Error('no network expected'); });
    try {
        const res = await fillTags(tagged);
        assert.equal(res.status, 200);
        assert.equal(res.body.updated, false);
        assert.equal(tagsOf(tagged), 'Eigene');

        const notLinked = await fillTags(unlinked);
        assert.equal(notLinked.status, 409);
        assert.equal(notLinked.body.code, 'MP_NOT_LINKED');

        assert.equal((await fillTags(tagged, visitor)).status, 403);
        assert.equal((await fillTags(987654)).status, 404);
        assert.equal(fake.calls.length, 0);
    } finally { fake.restore(); }
});

test('Genres nachladen: an unreachable Manga Passion is a 503, a known missing edition a 404 without a request', async () => {
    const down = createSeries(nextEdition++);
    let fake = withFakeMangaPassion(() => { throw new Error('ECONNREFUSED'); });
    try {
        const res = await fillTags(down);
        assert.equal(res.status, 503);
        assert.equal(res.body.code, 'MP_UNAVAILABLE');
        assert.equal(tagsOf(down), null);
    } finally { fake.restore(); }

    const goneId = nextEdition++;
    const gone = createSeries(goneId);
    seedCache(`mp_edition_vols_${goneId}`, { notFound: true, edition: null, volumes: [] });
    fake = withFakeMangaPassion(() => { throw new Error('no network expected'); });
    try {
        const res = await fillTags(gone);
        assert.equal(res.status, 404);
        assert.equal(res.body.code, 'MP_EDITION_NOT_FOUND');
        assert.equal(fake.calls.length, 0);
    } finally { fake.restore(); }
});

test('Genres nachladen: a cached 404 older than the edition cache TTL is asked again', async () => {
    const yearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const seedOld = (key, data) => db.prepare('INSERT INTO manga_passion_cache (cache_key, json_data, created_at) VALUES (?, ?, ?)')
        .run(key, JSON.stringify(data), yearAgo);

    const backId = nextEdition++;
    const back = createSeries(backId);
    seedOld(`mp_edition_vols_${backId}`, { notFound: true, edition: null, volumes: [] });
    let fake = withFakeMangaPassion(() => ({
        ok: true,
        status: 200,
        json: async () => ({ id: backId, title: 'Wieder da', sources: [{ tags: [{ name: 'Comedy' }] }] })
    }));
    try {
        const res = await fillTags(back);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.source, 'manga_passion');
        assert.equal(tagsOf(back), 'Komödie');
        assert.equal(fake.calls.length, 1);
    } finally { fake.restore(); }

    const downId = nextEdition++;
    const down = createSeries(downId);
    seedOld(`mp_edition_info_${downId}`, { notFound: true });
    fake = withFakeMangaPassion(() => { throw new Error('ECONNREFUSED'); });
    try {
        const res = await fillTags(down);
        assert.equal(res.status, 503, 'an old 404 is no proof while Manga Passion is unreachable');
        assert.equal(res.body.code, 'MP_UNAVAILABLE');
        assert.equal(fake.calls.length, 1);
    } finally { fake.restore(); }

    const goneId = nextEdition++;
    const gone = createSeries(goneId);
    seedOld(`mp_edition_vols_${goneId}`, { notFound: true, edition: null, volumes: [] });
    fake = withFakeMangaPassion(() => ({ ok: false, status: 404, json: async () => ({}) }));
    try {
        const res = await fillTags(gone);
        assert.equal(res.status, 404);
        assert.equal(res.body.code, 'MP_EDITION_NOT_FOUND');
        assert.equal(fake.calls.length, 1);
        assert.equal((await fillTags(gone)).status, 404);
        assert.equal(fake.calls.length, 1, 'the fresh 404 answers without a second request');
    } finally { fake.restore(); }
});

test('sync-edition fills empty genres from the edition and never replaces existing ones', async () => {
    const editionId = nextEdition++;
    seedCache(`mp_edition_vols_${editionId}`, {
        edition: { id: editionId, title: 'Sync', publisher: 'Carlsen Manga', total_volumes: 3, author: 'A', tags: 'Comedy, Seinen' },
        volumes: []
    });
    const empty = createSeries(null);
    const tagged = createSeries(null, { tags: 'Eigene' });
    const fake = withFakeMangaPassion(() => { throw new Error('no network expected'); });
    try {
        assert.equal((await editor('POST', `/mangas/${empty}/sync-edition`, { edition_id: editionId })).status, 200);
        assert.equal(tagsOf(empty), 'Komödie, Seinen');
        assert.equal((await editor('POST', `/mangas/${tagged}/sync-edition`, { edition_id: editionId })).status, 200);
        assert.equal(tagsOf(tagged), 'Eigene');
    } finally { fake.restore(); }
});

test('volume lookup by ISBN alone names the ISBN when nothing is found (never "undefined")', async () => {
    const fake = withFakeMangaPassion(() => { throw new Error('ECONNREFUSED'); });
    try {
        const res = await editor('GET', '/volumes/lookup?isbn=9783551000017');
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.success, false);
        assert.doesNotMatch(res.body.message, /undefined/);
        assert.match(res.body.message, /9783551000017/);
    } finally { fake.restore(); }
});
