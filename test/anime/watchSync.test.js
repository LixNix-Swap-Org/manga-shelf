// POST /anime/watch-sync on the memory core: matching chain, monotonic progress, unmatched answers, roles and the guards.
const test = require('node:test');
const assert = require('node:assert/strict');
const gateway = require('../../core/anime/gateway');
const listSync = require('../../core/anime/listSync');
const watch = require('../../core/handlers/watch');
const cr = require('../../core/watch/crunchyroll');
const { memoryWith, fixture, offline, ctxAs, fakeFetch, aniListFixtures, json } = require('./helpers');

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
// the answer without its `watch` object (the sync state, asserted on its own)
const ran = (body) => Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'watch'));
const fixtureItems = () => cr.mergeItems(cr.parseWatchHistory(fixture('crunchyroll/watch-history.json')), cr.parseDiscoverHistory(fixture('crunchyroll/discover-history.json')));

test('history from the fixtures: seasons by AniList link and title, titles for the rest, resume link, learned season links', async () => {
    const core = newCore();
    const s1 = addAnime(core, { title: 'Frieren', title_english: 'Frieren: Beyond Journey’s End', episodes: 28, external_links: SERIES_LINK });
    const s2 = addAnime(core, { title: 'Sousou no Frieren 2nd Season', title_english: 'Frieren: Beyond Journey’s End Season 2', episodes: 10, external_links: SERIES_LINK });
    const dungeon = addAnime(core, { title: 'Dungeon Meshi', title_english: 'Delicious in Dungeon', episodes: 24 });
    const ed = core.client('ed');

    const res = await ed('POST', '/anime/watch-sync', cr.syncBody(fixtureItems()));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(ran(res.body), {
        applied: [
            { anime_id: s1, episodes_watched: 7, status: 'Schaue' },
            { anime_id: s2, episodes_watched: 2, status: 'Schaue' },
            { anime_id: dungeon, episodes_watched: 3, status: 'Schaue' }
        ],
        unmatched: [],
        unchanged: 0,
        added: []
    });
    assert.deepEqual(res.body.watch, { auto_add: true, last_at: res.body.watch.last_at, last_platform: null, last_applied: 3, last_added: 0 });
    const first = progressOf(core, s1);
    assert.deepEqual([first.resume_url, first.resume_episode], ['https://www.crunchyroll.com/watch/GTESTEP008/test-episode-eight', 8]);
    assert.deepEqual([progressOf(core, dungeon).resume_url, progressOf(core, dungeon).resume_episode], ['https://www.crunchyroll.com/watch/GTESTDG004/test-dungeon-four', 4]);
    assert.deepEqual(seasonLinks(core), [[s1, 'GTESTSER01:1'], [s2, 'GTESTSER01:2']], 'link matches are learned per season, title matches are not');
    assert.equal(core.conn.prepare("SELECT COUNT(*) AS n FROM anime_links WHERE service = 'crunchyroll'").get().n, 0, 'no series link is invented');

    const again = await ed('POST', '/anime/watch-sync', cr.syncBody(fixtureItems()));
    assert.deepEqual(ran(again.body), { applied: [], unmatched: [], unchanged: 3, added: [] });
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
    assert.deepEqual(ran(next.body), { applied: [{ anime_id: fit, episodes_watched: 6, status: 'Schaue' }], unmatched: [], unchanged: 0, added: [] });

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
    assert.deepEqual(ran(empty.body), { applied: [], unmatched: [], unchanged: 0, added: [] });
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
    assert.deepEqual(ran(second.body), { applied: [], unmatched: [], unchanged: 1, added: [] });
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
    assert.deepEqual(ran(synced.body), { applied: [{ anime_id: id, episodes_watched: 1012, status: 'Schaue' }], unmatched: [], unchanged: 0, added: [] });
    const again = await ed('POST', '/anime/watch-sync', body(1000, 1012));
    assert.deepEqual(ran(again.body), { applied: [], unmatched: [], unchanged: 1, added: [] }, 'both seasons map, the lower one changes nothing');

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
    assert.deepEqual((await ed('POST', '/anime/watch-sync', body(3))).body, { applied: [], unmatched: [], added: [], throttled: true, retry_after: 1 });
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
    await assert.rejects(watch.sync(moving, { body: { service: 'crunchyroll', items: [item({ series_title: 'Kern Push', episode: 9 })] } }), (err) => err.status === 503);
    assert.equal(progressOf(core, id).episodes_watched, 3);
});

// --- automatic adding (phase 1 lookups on a fake AniList, phase 2 commit), declines and the undo ---

