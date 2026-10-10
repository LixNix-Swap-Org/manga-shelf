// Anime gateway: credentials, request budgets, error mapping and fallbacks between sources.
const test = require('node:test');
const assert = require('node:assert/strict');
const gateway = require('../../core/anime/gateway');
const { fakeFetch, aniListFixtures, jikanFixtures, memoryWith, ctxAs, json, fixture } = require('./helpers');

const { requestJson, SourceError } = require('../../core/anime/request');
const cache = require('../../core/anime/cache');
const { searchKey } = require('../../core/anime/normalize');

/** One AniList Media request through requestJson with the access's credential (as the adapters send it). */
const aniListExec = (ctx, credential) => requestJson(ctx, 'https://graphql.anilist.co', {
    method: 'POST',
    headers: credential ? { Authorization: `Bearer ${credential.secret}` } : {},
    body: JSON.stringify({ query: 'query { Media(id: 154587) { id } }' })
}, { label: 'AniList' });

const rateLimited = () => json({ errors: [{ message: 'Too Many Requests.', status: 429 }], data: null }, { status: 429, headers: { 'retry-after': '60', 'x-ratelimit-remaining': '0' } });

test.afterEach(() => gateway.resetGatewayState());

test('search: both sources in parallel, merged by MAL id, then answered from the cache', async () => {
    const http = fakeFetch({ anilist: aniListFixtures, jikan: jikanFixtures });
    const core = memoryWith(http.fetch);
    const ctx = ctxAs(core, 'ed');
    const first = await gateway.searchAnime(ctx, 'Frieren');
    assert.deepEqual(first.sources_used.sort(), ['anilist', 'jikan']);
    assert.equal(first.cached, false);
    assert.equal(first.partial, false);
    assert.equal(first.credential_used, 'shared');
    const frieren = first.results.find((r) => r.anilist_id === 154587);
    assert.equal(frieren.mal_id, 52991);
    assert.equal(first.results.filter((r) => r.mal_id === 52991).length, 1);
    assert.equal(http.count('anilist'), 1);
    assert.equal(http.count('jikan'), 1);

    const again = await gateway.searchAnime(ctxAs(core, 'admin'), 'frieren');
    assert.equal(again.cached, true);
    assert.equal(http.calls.length, 2, 'no further request');
    const state = gateway.sourcesState(ctx);
    assert.equal(state.anilist.limit, 30);
    assert.equal(state.anilist.remaining, 29, 'remaining follows X-RateLimit-Remaining');
});

test('search: both spellings of an umlaut term go out in one AniList request', async () => {
    const http = fakeFetch({ anilist: aniListFixtures, jikan: jikanFixtures });
    const ctx = ctxAs(memoryWith(http.fetch), 'ed');
    const result = await gateway.searchAnime(ctx, 'Tagebücher der Apothekerin');
    assert.equal(http.count('anilist'), 1);
    const call = http.calls.find((c) => c.host === 'anilist');
    assert.deepEqual(Object.values(call.body.variables), ['Tagebücher der Apothekerin', 'Tagebucher der Apothekerin']);
    assert.ok(result.results.some((r) => /Kusuriya/.test(r.title.romaji || '')));
});

test('failover: AniList 429 pauses AniList and Jikan answers alone', async () => {
    const http = fakeFetch({ anilist: rateLimited, jikan: jikanFixtures });
    const core = memoryWith(http.fetch);
    const ctx = ctxAs(core, 'ed');
    const result = await gateway.searchAnime(ctx, 'Frieren');
    assert.deepEqual(result.sources_used, ['jikan']);
    assert.equal(result.partial, true);
    assert.ok(result.results.length > 0);
    const state = gateway.sourcesState(ctx);
    assert.ok(state.anilist.paused_until > Date.now() + 50000);
    assert.equal(state.slow_recently, true);

    const second = await gateway.searchAnime(ctx, 'Berserk');
    assert.deepEqual(second.sources_used, ['jikan']);
    assert.equal(http.count('anilist'), 1, 'a paused source is not asked');
});

