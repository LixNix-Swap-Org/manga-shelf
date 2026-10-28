// The live season chain (GET /anime/:id/season-chain) and the discover views against a fake AniList: stored relations
// of the collection first, one cached request per step beyond them, the request cap, and nothing asked when
// ANIME_SOURCES leaves AniList out.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeFetch, memoryWith, json } = require('./helpers');

const node = (id) => ({
    id, type: 'ANIME', format: 'TV', status: 'FINISHED', episodes: 12, seasonYear: 2000 + (id % 100), title: { romaji: `Staffel ${id % 100}` }
});

/** AniList media of a TV franchise of `count` seasons with the ids base+1 … base+count, linked by PREQUEL/SEQUEL. */
function franchise(base, count) {
    const media = {};
    for (let n = 1; n <= count; n += 1) {
        const id = base + n;
        const edges = [];
        if (n > 1) edges.push({ relationType: 'PREQUEL', node: node(id - 1) });
        if (n < count) edges.push({ relationType: 'SEQUEL', node: node(id + 1) });
        media[id] = { ...node(id), relations: { edges } };
    }
    return media;
}

/** The relations column the store writes for an AniList media. */
const storedRelations = (media) => JSON.stringify(media.relations.edges.map((e) => ({
    relation: e.relationType, kind: 'ANIME', anilist_id: e.node.id, mal_id: null, title: e.node.title.romaji, format: e.node.format,
    status: e.node.status, episodes: e.node.episodes, season_year: e.node.seasonYear, cover_url: null
})));

/** id_in answers from `media`; ids in `fail` answer 500. `asked` lists the ids of every id_in request. */
function aniList(media, { fail = new Set() } = {}) {
    const asked = [];
    const handler = (body) => {
        const ids = (body.variables && body.variables.ids) || [];
        if (!body.query.includes('id_in')) return json({ data: { Page: { pageInfo: { hasNextPage: false }, media: [] } } });
        asked.push(...ids);
        if (ids.some((id) => fail.has(id))) return json({ errors: [{ message: 'kaputt' }] }, { status: 500 });
        return json({ data: { Page: { media: ids.map((id) => media[id]).filter(Boolean) } } });
    };
    return { handler, asked };
}

function coreWith(fake, sources) {
    const http = fakeFetch({ anilist: fake.handler });
    const core = memoryWith(http.fetch, sources ? { config: { appTimeZone: 'Europe/Berlin', appVersion: 'test', anime: { sources } } } : {});
    return { core, http, ed: core.client('ed') };
}

/** Puts season n of `media` into the collection with its stored relations; returns the entry id. */
const addSeason = (core, media, id) => Number(core.run('INSERT INTO animes (title, anilist_id, format, relations) VALUES (?, ?, ?, ?)',
    media[id].title.romaji, id, 'TV', storedRelations(media[id])).lastInsertRowid);

const titles = (res) => res.body.seasons.map((s) => s.title);

test('season chain: entries in the collection lend their stored relations; AniList is asked only beyond them, once per step', async () => {
    const media = franchise(7000, 6);
    const fake = aniList(media);
    const { core, http, ed } = coreWith(fake);
    const s1 = addSeason(core, media, 7001);
    const s2 = addSeason(core, media, 7002);

    const fromTwo = await ed('GET', `/anime/${s2}/season-chain`);
    assert.equal(fromTwo.status, 200, JSON.stringify(fromTwo.body));
    assert.deepEqual(titles(fromTwo), ['Staffel 1', 'Staffel 2', 'Staffel 3', 'Staffel 4', 'Staffel 5', 'Staffel 6']);
    assert.deepEqual(fromTwo.body.seasons.map((s) => s.in_collection_id), [s1, s2, null, null, null, null]);
    assert.deepEqual(fake.asked.sort(), [7001, 7003, 7004, 7005, 7006], 'one request per step outside the collection, plus the stored end (season 1) for a newly announced prequel');

    const fromOne = await ed('GET', `/anime/${s1}/season-chain`);
    assert.deepEqual(titles(fromOne), titles(fromTwo));
    assert.equal(http.count('anilist'), 5, 'the neighbouring season reuses the cached steps');
    await core.close();
});