const RECENT = '2026-10-03T20:00:00Z';
const media = (id, title, { format = 'TV', episodes = 12, links = [], relations = [], idMal = null, synonyms = [] } = {}) => ({
    id, idMal, type: 'ANIME', format, status: 'FINISHED', episodes, duration: 24, season: 'FALL', seasonYear: 2025,
    startDate: { year: 2025, month: 10, day: 1 }, endDate: { year: 2025, month: 12, day: 20 },
    title: { romaji: title, english: null, native: null }, synonyms, coverImage: { large: null }, bannerImage: null, genres: [],
    averageScore: 70, studios: { nodes: [] }, nextAiringEpisode: null, description: '',
    externalLinks: links.map((url) => ({ site: 'Crunchyroll', url, type: 'STREAMING' })), streamingEpisodes: [],
    relations: { edges: relations.map(([relationType, f]) => ({ relationType, node: { id: 99999, type: 'ANIME', format: f, title: { romaji: 'Andere' } } })) }
});

/** AniList by query: id_in answers from the catalog, every search alias from `search[term]`. */
function aniListFake({ catalog = [], search = {}, delayMs = 0 } = {}) {
    return async (body, init) => {
        if (delayMs) {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, delayMs);
                init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); });
            });
        }
        const vars = body.variables || {};
        if (body.query.includes('id_in')) return json({ data: { Page: { media: vars.ids.map((id) => catalog.find((m) => m.id === id)).filter(Boolean) } } });
        if (body.query.includes('SaveMediaListEntry') || body.query.includes('MediaList(') || body.query.includes('Viewer')) return aniListFixtures(body);
        const data = {};
        for (const [name, term] of Object.entries(vars)) {
            const i = Number(name.slice(1));
            data[i === 0 ? 'Page' : `s${i}`] = { media: (search[term] || []).map((id) => catalog.find((m) => m.id === id)).filter(Boolean) };
        }
        return json({ data });
    };
}

const autoCore = (fake, overrides = {}) => {
    const http = fakeFetch({ anilist: fake });
    let t = Date.parse('2026-10-04T10:00:00Z');
    const core = memoryWith(http.fetch, { now: () => new Date(t += 31 * 1000), ...overrides });
    return { core, http, ed: core.client('ed'), lookups: () => http.calls.filter((c) => c.host === 'anilist').length };
};
const started = (fields) => item({ external_id: 'GNEUSHOW01', series_title: 'Kern Neustart', episode: 1, fully_watched: false,
    resume_url: 'https://www.crunchyroll.com/watch/GNEUEP0001/folge-eins', resume_episode: 1, watched_at: RECENT, ...fields });
const autoBody = (items, extra = {}) => ({ service: 'crunchyroll', items, auto_add: true, platform: 'macos', ...extra });
const state = (core, name = 'ed') => require('../../core/watch/syncState').readWatchState(core.ctx, userId(core, name));
const NEU_LINK = 'https://www.crunchyroll.com/series/GNEUSHOW01/kern-neustart';
const NEU = media(5001, 'Kern Neustart', { links: [NEU_LINK] });

test('starting a show nobody has: looked up on AniList and added with "Schaue", episode 0 and the resume link', async () => {
    const { core, ed, lookups, http } = autoCore(aniListFake({ catalog: [NEU], search: { 'Kern Neustart': [5001], 'kern neustart': [5001] } }));
    const res = await ed('POST', '/anime/watch-sync', autoBody([started({ series_slug: 'kern-neustart' })]));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const id = core.conn.prepare('SELECT id FROM animes WHERE anilist_id = 5001').get().id;
    assert.deepEqual(res.body.added, [{ anime_id: id, title: 'Kern Neustart', external_id: 'GNEUSHOW01', season: 1, episodes_watched: 0, status: 'Schaue' }]);
    assert.deepEqual([res.body.applied, res.body.unmatched, res.body.unchanged], [[], [], 0], 'an added entry is never also applied');
    assert.deepEqual(res.body.watch, { auto_add: true, last_at: res.body.watch.last_at, last_platform: 'macos', last_applied: 0, last_added: 1 });
    const mine = progressOf(core, id);
    assert.deepEqual([mine.status, mine.episodes_watched, mine.resume_url, mine.resume_episode, mine.started_at],
        ['Schaue', 0, 'https://www.crunchyroll.com/watch/GNEUEP0001/folge-eins', 1, null]);
    assert.deepEqual(seasonLinks(core), [[id, 'GNEUSHOW01:1']], 'the detail names the series: the season link is learned');
    assert.equal(lookups(), 2, 'one search for the terms, one detail request');
    assert.deepEqual(http.calls.find((c) => c.body.query.includes('id_in')).body.variables, { ids: [5001] });
    assert.deepEqual(state(core).added.map((p) => [p.anime_id, p.key]), [[id, 'GNEUSHOW01:1']]);
    assert.ok(core.conn.prepare('SELECT created_at FROM animes WHERE id = ?').get(id).created_at.startsWith('2026-10-04'));

    const again = await ed('POST', '/anime/watch-sync', autoBody([started({ episode: 3 })]));
    assert.deepEqual([again.body.added, again.body.applied], [[], [{ anime_id: id, episodes_watched: 2, status: 'Schaue' }]]);
    assert.equal(lookups(), 2, 'the season link matches it now');
    const sync = await ed('GET', '/anime/sync');
    assert.deepEqual(sync.body.watch, { auto_add: true, last_at: again.body.watch.last_at, last_platform: 'macos', last_applied: 1, last_added: 0 });
});