test('failover: both sources down -> stale cache, else 503; errors are never cached', async () => {
    const http = fakeFetch({ anilist: () => json({}, { status: 502 }), jikan: () => json({}, { status: 503 }) });
    const core = memoryWith(http.fetch);
    const ctx = ctxAs(core, 'ed');
    await assert.rejects(gateway.searchAnime(ctx, 'Frieren'), (err) => err.status === 503 && err.code === 'SOURCES_UNAVAILABLE');
    assert.equal(core.conn.prepare('SELECT count(*) AS n FROM api_cache').get().n, 0);

    core.conn.prepare('INSERT INTO api_cache (cache_key, json_data, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run('anime:search:frieren:10', JSON.stringify({ results: [{ title: { romaji: 'Alt' } }], sources_used: ['anilist'], partial: false }), 1, 2);
    const stale = await gateway.searchAnime(ctx, 'Frieren');
    assert.equal(stale.cached, true);
    assert.equal(stale.partial, true);
    assert.equal(stale.results[0].title.romaji, 'Alt');
});

test('own AniList key first (Bearer), the pool when its bucket is empty', async () => {
    const http = fakeFetch({ anilist: aniListFixtures, jikan: jikanFixtures });
    const used = [];
    const credentials = {
        get: (userId, provider) => (userId === 2 && provider === 'anilist' ? { secret: 'eigener-token', allowBackground: false } : null),
        used: (userId, provider, ok) => used.push([userId, provider, ok])
    };
    const core = memoryWith(http.fetch, { credentials });
    const ctx = ctxAs(core, 'ed');
    const own = await gateway.searchAnime(ctx, 'Frieren');
    assert.equal(own.credential_used, 'own');
    assert.equal(http.calls.find((c) => c.host === 'anilist').headers.Authorization, 'Bearer eigener-token');
    assert.deepEqual(used[0], [2, 'anilist', true]);

    const budget = gateway.state().budget;
    while (budget.take('user:2:anilist', { perMinute: 30 }, 'interactive', Date.now())) { /* empty the own bucket */ }
    const pooled = await gateway.searchAnime(ctx, 'Berserk');
    assert.equal(pooled.credential_used, 'shared');
    assert.equal(http.calls.filter((c) => c.host === 'anilist').at(-1).headers.Authorization, undefined);
});

test('an expired own AniList token (HTTP 400 "Invalid token", as AniList answers) is disabled and the pool used', async () => {
    const failed = [];
    const http = fakeFetch({
        anilist: (body, init) => (init.headers.Authorization ? json({ data: null, errors: [{ message: 'Invalid token', status: 400 }] }, { status: 400 }) : aniListFixtures(body)),
        jikan: jikanFixtures
    });
    let disabled = false;
    const credentials = {
        get: (userId, provider) => (!disabled && provider === 'anilist' ? { secret: 'abgelaufen' } : null),
        failed: (userId, provider, message) => { disabled = true; failed.push([userId, provider, message]); },
        status: (userId, provider) => (provider === 'anilist' ? { configured: true, last_error: disabled ? 'abgelehnt' : null } : null)
    };
    const ctx = ctxAs(memoryWith(http.fetch, { credentials }), 'ed');
    const result = await gateway.searchAnime(ctx, 'Frieren');
    assert.equal(result.credential_used, 'shared');
    assert.deepEqual(result.sources_used.sort(), ['anilist', 'jikan']);
    assert.equal(result.partial, false);
    assert.deepEqual(failed, [[2, 'anilist', 'AniList lehnt den Schlüssel ab (400)']]);
    assert.equal(http.count('anilist'), 2);
    assert.equal(gateway.sourcesState(ctx).anilist.key_disabled, true);
    const meta = await gateway.getAnime(ctx, { anilist_id: 154587 });
    assert.equal(meta.anilist_id, 154587, 'later requests go straight to the pool');
    assert.equal(http.calls.filter((c) => c.host === 'anilist' && c.headers.Authorization).length, 1);
});

test('an odd answer for an own key: the pool is asked; the key is disabled only when the pool answers properly', async () => {
    let poolBroken = false;
    const odd = () => json({ data: null, errors: [{ message: 'Something odd', status: 400 }] }, { status: 400 });
    const http = fakeFetch({
        anilist: (body, init) => (init.headers.Authorization || poolBroken ? odd() : aniListFixtures(body)),
        jikan: () => undefined
    });
    const failed = [];
    const credentials = {
        get: (userId, provider) => (provider === 'anilist' ? { secret: 'eigener-token' } : null),
        failed: (...args) => failed.push(args)
    };
    const ctx = ctxAs(memoryWith(http.fetch, { credentials }), 'ed');
    const meta = await gateway.getAnime(ctx, { anilist_id: 154587 });
    assert.equal(meta.anilist_id, 154587);
    assert.equal(failed.length, 0, 'one odd answer is only a strike');
    await gateway.call(ctx, 'anilist', { userId: 2 }, (credential) => aniListExec(ctx, credential));
    assert.equal(failed.length, 1, 'the second strike within ten minutes disables the key');
    assert.match(failed[0][2], /AniList lehnt den Schlüssel ab \(400\)/);

    failed.length = 0;
    poolBroken = true;
    await assert.rejects(gateway.getAnime(ctx, { anilist_id: 154587 }), (err) => err.kind === 'bad');
    assert.equal(failed.length, 0, 'the pool fails the same way: the key stays');
});

test('suspect keys: an empty 2xx answer never counts; two refused answers more than ten minutes apart do not disable', async () => {
    let keyAnswer = () => new Response('', { status: 200 });
    const http = fakeFetch({ anilist: (body, init) => (init.headers.Authorization ? keyAnswer(body) : aniListFixtures(body)), jikan: () => undefined });
    const failed = [];
    const credentials = {
        get: (userId, provider) => (provider === 'anilist' ? { secret: 'eigener-token' } : null),
        failed: (...args) => failed.push(args),
        used: () => {}
    };
    const core = memoryWith(http.fetch, { credentials });
    let now = Date.parse('2026-10-04T10:00:00Z');
    const ctx = { ...ctxAs(core, 'ed'), now: () => new Date(now) };
    const ask = () => gateway.call(ctx, 'anilist', { userId: 2 }, (credential) => aniListExec(ctx, credential));

    for (let i = 0; i < 3; i++) assert.equal((await ask()).credential_used, 'shared');
    assert.equal(failed.length, 0, 'a CDN page or truncated body is a glitch, not a refused key');

    keyAnswer = () => json({ data: null, errors: [{ message: 'Something odd', status: 400 }] }, { status: 400 });
    await ask();
    now += 11 * 60 * 1000;
    await ask();
    assert.equal(failed.length, 0, 'the first strike expired');

    keyAnswer = (body) => aniListFixtures(body);
    assert.equal((await ask()).credential_used, 'own');
    keyAnswer = () => json({ data: null, errors: [{ message: 'Something odd', status: 400 }] }, { status: 400 });
    now += 60 * 1000;
    await ask();
    assert.equal(failed.length, 0, 'a proper answer of the key clears its strike');
    now += 60 * 1000;
    await ask();
    assert.equal(failed.length, 1);
    assert.equal(failed[0][0], 2);
});

test('suspect keys: only answers flagged as GraphQL errors count, not a message that merely looks like one', async () => {
    const failed = [];
    const credentials = {
        get: (userId, provider) => (provider === 'anilist' ? { secret: 'eigener-token' } : null),
        failed: (...args) => failed.push(args),
        used: () => {}
    };
    const http = fakeFetch({ anilist: aniListFixtures, jikan: () => undefined });
    const ctx = ctxAs(memoryWith(http.fetch, { credentials }), 'ed');
    let graphql = false;
    const ask = () => gateway.call(ctx, 'anilist', { userId: 2 }, (credential) => {
        if (credential) throw new SourceError('bad', 'AniList: ungültige Antwort (HTTP 400: kaputt)', { status: 400, graphql });
        return aniListExec(ctx, credential);
    });

    for (let i = 0; i < 3; i++) assert.equal((await ask()).credential_used, 'shared');
    assert.equal(failed.length, 0, 'the message shape alone is no refusal');

    graphql = true;
    await ask();
    await ask();
    assert.equal(failed.length, 1);
    assert.equal(failed[0][0], 2);
});

test('MyAnimeList API only with a client id, Jikan otherwise', async () => {
    const http = fakeFetch({
        anilist: aniListFixtures,
        jikan: jikanFixtures,
        mal: (path) => (path.startsWith('/anime?') ? json(fixture('mal-search-frieren.json')) : undefined)
    });
    const plain = ctxAs(memoryWith(http.fetch), 'ed');
    await gateway.searchAnime(plain, 'Frieren');
    assert.equal(http.count('mal'), 0);

    const withKey = ctxAs(memoryWith(http.fetch, { credentials: { instance: (p) => (p === 'mal' ? { secret: '0123456789abcdef0123456789abcdef' } : null) } }), 'ed');
    const result = await gateway.searchAnime(withKey, 'Frieren');
    assert.ok(result.sources_used.includes('mal'));
    const call = http.calls.find((c) => c.host === 'mal');
    assert.equal(call.headers['X-MAL-CLIENT-ID'], '0123456789abcdef0123456789abcdef');
});

test('a "max query complexity" answer halves the search group and splits the request', async () => {
    let complex = true;
    const http = fakeFetch({
        anilist: (body) => {
            if (Object.keys(body.variables).length > 1 && complex) {
                complex = false;
                return json({ errors: [{ message: 'Max query complexity exceeded', status: 400 }], data: null }, { status: 400 });
            }
            return aniListFixtures(body);
        },
        jikan: jikanFixtures
    });
    const ctx = ctxAs(memoryWith(http.fetch), 'ed');
    const result = await gateway.searchAnime(ctx, 'Tagebücher der Apothekerin');
    assert.equal(result.sources_used.includes('anilist'), true);
    assert.equal(gateway.state().groupSize, 1);
    assert.equal(http.count('anilist'), 3, 'the group, then each term on its own');
});

test('at most 3 waiting searches per user: the fourth gets 429 without asking a source', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const http = fakeFetch({ anilist: async (body) => { await gate; return aniListFixtures(body); }, jikan: async (p) => { await gate; return jikanFixtures(p); } });
    const ctx = ctxAs(memoryWith(http.fetch), 'ed');
    const running = ['a1', 'b2', 'c3'].map((q) => gateway.searchAnime(ctx, q));
    await assert.rejects(gateway.searchAnime(ctx, 'd4'), (err) => err.status === 429 && err.extra.retry_after === 5 && /Zu viele Suchanfragen/.test(err.message));
    const otherUser = gateway.searchAnime({ ...ctx, user: { id: 1, username: 'admin', role: 'admin' } }, 'e5');
    release();
    await Promise.all([...running, otherUser]);
});

