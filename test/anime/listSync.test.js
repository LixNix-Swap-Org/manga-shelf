// AniList list sync (core/anime/listSync.js): merge rule, own key only, throttle, push coalescing, routes.
const test = require('node:test');
const assert = require('node:assert/strict');
const gateway = require('../../core/anime/gateway');
const listSync = require('../../core/anime/listSync');
const { fakeFetch, aniListFixtures, memoryWith, ctxAs, json } = require('./helpers');

test.afterEach(() => gateway.resetGatewayState());

async function waitUntil(check, ms = 3000) {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) throw new Error('waitUntil: timed out');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

/** Credentials of user 2 ('ed'): an own AniList token; user 3 is a volunteer that must never be used. */
function credentials({ allowBackground = false } = {}) {
    const failed = [];
    let own = { secret: 'eigener-token', allowBackground };
    return {
        failed,
        provider: {
            get: (userId, provider) => (userId === 2 && provider === 'anilist' ? own : null),
            background: () => [{ userId: 3, secret: 'freiwilliger-token' }],
            failed: (userId, provider, message) => { failed.push([userId, provider, message]); own = null; },
            used: () => {},
            status: () => null
        }
    };
}

function setup({ handler = aniListFixtures, allowBackground = false } = {}) {
    const http = fakeFetch({ anilist: handler });
    const creds = credentials({ allowBackground });
    const core = memoryWith(http.fetch, { credentials: creds.provider });
    const add = (title, anilistId, episodes) => Number(core.conn.prepare('INSERT INTO animes (title, anilist_id, episodes) VALUES (?, ?, ?)').run(title, anilistId, episodes).lastInsertRowid);
    const ids = { frieren: add('Frieren', 154587, 28), onePiece: add('One Piece', 21, null), aot: add('Attack on Titan', 16498, 25), local: add('Nur hier', 777, 12) };
    const progress = core.conn.prepare("INSERT INTO anime_progress (anime_id, user_id, status, episodes_watched, updated_at) VALUES (?, 2, ?, ?, '2025-01-01 00:00:00')");
    progress.run(ids.frieren, 'Schaue', 6);
    progress.run(ids.onePiece, 'Schaue', 1100);
    progress.run(ids.aot, 'Gesehen', 25);
    progress.run(ids.local, 'Schaue', 2);
    return { http, creds, core, ids, ed: core.client('ed'), mine: (id) => core.conn.prepare('SELECT * FROM anime_progress WHERE anime_id = ? AND user_id = 2').get(id) };
}

const anilistCalls = (http) => http.calls.filter((c) => c.host === 'anilist');

test('switching on checks the own token (Viewer) and stores the AniList user; visitors and missing tokens are refused', async () => {
    const { ed, core, http } = setup();
    assert.equal((await core.client('vis')('GET', '/anime/sync')).status, 403);
    let res = await ed('GET', '/anime/sync');
    assert.deepEqual(res.body, { anilist: { enabled: false, external_user_id: null, last_synced_at: null, last_error: null, last_report: null, available: true } });
    assert.equal((await ed('PUT', '/anime/sync', { anilist: {} })).status, 400);
    res = await ed('PUT', '/anime/sync', { anilist: { enabled: true } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.anilist.enabled, res.body.anilist.external_user_id], [true, '7']);
    assert.equal(anilistCalls(http)[0].headers.Authorization, 'Bearer eigener-token');
    res = await ed('PUT', '/anime/sync', { anilist: { enabled: false } });
    assert.deepEqual([res.body.anilist.enabled, res.body.anilist.external_user_id], [false, '7']);

    const admin = await core.client('admin')('PUT', '/anime/sync', { anilist: { enabled: true } });
    assert.deepEqual([admin.status, admin.body.code], [400, 'NO_TOKEN'], 'no own token, no pool fallback');
});