test('no lookups without auto_add, with the switch off, for old items, or when AniList is not used', async () => {
    const fake = aniListFake({ catalog: [NEU], search: { 'Kern Neustart': [5001] } });
    const { core, ed, lookups } = autoCore(fake);
    assert.equal((await ed('POST', '/anime/watch-sync', autoBody([started()], { auto_add: undefined }))).body.added.length, 0);
    assert.equal((await ed('PUT', '/anime/sync', { watch: { auto_add: false } })).body.watch.auto_add, false);
    assert.equal((await ed('POST', '/anime/watch-sync', autoBody([started()]))).body.added.length, 0);
    assert.equal(lookups(), 0);
    assert.equal(state(core).auto_add, false);
    assert.equal((await ed('PUT', '/anime/sync', { watch: { auto_add: 'ja' } })).status, 400);
    assert.equal((await ed('PUT', '/anime/sync', { watch: { auto_add: true } })).body.watch.auto_add, true);

    const old = await ed('POST', '/anime/watch-sync', autoBody([started({ watched_at: '2026-09-20T20:00:00Z' }), started({ external_id: 'GNOTIME001', watched_at: null })]));
    assert.deepEqual([old.body.added, old.body.unmatched, lookups()], [[], [], 0], 'count-0 items never show up as unmatched');

    const off = autoCore(fake, { config: { appTimeZone: 'Europe/Berlin', anime: { sources: ['jikan'] } } });
    assert.equal((await off.ed('POST', '/anime/watch-sync', autoBody([started()]))).body.added.length, 0);
    assert.equal(off.lookups(), 0, 'AniList switched off on this server');
});

test('a show already in the list: starting it writes "Schaue" at 0 once, without a progress row only', async () => {
    const { core, ed, lookups } = autoCore(aniListFake());
    const id = addAnime(core, { title: 'Kern Neustart', episodes: 12 });
    const res = await ed('POST', '/anime/watch-sync', autoBody([started()]));
    assert.deepEqual(ran(res.body), { applied: [{ anime_id: id, episodes_watched: 0, status: 'Schaue' }], unmatched: [], unchanged: 0, added: [] });
    assert.equal(lookups(), 0);
    assert.deepEqual(state(core).matched.map((p) => [p.anime_id, p.key]), [[id, 'GNEUSHOW01:1']], 'a title hit is recorded as matched');
    const again = await ed('POST', '/anime/watch-sync', autoBody([started()]));
    assert.deepEqual(ran(again.body), { applied: [], unmatched: [], unchanged: 0, added: [] }, 'an existing row is left alone and not counted');
});

test('lookup decisions: one-season check, ambiguous hits as external candidates, remembered for later runs', async () => {
    const s2 = media(5102, 'Kern Zwilling 2nd Season', { links: ['https://www.crunchyroll.com/series/GZWILL0001/kern-zwilling'] });
    const s1 = media(5101, 'Kern Zwilling', { links: ['https://www.crunchyroll.com/series/GZWILL0001/kern-zwilling'], relations: [['SEQUEL', 'TV']] });
    const a = media(5201, 'Kern Doppelt', { idMal: 801 });
    const b = media(5202, 'Kern Doppelt', { format: 'ONA', idMal: 802 });
    const movie = media(5203, 'Kern Doppelt', { format: 'MOVIE' });
    const fake = aniListFake({ catalog: [s1, s2, a, b, movie], search: { 'Kern Zwilling': [5101, 5102], 'Kern Doppelt': [5201, 5202, 5203] } });
    const { core, ed, lookups } = autoCore(fake);
    const items = [
        item({ external_id: 'GZWILL0001', series_title: 'Kern Zwilling', season: 2, episode: 3, watched_at: RECENT }),
        item({ external_id: 'GDOPPEL001', series_title: 'Kern Doppelt', episode: 2, watched_at: '2026-10-03T19:00:00Z' })
    ];
    const res = await ed('POST', '/anime/watch-sync', autoBody(items));
    const id = core.conn.prepare('SELECT id FROM animes WHERE anilist_id = 5102').get().id;
    assert.deepEqual(res.body.added.map((x) => [x.anime_id, x.season, x.episodes_watched]), [[id, 2, 3]], 'season 2: the entry naming season 2');
    assert.deepEqual(res.body.unmatched.map((u) => [u.external_id, u.reason, u.candidates.map((c) => [c.kind, c.anilist_id, c.score])]),
        [['GDOPPEL001', 'no_match', [['external', 5201, 1], ['external', 5202, 1]]]], 'two exact titles, no link: the user decides; movies never');
    assert.deepEqual(Object.keys(res.body.unmatched[0].candidates[0]).sort(), ['anilist_id', 'episodes', 'format', 'kind', 'mal_id', 'score', 'season_year', 'title']);
    const calls = lookups();

    const again = await ed('POST', '/anime/watch-sync', autoBody([items[1]]));
    assert.deepEqual(again.body.unmatched[0].candidates.map((c) => c.anilist_id), [5201, 5202], 'the memory brings them back');
    assert.equal(lookups(), calls, 'without a new lookup');
    core.conn.prepare("INSERT INTO animes (title, mal_id) VALUES ('Anderswo', 802)").run();
    const third = await ed('POST', '/anime/watch-sync', autoBody([items[1]]));
    assert.deepEqual(third.body.unmatched[0].candidates.map((c) => c.anilist_id), [5201], 'one is in the collection by now');
});