test('getAnime: AniList Media with relations, gaps from Jikan by MAL id', async () => {
    const http = fakeFetch({ anilist: aniListFixtures, jikan: (p) => (p.startsWith('/anime/52991/full') ? json({ data: fixture('jikan-search-frieren.json').data[0] }) : undefined) });
    const ctx = ctxAs(memoryWith(http.fetch), 'ed');
    const meta = await gateway.getAnime(ctx, { anilist_id: 154587 });
    assert.equal(meta.source, 'merged');
    assert.equal(meta.anilist_id, 154587);
    assert.equal(meta.mal_id, 52991);
    assert.ok(meta.relations.length > 0);
});

test('background refresh: due entries in one id_in request, only volunteers lend their keys', async () => {
    const http = fakeFetch({ anilist: aniListFixtures });
    const credentials = {
        get: () => ({ secret: 'persönlich-nie-im-hintergrund' }),
        background: (provider) => (provider === 'anilist' ? [{ userId: 3, secret: 'freiwillig' }] : [])
    };
    const core = memoryWith(http.fetch, { credentials });
    const insert = core.conn.prepare("INSERT INTO animes (title, anilist_id, mal_id, status, next_check_at) VALUES (?, ?, ?, 'RELEASING', ?)");
    insert.run('Frieren', 154587, 52991, 1);
    insert.run('One Piece', 21, 21, 1);
    insert.run('Später', 999999, null, Date.now() + 100000);
    const budget = gateway.state().budget;
    while (budget.take('shared:anilist', { perMinute: 30 }, 'refresh', Date.now())) { /* background share of the pool used up */ }
    const report = await gateway.refreshDue(core.ctx);
    assert.deepEqual([report.due, report.updated, report.missing, report.stopped], [2, 2, 0, false]);
    assert.equal(http.count('anilist'), 1, 'one batch for both');
    const call = http.calls[0];
    assert.match(call.body.query, /id_in/);
    assert.equal(call.headers.Authorization, 'Bearer freiwillig');
    const onePiece = core.conn.prepare('SELECT * FROM animes WHERE anilist_id = 21').get();
    assert.equal(onePiece.next_airing_episode, 1181);
    assert.equal(onePiece.meta_source, 'anilist');
    assert.ok(onePiece.next_check_at > Date.now());
});

