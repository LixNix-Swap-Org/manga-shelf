// Anime tags, the anime calendar feed (iCal with times) and the checks of the discover endpoints.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../helpers');

let ctx;
let admin;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
});
test.after(async () => { await ctx.close(); });

test('tags are trimmed, deduplicated and validated', async () => {
    const created = await admin('POST', '/anime', { title: 'Tag-Serie', episodes: 12, kind: 'anime' });
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.deepEqual(created.body.tags, []);
    const put = await admin('PUT', `/anime/${id}`, { tags: ['  Winter 2026 ', 'winter 2026', 'Mit Freunden'] });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body.tags, ['Winter 2026', 'Mit Freunden']);
    assert.deepEqual((await admin('GET', '/anime')).body.find((a) => a.id === id).tags, ['Winter 2026', 'Mit Freunden']);
    assert.equal((await admin('PUT', `/anime/${id}`, { tags: ['x'.repeat(31)] })).status, 400);
    assert.equal((await admin('PUT', `/anime/${id}`, { tags: 'Winter' })).status, 400);
    assert.equal((await admin('PUT', `/anime/${id}`, { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).status, 400);
    assert.deepEqual((await admin('PUT', `/anime/${id}`, { tags: null })).body.tags, []);
});

test('tags_add / tags_remove change the stored tags, so two people adding at once both keep theirs', async () => {
    const id = (await admin('POST', '/anime', { title: 'Gemeinsame Tags', episodes: 12, kind: 'anime' })).body.id;
    await admin('PUT', `/anime/${id}`, { tags: ['Winter'] });
    // both started from ['Winter']: the second change no longer drops the first one's tag
    assert.deepEqual((await admin('PUT', `/anime/${id}`, { tags_add: ['Mit Freunden'] })).body.tags, ['Winter', 'Mit Freunden']);
    assert.deepEqual((await admin('PUT', `/anime/${id}`, { tags_add: [' Lieblinge '] })).body.tags, ['Winter', 'Mit Freunden', 'Lieblinge']);
    assert.deepEqual((await admin('PUT', `/anime/${id}`, { tags_add: ['winter'] })).body.tags, ['Winter', 'Mit Freunden', 'Lieblinge']);
    assert.deepEqual((await admin('PUT', `/anime/${id}`, { tags_remove: ['mit freunden'] })).body.tags, ['Winter', 'Lieblinge']);
    assert.deepEqual((await admin('PUT', `/anime/${id}`, { tags_remove: ['Gibt es nicht'] })).body.tags, ['Winter', 'Lieblinge']);
    assert.equal((await admin('PUT', `/anime/${id}`, { tags_add: 'Winter' })).status, 400);
    assert.equal((await admin('PUT', `/anime/${id}`, { tags_add: ['x'.repeat(31)] })).status, 400);
    assert.equal((await admin('PUT', `/anime/${id}`, { tags_add: Array.from({ length: 19 }, (_, i) => `t${i}`) })).status, 400);
    assert.deepEqual((await admin('GET', `/anime/${id}`)).body.tags, ['Winter', 'Lieblinge']);
    // `tags` still replaces the whole list and wins over tags_add
    assert.deepEqual((await admin('PUT', `/anime/${id}`, { tags: ['Neu'], tags_add: ['Ignoriert'] })).body.tags, ['Neu']);
});

test('anime feed: needs the radar token, lists next and estimated weekly episodes with times', async () => {
    const { db } = require('../../db');
    const created = await admin('POST', '/anime', { title: 'Weekly Show', episodes: 12, kind: 'anime' });
    const id = created.body.id;
    assert.equal((await admin('PUT', `/anime/${id}/progress`, { status: 'Schaue', episodes_watched: 2 })).status, 200);
    const at = Math.floor(Date.now() / 1000) + 3600;
    db.prepare("UPDATE animes SET format = 'TV', next_airing_episode = 3, next_airing_at = ?, next_airing_estimated = 0 WHERE id = ?").run(at, id);
    const other = await admin('POST', '/anime', { title: 'Nicht auf der Liste', episodes: 12, kind: 'anime' });
    db.prepare('UPDATE animes SET next_airing_episode = 1, next_airing_at = ? WHERE id = ?').run(at, other.body.id);
    assert.equal((await admin('DELETE', `/anime/${other.body.id}/progress`)).status, 200);

    assert.equal((await fetch(`${ctx.base}/anime/feed.ics`)).status, 404);
    assert.equal((await fetch(`${ctx.base}/anime/feed.ics?token=${'a'.repeat(43)}`)).status, 404);
    const token = (await admin('POST', '/radar/feed-token')).body.path.split('token=')[1];
    const res = await fetch(`${ctx.base}/anime/feed.ics?token=${token}`);
    assert.equal(res.status, 200);
    assert.ok((await admin('GET', '/radar/feed-token')).body.last_used_at, 'the anime feed marks the token as used');
    assert.match(res.headers.get('content-type'), /text\/calendar/);
    const text = await res.text();
    assert.equal((text.match(/BEGIN:VEVENT/g) || []).length, 4, 'next episode and three weekly estimates');
    assert.match(text, /SUMMARY:Weekly Show – Folge 3\r\n/);
    assert.match(text, /SUMMARY:Weekly Show – Folge 4 \(geschätzt\)/);
    assert.match(text, /DTSTART:\d{8}T\d{6}Z/);
    assert.doesNotMatch(text, /Nicht auf der Liste/);
});

test('discover endpoints check their input', async () => {
    assert.equal((await admin('GET', '/anime/discover/season?season=MONSUN&year=2026')).status, 400);
    assert.equal((await admin('GET', '/anime/discover/season?season=FALL&year=1900')).status, 400);
    assert.equal((await ctx.client()('GET', '/anime/discover/season')).status, 401);
    const recs = await admin('GET', '/anime/discover/recommendations');
    assert.equal(recs.status, 200);
    assert.equal(recs.body.seeds >= 0, true);
});

test('a passed episode is kept in the history when the next one replaces it', async () => {
    const { db } = require('../../db');
    const store = require('../../core/anime/store');
    const { createCtx } = require('../../db');
    const created = await admin('POST', '/anime', { title: 'History Show', episodes: 12, kind: 'anime' });
    const id = created.body.id;
    const past = Math.floor(Date.now() / 1000) - 3600;
    db.prepare('UPDATE animes SET next_airing_episode = 5, next_airing_at = ?, next_airing_estimated = 0 WHERE id = ?').run(past, id);
    const { emptyMeta } = require('../../core/anime/normalize');
    const meta = emptyMeta({ title: { romaji: 'History Show', english: null, native: null }, next_airing: { episode: 6, at: past + 7 * 86400 }, source: 'anilist' });
    assert.equal(store.applySnapshot(createCtx(), id, meta), true);
    assert.deepEqual(db.prepare('SELECT episode, at FROM anime_airings WHERE anime_id = ?').all(id).map((r) => ({ ...r })), [{ episode: 5, at: past }]);
    // the same snapshot again changes nothing, a future announcement is not recorded
    store.applySnapshot(createCtx(), id, meta);
    assert.equal(db.prepare('SELECT count(*) AS n FROM anime_airings WHERE anime_id = ?').get(id).n, 1);

    const day = (s) => new Date(s * 1000).toISOString().slice(0, 10);
    const res = await admin('GET', `/anime/history?from=${day(past - 86400)}&to=${day(past + 86400)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.airings.some((a) => a.anime_id === id), true, 'listed for the account that follows it');
    assert.equal((await admin('GET', '/anime/history?from=2026-01-01&to=2028-01-01')).status, 400);
    assert.equal((await admin('GET', '/anime/history?from=x&to=y')).status, 400);
});

test('statistics carry the anime insights', async () => {
    const created = await admin('POST', '/anime', { title: 'Insight-Serie', episodes: 12, kind: 'anime', genres: ['Action'], studios: ['Studio X'] });
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.equal((await admin('PUT', `/anime/${id}/progress`, { status: 'Gesehen', score: 8 })).status, 200);
    const stats = await admin('GET', '/stats');
    assert.equal(stats.status, 200);
    const insights = stats.body.anime.insights;
    assert.equal(insights.scores.length, 10);
    assert.equal(insights.scores[7], 1);
    assert.equal(insights.by_month.length, 12);
    assert.equal(insights.by_month.at(-1).completed, 1);
    assert.equal(insights.recap.completed, 1);
    assert.equal(insights.recap.average, 8);
});