test('two series ids for one AniList entry make one entry; the undo declines both keys', async () => {
    const show = media(5301, 'Kern Einheit', { links: ['https://www.crunchyroll.com/series/GEINHEIT01/a', 'https://www.crunchyroll.com/series/GEINHEIT02/b'] });
    const { core, ed } = autoCore(aniListFake({ catalog: [show], search: { 'Kern Einheit': [5301] } }));
    const items = [
        item({ external_id: 'GEINHEIT01', series_title: 'Kern Einheit', episode: 2, watched_at: '2026-10-03T18:00:00Z' }),
        item({ external_id: 'GEINHEIT02', series_title: 'Kern Einheit', episode: 4, watched_at: RECENT })
    ];
    const res = await ed('POST', '/anime/watch-sync', autoBody(items));
    const id = core.conn.prepare('SELECT id FROM animes WHERE anilist_id = 5301').get().id;
    assert.deepEqual(res.body.added.map((x) => [x.anime_id, x.external_id, x.episodes_watched]), [[id, 'GEINHEIT02', 4]], 'the newest key, the highest count');
    assert.deepEqual(res.body.applied, []);
    assert.deepEqual(state(core).added.map((p) => p.key).sort(), ['GEINHEIT01:1', 'GEINHEIT02:1']);

    const undo = await ed('POST', '/anime/watch-sync/undo', { anime_id: id, external_id: 'GEINHEIT02', season: 1 });
    assert.deepEqual([undo.status, undo.body], [200, { removed: 'entry' }]);
    assert.equal(core.conn.prepare('SELECT COUNT(*) AS n FROM animes WHERE id = ?').get(id).n, 0);
    assert.deepEqual(state(core).declined.sort(), ['GEINHEIT01:1', 'GEINHEIT02:1']);
    assert.deepEqual(state(core).added, []);
    const after = await ed('POST', '/anime/watch-sync', autoBody(items));
    assert.deepEqual([after.body.added, after.body.unmatched.map((u) => u.reason)], [[], ['declined', 'declined']]);
});

test('undo in the progress branch: someone else watches it, so only my progress and the season link go, and it stays declined', async () => {
    const { core, ed } = autoCore(aniListFake({ catalog: [NEU], search: { 'Kern Neustart': [5001] } }));
    const res = await ed('POST', '/anime/watch-sync', autoBody([started({ episode: 3, fully_watched: true })]));
    const [added] = res.body.added;
    setProgress(core, added.anime_id, 'admin', 'Schaue', 1);
    const undo = await ed('POST', '/anime/watch-sync/undo', { anime_id: added.anime_id, external_id: added.external_id, season: added.season });
    assert.deepEqual(undo.body, { removed: 'progress' });
    assert.equal(progressOf(core, added.anime_id), undefined);
    assert.deepEqual(seasonLinks(core), []);
    assert.equal((await ed('POST', '/anime/watch-sync/undo', { anime_id: added.anime_id, external_id: added.external_id, season: added.season })).status, 404, 'once');

    const sync = await ed('POST', '/anime/watch-sync', autoBody([started({ episode: 4, fully_watched: true })]));
    assert.equal(progressOf(core, added.anime_id), undefined, 'the title hit no longer writes');
    assert.deepEqual(sync.body.unmatched.map((u) => [u.reason, u.candidates.map((c) => c.id)]), [['declined', [added.anime_id]]], 'the entry it would have picked comes first');

    const confirm = await ed('POST', `/anime/${added.anime_id}/watched`, { episode: 4, remember: { service: 'crunchyroll', external_id: 'GNEUSHOW01', season: 1 } });
    assert.equal(confirm.status, 200);
    assert.deepEqual(state(core).declined, [], 'confirming the season in the dialog lifts the decline');
    const next = await ed('POST', '/anime/watch-sync', autoBody([started({ episode: 5, fully_watched: true })]));
    assert.deepEqual(next.body.applied, [{ anime_id: added.anime_id, episodes_watched: 5, status: 'Schaue' }]);
});