test('background refresh waits for AniList: a paused AniList stops the sweep', async () => {
    const http = fakeFetch({ anilist: rateLimited, jikan: jikanFixtures });
    const core = memoryWith(http.fetch);
    core.conn.prepare("INSERT INTO animes (title, anilist_id, next_check_at) VALUES ('Frieren', 154587, 1)").run();
    const report = await gateway.refreshDue(core.ctx);
    assert.equal(report.stopped, true);
    assert.equal(http.count('jikan'), 0, 'sweeps never fall back to Jikan one by one');
});

test('a hanging second source costs at most the grace period, not its timeout', async () => {
    const http = fakeFetch({ anilist: aniListFixtures, jikan: () => new Promise(() => {}) });
    const ctx = ctxAs(memoryWith(http.fetch), 'ed');
    const started = Date.now();
    const result = await gateway.searchAnime(ctx, 'Frieren');
    const took = Date.now() - started;
    assert.deepEqual(result.sources_used, ['anilist']);
    assert.equal(result.partial, true);
    assert.ok(took >= 2400 && took < 4000, `answered after ${took} ms`);
    const meta = await gateway.getAnime(ctx, { anilist_id: 154587 });
    assert.equal(meta.anilist_id, 154587, 'AniList alone when MyAnimeList hangs');
});