test('pull and push: higher count wins, status follows, entries outside the list are only counted', async () => {
    const { ed, http, ids, mine } = setup();
    await ed('PUT', '/anime/sync', { anilist: { enabled: true } });
    const res = await ed('POST', '/anime/sync/run', {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const r = res.body.anilist;
    assert.deepEqual([r.ran, r.pulled, r.pushed, r.not_in_list, r.changed, r.last_error], [true, 1, 1, 1, true, null]);
    assert.ok(r.last_synced_at > 0);
    assert.deepEqual([mine(ids.frieren).episodes_watched, mine(ids.frieren).status], [10, 'Schaue'], 'AniList was ahead');
    assert.equal(mine(ids.onePiece).episodes_watched, 1100, 'never backwards');
    const save = anilistCalls(http).find((c) => c.body.query.includes('SaveMediaListEntry'));
    assert.deepEqual(save.body.variables, { m: 21, p: 1100, s: 'CURRENT' });
    assert.ok(anilistCalls(http).every((c) => c.headers.Authorization === 'Bearer eigener-token'), 'only the own token, never the pool or a volunteer');
    assert.equal(mine(ids.local).episodes_watched, 2, 'local-only entries are left alone');

    const again = await ed('POST', '/anime/sync/run', {});
    assert.deepEqual([again.body.anilist.ran, again.body.anilist.pulled], [false, 0], 'at most once a minute');
    const state = (await ed('GET', '/anime/sync')).body.anilist;
    assert.deepEqual(state.last_report, { pulled: 1, pushed: 1, not_in_list: 1 });
});

test('decide: tie on progress goes to the newer side; a rewatch is never overwritten', () => {
    const local = { status: 'Schaue', episodes_watched: 5, updated_at: '2025-10-01 12:00:00' };
    const at = Date.parse('2025-10-01T12:00:00Z') / 1000;
    assert.equal(listSync.decide({ status: 'CURRENT', progress: 6, updatedAt: 0 }, local), 'pull');
    assert.equal(listSync.decide({ status: 'COMPLETED', progress: 4, updatedAt: at + 999 }, local), 'push');
    assert.equal(listSync.decide({ status: 'PAUSED', progress: 5, updatedAt: at + 60 }, local), 'pull');
    assert.equal(listSync.decide({ status: 'PAUSED', progress: 5, updatedAt: at - 60 }, local), 'push');
    assert.equal(listSync.decide({ status: 'CURRENT', progress: 5, updatedAt: at + 60 }, local), null);
    assert.equal(listSync.decide({ status: 'REPEATING', progress: 2, updatedAt: at + 60 }, { ...local, status: 'Gesehen' }), null);
    assert.equal(listSync.decide({ status: 'PLANNING', progress: 0, updatedAt: 1 }, null), 'pull');
});

test('a refused token is disabled, recorded and never retried over the pool', async () => {
    let viewerDone = false;
    const handler = (body, init) => {
        if (body.query.includes('Viewer')) {
            viewerDone = true;
            return aniListFixtures(body);
        }
        return init.headers.Authorization ? json({ data: null, errors: [{ message: 'Invalid token', status: 400 }] }, { status: 400 }) : aniListFixtures(body);
    };
    const { ed, http, creds } = setup({ handler });
    await ed('PUT', '/anime/sync', { anilist: { enabled: true } });
    assert.ok(viewerDone);
    const res = await ed('POST', '/anime/sync/run', {});
    assert.deepEqual([res.body.anilist.ran, res.body.anilist.last_error], [true, listSync.TEXT.rejected]);
    assert.deepEqual(creds.failed, [[2, 'anilist', 'AniList lehnt den Schlüssel ab (400)']]);
    assert.equal(anilistCalls(http).length, 2, 'Viewer and one list read, no retry without the token');
    assert.equal((await ed('GET', '/anime/sync')).body.anilist.last_synced_at, null);
});

test('auto run from the anime tab skips a sync younger than 15 minutes', async () => {
    const { ed, core } = setup();
    await ed('PUT', '/anime/sync', { anilist: { enabled: true } });
    core.conn.prepare('UPDATE anime_sync SET last_synced_at = ?').run(Date.now() - 60 * 1000);
    assert.equal((await ed('POST', '/anime/sync/run', { auto: true })).body.anilist.ran, false);
    core.conn.prepare('UPDATE anime_sync SET last_synced_at = ?').run(Date.now() - 20 * 60 * 1000);
    assert.equal((await ed('POST', '/anime/sync/run', { auto: true })).body.anilist.ran, true);
});

test('background runs (scheduler) need allowBackground and a due sync', async () => {
    const off = setup();
    await off.ed('PUT', '/anime/sync', { anilist: { enabled: true } });
    const before = off.http.count('anilist');
    assert.deepEqual(await listSync.runDue(off.core.ctx), { due: 1, ran: 0 });
    assert.equal(off.http.count('anilist'), before, 'no call without allowBackground');
    gateway.resetGatewayState();

    const on = setup({ allowBackground: true });
    await on.ed('PUT', '/anime/sync', { anilist: { enabled: true } });
    assert.deepEqual(await listSync.runDue(on.core.ctx), { due: 1, ran: 1 });
    assert.deepEqual(await listSync.runDue(on.core.ctx), { due: 0, ran: 0 }, 'next one in 6 hours');
});

test('quick +1 presses become one AniList read and one write; admins acting for others never push', async () => {
    const { ed, core, http, ids } = setup();
    await ed('PUT', '/anime/sync', { anilist: { enabled: true } });
    listSync.setPushDelay(50);
    for (const n of [7, 8, 9]) assert.equal((await ed('PUT', `/anime/${ids.frieren}/progress`, { episodes_watched: n })).status, 200);
    await waitUntil(() => anilistCalls(http).some((c) => c.body.query.includes('SaveMediaListEntry')));
    await gateway.state().background.idle();
    const reads = anilistCalls(http).filter((c) => c.body.query.includes('MediaList('));
    const writes = anilistCalls(http).filter((c) => c.body.query.includes('SaveMediaListEntry'));
    assert.deepEqual([reads.length, writes.length], [1, 1]);
    assert.deepEqual(writes[0].body.variables, { m: 154587, p: 9, s: 'CURRENT' });

    const calls = anilistCalls(http).length;
    assert.equal((await core.client('admin')('PUT', `/anime/${ids.frieren}/progress`, { user_id: 2, episodes_watched: 10 })).status, 200);
    assert.equal(listSync.schedulePush(ctxAs(core, 'admin'), 2, ids.frieren), false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await gateway.state().background.idle();
    assert.equal(anilistCalls(http).length, calls);
});

test('a database reopened during the sync writes nothing', async () => {
    let generation = 1;
    const handler = (body) => {
        if (body.query.includes('MediaListCollection')) generation++;
        return aniListFixtures(body);
    };
    const { core, ids, mine } = setup({ handler });
    const ctx = { ...ctxAs(core, 'ed'), db: { ...core.ctx.db, generation: () => generation } };
    await listSync.setEnabled(ctx, 2, true);
    const result = await listSync.run(ctx, 2);
    assert.equal(result.ran, false);
    assert.equal(mine(ids.frieren).episodes_watched, 6);
    assert.equal(core.conn.prepare('SELECT last_synced_at FROM anime_sync').get().last_synced_at, null);
});

test('switching the sync off clears an old token error, so the paused hint disappears', async () => {
    const { core } = setup();
    const ctx = ctxAs(core, 'ed');
    await listSync.setEnabled(ctx, 2, true);
    core.conn.prepare("UPDATE anime_sync SET last_error = 'AniList lehnt den Token ab' WHERE user_id = 2").run();
    const state = await listSync.setEnabled(ctx, 2, false);
    assert.equal(state.enabled, false);
    assert.equal(state.last_error, null);
    assert.equal(core.conn.prepare('SELECT enabled, last_error FROM anime_sync WHERE user_id = 2').get().last_error, null);
});

test('a replaced key resolves the AniList account again; a removed key switches the sync off', async () => {
    let token = 'token-a';
    const handler = (body, init) => {
        if (body.query.includes('Viewer')) return json({ data: { Viewer: { id: init.headers.Authorization === 'Bearer token-b' ? 99 : 7, name: 'x' } } });
        return aniListFixtures(body);
    };
    const http = fakeFetch({ anilist: handler });
    const provider = { get: (userId, p) => (userId === 2 && p === 'anilist' && token ? { secret: token, allowBackground: false } : null), used: () => {}, failed: () => {} };
    const core = memoryWith(http.fetch, { credentials: provider });
    const ctx = ctxAs(core, 'ed');
    assert.equal((await listSync.setEnabled(ctx, 2, true)).external_user_id, '7');
    core.conn.prepare("UPDATE anime_sync SET last_error = 'AniList lehnt den Token ab' WHERE user_id = 2").run();

    token = 'token-b';
    listSync.onCredentialChanged(ctx, 2, 'mal');
    assert.equal(listSync.stateOf(ctx, 2).external_user_id, '7', 'other providers leave the sync alone');
    listSync.onCredentialChanged(ctx, 2, 'anilist');
    assert.deepEqual([listSync.stateOf(ctx, 2).enabled, listSync.stateOf(ctx, 2).external_user_id, listSync.stateOf(ctx, 2).last_error], [true, null, null]);
    assert.equal(listSync.schedulePush(ctx, 2, 1), false, 'no push before the new account is known');
    const result = await listSync.run(ctx, 2);
    assert.equal(result.ran, true);
    const read = anilistCalls(http).find((c) => c.body.query.includes('MediaListCollection'));
    assert.deepEqual([read.body.variables.u, read.headers.Authorization], [99, 'Bearer token-b'], 'reads the list of the new key');
    assert.equal(listSync.stateOf(ctx, 2).external_user_id, '99');

    token = null;
    listSync.onCredentialChanged(ctx, 2, 'anilist', { removed: true });
    assert.deepEqual([listSync.stateOf(ctx, 2).enabled, listSync.stateOf(ctx, 2).external_user_id, listSync.stateOf(ctx, 2).last_error], [false, null, null]);
});

test('read-only roles: the background sync skips them and a demotion switches the sync off', async () => {
    const { ed, core } = setup({ allowBackground: true });
    await ed('PUT', '/anime/sync', { anilist: { enabled: true } });
    core.conn.prepare("UPDATE users SET role = 'visitor' WHERE id = 2").run();
    assert.deepEqual(await listSync.runDue(core.ctx), { due: 0, ran: 0 });
    core.conn.prepare("UPDATE users SET role = 'editor' WHERE id = 2").run();
    listSync.onRoleChanged(core.ctx, 2, 'editor');
    assert.deepEqual(await listSync.runDue(core.ctx), { due: 1, ran: 1 }, 'editors keep their sync');
    listSync.onRoleChanged(core.ctx, 2, 'guest');
    assert.equal(listSync.stateOf(core.ctx, 2).enabled, false);
});

test('a key saved while a sync runs is not overwritten with the old account', async () => {
    let core;
    const handler = (body) => {
        if (body.query.includes('MediaListCollection')) listSync.onCredentialChanged(core.ctx, 2, 'anilist');
        return aniListFixtures(body);
    };
    ({ core } = setup({ handler }));
    const ctx = ctxAs(core, 'ed');
    await listSync.setEnabled(ctx, 2, true);
    assert.equal((await listSync.run(ctx, 2)).ran, true);
    assert.equal(listSync.stateOf(ctx, 2).external_user_id, null);
});