test('undo: only pairs of my added list, within the hour; the { anime_id } form only for fresh entries', async () => {
    let t = Date.parse('2026-10-04T10:00:00Z');
    const http = fakeFetch({ anilist: aniListFake({ catalog: [NEU], search: { 'Kern Neustart': [5001] } }) });
    const core = memoryWith(http.fetch, { now: () => new Date(t) });
    const ed = core.client('ed');
    const [added] = (await ed('POST', '/anime/watch-sync', autoBody([started()]))).body.added;
    const keyed = { anime_id: added.anime_id, external_id: 'gneushow01', season: 1 };
    assert.equal((await core.client('admin')('POST', '/anime/watch-sync/undo', keyed)).status, 404, 'not in the admin\'s list');
    assert.equal((await ed('POST', '/anime/watch-sync/undo', { ...keyed, season: 2 })).status, 404);
    assert.equal((await ed('POST', '/anime/watch-sync/undo', { anime_id: 'x' })).status, 400);
    assert.equal((await core.client('vis')('POST', '/anime/watch-sync/undo', keyed)).status, 403);
    t += 61 * 60 * 1000;
    const late = await ed('POST', '/anime/watch-sync/undo', keyed);
    assert.deepEqual([late.status, late.body.code, late.body.error],
        [409, 'UNDO_EXPIRED', 'Rückgängig geht nicht mehr – die Stunde ist um oder jemand anderes hat schon Fortschritt eingetragen']);
    assert.equal((await ed('POST', '/anime/watch-sync/undo', { anime_id: added.anime_id })).body.code, 'UNDO_EXPIRED', 'created more than an hour ago');

    const manual = (await ed('POST', '/anime', { title: 'Kern Frisch', episodes: 12, watched: { episode: 2 } })).body.id;
    setProgress(core, manual, 'admin', 'Schaue', 1);
    assert.equal((await ed('POST', '/anime/watch-sync/undo', { anime_id: manual })).body.code, 'UNDO_EXPIRED', 'someone else has progress');
    core.conn.prepare('DELETE FROM anime_progress WHERE anime_id = ? AND user_id = 1').run(manual);
    assert.deepEqual((await ed('POST', '/anime/watch-sync/undo', { anime_id: manual })).body, { removed: 'entry' });
    assert.deepEqual(state(core).declined, [], 'the { anime_id } form declines nothing');
});

test('declines: "Von deiner Liste entfernen" and deleting a title-matched entry keep the sync from writing or adding it again', async () => {
    const { core, ed, lookups } = autoCore(aniListFake({ catalog: [NEU], search: { 'Kern Neustart': [5001] } }));
    const id = addAnime(core, { title: 'Kern Neustart', episodes: 12 });
    const body = (episode) => autoBody([started({ episode, fully_watched: true })]);
    assert.deepEqual((await ed('POST', '/anime/watch-sync', body(2))).body.applied, [{ anime_id: id, episodes_watched: 2, status: 'Schaue' }]);
    assert.equal((await ed('DELETE', `/anime/${id}/progress`)).status, 200);
    assert.deepEqual(state(core).declined, [], 'without decline=1 nothing is declined');
    await ed('POST', '/anime/watch-sync', body(3));
    assert.equal((await ed('DELETE', `/anime/${id}/progress?decline=1`)).status, 200);
    assert.deepEqual(state(core).declined, ['GNEUSHOW01:1']);
    const declined = await ed('POST', '/anime/watch-sync', body(4));
    assert.equal(progressOf(core, id), undefined);
    assert.deepEqual(declined.body.unmatched.map((u) => u.reason), ['declined']);

    await ed('PUT', `/anime/${id}/progress`, { status: 'Schaue', episodes_watched: 3, restore: true });
    assert.deepEqual((await ed('POST', '/anime/watch-sync', body(5))).body.applied, [{ anime_id: id, episodes_watched: 5, status: 'Schaue' }]);
    assert.equal((await ed('DELETE', `/anime/${id}`)).status, 200);
    const gone = await ed('POST', '/anime/watch-sync', body(6));
    assert.deepEqual([gone.body.added, gone.body.unmatched.map((u) => u.reason), lookups()], [[], ['declined'], 0]);

    const confirmed = addAnime(core, { title: 'Kern Andere Wahl', episodes: 12 });
    assert.equal((await ed('POST', `/anime/${confirmed}/watched`, { episode: 6, remember: { service: 'crunchyroll', external_id: 'GNEUSHOW01', season: 1 } })).status, 200);
    assert.deepEqual(state(core).declined, [], 'confirming a season in the dialog lifts the decline');
});

