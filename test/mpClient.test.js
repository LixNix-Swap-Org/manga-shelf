const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-mpclient-test-'));
process.env.DATA_DIR = dataDir;

const { db, uploadsDir } = require('../db');
const mp = require('../mangaPassion');
const client = require('../services/mangaPassion/client');
const { buildSearchQueries } = require('../services/mangaPassion/classify');
const { cleanOrphanUploads } = require('../services/uploadCleanup');

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const queryOf = (url) => decodeURIComponent(String(url).split('title=')[1].split('&')[0]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const edition = (id, extra = {}) => ({ id, title: 'Edition ' + id, numVolumes: 3, status: 1, publishers: [{ name: 'Carlsen Manga' }], ...extra });

async function withFetch(stub, fn) {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => { calls.push(String(url)); return stub(String(url), opts); };
    try { return await fn(calls); } finally { global.fetch = realFetch; }
}

function cacheRow(key) {
    return db.prepare('SELECT json_data, created_at FROM manga_passion_cache WHERE cache_key = ?').get(key);
}
function seedCache(key, value, createdAt = Date.now()) {
    db.prepare(`INSERT INTO manga_passion_cache (cache_key, json_data, created_at) VALUES (?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET json_data = excluded.json_data, created_at = excluded.created_at`)
        .run(key, JSON.stringify(value), createdAt);
}
function clearSearchCache() {
    db.prepare("DELETE FROM manga_passion_cache WHERE cache_key LIKE 'mp_search_q_%'").run();
}
const vol = (n, extra = {}) => ({ id: 100 + n, volume_number: String(n), num: n, title: null, price: 8, release_date: null, is_released: true, ...extra });
const createManga = (title, total = 3, link = null) => Number(db.prepare(
    'INSERT INTO mangas (title, publisher, total_volumes, manga_passion_id) VALUES (?, ?, ?, ?)').run(title, 'Carlsen Manga', total, link).lastInsertRowid);
const linkOf = (id) => db.prepare('SELECT manga_passion_id AS v FROM mangas WHERE id = ?').get(id).v;

// --- outage vs. not found, deadline -------------------------------------------------------------

test('search: a network outage is reported as unavailable and stops after the first failed query', async () => {
    clearSearchCache();
    await withFetch(async () => { throw new TypeError('fetch failed'); }, async (calls) => {
        const res = await mp.searchMangaPassionEditions('Ausfall Reihe', 'Carlsen Manga', 3);
        assert.equal(res.unavailable, true);
        assert.deepEqual(res.candidates, []);
        assert.equal(res.recommended, null);
        assert.equal(calls.length, 1);
    });
});

test('search: 5xx answers count as an outage, never as "no edition found"', async () => {
    clearSearchCache();
    await withFetch(async () => json({}, 503), async (calls) => {
        const res = await mp.searchMangaPassionEditions('Serverfehler Reihe', 'Carlsen Manga', 3);
        assert.equal(res.unavailable, true);
        assert.ok(calls.length <= 2);
    });
    assert.equal(db.prepare("SELECT COUNT(*) c FROM manga_passion_cache WHERE cache_key LIKE 'mp_search_q_%'").get().c, 0);
});

test('search: one failing query among working ones still returns the hit', async () => {
    clearSearchCache();
    let n = 0;
    await withFetch(async (url) => (n++ === 0 ? json({}, 500)
        : json({ 'hydra:member': queryOf(url) === 'Teilausfall Reihe' ? [edition(9101, { title: 'Teilausfall Reihe' })] : [] })), async () => {
        const res = await mp.searchMangaPassionEditions('Teilausfall: Reihe', 'Carlsen Manga', 3);
        assert.equal(res.recommended?.id, 9101);
        assert.ok(!res.unavailable);
    });
});

test('search: empty 200 answers are a real "not found" and run every round', async () => {
    clearSearchCache();
    const title = 'Hells Paradise Jigokuraku';
    const { primary, variants, words } = buildSearchQueries(title);
    await withFetch(async () => json({ 'hydra:member': [] }), async (calls) => {
        const res = await mp.searchMangaPassionEditions(title);
        assert.ok(!res.unavailable);
        assert.equal(calls.length, new Set([...primary, ...variants, ...words].map(q => q.toLowerCase())).size);
    });
});

test('search: a stalled API is cut off by the overall deadline', async () => {
    clearSearchCache();
    const keepAlive = setInterval(() => {}, 1000);
    try {
        await withFetch((url, opts) => new Promise((resolve, reject) => {
            opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
        }), async (calls) => {
            const started = Date.now();
            const res = await mp.searchMangaPassionEditions('Haengende Reihe', '', null, { deadlineMs: 80, requestTimeoutMs: 5000 });
            assert.ok(Date.now() - started < 2000);
            assert.equal(res.unavailable, true);
            assert.equal(calls.length, 1);
        });
        await withFetch((url, opts) => new Promise((resolve, reject) => {
            opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
        }), async (calls) => {
            const res = await mp.searchMangaPassionEditions('Haengende Reihe Zwei', '', null, { deadlineMs: 5000, requestTimeoutMs: 40 });
            assert.equal(res.unavailable, true);
            assert.equal(calls.length, 1);
        });
    } finally { clearInterval(keepAlive); }
});

test('search: a caller signal (client gone) aborts the search', async () => {
    clearSearchCache();
    const keepAlive = setInterval(() => {}, 1000);
    const ac = new AbortController();
    try {
        await withFetch((url, opts) => new Promise((resolve, reject) => {
            opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
        }), async (calls) => {
            setTimeout(() => ac.abort(), 30);
            const res = await mp.searchMangaPassionEditions('Abgebrochene Reihe', '', null, { signal: ac.signal });
            assert.equal(res.unavailable, true);
            assert.equal(calls.length, 1);
        });
    } finally { clearInterval(keepAlive); }
});

// --- search cache --------------------------------------------------------------------------------

test('search cache: a repeated search asks the API only once and returns the same ranking', async () => {
    clearSearchCache();
    const stub = async () => json({ 'hydra:member': [edition(9201, { title: 'Cache Reihe' }), edition(9202, { title: 'Cache Reihe Extra' })] });
    const first = await withFetch(stub, async () => mp.searchMangaPassionEditions('Cache Reihe', 'Carlsen Manga', 3));
    await withFetch(stub, async (calls) => {
        const second = await mp.searchMangaPassionEditions('Cache Reihe', 'Carlsen Manga', 3);
        assert.equal(calls.length, 0);
        assert.deepEqual(second, first);
        // scoring stays local: other publisher/total use the same cached list
        const other = await mp.searchMangaPassionEditions('Cache Reihe', 'Tokyopop', 10);
        assert.equal(calls.length, 0);
        assert.equal(other.candidates.length, 2);
    });
    await withFetch(stub, async (calls) => {
        await mp.searchMangaPassionEditions('Cache Reihe', 'Carlsen Manga', 3, { forceRefresh: true });
        assert.ok(calls.length >= 1);
    });
});

test('search cache: an outage is not cached, the next call asks again', async () => {
    clearSearchCache();
    await withFetch(async () => { throw new TypeError('fetch failed'); }, async () => {
        await mp.searchMangaPassionEditions('Wackel Reihe');
    });
    await withFetch(async () => json({ 'hydra:member': [edition(9301, { title: 'Wackel Reihe' })] }), async (calls) => {
        const res = await mp.searchMangaPassionEditions('Wackel Reihe');
        assert.ok(calls.length >= 1);
        assert.equal(res.recommended?.id, 9301);
    });
});

test('search cache: an empty answer is cached for a shorter time only', async () => {
    clearSearchCache();
    const stub = async () => json({ 'hydra:member': [] });
    await withFetch(stub, async () => mp.searchMangaPassionEditions('Leere Reihe'));
    await withFetch(stub, async (calls) => {
        await mp.searchMangaPassionEditions('Leere Reihe');
        assert.equal(calls.length, 0);
    });
    db.prepare("UPDATE manga_passion_cache SET created_at = ? WHERE cache_key LIKE 'mp_search_q_%'").run(Date.now() - 2 * 60 * 60 * 1000);
    await withFetch(stub, async (calls) => {
        await mp.searchMangaPassionEditions('Leere Reihe');
        assert.ok(calls.length >= 1);
    });
});

test('reconcileMangaGaps: opening an unlinked, ambiguous series twice searches only once', async () => {
    clearSearchCache();
    const twin = (id) => edition(id, { title: 'Doppel Reihe' });
    const stub = async (url) => {
        if (url.includes('/editions?title=')) return json({ 'hydra:member': [twin(9401), twin(9402)] });
        if (/\/editions\/\d+\/volumes/.test(url)) return json({ 'hydra:member': [{ id: 1, number: 1, numberDisplay: '1', price: 700, date: '2020-01-01' }] });
        const m = url.match(/\/editions\/(\d+)$/);
        return m ? json(edition(Number(m[1]))) : json({}, 404);
    };
    const id = createManga('Doppel Reihe');
    await withFetch(stub, async (calls) => {
        await mp.reconcileMangaGaps(id);
        await mp.reconcileMangaGaps(id);
        assert.equal(linkOf(id), null);
        assert.equal(new Set(calls.filter(u => u.includes('/editions?title='))).size, calls.filter(u => u.includes('/editions?title=')).length);
    });
});

// --- edition details: partial results, pagination, ids, stale data ------------------------------

test('edition details: volumes without their edition are not returned as usable data', async () => {
    const id = 9501;
    await withFetch(async (url) => (url.includes('/volumes')
        ? json({ 'hydra:member': [{ id: 1, number: 1, numberDisplay: '1', price: 700, date: '2020-01-01' },
            { id: 2, number: null, numberDisplay: 'Leerschuber', type: 3, specialType: 1, price: 1200, date: '2020-01-01' }] })
        : json({}, 503)), async () => {
        const res = await mp.getEditionDetailsAndVolumes(id);
        assert.equal(res.edition, null);
        assert.equal(res.incomplete, true);
        assert.deepEqual(res.volumes, []);
        assert.equal(cacheRow(`mp_edition_vols_${id}`), undefined);

        const mangaId = createManga('Halbe Daten', 50, id);
        const gaps = await mp.reconcileMangaGaps(mangaId);
        assert.equal(gaps.success, false);
        assert.match(gaps.message, /nicht erreichbar/);
    });
});

test('edition details: invalid edition ids never reach the API or the cache', async () => {
    await withFetch(async () => json({}), async (calls) => {
        for (const bad of ['87?x', '1/../../volumes/5', '0', -1, 1.5, {}, null, '', '87abc']) {
            const res = await mp.getEditionDetailsAndVolumes(bad);
            assert.equal(res.notFound, true);
        }
        assert.equal(calls.length, 0);
    });
    assert.equal(db.prepare("SELECT COUNT(*) c FROM manga_passion_cache WHERE cache_key LIKE 'mp_edition_vols_%?%' OR cache_key LIKE 'mp_edition_vols_%/%'").get().c, 0);
    assert.equal(mp.toEditionId('87'), 87);
    assert.equal(mp.toEditionId(' 087 '), 87);
    assert.equal(mp.toEditionId('87?x'), null);
    assert.equal(mp.toEditionId(2 ** 60), null);

    seedCache('mp_edition_vols_9502', { edition: { id: 9502, title: 'X', publisher: 'Carlsen Manga', author: 'A' }, volumes: [vol(1)] });
    await withFetch(async () => json({}), async (calls) => {
        assert.equal((await mp.getEditionDetailsAndVolumes('9502')).edition.id, 9502);
        assert.equal(calls.length, 0);
    });
});

test('edition details: a 404 on a later volume page is incomplete, never cached as complete', async () => {
    const id = 9601;
    const page1 = { 'hydra:member': Array.from({ length: 3 }, (_, i) => ({ id: i + 1, number: i + 1, numberDisplay: String(i + 1), price: 700 })),
        'hydra:view': { 'hydra:next': `/editions/${id}/volumes?itemsPerPage=100&page=2` } };
    const stub = async (url) => {
        if (url.includes('page=2')) return json({}, 404);
        if (url.includes('/volumes')) return json(page1);
        return json(edition(id));
    };
    await withFetch(stub, async () => {
        const res = await mp.getEditionDetailsAndVolumes(id);
        assert.equal(res.incomplete, true);
        assert.equal(res.volumes.length, 3);
        assert.equal(cacheRow(`mp_edition_vols_${id}`), undefined);
    });

    const good = { edition: { id, title: 'Gut', publisher: 'Carlsen Manga', author: 'A', total_volumes: 5 }, volumes: [1, 2, 3, 4, 5].map(n => vol(n)) };
    seedCache(`mp_edition_vols_${id}`, good, 1000);
    await withFetch(stub, async () => {
        const res = await mp.getEditionDetailsAndVolumes(id, true);
        assert.equal(res.volumes.length, 5);
        assert.equal(res.stale, true);
        assert.equal(cacheRow(`mp_edition_vols_${id}`).created_at, 1000);
    });

    await withFetch(async (url) => (url.includes('/volumes') ? json({}, 404) : json(edition(9602))), async () => {
        const res = await mp.getEditionDetailsAndVolumes(9602);
        assert.equal(res.notFound, true);
        assert.equal(JSON.parse(cacheRow('mp_edition_vols_9602').json_data).notFound, true);
    });
});

test('edition details: pagination is capped, stops on a repeated link and stays on the API host', async () => {
    const loop = async (url) => (url.includes('/volumes')
        ? json({ 'hydra:member': [{ id: 1, number: 1, numberDisplay: '1' }], 'hydra:view': { 'hydra:next': '/editions/9701/volumes?page=2' } })
        : json(edition(9701)));
    await withFetch(loop, async (calls) => {
        const res = await mp.getEditionDetailsAndVolumes(9701);
        assert.equal(res.incomplete, true);
        assert.ok(calls.length <= client.MAX_VOLUME_PAGES + 1);
        assert.equal(cacheRow('mp_edition_vols_9701'), undefined);
    });

    let page = 0;
    const endless = async (url) => (url.includes('/volumes')
        ? json({ 'hydra:member': [{ id: ++page, number: page, numberDisplay: String(page) }], 'hydra:view': { 'hydra:next': `/editions/9702/volumes?page=${page + 1}` } })
        : json(edition(9702)));
    await withFetch(endless, async (calls) => {
        const res = await mp.getEditionDetailsAndVolumes(9702);
        assert.equal(res.incomplete, true);
        assert.equal(calls.filter(u => u.includes('/volumes')).length, client.MAX_VOLUME_PAGES);
    });

    for (const foreign of ['https://evil.example/x', '//evil.example/x', 'http://api.manga-passion.de/editions/9703/volumes?page=2']) {
        db.prepare("DELETE FROM manga_passion_cache WHERE cache_key = 'mp_edition_vols_9703'").run();
        await withFetch(async (url) => (url.includes('/volumes')
            ? json({ 'hydra:member': [{ id: 1, number: 1, numberDisplay: '1' }], 'hydra:view': { 'hydra:next': foreign } })
            : json(edition(9703))), async (calls) => {
            const res = await mp.getEditionDetailsAndVolumes(9703);
            assert.equal(res.incomplete, true, foreign);
            assert.ok(calls.every(u => u.startsWith('https://api.manga-passion.de/')), foreign);
        });
    }

    await withFetch(async (url) => {
        if (url.includes('page=2')) return json({ 'hydra:member': [{ id: 2, number: 2, numberDisplay: '2' }] });
        if (url.includes('/volumes')) return json({ 'hydra:member': [{ id: 1, number: 1, numberDisplay: '1' }], 'hydra:view': { 'hydra:next': 'https://api.manga-passion.de/editions/9704/volumes?page=2' } });
        return json(edition(9704));
    }, async () => {
        const res = await mp.getEditionDetailsAndVolumes(9704);
        assert.equal(res.incomplete, undefined);
        assert.equal(res.volumes.length, 2);
        assert.ok(cacheRow('mp_edition_vols_9704'));
    });
});

test('edition details: stale data is flagged, normalized and its release flags are recomputed', async () => {
    const id = 9801;
    seedCache(`mp_edition_vols_${id}`, {
        edition: { id, title: 'Alt', publisher: 'Carlsen Manga!', author: 'A', total_volumes: 3 },
        volumes: [vol(1, { release_date: '2020-01-01' }), vol(2, { release_date: '2026-01-15', is_released: false }), vol(3, { release_date: null, is_released: false })]
    }, 0);
    await withFetch(async () => { throw new TypeError('fetch failed'); }, async () => {
        const res = await mp.getEditionDetailsAndVolumes(id);
        assert.equal(res.stale, true);
        assert.equal(res.incomplete, undefined);
        assert.equal(res.edition.publisher, 'Carlsen Manga');
        assert.equal(res.volumes[1].is_released, true);
        assert.equal(res.volumes[2].is_released, false);

        const mangaId = createManga('Alte Reihe', 3, id);
        const gaps = await mp.reconcileMangaGaps(mangaId);
        assert.equal(gaps.gaps.find(g => String(g.volume_number) === '2').is_released, true);
    });

    seedCache('mp_edition_vols_9802', { edition: { id: 9802, title: 'Frisch', publisher: 'Carlsen Manga', author: 'A' },
        volumes: [vol(1, { release_date: '2026-01-15', is_released: false })] });
    const fresh = await mp.getEditionDetailsAndVolumes(9802);
    assert.equal(fresh.volumes[0].is_released, true);
    assert.equal(fresh.stale, undefined);

    seedCache('mp_edition_vols_9803', { notFound: true, edition: null, volumes: [] });
    assert.deepEqual(await mp.getEditionDetailsAndVolumes(9803), { notFound: true, edition: null, volumes: [] });
});

test('edition details: status mapping and no customArrangement in the mapped volumes', async () => {
    assert.equal(client.mapEditionStatus(2), 'Abgeschlossen');
    assert.equal(client.mapEditionStatus(1), 'Laufend');
    assert.equal(client.mapEditionStatus(0), 'Unbekannt');
    await withFetch(async (url) => (url.includes('/volumes')
        ? json({ 'hydra:member': [{ id: 1, number: null, numberDisplay: 'Leerschuber', type: 3, specialType: 1, arrangement: 1, customArrangement: 5 }] })
        : json(edition(9901))), async () => {
        const res = await mp.getEditionDetailsAndVolumes(9901);
        assert.equal('customArrangement' in res.volumes[0], false);
    });
});

// --- auto-link race and read-only callers -------------------------------------------------------

function raceApi() {
    return async (url) => {
        if (url.includes('/editions?title=')) {
            await sleep(150);
            return json({ 'hydra:member': [edition(87, { title: 'Konflikt Reihe' })] });
        }
        if (url.includes('/editions/87/volumes')) return json({ 'hydra:member': [{ id: 871, number: 1, numberDisplay: '1', price: 700, date: '2020-01-01' }] });
        if (url.endsWith('/editions/87')) return json(edition(87, { title: 'Konflikt Reihe' }));
        return json({}, 404);
    };
}
function seedUserEdition() {
    seedCache('mp_edition_vols_4242', { edition: { id: 4242, title: 'Gewaehlt', publisher: 'Carlsen Manga', author: 'A', total_volumes: 3 },
        volumes: [vol(1, { id: 42421, release_date: '2019-05-05', price: 9 })] });
}

test('auto-link: an edition stored while the search ran wins over the guess', async () => {
    clearSearchCache();
    seedUserEdition();
    const id = createManga('Konflikt Reihe');
    await withFetch(raceApi(), async () => {
        const pending = mp.reconcileMangaGaps(id);
        await sleep(50);
        db.prepare('UPDATE mangas SET manga_passion_id = 4242 WHERE id = ?').run(id);
        const res = await pending;
        assert.equal(linkOf(id), 4242);
        assert.equal(res.edition.id, 4242);
        assert.equal(res.link_confirmed, true);
    });
});

test('auto-link: autofill uses the edition the user stored meanwhile', async () => {
    clearSearchCache();
    seedUserEdition();
    const id = createManga('Konflikt Reihe');
    db.prepare('INSERT INTO volumes (manga_id, volume_number, status, type) VALUES (?, ?, ?, ?)').run(id, '1', 'Vorhanden', 'volume');
    await withFetch(raceApi(), async () => {
        const pending = mp.autofillMangaVolumes(id);
        await sleep(50);
        db.prepare('UPDATE mangas SET manga_passion_id = 4242 WHERE id = ?').run(id);
        await pending;
        assert.equal(linkOf(id), 4242);
        const v = db.prepare('SELECT release_date, price FROM volumes WHERE manga_id = ?').get(id);
        assert.equal(v.release_date, '2019-05-05');
        assert.equal(v.price, 9);
    });
});

test('auto-link: without a concurrent choice the confident match is stored', async () => {
    clearSearchCache();
    const id = createManga('Konflikt Reihe');
    await withFetch(raceApi(), async () => {
        const res = await mp.reconcileMangaGaps(id);
        assert.equal(linkOf(id), 87);
        assert.equal(res.link_confirmed, true);
    });
});

test('linkRecommendedEdition: persist=false never writes, the conditional save never overwrites', () => {
    const searchRes = { recommended: { id: 87 }, candidates: [{ id: 87, score: 260, title_relation: 'exact' }] };
    const id = createManga('Nur lesen');
    const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(id);
    const res = client.linkRecommendedEdition(manga, searchRes, { persist: false });
    assert.deepEqual(res, { editionId: 87, confident: true });
    assert.equal(linkOf(id), null);

    db.prepare('UPDATE mangas SET manga_passion_id = 4242 WHERE id = ?').run(id);
    assert.equal(client.saveEditionLink({ id }, 87), false);
    assert.equal(linkOf(id), 4242);
    assert.deepEqual(client.linkRecommendedEdition({ id }, { recommended: null, candidates: [], unavailable: true }),
        { editionId: 4242, confident: true, superseded: true });
    const other = createManga('Ausfall Link');
    assert.deepEqual(client.linkRecommendedEdition({ id: other }, { recommended: null, candidates: [], unavailable: true }),
        { editionId: null, confident: false, unavailable: true });
});

// --- cover reuse --------------------------------------------------------------------------------

test('cover reuse refreshes the mtime so the orphan cleanup keeps it', async () => {
    const url = 'https://unreachable.invalid/cover.jpg';
    const name = `mp-cov-${crypto.createHash('md5').update(url).digest('hex').slice(0, 16)}.jpg`;
    const file = path.join(uploadsDir, name);
    fs.writeFileSync(file, Buffer.alloc(800, 1));
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(file, old, old);

    assert.equal(await client.downloadRemoteImageToUploads(url), `/uploads/${name}`);
    assert.ok(Date.now() - fs.statSync(file).mtimeMs < 60 * 1000);
    assert.ok(!cleanOrphanUploads().files.includes(name));
    assert.ok(fs.existsSync(file));
});

// --- lookup -------------------------------------------------------------------------------------

test('lookup: only edition metadata is loaded, no volume pages, weak candidates use the search fields', async () => {
    clearSearchCache();
    const stub = async (url) => {
        if (url.includes('/editions?title=')) {
            return json({ 'hydra:member': [edition(9911, { title: 'Nachschlage Reihe' }), edition(9912, { title: 'Voellig Anders Xyz' })] });
        }
        const m = url.match(/\/editions\/(\d+)$/);
        if (m) return json({ ...edition(Number(m[1]), { title: 'Nachschlage Reihe' }), description: 'Text', sources: [{ romaji: 'Rom', contributors: [{ contributor: { name: 'Autorin' } }] }] });
        return json({}, 404);
    };
    await withFetch(stub, async (calls) => {
        const res = await mp.searchMangaPassionForLookup('Nachschlage Reihe');
        assert.equal(calls.filter(u => u.includes('/volumes')).length, 0);
        const hit = res.find(r => r.manga_passion_id === 9911);
        assert.equal(hit.author, 'Autorin');
        assert.equal(hit.alt_title, 'Rom');
        assert.equal(hit.description, 'Text');
        assert.ok(!calls.some(u => u.endsWith('/editions/9912')));
        assert.ok(res.some(r => r.manga_passion_id === 9912));
    });
    await withFetch(stub, async (calls) => {
        await mp.searchMangaPassionForLookup('Nachschlage Reihe');
        assert.equal(calls.length, 0);
    });
});

test('lookup: a fresh full edition entry is reused and a failed edition fetch is not cached', async () => {
    clearSearchCache();
    seedCache('mp_edition_vols_9921', { edition: { id: 9921, title: 'Vorrat Reihe', publisher: 'Carlsen Manga', author: 'Aus Cache', status: 'Laufend' }, volumes: [vol(1)] });
    await withFetch(async (url) => {
        if (url.includes('/editions?title=')) return json({ 'hydra:member': [edition(9921, { title: 'Vorrat Reihe' }), edition(9922, { title: 'Vorrat Reihe Zwei' })] });
        return json({}, 503);
    }, async (calls) => {
        const res = await mp.searchMangaPassionForLookup('Vorrat Reihe');
        assert.equal(res.find(r => r.manga_passion_id === 9921).author, 'Aus Cache');
        assert.ok(!calls.some(u => u.endsWith('/editions/9921')));
        assert.equal(res.find(r => r.manga_passion_id === 9922).title, 'Vorrat Reihe Zwei');
    });
    assert.equal(cacheRow('mp_edition_info_9922'), undefined);
});

test('lookup: the "Unbekannt" placeholder never becomes status or publisher', async () => {
    clearSearchCache();
    await withFetch(async (url) => {
        if (url.includes('/editions?title=')) return json({ 'hydra:member': [{ id: 9931, title: 'Platzhalter Reihe', status: 0, publishers: [] }] });
        return json({ id: 9931, title: 'Platzhalter Reihe', status: 0, publishers: [] });
    }, async () => {
        const [hit] = await mp.searchMangaPassionForLookup('Platzhalter Reihe');
        assert.equal(hit.publisher, null);
        assert.equal(hit.status, 'Laufend');
    });
});

test('edition details: a month-only volume keeps "YYYY-MM" instead of the last day Manga Passion sends', async () => {
    const id = 9931;
    const volumes = [
        { id: 99311, number: 1, numberDisplay: '1', date: '2026-11-30T00:00:00+00:00', year: 2026, month: 11, day: null },
        { id: 99312, number: 2, numberDisplay: '2', date: '2020-02-29T00:00:00+00:00', year: 2020, month: 2, day: null },
        { id: 99313, number: 3, numberDisplay: '3', date: '2026-12-04T00:00:00+00:00', year: 2026, month: 12, day: 4 }
    ];
    await withFetch(async (url) => {
        if (url.includes(`/editions/${id}/volumes`)) return json({ 'hydra:member': volumes });
        if (url.endsWith(`/editions/${id}`)) return json(edition(id));
        return json({}, 404);
    }, async () => {
        const res = await mp.getEditionDetailsAndVolumes(id, true);
        assert.deepEqual(res.volumes.map(v => v.release_date), ['2026-11', '2020-02', '2026-12-04']);
        assert.equal(res.volumes[1].is_released, true);
    });
    // a month-only date counts as released once the month is over, also when read from the cache
    const cached = await mp.getEditionDetailsAndVolumes(id);
    assert.equal(cached.volumes[0].release_date, '2026-11');
    const { isOfficialReleased } = require('../services/mangaPassion/classify');
    assert.equal(cached.volumes[0].is_released, isOfficialReleased('2026-11'));
});