test('ownOnly calls use the own key alone: no pool, no volunteers, no strikes; without a key kind notoken', async () => {
    const refused = (body, init) => (init.headers.Authorization === 'Bearer eigener'
        ? json({ data: null, errors: [{ message: 'Private list', status: 403 }] }, { status: 403 })
        : aniListFixtures(body));
    const http = fakeFetch({ anilist: refused });
    const failed = [];
    const credentials = {
        get: (userId, provider) => (userId === 2 && provider === 'anilist' ? { secret: 'eigener', allowBackground: false } : null),
        background: () => [{ userId: 3, secret: 'freiwillig' }],
        failed: (...args) => failed.push(args)
    };
    const core = memoryWith(http.fetch, { credentials });
    const exec = (credential) => require('../../core/anime/anilist').listCollection(core.ctx, 7, { credential });
    for (const priority of ['interactive', 'refresh']) {
        await assert.rejects(gateway.call(core.ctx, 'anilist', { priority, userId: 2, ownOnly: true }, exec), (err) => err.kind === 'auth');
    }
    assert.deepEqual(http.calls.map((c) => c.headers.Authorization), ['Bearer eigener', 'Bearer eigener'], 'never the pool or a volunteer');
    assert.equal(failed.length, 2, 'a 403 on the own key disables it like elsewhere');
    await assert.rejects(gateway.call(core.ctx, 'anilist', { userId: 1, ownOnly: true }, exec), (err) => err.kind === 'notoken');
    assert.equal(http.calls.length, 2);

    const bad = fakeFetch({ anilist: () => json({ data: null, errors: [{ message: 'Validation error', status: 400 }] }, { status: 400 }) });
    const quiet = memoryWith(bad.fetch, { credentials: { ...credentials, failed: (...args) => failed.push(args) } });
    await assert.rejects(gateway.call(quiet.ctx, 'anilist', { userId: 2, ownOnly: true }, (credential) => require('../../core/anime/anilist').listCollection(quiet.ctx, 7, { credential })),
        (err) => err.kind === 'bad');
    assert.equal(bad.calls.length, 1);
    assert.equal(failed.length, 2, 'a refused-looking answer is no strike without a pool to compare');
});