test('a started episode 1 on an entry I already have is remembered as matched, so "Von deiner Liste entfernen" sticks', async () => {
    const { core, ed, lookups } = autoCore(aniListFake());
    const id = addAnime(core, { title: 'Kern Neustart', episodes: 12 });
    setProgress(core, id, 'ed', 'Geplant', 0);
    assert.deepEqual(ran((await ed('POST', '/anime/watch-sync', autoBody([started()]))).body), { applied: [], unmatched: [], unchanged: 0, added: [] });
    assert.deepEqual(state(core).matched.map((p) => [p.anime_id, p.key]), [[id, 'GNEUSHOW01:1']]);
    assert.equal((await ed('DELETE', `/anime/${id}/progress?decline=1`)).status, 200);
    assert.deepEqual(state(core).declined, ['GNEUSHOW01:1']);
    assert.deepEqual(ran((await ed('POST', '/anime/watch-sync', autoBody([started()]))).body), { applied: [], unmatched: [], unchanged: 0, added: [] });
    assert.equal(progressOf(core, id), undefined, 'not written back at 0');
    const later = await ed('POST', '/anime/watch-sync', autoBody([started({ episode: 2, fully_watched: true })]));
    assert.equal(progressOf(core, id), undefined);
    assert.deepEqual(later.body.unmatched.map((u) => u.reason), ['declined']);
    assert.equal(lookups(), 0);
});

test('a second series id on an entry whose season link is taken is remembered as matched, so its decline sticks', async () => {
    const core = newCore();
    const listed = JSON.stringify(['GKERNDUB01', 'GKERNSUB01'].map((sid) => ({ site: 'Crunchyroll', url: `https://www.crunchyroll.com/series/${sid}/kern-doppelspur`, type: 'STREAMING' })));
    const id = addAnime(core, { title: 'Kern Doppelspur', episodes: 12, external_links: listed });
    core.conn.prepare("INSERT INTO anime_links (anime_id, service, external_id) VALUES (?, 'crunchyroll:season:1', 'GKERNSUB01:1')").run(id);
    const ed = core.client('ed');
    const body = (episode) => ({ service: 'crunchyroll', items: [item({ external_id: 'GKERNDUB01', episode, watched_at: RECENT })] });

    assert.deepEqual((await ed('POST', '/anime/watch-sync', body(3))).body.applied, [{ anime_id: id, episodes_watched: 3, status: 'Schaue' }]);
    assert.deepEqual(seasonLinks(core), [[id, 'GKERNSUB01:1']], 'the entry holds one season-1 link');
    assert.deepEqual(state(core).matched.map((p) => [p.anime_id, p.key]), [[id, 'GKERNDUB01:1']]);
    assert.equal((await ed('DELETE', `/anime/${id}/progress?decline=1`)).status, 200);
    assert.deepEqual([...state(core).declined].sort(), ['GKERNDUB01:1', 'GKERNSUB01:1']);
    const next = await ed('POST', '/anime/watch-sync', body(4));
    assert.equal(progressOf(core, id), undefined);
    assert.deepEqual(next.body.unmatched.map((u) => u.reason), ['declined']);
});

test('deleting an entry for everyone declines it for the users whose sync added it', async () => {
    const { core, ed } = autoCore(aniListFake({ catalog: [NEU], search: { 'Kern Neustart': [5001] } }));
    const [added] = (await ed('POST', '/anime/watch-sync', autoBody([started()]))).body.added;
    assert.equal((await core.client('admin')('DELETE', `/anime/${added.anime_id}`)).status, 200);
    assert.deepEqual(state(core).declined, ['GNEUSHOW01:1'], 'the adder: its added key');
    assert.deepEqual(state(core, 'admin').declined, ['GNEUSHOW01:1'], 'the caller: the season link of the entry');
    assert.equal((await ed('POST', '/anime/watch-sync', autoBody([started()]))).body.added.length, 0);
});

test('an AniList entry already in the collection is matched, not added; its season link is learned', async () => {
    const show = media(5401, 'Kern Bekannt', { links: ['https://www.crunchyroll.com/series/GBEKANNT01/kern-bekannt'] });
    const { core, ed } = autoCore(aniListFake({ catalog: [show], search: { 'Kern Bekannt': [5401] } }));
    const id = addAnime(core, { title: 'Ganz anderer Titel', anilist_id: 5401, episodes: 12 });
    const res = await ed('POST', '/anime/watch-sync', autoBody([item({ external_id: 'GBEKANNT01', series_title: 'Kern Bekannt', episode: 3, watched_at: RECENT })]));
    assert.deepEqual([res.body.added, res.body.applied], [[], [{ anime_id: id, episodes_watched: 3, status: 'Schaue' }]]);
    assert.deepEqual(seasonLinks(core), [[id, 'GBEKANNT01:1']]);
    assert.deepEqual(state(core).matched.map((p) => [p.anime_id, p.key]), [[id, 'GBEKANNT01:1']]);
});