test('season chain: a whole franchise in the collection asks only about its two ends, once', async () => {
    const media = franchise(7100, 6);
    const fake = aniList(media);
    const { core, http, ed } = coreWith(fake);
    const ids = Object.keys(media).map((id) => addSeason(core, media, Number(id)));
    for (const id of ids) assert.deepEqual(titles(await ed('GET', `/anime/${id}/season-chain`)).length, 6);
    assert.deepEqual(fake.asked.sort(), [7101, 7106], 'the first and the last season, then from the cache');
    assert.equal(http.count('anilist'), 2);
    await core.close();
});

test('season chain: a sequel announced after the newest season was stored is found', async () => {
    const media = franchise(7500, 7);
    const fake = aniList(media);
    const { core, ed } = coreWith(fake);
    const stale = { ...media[7506], relations: { edges: media[7506].relations.edges.filter((e) => e.relationType !== 'SEQUEL') } };
    const s5 = addSeason(core, media, 7505);
    const s6 = addSeason(core, { 7506: stale }, 7506);
    const res = await ed('GET', `/anime/${s5}/season-chain`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(titles(res).includes('Staffel 7'), 'the stored newest season has no sequel yet; AniList knows it');
    assert.deepEqual(res.body.seasons.find((s) => s.title === 'Staffel 6').in_collection_id, s6);
    await core.close();
});

test('season chain: a canon OVA or movie between two TV seasons is bridged without appearing as a season', async () => {
    const s1Node = { ...node(7601), title: { romaji: 'Staffel 1' } };
    const ovaNode = { id: 7602, type: 'ANIME', format: 'OVA', status: 'FINISHED', episodes: 3, seasonYear: 2023, title: { romaji: 'Zwischen-OVA' } };
    const s2Node = { ...node(7603), title: { romaji: 'Staffel 2' } };
    const s3Node = { ...node(7604), title: { romaji: 'Staffel 3' } };
    const media = {
        7601: { ...s1Node, relations: { edges: [{ relationType: 'SEQUEL', node: ovaNode }] } },
        7602: { ...ovaNode, relations: { edges: [{ relationType: 'PREQUEL', node: s1Node }, { relationType: 'SEQUEL', node: s2Node }] } },
        7603: { ...s2Node, relations: { edges: [{ relationType: 'PREQUEL', node: ovaNode }, { relationType: 'SEQUEL', node: s3Node }] } },
        7604: { ...s3Node, relations: { edges: [{ relationType: 'PREQUEL', node: s2Node }] } }
    };
    const fake = aniList(media);
    const { core, ed } = coreWith(fake);
    const s1 = addSeason(core, media, 7601);

    const fromOne = await ed('GET', `/anime/${s1}/season-chain`);
    assert.equal(fromOne.status, 200, JSON.stringify(fromOne.body));
    assert.deepEqual(titles(fromOne), ['Staffel 1', 'Staffel 2', 'Staffel 3']);

    // also works in the stored season_chain when the bridge OVA and season 2 are in the collection
    addSeason(core, media, 7602);
    const s2 = addSeason(core, media, 7603);
    const detail = await ed('GET', `/anime/${s1}`);
    assert.deepEqual(detail.body.season_chain.map((s) => s.title), ['Staffel 1', 'Staffel 2', 'Staffel 3']);
    assert.deepEqual(detail.body.season_chain.map((s) => s.in_collection_id), [s1, s2, null]);
    await core.close();
});

test('season chain: a failed step answers 503 and keeps the steps before it; the retry asks only from there', async () => {
    const media = franchise(7200, 6);
    const fail = new Set([7205]);
    const fake = aniList(media, { fail });
    const { core, ed } = coreWith(fake);
    const s1 = addSeason(core, media, 7201);

    const failed = await ed('GET', `/anime/${s1}/season-chain`);
    assert.deepEqual([failed.status, failed.body.code], [503, 'SOURCES_UNAVAILABLE']);
    assert.deepEqual(fake.asked, [7202, 7203, 7204, 7205]);
    fail.clear();
    fake.asked.length = 0;
    const retry = await ed('GET', `/anime/${s1}/season-chain`);
    assert.equal(retry.status, 200);
    assert.equal(titles(retry).length, 6);
    assert.deepEqual(fake.asked, [7205, 7206, 7201], 'steps 2 to 4 come from the cache; then the stored first season is asked once for a prequel');
    await core.close();
});

test('season chain: at most 12 AniList requests per call, the next call goes on from the cache', async () => {
    const media = franchise(7300, 30);
    const fake = aniList(media);
    const { core, ed } = coreWith(fake);
    const middle = addSeason(core, media, 7315);

    const first = await ed('GET', `/anime/${middle}/season-chain`);
    assert.equal(first.status, 200);
    assert.equal(fake.asked.length, 12);
    assert.ok(titles(first).length < 25, 'the cap ends the walk');
    const longer = await ed('GET', `/anime/${middle}/season-chain`);
    assert.equal(titles(longer).length, 25, 'the second call walks on from the cached steps: 12 each way');
    assert.ok(fake.asked.length - 12 <= 12);
    await core.close();
});

test('ANIME_SOURCES without AniList: the season chain answers the stored chain, discover answers 503, no AniList request', async () => {
    const media = franchise(7400, 4);
    const fake = aniList(media);
    const { core, http, ed } = coreWith(fake, ['jikan']);
    const s1 = addSeason(core, media, 7401);
    const s2 = addSeason(core, media, 7402);
    core.run("INSERT INTO anime_progress (anime_id, user_id, status, score) VALUES (?, 2, 'Gesehen', 9)", s1);

    const chain = await ed('GET', `/anime/${s2}/season-chain`);
    assert.equal(chain.status, 200, JSON.stringify(chain.body));
    assert.deepEqual(titles(chain), ['Staffel 1', 'Staffel 2', 'Staffel 3'], 'the stored chain: the neighbour outside the collection ends it');
    assert.deepEqual(titles(chain), (await ed('GET', `/anime/${s2}`)).body.season_chain.map((s) => s.title));
    for (const url of ['/anime/discover/season?season=FALL&year=2025', '/anime/discover/recommendations']) {
        const res = await ed('GET', url);
        assert.deepEqual([res.status, res.body.code, res.body.error], [503, 'SOURCES_UNAVAILABLE', 'AniList ist gerade nicht erreichbar. Bitte später erneut versuchen.'], url);
    }
    assert.equal(http.count('anilist'), 0);
    await core.close();

    // the same calls with AniList on do reach the fake
    const on = coreWith(aniList(media));
    const t1 = addSeason(on.core, media, 7401);
    const t2 = addSeason(on.core, media, 7402);
    on.core.run("INSERT INTO anime_progress (anime_id, user_id, status, score) VALUES (?, 2, 'Gesehen', 9)", t1);
    assert.equal((await on.ed('GET', `/anime/${t2}/season-chain`)).status, 200);
    assert.equal((await on.ed('GET', '/anime/discover/season?season=FALL&year=2025')).status, 200);
    await on.ed('GET', '/anime/discover/recommendations');
    assert.ok(on.http.count('anilist') >= 4);
    await on.core.close();
});

test('season chain: an OVA between two seasons is walked through in both directions and not listed', async () => {
    // season 1 -> OVA -> season 2 -> season 3, the shape AniList has for That Time I Got Reincarnated as a Slime
    const ova = { id: 7901, type: 'ANIME', format: 'OVA', status: 'FINISHED', episodes: 2, seasonYear: 2023, title: { romaji: 'Zwischen-OVA' } };
    const media = {
        7900: { ...node(7900), relations: { edges: [{ relationType: 'SEQUEL', node: ova }] } },
        7901: { ...ova, relations: { edges: [{ relationType: 'PREQUEL', node: node(7900) }, { relationType: 'SEQUEL', node: node(7902) }] } },
        7902: { ...node(7902), relations: { edges: [{ relationType: 'PREQUEL', node: ova }, { relationType: 'SEQUEL', node: node(7903) }] } },
        7903: { ...node(7903), relations: { edges: [{ relationType: 'PREQUEL', node: node(7902) }] } }
    };
    const fake = aniList(media);
    const { core, ed } = coreWith(fake);
    const s1 = addSeason(core, media, 7900);
    const s3 = addSeason(core, media, 7903);
    const expected = ['Staffel 0', 'Staffel 2', 'Staffel 3'];

    const forward = await ed('GET', `/anime/${s1}/season-chain`);
    assert.equal(forward.status, 200, JSON.stringify(forward.body));
    assert.deepEqual(titles(forward), expected, 'the OVA links season 1 to season 2 but is no season');
    const backward = await ed('GET', `/anime/${s3}/season-chain`);
    assert.deepEqual(titles(backward), expected, 'the same line from the last season');
    assert.ok(!titles(forward).includes('Zwischen-OVA'));
    await core.close();
});

test('season chain: the stored chain of the detail also steps through an OVA that is in the collection', async () => {
    const ova = { id: 7911, type: 'ANIME', format: 'OVA', status: 'FINISHED', episodes: 2, seasonYear: 2023, title: { romaji: 'Zwischen-OVA' } };
    const media = {
        7910: { ...node(7910), relations: { edges: [{ relationType: 'SEQUEL', node: ova }] } },
        7911: { ...ova, relations: { edges: [{ relationType: 'PREQUEL', node: node(7910) }, { relationType: 'SEQUEL', node: node(7912) }] } },
        7912: { ...node(7912), relations: { edges: [{ relationType: 'PREQUEL', node: ova }] } }
    };
    const { core, ed } = coreWith(aniList(media), ['jikan']);
    const s1 = addSeason(core, media, 7910);
    core.run('INSERT INTO animes (title, anilist_id, format, relations) VALUES (?, ?, ?, ?)', 'Zwischen-OVA', 7911, 'OVA', storedRelations(media[7911]));
    addSeason(core, media, 7912);
    const detail = await ed('GET', `/anime/${s1}`);
    assert.deepEqual(detail.body.season_chain.map((s) => s.title), ['Staffel 10', 'Staffel 12']);
    await core.close();
});

test('season chain: an OVA that is not in the collection is bridged through the season that names it (detail and AniList off)', async () => {
    // season 1 -> OVA -> season 2 -> season 3; only the three seasons are in the collection, the OVA is not
    const ova = { id: 7921, type: 'ANIME', format: 'OVA', status: 'FINISHED', episodes: 2, seasonYear: 2023, title: { romaji: 'Zwischen-OVA' } };
    const media = {
        7920: { ...node(7920), relations: { edges: [{ relationType: 'SEQUEL', node: ova }] } },
        7921: { ...ova, relations: { edges: [{ relationType: 'PREQUEL', node: node(7920) }, { relationType: 'SEQUEL', node: node(7922) }] } },
        7922: { ...node(7922), relations: { edges: [{ relationType: 'PREQUEL', node: ova }, { relationType: 'SEQUEL', node: node(7923) }] } },
        7923: { ...node(7923), relations: { edges: [{ relationType: 'PREQUEL', node: node(7922) }] } }
    };
    const fake = aniList(media);
    const { core, ed } = coreWith(fake, ['jikan']);
    const s1 = addSeason(core, media, 7920);
    addSeason(core, media, 7922);
    const s3 = addSeason(core, media, 7923);
    const expected = ['Staffel 20', 'Staffel 22', 'Staffel 23'];

    assert.deepEqual((await ed('GET', `/anime/${s1}`)).body.season_chain.map((s) => s.title), expected, 'forward from season 1');
    assert.deepEqual((await ed('GET', `/anime/${s3}`)).body.season_chain.map((s) => s.title), expected, 'back from season 3');
    const live = await ed('GET', `/anime/${s1}/season-chain`);
    assert.equal(live.status, 200, JSON.stringify(live.body));
    assert.deepEqual(titles(live), expected, 'the live chain without AniList uses the same stored relations');
    assert.deepEqual(fake.asked, [], 'nothing is asked from AniList');
    await core.close();
});
