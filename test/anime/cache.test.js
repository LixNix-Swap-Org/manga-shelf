const test = require('node:test');
const assert = require('node:assert/strict');
const cache = require('../../core/anime/cache');
const gateway = require('../../core/anime/gateway');
const { fakeFetch, aniListFixtures, jikanFixtures, memoryWith, json } = require('./helpers');

test.afterEach(() => gateway.resetGatewayState());

test('api_cache: values expire after their TTL, stale reads only on request, prune keeps the table small', () => {
    let now = 1_000_000;
    const core = memoryWith(fakeFetch().fetch, { now: () => new Date(now) });
    cache.write(core.ctx, 'k', { a: 1 }, 1000);
    assert.deepEqual(cache.read(core.ctx, 'k').value, { a: 1 });
    now += 1000;
    assert.equal(cache.read(core.ctx, 'k'), null);
    const stale = cache.read(core.ctx, 'k', { allowStale: true });
    assert.equal(stale.expired, true);
    now += 2 * 24 * 60 * 60 * 1000;
    cache.prune(core.ctx);
    assert.equal(cache.read(core.ctx, 'k', { allowStale: true }), null, 'expired for over a day: gone');
    assert.deepEqual(cache.TTL, { search: 3600000, partial: 300000, notFound: 600000, adaptations: 86400000 });
});

test('search results stay 1 h, empty results 10 min, failures not at all', async () => {
    let now = Date.now();
    let empty = false;
    const http = fakeFetch({
        anilist: (body) => (empty ? json({ data: { Page: { media: [] } } }) : aniListFixtures(body)),
        jikan: (p) => (empty ? json({ data: [] }) : jikanFixtures(p))
    });
    const core = memoryWith(http.fetch, { now: () => new Date(now) });
    const ctx = { ...core.ctx, user: { id: 2, username: 'ed', role: 'editor' } };
    await gateway.searchAnime(ctx, 'Frieren');
    const row = core.conn.prepare("SELECT created_at, expires_at FROM api_cache WHERE cache_key = 'anime:search:frieren:10'").get();
    assert.equal(row.expires_at - row.created_at, 60 * 60 * 1000);
    empty = true;
    await gateway.searchAnime(ctx, 'Gibtsnicht');
    const negative = core.conn.prepare("SELECT created_at, expires_at FROM api_cache WHERE cache_key = 'anime:search:gibtsnicht:10'").get();
    assert.equal(negative.expires_at - negative.created_at, 10 * 60 * 1000);
});

test('stale-while-revalidate: the list answers with the stored state at once and refreshes in the background', async () => {
    const http = fakeFetch({ anilist: aniListFixtures });
    const core = memoryWith(http.fetch);
    core.conn.prepare("INSERT INTO animes (title, title_english, anilist_id, status, episodes, next_check_at, meta_fetched_at) VALUES ('Alt', 'Alt', 21, 'RELEASING', 1000, 1, 1)").run();
    const ed = core.client('ed');
    const list = await ed('GET', '/anime');
    assert.equal(list.status, 200);
    assert.equal(list.body[0].title, 'Alt');
    assert.equal(list.body[0].stale, true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await gateway.state().background.idle();
    const row = core.conn.prepare('SELECT * FROM animes WHERE anilist_id = 21').get();
    assert.match(row.title, /^one piece$/i, 'an untouched display title follows the source');
    assert.equal(row.next_airing_episode, 1181);
    assert.ok(row.next_check_at > Date.now());
    assert.equal((await ed('GET', '/anime')).body[0].stale, false);
});

test('manual refresh: at most once per 60 s per entry (429 with retry_after), manual entries cannot be refreshed', async () => {
    let now = Date.now();
    const http = fakeFetch({ anilist: aniListFixtures, jikan: () => undefined });
    const core = memoryWith(http.fetch, { now: () => new Date(now) });
    core.conn.prepare("INSERT INTO animes (id, title, anilist_id, next_check_at) VALUES (5, 'Frieren', 154587, 1)").run();
    core.conn.prepare("INSERT INTO animes (id, title) VALUES (6, 'Selbst angelegt')").run();
    const ed = core.client('ed');
    const first = await ed('POST', '/anime/5/refresh');
    assert.equal(first.status, 200);
    assert.equal(first.body.refreshed, true);
    assert.equal(first.body.mal_id, 52991);
    const second = await ed('POST', '/anime/5/refresh');
    assert.equal(second.status, 429);
    assert.equal(second.body.code, 'REFRESH_TOO_SOON');
    assert.ok(second.body.retry_after > 55 && second.body.retry_after <= 60);
    now += 61 * 1000;
    assert.equal((await ed('POST', '/anime/5/refresh')).status, 200);
    assert.equal((await ed('POST', '/anime/6/refresh')).status, 400);
    assert.equal((await core.client('vis')('POST', '/anime/5/refresh')).status, 403);
});
