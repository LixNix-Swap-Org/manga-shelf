// POST /anime/watch-sync on the memory core: matching chain, monotonic progress, unmatched answers, roles and the guards.
const test = require('node:test');
const assert = require('node:assert/strict');
const gateway = require('../../core/anime/gateway');
const listSync = require('../../core/anime/listSync');
const watch = require('../../core/handlers/watch');
const cr = require('../../core/watch/crunchyroll');
const { memoryWith, fixture, offline, ctxAs } = require('./helpers');

test.afterEach(() => gateway.resetGatewayState());

// every clock read moves 31 s on, so the per-user throttle never hides a run; the throttle test passes its own clock
const newCore = (now) => {
    let t = Date.parse('2026-10-04T10:00:00Z');
    return memoryWith(async (url) => { throw offline(url); }, { now: now || (() => new Date(t += 31 * 1000)) });
};
const addAnime = (core, columns) => {
    const keys = Object.keys(columns);
    return Number(core.conn.prepare(`INSERT INTO animes (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => columns[k])).lastInsertRowid);
};
const userId = (core, name) => core.users.find((u) => u.username === name).id;
const progressOf = (core, animeId, name = 'ed') => core.conn.prepare('SELECT * FROM anime_progress WHERE anime_id = ? AND user_id = ?').get(animeId, userId(core, name));
const setProgress = (core, animeId, name, status, episodes) => core.conn.prepare('INSERT INTO anime_progress (anime_id, user_id, status, episodes_watched) VALUES (?, ?, ?, ?)')
    .run(animeId, userId(core, name), status, episodes);
const seasonLinks = (core) => core.conn.prepare("SELECT anime_id, external_id FROM anime_links WHERE service LIKE 'crunchyroll:season:%' ORDER BY anime_id, external_id").all()
    .map((r) => [r.anime_id, r.external_id]);
const SERIES_LINK = JSON.stringify([{ site: 'Crunchyroll', url: 'https://www.crunchyroll.com/series/GTESTSER01/frieren-beyond-journeys-end', type: 'STREAMING' }]);
const item = (fields) => ({ external_id: 'GTESTKRN01', series_title: null, season: 1, fully_watched: true, resume_url: null, watched_at: null, ...fields });
const fixtureItems = () => cr.mergeItems(cr.parseWatchHistory(fixture('crunchyroll/watch-history.json')), cr.parseDiscoverHistory(fixture('crunchyroll/discover-history.json')));

test('history from the fixtures: seasons by AniList link and title, titles for the rest, resume link, learned season links', async () => {
    const core = newCore();
    const s1 = addAnime(core, { title: 'Frieren', title_english: 'Frieren: Beyond Journey’s End', episodes: 28, external_links: SERIES_LINK });
    const s2 = addAnime(core, { title: 'Sousou no Frieren 2nd Season', title_english: 'Frieren: Beyond Journey’s End Season 2', episodes: 10, external_links: SERIES_LINK });
    const dungeon = addAnime(core, { title: 'Dungeon Meshi', title_english: 'Delicious in Dungeon', episodes: 24 });
    const ed = core.client('ed');

    const res = await ed('POST', '/anime/watch-sync', cr.syncBody(fixtureItems()));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, {
        applied: [
            { anime_id: s1, episodes_watched: 7, status: 'Schaue' },
            { anime_id: s2, episodes_watched: 2, status: 'Schaue' },
            { anime_id: dungeon, episodes_watched: 3, status: 'Schaue' }
        ],
        unmatched: [],
        unchanged: 0
    });
    const first = progressOf(core, s1);
    assert.deepEqual([first.resume_url, first.resume_episode], ['https://www.crunchyroll.com/watch/GTESTEP008/test-episode-eight', 8]);
    assert.deepEqual([progressOf(core, dungeon).resume_url, progressOf(core, dungeon).resume_episode], ['https://www.crunchyroll.com/watch/GTESTDG004/test-dungeon-four', 4]);
    assert.deepEqual(seasonLinks(core), [[s1, 'GTESTSER01:1'], [s2, 'GTESTSER01:2']], 'link matches are learned per season, title matches are not');
    assert.equal(core.conn.prepare("SELECT COUNT(*) AS n FROM anime_links WHERE service = 'crunchyroll'").get().n, 0, 'no series link is invented');

    const again = await ed('POST', '/anime/watch-sync', cr.syncBody(fixtureItems()));
    assert.deepEqual(again.body, { applied: [], unmatched: [], unchanged: 3 });
    const entry = (await ed('GET', '/anime')).body.find((a) => a.id === s1);
    assert.equal(entry.watch.next_url, 'https://www.crunchyroll.com/watch/GTESTEP008/test-episode-eight', '"Weiter" follows the synced resume link');
});

test('unmatched series come back with candidates; confirming with remember.season maps the next sync', async () => {
    const core = newCore();
    const fit = addAnime(core, { title: 'Das Kern Abenteuer Zwei', episodes: 12 });
    addAnime(core, { title: 'Ganz anders', episodes: 12 });
    const ed = core.client('ed');
    const body = { service: 'crunchyroll', items: [item({ series_title: 'Kern Abenteuer', episode: 4, fully_watched: false })] };

    const res = await ed('POST', '/anime/watch-sync', body);
    assert.deepEqual(res.body.applied, []);
    assert.equal(res.body.unmatched.length, 1);
    const u = res.body.unmatched[0];
    assert.deepEqual({ ...u, candidates: u.candidates.map((c) => c.id) },
        { external_id: 'GTESTKRN01', series_title: 'Kern Abenteuer', season: 1, episode: 4, episodes_watched: 3, reason: 'no_match', candidates: [fit] });
    assert.deepEqual(Object.keys(u.candidates[0]).sort(), ['episodes', 'id', 'my_episodes', 'my_status', 'score', 'season', 'title']);
    assert.equal(u.candidates[0].season, 1);
    assert.ok(u.candidates[0].score >= 0.5 && u.candidates[0].score < 0.9);
    assert.equal(progressOf(core, fit), undefined);

    const confirm = await ed('POST', `/anime/${fit}/watched`, { episode: u.episodes_watched, remember: { service: 'crunchyroll', external_id: u.external_id, season: u.season } });
    assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
    assert.deepEqual(seasonLinks(core), [[fit, 'GTESTKRN01:1']]);
    const next = await ed('POST', '/anime/watch-sync', { service: 'crunchyroll', items: [item({ series_title: 'Kern Abenteuer', episode: 6 })] });
    assert.deepEqual(next.body, { applied: [{ anime_id: fit, episodes_watched: 6, status: 'Schaue' }], unmatched: [], unchanged: 0 });

    assert.equal((await ed('POST', `/anime/${fit}/watched`, { episode: 1, remember: { service: 'crunchyroll', external_id: 'GTESTKRN01', season: 0 } })).status, 400);
    assert.equal((await ed('POST', `/anime/${fit}/watched`, { episode: 1, remember: { service: 'crunchyroll', external_id: 'GTESTKRN01', season: '2' } })).status, 400);
});

test('the user\'s choice moves a season link; entries tied to another season are never picked by the series link', async () => {
    const core = newCore();
    const a = addAnime(core, { title: 'Kern Zwilling', episodes: 12 });
    const b = addAnime(core, { title: 'Kern Zwilling Neu', episodes: 12 });
    const ed = core.client('ed');
    await ed('POST', `/anime/${a}/watched`, { episode: 1, remember: { service: 'crunchyroll', external_id: 'GTESTKRN01', season: 1 } });
    await ed('POST', `/anime/${b}/watched`, { episode: 1, remember: { service: 'crunchyroll', external_id: 'GTESTKRN01', season: 1 } });
    assert.deepEqual(seasonLinks(core), [[b, 'GTESTKRN01:1']]);

    const res = await ed('POST', '/anime/watch-sync', { service: 'crunchyroll', items: [item({ episode: 5 }), item({ season: 2, episode: 3 })] });
    assert.deepEqual(res.body.applied, [{ anime_id: b, episodes_watched: 5, status: 'Schaue' }]);
    assert.deepEqual(res.body.unmatched.map((u) => [u.season, u.reason, u.candidates.map((c) => c.id)]), [[2, 'no_match', [a]]],
        'season 2: a is linked to the series but its titles name no season 2');
});

test('several entries fit: the one the caller watches wins, otherwise the user decides', async () => {
    const core = newCore();
    const links = JSON.stringify([{ site: 'Crunchyroll', url: 'https://www.crunchyroll.com/de/series/GTESTKRN01/kern', type: 'STREAMING' }]);
    const a = addAnime(core, { title: 'Kern Doppel', episodes: 12, external_links: links });
    const b = addAnime(core, { title: 'Kern Doppel Teil Zwei', episodes: 12, external_links: links });
    const ed = core.client('ed');
    const body = { service: 'crunchyroll', items: [item({ episode: 5 })] };

    const open = await ed('POST', '/anime/watch-sync', body);
    assert.deepEqual(open.body.unmatched.map((u) => [u.reason, u.candidates.map((c) => c.id).sort()]), [['ambiguous', [a, b].sort()]]);
    assert.deepEqual(seasonLinks(core), []);

    setProgress(core, b, 'ed', 'Schaue', 2);
    const picked = await ed('POST', '/anime/watch-sync', body);
    assert.deepEqual(picked.body.applied, [{ anime_id: b, episodes_watched: 5, status: 'Schaue' }]);
    assert.deepEqual(seasonLinks(core), [], 'a pick among several is not learned');
});

test('progress rules: never backwards, a rise leaves Pausiert, Gesehen at the total, past the total unmatched and unwritten', async () => {
    const core = newCore();
    const ahead = addAnime(core, { title: 'Kern Voraus', episodes: 24 });
    const paused = addAnime(core, { title: 'Kern Pause', episodes: 24 });
    const done = addAnime(core, { title: 'Kern Ende', episodes: 12 });
    const short = addAnime(core, { title: 'Kern Kurz', episodes: 12 });
    setProgress(core, ahead, 'ed', 'Schaue', 10);
    setProgress(core, paused, 'ed', 'Pausiert', 3);
    setProgress(core, short, 'ed', 'Schaue', 2);
    const ed = core.client('ed');
    const res = await ed('POST', '/anime/watch-sync', {
        service: 'crunchyroll',
        items: [
            item({ external_id: 'GTESTVOR01', series_title: 'Kern Voraus', episode: 5 }),
            item({ external_id: 'GTESTPAU01', series_title: 'Kern Pause', episode: 5 }),
            item({ external_id: 'GTESTEND01', series_title: 'Kern Ende', episode: 12 }),
            item({ external_id: 'GTESTKUR01', series_title: 'Kern Kurz', episode: 14 })
        ]
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.applied, [{ anime_id: done, episodes_watched: 12, status: 'Gesehen' }, { anime_id: paused, episodes_watched: 5, status: 'Schaue' }]);
    assert.equal(res.body.unchanged, 1);
    assert.deepEqual(res.body.unmatched.map((u) => [u.external_id, u.reason, u.episodes_watched, u.candidates.map((c) => [c.id, c.episodes])]),
        [['GTESTKUR01', 'episode_above_total', 14, [[short, 12]]]]);
    assert.equal(progressOf(core, ahead).episodes_watched, 10);
    assert.ok(progressOf(core, done).finished_at);
    assert.equal(progressOf(core, short).episodes_watched, 2);
});

test('roles and input: editors only, always the caller\'s own progress, bad bodies 400', async () => {
    const core = newCore();
    const id = addAnime(core, { title: 'Kern Eigen', episodes: 12 });
    const body = { service: 'crunchyroll', items: [item({ series_title: 'Kern Eigen', episode: 4 })] };
    const vis = await core.client('vis')('POST', '/anime/watch-sync', body);
    assert.deepEqual([vis.status, vis.body.code], [403, 'READ_ONLY']);

    const admin = await core.client('admin')('POST', '/anime/watch-sync', { ...body, user_id: userId(core, 'ed') });
    assert.deepEqual(admin.body.applied, [{ anime_id: id, episodes_watched: 4, status: 'Schaue' }]);
    assert.equal(progressOf(core, id, 'admin').episodes_watched, 4);
    assert.equal(progressOf(core, id, 'ed'), undefined, 'user_id is ignored: the history is the caller\'s');

    const ed = core.client('ed');
    for (const [bad, message] of [
        [{ items: [] }, 'Abgleich gibt es nur für Crunchyroll'],
        [{ service: 'netflix', items: [] }, 'Abgleich gibt es nur für Crunchyroll'],
        [{ service: 'crunchyroll', items: 'x' }, `Erwartet: { service, items: [...] } mit höchstens ${cr.MAX_ITEMS} Einträgen`],
        [{ service: 'crunchyroll', items: Array.from({ length: 201 }, () => item({ episode: 1 })) }, 'Erwartet: { service, items: [...] } mit höchstens 200 Einträgen'],
        [{ service: 'crunchyroll', items: [item({ episode: 1 }), item({ episode: 0 })] }, 'Ungültiger Eintrag Nr. 2']
    ]) {
        const res = await ed('POST', '/anime/watch-sync', bad);
        assert.deepEqual([res.status, res.body.error], [400, message]);
    }
    const twice = await ed('POST', '/anime/watch-sync', { service: 'crunchyroll', items: [item({ external_id: 'GTESTDOP01', episode: 2 }), item({ external_id: 'GTESTDOP01', episode: 2 })] });
    assert.equal(twice.body.unmatched.length, 1, 'duplicates fold into one item');
    const empty = await ed('POST', '/anime/watch-sync', { service: 'crunchyroll', items: [] });
    assert.deepEqual(empty.body, { applied: [], unmatched: [], unchanged: 0 });
});

test('an entry confirmed as complete stays done: the episode past its total is not offered again', async () => {
    const core = newCore();
    const id = addAnime(core, { title: 'Probe Show 2nd Season', episodes: 12 });
    const ed = core.client('ed');
    const body = { service: 'crunchyroll', items: [item({ external_id: 'GPROBE0001', series_title: 'Probe Show 2nd Season', season: 2, episode: 20 })] };
    const first = await ed('POST', '/anime/watch-sync', body);
    assert.deepEqual(first.body.unmatched.map((u) => [u.reason, u.episodes_watched]), [['episode_above_total', 20]]);
    assert.deepEqual(first.body.unmatched[0].candidates.map((c) => [c.id, c.season]), [[id, 2]]);

    const done = await ed('POST', `/anime/${id}/watched`, { episode: 20, complete: true, remember: { service: 'crunchyroll', external_id: 'GPROBE0001', season: 2 } });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const second = await ed('POST', '/anime/watch-sync', body);
    assert.deepEqual(second.body, { applied: [], unmatched: [], unchanged: 1 });
    assert.equal(progressOf(core, id).episodes_watched, 12);
});

test('one entry holds several seasons of a long-running series: each confirmed season keeps syncing', async () => {
    const core = newCore();
    const id = addAnime(core, { title: 'Probe Longrunner', episodes: null });
    const other = addAnime(core, { title: 'Probe Anderes', episodes: 12 });
    const ed = core.client('ed');
    const body = (e20, e21) => ({ service: 'crunchyroll', items: [
        item({ external_id: 'GPROBE0001', season: 20, episode: e20 }), item({ external_id: 'GPROBE0001', season: 21, episode: e21 })
    ] });
    const first = await ed('POST', '/anime/watch-sync', body(1000, 1010));
    assert.deepEqual(first.body.unmatched.map((u) => [u.season, u.reason]), [[20, 'no_match'], [21, 'no_match']]);

    for (const season of [21, 20]) {
        const res = await ed('POST', `/anime/${id}/watched`, { episode: 1, remember: { service: 'crunchyroll', external_id: 'GPROBE0001', season } });
        assert.equal(res.status, 200, JSON.stringify(res.body));
    }
    assert.deepEqual(seasonLinks(core), [[id, 'GPROBE0001:20'], [id, 'GPROBE0001:21']], 'the second season does not replace the first');
    const synced = await ed('POST', '/anime/watch-sync', body(1000, 1012));
    assert.deepEqual(synced.body, { applied: [{ anime_id: id, episodes_watched: 1012, status: 'Schaue' }], unmatched: [], unchanged: 0 });
    const again = await ed('POST', '/anime/watch-sync', body(1000, 1012));
    assert.deepEqual(again.body, { applied: [], unmatched: [], unchanged: 1 }, 'both seasons map, the lower one changes nothing');

    // another entry taking season 20 moves only that season
    await ed('POST', `/anime/${other}/watched`, { episode: 1, remember: { service: 'crunchyroll', external_id: 'GPROBE0001', season: 20 } });
    assert.deepEqual(seasonLinks(core), [[id, 'GPROBE0001:21'], [other, 'GPROBE0001:20']]);
});

test('a W1 series link (no season) still leaves the series to the link-free entries of other seasons', async () => {
    const core = newCore();
    const s1 = addAnime(core, { title: 'Probe Show', episodes: 12 });
    await core.client('ed')('POST', `/anime/${s1}/watched`, { episode: 12, remember: { service: 'crunchyroll', external_id: 'GPROBE0001' } });
    assert.deepEqual(seasonLinks(core), [], 'remember without season stores the series link only');
    assert.equal(core.conn.prepare("SELECT COUNT(*) AS n FROM anime_links WHERE service = 'crunchyroll'").get().n, 1);
    const listed = JSON.stringify([{ site: 'Crunchyroll', url: 'https://www.crunchyroll.com/series/GPROBE0001/probe-show', type: 'STREAMING' }]);
    const s2 = addAnime(core, { title: 'Probe Show Fortsetzung', title_english: 'Probe Show Season 2', episodes: 12, external_links: listed });
    const ed = core.client('ed');

    const res = await ed('POST', '/anime/watch-sync', { service: 'crunchyroll', items: [item({ external_id: 'GPROBE0001', season: 2, episode: 3 })] });
    assert.deepEqual(res.body.applied, [{ anime_id: s2, episodes_watched: 3, status: 'Schaue' }], 'the AniList link family is tried after the series link');
    assert.deepEqual(seasonLinks(core), [[s2, 'GPROBE0001:2']]);
});

test('a series link that fits no season falls through to the title; candidates are the union', async () => {
    const core = newCore();
    const s1 = addAnime(core, { title: 'Probe Show', episodes: 12 });
    const s2 = addAnime(core, { title: 'Probe Show 2nd Season', title_english: 'Probe Show Season 2', episodes: 12 });
    const ed = core.client('ed');
    await ed('POST', `/anime/${s1}/watched`, { episode: 12, remember: { service: 'crunchyroll', external_id: 'GPROBE0001' } });

    const titled = await ed('POST', '/anime/watch-sync', { service: 'crunchyroll', items: [item({ external_id: 'GPROBE0001', series_title: 'Probe Show Season 2', season: 2, episode: 3 })] });
    assert.deepEqual(titled.body.applied, [{ anime_id: s2, episodes_watched: 3, status: 'Schaue' }]);

    const weak = await ed('POST', '/anime/watch-sync', { service: 'crunchyroll', items: [item({ external_id: 'GPROBE0001', series_title: 'Probe', season: 3, episode: 2 })] });
    assert.deepEqual(weak.body.unmatched.map((u) => [u.reason, u.candidates.map((c) => [c.id, c.season])]), [['no_match', [[s1, 1]]]],
        'the linked entry stays a candidate; the entry naming season 2 is dropped for a season-3 item');
});

test('title fallback: candidates naming another season are dropped, unmarked ones stay', async () => {
    const core = newCore();
    const plain = addAnime(core, { title: 'Die Reise von Sousou no Frieren', episodes: 28 });
    addAnime(core, { title: 'Sousou no Frieren 2nd Season', episodes: 12 });
    const ed = core.client('ed');
    const res = await ed('POST', '/anime/watch-sync', { service: 'crunchyroll', items: [item({ external_id: 'GPROBE0002', series_title: 'Sousou no Frieren', episode: 7 })] });
    assert.deepEqual(res.body.unmatched.map((u) => [u.reason, u.candidates.map((c) => [c.id, c.season])]), [['no_match', [[plain, 1]]]]);
});

test('watch-sync is throttled per user: a second run within 30 s writes nothing and says so', async () => {
    let t = Date.parse('2026-10-04T10:00:00Z');
    const core = newCore(() => new Date(t));
    const id = addAnime(core, { title: 'Kern Takt', episodes: 12 });
    const body = (episode) => ({ service: 'crunchyroll', items: [item({ series_title: 'Kern Takt', episode })] });
    const ed = core.client('ed');
    assert.deepEqual((await ed('POST', '/anime/watch-sync', body(2))).body.applied, [{ anime_id: id, episodes_watched: 2, status: 'Schaue' }]);
    t += 29 * 1000;
    assert.deepEqual((await ed('POST', '/anime/watch-sync', body(3))).body, { applied: [], unmatched: [], throttled: true });
    assert.equal(progressOf(core, id).episodes_watched, 2);
    assert.equal((await core.client('admin')('POST', '/anime/watch-sync', body(3))).body.applied.length, 1, 'per user');
    assert.equal((await ed('POST', '/anime/watch-sync', { service: 'crunchyroll', items: 'x' })).status, 400, 'a bad body is refused, not throttled');
    t += 2 * 1000;
    assert.deepEqual((await ed('POST', '/anime/watch-sync', body(3))).body.applied, [{ anime_id: id, episodes_watched: 3, status: 'Schaue' }]);
});

test('applied entries go to the AniList push; a reopened database writes nothing', async (t) => {
    const core = newCore();
    const id = addAnime(core, { title: 'Kern Push', episodes: 12 });
    const pushes = [];
    t.mock.method(listSync, 'schedulePush', (ctx, uid, animeId) => pushes.push([uid, animeId]));
    const body = { service: 'crunchyroll', items: [item({ series_title: 'Kern Push', episode: 3 })] };
    await core.client('ed')('POST', '/anime/watch-sync', body);
    assert.deepEqual(pushes, [[userId(core, 'ed'), id]]);
    await core.client('ed')('POST', '/anime/watch-sync', body);
    assert.equal(pushes.length, 1, 'nothing changed, nothing pushed');

    let generation = 0;
    const ctx = ctxAs(core, 'ed');
    const moving = { ...ctx, db: { ...ctx.db, generation: () => ++generation, transaction: ctx.db.transaction } };
    assert.throws(() => watch.sync(moving, { body: { service: 'crunchyroll', items: [item({ series_title: 'Kern Push', episode: 9 })] } }), (err) => err.status === 503);
    assert.equal(progressOf(core, id).episodes_watched, 3);
});