test('spare lookups: own key then pool at prefetch priority, no waiting, no volunteers, no half-open probe', async () => {
    const http = fakeFetch({ anilist: aniListFixtures });
    const credentials = {
        get: (userId, provider) => (userId === 2 && provider === 'anilist' ? { secret: 'eigener-token' } : null),
        background: () => [{ userId: 3, secret: 'freiwilliger-token' }],
        used: () => {}
    };
    const ctx = ctxAs(memoryWith(http.fetch, { credentials }), 'ed');
    let counted = 0;
    const options = { userId: 2, beforeRequest: () => { counted++; } };
    const lists = await gateway.spareSearch(ctx, ['Frieren'], options);
    assert.ok(lists[0].length > 0 && lists[0].every((m) => m.anilist_id));
    assert.equal(http.calls.at(-1).headers.Authorization, 'Bearer eigener-token');
    assert.equal(counted, 1);
    assert.ok(cache.read(ctx, `watch:search:${searchKey('Frieren')}`), 'cached under watch:search only');
    assert.equal(cache.read(ctx, `anime:search:${searchKey('Frieren')}:10`), null);
    await gateway.spareSearch(ctx, ['Frieren'], options);
    assert.deepEqual([counted, http.count('anilist')], [1, 1], 'the cached term asks nobody');

    const budget = gateway.state().budget;
    const now = Date.now();
    while (budget.take('user:2:anilist', { perMinute: 30 }, 'prefetch', now)) { /* down to the interactive reserve */ }
    assert.ok(budget.take('user:2:anilist', { perMinute: 30 }, 'interactive', now), 'the own key keeps its reserve for the user');
    await gateway.spareDetail(ctx, [154587], options);
    assert.equal(http.calls.at(-1).headers.Authorization, undefined, 'the pool, not the reserve and never a volunteer');

    for (let i = 0; i < 3; i++) budget.failure('shared:anilist', Date.now());
    while (budget.take('user:2:anilist', { perMinute: 30 }, 'interactive', Date.now())) { /* empty */ }
    await assert.rejects(gateway.spareDetail(ctx, [154587], options), (err) => err instanceof SourceError);
    assert.equal(http.calls.filter((c) => c.headers.Authorization === 'Bearer freiwilliger-token').length, 0);
    budget.state('shared:anilist', Date.now() + 61 * 1000);
    assert.equal(budget.state('shared:anilist', Date.now() + 61 * 1000).circuit, 'half-open');
    const before = http.count('anilist');
    await assert.rejects(gateway.call({ ...ctx, now: () => new Date(Date.now() + 61 * 1000) }, 'anilist', { spare: true }, () => ({ metas: [] })));
    assert.equal(http.count('anilist'), before, 'the half-open pool is left to its own probe');
});