test('skip, platform and the new fields: stored normalised, skipped keys are never looked up, more than 200 is refused', async () => {
    const { core, ed, lookups } = autoCore(aniListFake({ catalog: [NEU], search: { 'Kern Neustart': [5001] } }));
    const skip = ['gneushow01:01', 'GNEUSHOW01:0', 'x', 7, 'ABCDEFG:100', 'GANDERS001:2'];
    const res = await ed('POST', '/anime/watch-sync', autoBody([started()], { skip, platform: 'amiga', auto_add: 'yes' }));
    assert.equal(res.status, 200);
    assert.deepEqual(state(core).skipped, ['GNEUSHOW01:1', 'GANDERS001:2']);
    assert.equal(res.body.watch.last_platform, null);
    const next = await ed('POST', '/anime/watch-sync', autoBody([started()]));
    assert.deepEqual([next.body.added, lookups()], [[], 0], 'skipped on any device');
    const many = await ed('POST', '/anime/watch-sync', autoBody([], { skip: Array.from({ length: 201 }, () => 'GNEUSHOW01:1') }));
    assert.deepEqual([many.status, many.body.error], [400, 'Erwartet: { skip: [...] } mit höchstens 200 Einträgen']);
    assert.equal((await ed('POST', '/anime/watch-sync', autoBody([], { skip: 'x', platform: 7 }))).status, 200);
});

test('caps: at most 3 items looked up per run, 5 new entries per hour', async () => {
    const catalog = [];
    const search = {};
    for (let i = 1; i <= 7; i++) {
        const id = 5500 + i;
        catalog.push(media(id, `Kern Reihe ${i}`, { links: [`https://www.crunchyroll.com/series/GREIHE000${i}/x`] }));
        search[`Kern Reihe ${i}`] = [id];
    }
    let t = Date.parse('2026-10-04T10:00:00Z');
    const http = fakeFetch({ anilist: aniListFake({ catalog, search }) });
    const core = memoryWith(http.fetch, { now: () => new Date(t) });
    const ed = core.client('ed');
    const lookups = () => http.calls.filter((c) => c.host === 'anilist').length;
    const items = (from, to) => Array.from({ length: to - from + 1 }, (_, k) => {
        const i = from + k;
        return item({ external_id: `GREIHE000${i}`, series_title: `Kern Reihe ${i}`, episode: 2, watched_at: `2026-10-03T1${i}:00:00Z` });
    });
    const first = await ed('POST', '/anime/watch-sync', autoBody(items(1, 5)));
    assert.deepEqual(first.body.added.map((a) => a.external_id), ['GREIHE0005', 'GREIHE0004', 'GREIHE0003'], 'newest first');
    assert.deepEqual(first.body.unmatched.map((u) => u.external_id), ['GREIHE0002', 'GREIHE0001'], 'put off, still unmatched');
    assert.equal(lookups(), 6);
    t += 31 * 1000;
    const second = await ed('POST', '/anime/watch-sync', autoBody(items(1, 7)));
    assert.deepEqual(second.body.added.map((a) => a.external_id), ['GREIHE0007', 'GREIHE0006']);
    assert.equal(lookups(), 10, 'two items looked up, then the cap of 10 lookups an hour');
    t += 31 * 1000;
    gateway.state().watchCaps.get(userId(core, 'ed')).lookups = [];
    const third = await ed('POST', '/anime/watch-sync', autoBody(items(1, 2)));
    assert.deepEqual([third.body.added, third.body.unmatched.length, lookups()], [[], 2, 14], 'looked up, but 5 entries an hour at most');
    t += 61 * 60 * 1000;
    assert.equal((await ed('POST', '/anime/watch-sync', autoBody(items(1, 2)))).body.added.length, 2, 'not remembered: added an hour later');
});

test('a slow AniList costs at most the phase budget: the run answers with the ordinary result and adds nothing', async () => {
    const { core, ed } = autoCore(aniListFake({ catalog: [NEU], search: { 'Kern Neustart': [5001] }, delayMs: 9000 }));
    const id = addAnime(core, { title: 'Kern Gewöhnlich', episodes: 12 });
    const startedAt = Date.now();
    const res = await ed('POST', '/anime/watch-sync', autoBody([started(), item({ external_id: 'GGEWOEHN01', series_title: 'Kern Gewöhnlich', episode: 2 })]));
    assert.ok(Date.now() - startedAt < 20000);
    assert.deepEqual([res.body.applied, res.body.added], [[{ anime_id: id, episodes_watched: 2, status: 'Schaue' }], []]);
    assert.equal(gateway.state().budget.state('shared:anilist', Date.now()).circuit, 'closed');
});

