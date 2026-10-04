// Background refresh of anime entries: sweeps, stale-while-revalidate, locks and abort on db reopen.
const test = require('node:test');
const assert = require('node:assert/strict');
const gateway = require('../../core/anime/gateway');
const { fakeFetch, aniListFixtures, jikanFixtures, memoryWith, ctxAs, json, fixture } = require('./helpers');

test.afterEach(() => gateway.resetGatewayState());

const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await gateway.state().background.idle();
};

/** AniList id batches as they come without the MAL merge: no English title, studios or genres for Frieren. */
function thinBatches(body) {
    if (!body.query.includes('id_in') && !body.query.includes('idMal_in')) return aniListFixtures(body);
    const data = fixture('anilist-ids.json');
    for (const media of data.data.Page.media) {
        if (media.id !== 154587) continue;
        media.title.english = null;
        media.studios = { nodes: [] };
        media.genres = [];
    }
    return json(data);
}

const kept = (core, id) => core.conn.prepare('SELECT description, relations, title, title_english, studios, genres, external_links, streaming_episodes FROM animes WHERE id = ?').get(id);

test('background refreshes never wipe data: sweep and stale-while-revalidate keep description, relations, English title, studios, genres, links', async () => {
    const http = fakeFetch({ anilist: thinBatches });
    const core = memoryWith(http.fetch);
    const created = await core.client('ed')('POST', '/anime', { anilist_id: 154587 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id;
    const before = kept(core, id);
    assert.ok(before.description.length > 500);
    assert.ok(JSON.parse(before.relations).length > 0);
    assert.equal(before.studios, 'MADHOUSE');
    assert.equal(JSON.parse(before.external_links).length, 3);
    assert.equal(JSON.parse(before.streaming_episodes).length, 3);

    core.conn.prepare('UPDATE animes SET next_check_at = 1 WHERE id = ?').run(id);
    const report = await gateway.refreshDue(core.ctx);
    assert.equal(report.updated, 1);
    const batch = http.calls.filter((c) => c.host === 'anilist').at(-1);
    assert.match(batch.body.query, /id_in/);
    assert.match(batch.body.query, /description\(asHtml: false\)/, 'the id batch asks for the description');
    assert.match(batch.body.query, /externalLinks \{ site url type \} streamingEpisodes \{ title url site \}/, 'and for the links');
    assert.deepEqual(kept(core, id), before);

    core.conn.prepare('UPDATE animes SET next_check_at = 1 WHERE id = ?').run(id);
    assert.equal((await core.client('ed')('GET', '/anime')).body[0].stale, true);
    await settle();
    assert.deepEqual(kept(core, id), before);
    assert.ok(core.conn.prepare('SELECT next_check_at FROM animes WHERE id = ?').get(id).next_check_at > Date.now());
});

test('id resolution of a MyAnimeList entry keeps its description and relations', async () => {
    const http = fakeFetch({ anilist: thinBatches });
    const core = memoryWith(http.fetch);
    core.conn.prepare("INSERT INTO animes (id, title, mal_id, description, relations, studios) VALUES (4, 'Frieren', 52991, 'Eigene Beschreibung', '[{\"relation\":\"SEQUEL\"}]', 'Madhouse')").run();
    assert.ok(gateway.scheduleIdResolution(core.ctx, 4));
    await settle();
    const row = core.conn.prepare('SELECT * FROM animes WHERE id = 4').get();
    assert.equal(row.anilist_id, 154587);
    assert.equal(row.description, 'Eigene Beschreibung');
    assert.equal(row.relations, '[{"relation":"SEQUEL"}]');
    assert.equal(row.studios, 'Madhouse');
});

test('stale-while-revalidate: stale entries go out in one batched AniList request', async () => {
    const http = fakeFetch({ anilist: aniListFixtures });
    const core = memoryWith(http.fetch);
    const insert = core.conn.prepare("INSERT INTO animes (title, anilist_id, status, next_check_at) VALUES (?, ?, 'RELEASING', 1)");
    insert.run('A', 21);
    insert.run('B', 16498);
    insert.run('C', 154587);
    const list = await core.client('ed')('GET', '/anime');
    assert.equal(list.body.filter((e) => e.stale).length, 3);
    await core.client('ed')('GET', '/anime');
    await settle();
    assert.equal(http.count('anilist'), 1);
    assert.deepEqual([...http.calls[0].body.variables.ids].sort((a, b) => a - b), [21, 16498, 154587]);
    assert.equal(core.conn.prepare('SELECT count(*) AS n FROM animes WHERE next_check_at > ?').get(Date.now()).n, 3);
});

test('MyAnimeList-only entries AniList does not know are refreshed over the MyAnimeList side', async () => {
    const http = fakeFetch({ anilist: aniListFixtures, jikan: jikanFixtures });
    const core = memoryWith(http.fetch);
    core.conn.prepare("INSERT INTO animes (id, title, mal_id, status, episodes, next_check_at) VALUES (8, 'Nur MAL', 99999, 'RELEASING', 3, 1)").run();

    await core.client('ed')('GET', '/anime');
    await settle();
    assert.equal(http.count('anilist'), 1, 'the idMal batch first');
    assert.equal(http.count('jikan'), 1, 'then Jikan for the entry AniList does not know');
    let row = core.conn.prepare('SELECT * FROM animes WHERE id = 8').get();
    assert.equal(row.meta_source, 'jikan');

    core.conn.prepare('UPDATE animes SET next_check_at = 1, meta_source = NULL WHERE id = 8').run();
    const report = await gateway.refreshDue(core.ctx);
    assert.deepEqual([report.due, report.updated, report.missing], [1, 0, 1]);
    await settle();
    assert.equal(http.count('jikan'), 2, 'the sweep queued the entry for the MyAnimeList side');
    row = core.conn.prepare('SELECT * FROM animes WHERE id = 8').get();
    assert.equal(row.meta_source, 'jikan');
});

test('manual refresh takes the 60 s lock only once it got a place in the per-user cap', async () => {
    const http = fakeFetch({ anilist: aniListFixtures, jikan: () => undefined });
    const core = memoryWith(http.fetch);
    core.conn.prepare("INSERT INTO animes (id, title, anilist_id) VALUES (5, 'Frieren', 154587)").run();
    const ed = core.client('ed');
    gateway.state();
    const users = gateway.state().users;
    for (let i = 0; i < 3; i++) assert.ok(users.enter(2));
    const refused = await ed('POST', '/anime/5/refresh');
    assert.equal(refused.status, 429);
    assert.equal(refused.body.code, 'TOO_MANY_SEARCHES');
    for (let i = 0; i < 3; i++) users.leave(2);
    const ok = await ed('POST', '/anime/5/refresh');
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.refreshed, true);
});

test('a database reopened during a refresh stops it before any write', async () => {
    let generation = 1;
    let reopenOnCall = false;
    const http = fakeFetch({
        anilist: (body) => {
            if (reopenOnCall) generation++;
            return aniListFixtures(body);
        },
        jikan: () => undefined
    });
    const core = memoryWith(http.fetch);
    core.ctx.db.generation = () => generation;
    core.conn.prepare("INSERT INTO animes (id, title, anilist_id, status, next_check_at) VALUES (5, 'Alt', 154587, 'RELEASING', 1)").run();
    reopenOnCall = true;
    const report = await gateway.refreshDue(core.ctx);
    assert.deepEqual([report.updated, report.stopped], [0, true]);
    const row = core.conn.prepare('SELECT * FROM animes WHERE id = 5').get();
    assert.equal(row.title, 'Alt');
    assert.equal(row.next_check_at, 1);

    const manual = await core.client('ed')('POST', '/anime/5/refresh');
    assert.equal(manual.status, 503);
    assert.equal(core.conn.prepare('SELECT title FROM animes WHERE id = 5').get().title, 'Alt');
});

test('refreshDue checks shouldStop again after the pause between groups', async () => {
    let stop = false;
    const http = fakeFetch({
        anilist: (body) => {
            setTimeout(() => { stop = true; }, 20);
            return aniListFixtures(body);
        }
    });
    const core = memoryWith(http.fetch);
    core.conn.prepare("INSERT INTO animes (title, anilist_id, next_check_at) VALUES ('Frieren', 154587, 1)").run();
    core.conn.prepare("INSERT INTO animes (title, mal_id, next_check_at) VALUES ('Nur MAL', 21, 1)").run();
    const report = await gateway.refreshDue(core.ctx, { pauseMs: 100, shouldStop: () => stop });
    assert.equal(http.count('anilist'), 1, 'the second group is not sent after the pause');
    assert.equal(report.updated, 1);
});

test('api_cache is pruned on every sweep, also when nothing is due', async () => {
    const core = memoryWith(fakeFetch().fetch);
    const insert = core.conn.prepare('INSERT INTO api_cache (cache_key, json_data, created_at, expires_at) VALUES (?, ?, ?, ?)');
    const now = Date.now();
    for (let i = 0; i < 2100; i++) insert.run(`fresh:${i}`, '{}', now - 1000 + i, now + 60000);
    for (let i = 0; i < 400; i++) insert.run(`old:${i}`, '{}', 1, 2);
    const report = await gateway.refreshDue(core.ctx);
    assert.equal(report.due, 0);
    assert.equal(core.conn.prepare("SELECT count(*) AS n FROM api_cache WHERE cache_key LIKE 'old:%'").get().n, 0);
    assert.equal(core.conn.prepare('SELECT count(*) AS n FROM api_cache').get().n, 2000);
});

test('series lookup: a MyAnimeList hit of an AniList hit is merged into it (also_on)', async () => {
    const http = fakeFetch({ anilist: aniListFixtures, jikan: jikanFixtures });
    const ctx = ctxAs(memoryWith(http.fetch), 'ed');
    const results = await gateway.searchManga(ctx, 'Berserk');
    const berserk = results.find((r) => r.id === 'al_30002');
    assert.equal(berserk.mal_id, 2);
    assert.deepEqual(berserk.also_on, ['mal']);
    assert.equal(results.some((r) => r.id === 'mal_2'), false);
    assert.equal(results.filter((r) => r.source === 'anilist').length, 3);
});

test('an id batch AniList finds too complex is split in halves, not dropped', async () => {
    const sizes = [];
    const http = fakeFetch({
        anilist: (body) => {
            if (!body.query.includes('id_in')) return aniListFixtures(body);
            sizes.push(body.variables.ids.length);
            if (body.variables.ids.length > 1) return json({ data: null, errors: [{ message: 'Max query complexity' }] }, { status: 400 });
            return aniListFixtures(body);
        }
    });
    const core = memoryWith(http.fetch);
    const insert = core.conn.prepare("INSERT INTO animes (title, anilist_id, next_check_at) VALUES (?, ?, 1)");
    insert.run('A', 21);
    insert.run('B', 16498);
    insert.run('C', 154587);
    const report = await gateway.refreshDue(core.ctx);
    assert.deepEqual([report.due, report.updated, report.stopped], [3, 3, false]);
    assert.deepEqual(sizes, [3, 2, 1, 1, 1]);
});

test('an interactive refresh answered only by the MyAnimeList side keeps the streaming links', async () => {
    let aniListUp = true;
    const http = fakeFetch({ anilist: (body) => (aniListUp ? aniListFixtures(body) : undefined), jikan: jikanFixtures });
    const core = memoryWith(http.fetch);
    const created = await core.client('ed')('POST', '/anime', { anilist_id: 154587 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id;
    const before = kept(core, id);
    assert.equal(JSON.parse(before.external_links).length, 3);
    aniListUp = false;
    const res = await core.client('ed')('POST', `/anime/${id}/refresh`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(core.conn.prepare('SELECT meta_source FROM animes WHERE id = ?').get(id).meta_source, 'jikan');
    const after = kept(core, id);
    assert.deepEqual([after.external_links, after.streaming_episodes], [before.external_links, before.streaming_episodes]);
    assert.equal(res.body.external_links.length, 3);
});