test('spare lookups: the gate runs once per AniList request sent, after a token was taken', async () => {
    const http = fakeFetch({ anilist: (body, init) => (init.headers.Authorization === 'Bearer eigener-token' ? json({}, { status: 503 }) : aniListFixtures(body)) });
    const credentials = { get: (userId, provider) => (userId === 2 && provider === 'anilist' ? { secret: 'eigener-token' } : null), used: () => {} };
    const ctx = ctxAs(memoryWith(http.fetch, { credentials }), 'ed');
    let counted = 0;
    const options = { userId: 2, beforeRequest: () => { counted++; } };
    const lists = await gateway.spareSearch(ctx, ['Frieren'], options);
    assert.ok(lists[0].length > 0);
    assert.deepEqual(http.calls.map((c) => c.headers.Authorization), ['Bearer eigener-token', undefined]);
    assert.equal(counted, 2, 'the own key and then the pool: two requests, two lookups');

    const budget = gateway.state().budget;
    for (const bucket of ['user:2:anilist', 'shared:anilist']) {
        while (budget.take(bucket, { perMinute: 30 }, 'prefetch', Date.now())) { /* down to the interactive reserve */ }
    }
    await assert.rejects(gateway.spareDetail(ctx, [154587], options), (err) => err instanceof SourceError && err.kind === 'busy');
    assert.deepEqual([counted, http.count('anilist')], [2, 2], 'nothing sent, nothing counted');

    let refused = 0;
    const stop = { userId: 2, beforeRequest: () => { refused++; throw new Error('stop'); } };
    gateway.resetGatewayState();
    await assert.rejects(gateway.spareDetail(ctx, [154587], stop), /stop/);
    assert.deepEqual([refused, http.count('anilist')], [1, 2], 'a refusing gate ends the call before the next access');
});

test('spare lookups: the UI cache counts only with AniList in it; a too complex search halves without touching the group size', async () => {
    let complex = true;
    const http = fakeFetch({
        anilist: (body) => {
            if (Object.keys(body.variables).length > 1 && complex) {
                complex = false;
                return json({ errors: [{ message: 'Max query complexity exceeded', status: 400 }], data: null }, { status: 400 });
            }
            return aniListFixtures(body);
        }
    });
    const ctx = ctxAs(memoryWith(http.fetch), 'ed');
    cache.write(ctx, `anime:search:${searchKey('Nur Jikan')}:10`, { results: [{ anilist_id: null, mal_id: 5 }], sources_used: ['jikan'] }, cache.TTL.search);
    cache.write(ctx, `anime:search:${searchKey('Mit AniList')}:10`, { results: [{ anilist_id: 77, mal_id: 5 }, { anilist_id: null, mal_id: 6 }], sources_used: ['anilist', 'jikan'] }, cache.TTL.search);
    let counted = 0;
    const lists = await gateway.spareSearch(ctx, ['Mit AniList', 'Nur Jikan', 'Frieren'], { beforeRequest: () => { counted++; } });
    assert.deepEqual(lists[0].map((m) => m.anilist_id), [77]);
    assert.equal(counted, 3, 'the pair was too complex: one more request per half');
    assert.equal(gateway.state().groupSize, 3);
    assert.deepEqual(http.calls.slice(1).map((c) => Object.values(c.body.variables)), [['Nur Jikan'], ['Frieren']]);
    await assert.rejects(gateway.spareSearch(ctx, ['Ganz Neu'], { beforeRequest: () => { throw new Error('stop'); } }), /stop/);
    assert.equal(http.count('anilist'), 3, 'a refusing gate sends nothing');
});

test('an aborted caller signal is not an outage: the token is released, no failure, no next access', async () => {
    const controller = new AbortController();
    const http = fakeFetch({ anilist: (body, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) });
    const credentials = { get: (userId, provider) => (userId === 2 && provider === 'anilist' ? { secret: 'eigener-token' } : null), used: () => {} };
    const ctx = ctxAs(memoryWith(http.fetch, { credentials }), 'ed');
    for (let i = 0; i < 3; i++) {
        const signal = i === 0 ? controller.signal : AbortSignal.abort();
        const pending = gateway.spareSearch(ctx, [`Abbruch ${i}`], { userId: 2, signal });
        if (i === 0) setTimeout(() => controller.abort(), 10);
        await assert.rejects(pending, (err) => err instanceof SourceError && (i > 0 || err.aborted === true));
    }
    assert.equal(http.count('anilist'), 1, 'own key only, the pool is not tried; an aborted signal sends nothing');
    assert.equal(gateway.state().budget.state('user:2:anilist', Date.now()).circuit, 'closed');
});