test('a client that leaves during a lookup: nothing counts against AniList, only ordinary items are written', async () => {
    let controller = null;
    const fake = aniListFake({ catalog: [NEU], search: { 'Kern Neustart': [5001] }, delayMs: 5000 });
    const { core } = autoCore(async (body, init) => {
        setTimeout(() => controller.abort(), 20);
        return fake(body, init);
    });
    const id = addAnime(core, { title: 'Kern Gewöhnlich', episodes: 12 });
    for (let episode = 2; episode <= 4; episode++) {
        controller = new AbortController();
        const ctx = { ...ctxAs(core, 'ed'), signal: controller.signal };
        const res = await watch.sync(ctx, { body: autoBody([started(), item({ external_id: 'GGEWOEHN01', series_title: 'Kern Gewöhnlich', episode })]) });
        assert.deepEqual([res.body.applied, res.body.added], [[{ anime_id: id, episodes_watched: episode, status: 'Schaue' }], []]);
    }
    assert.equal(gateway.state().budget.state('shared:anilist', Date.now()).circuit, 'closed', 'three aborted requests, no failure counted');
    assert.equal(core.conn.prepare("SELECT COUNT(*) AS n FROM api_cache WHERE cache_key LIKE 'watch:outcome:%'").get().n, 0, 'no memory');
});

test('added entries reach the AniList list after 60 s, and an undo within that window sends nothing', async (t) => {
    const own = { secret: 'eigener-token' };
    const credentials = { get: (uid, provider) => (uid === 2 && provider === 'anilist' ? own : null), background: () => [], failed: () => {}, used: () => {}, status: () => null };
    const other = media(5002, 'Kern Zweitstart', { links: ['https://www.crunchyroll.com/series/GZWEIT0001/x'] });
    const { core, ed, http } = autoCore(aniListFake({ catalog: [NEU, other], search: { 'Kern Neustart': [5001], 'Kern Zweitstart': [5002] } }), { credentials });
    assert.equal((await ed('PUT', '/anime/sync', { anilist: { enabled: true } })).status, 200);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const res = await ed('POST', '/anime/watch-sync', autoBody([started({ episode: 10, fully_watched: true }),
        started({ external_id: 'GZWEIT0001', series_title: 'Kern Zweitstart', episode: 10, fully_watched: true, watched_at: '2026-10-03T19:00:00Z' })]));
    const [kept, undone] = res.body.added;
    assert.deepEqual([kept.external_id, undone.external_id], ['GNEUSHOW01', 'GZWEIT0001']);
    assert.deepEqual((await ed('POST', '/anime/watch-sync/undo', { anime_id: undone.anime_id, external_id: undone.external_id, season: 1 })).body, { removed: 'entry' });
    t.mock.timers.tick(59 * 1000);
    await gateway.state().background.idle();
    const saves = () => http.calls.filter((c) => c.host === 'anilist' && c.body.query.includes('SaveMediaListEntry')).map((c) => c.body.variables.m);
    assert.deepEqual(saves(), [], 'nothing within the 60 s');
    t.mock.timers.tick(1000);
    t.mock.timers.reset();
    for (let i = 0; i < 20 && !saves().length; i++) {
        await gateway.state().background.idle();
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(saves(), [5001], 'only the entry that stayed');
    assert.ok(core.conn.prepare('SELECT 1 FROM animes WHERE id = ?').get(kept.anime_id));
});

test('resolve-link: a suggestion for a one-season show nobody has, never for a series with more seasons or without AniList', async () => {
    const solo = media(5601, 'Kern Einzeln', { links: ['https://www.crunchyroll.com/series/GEINZEL001/kern-einzeln'] });
    const multi = media(5602, 'Kern Mehrteiler', { links: ['https://www.crunchyroll.com/series/GMEHRT0001/kern-mehrteiler'], relations: [['SEQUEL', 'TV']] });
    const fake = aniListFake({ catalog: [solo, multi], search: { 'kern einzeln': [5601], 'kern mehrteiler': [5602] } });
    const { core, ed, lookups } = autoCore(fake);
    const res = await ed('POST', '/anime/resolve-link', { url: 'https://www.crunchyroll.com/series/GEINZEL001/kern-einzeln' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.anime_id, res.body.suggestion], [null, { anilist_id: 5601, title: 'Kern Einzeln', episodes: 12, format: 'TV' }]);
    assert.equal(lookups(), 2);
    assert.equal(core.conn.prepare("SELECT COUNT(*) AS n FROM api_cache WHERE cache_key LIKE 'watch:outcome:%'").get().n, 0, 'no memory');
    assert.equal((await ed('POST', '/anime/resolve-link', { url: 'https://www.crunchyroll.com/series/GMEHRT0001/kern-mehrteiler' })).body.suggestion, undefined);

    const id = addAnime(core, { title: 'Kern Einzeln', episodes: 12 });
    const known = await ed('POST', '/anime/resolve-link', { url: 'https://www.crunchyroll.com/series/GEINZEL001/kern-einzeln' });
    assert.deepEqual([known.body.anime_id, known.body.suggestion], [id, undefined]);

    const off = autoCore(fake, { config: { appTimeZone: 'Europe/Berlin', anime: { sources: ['jikan'] } } });
    assert.equal((await off.ed('POST', '/anime/resolve-link', { url: 'https://www.crunchyroll.com/series/GEINZEL001/kern-einzeln' })).body.suggestion, undefined);
    assert.equal(off.lookups(), 0);
});
