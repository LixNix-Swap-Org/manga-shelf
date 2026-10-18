// Anime ratings of a shared entry: public (named), anonymous (counted, no name), private (hidden); notes are never shared.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../helpers');

let ctx;
let anna;
let ben;
let carl;
let admin;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    anna = ctx.client();
    ben = ctx.client();
    carl = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    for (const name of ['anna', 'ben', 'carl']) {
        assert.equal((await admin('POST', '/users', { username: name, password: 'password123', role: 'editor' })).status, 200);
    }
    assert.equal((await anna('POST', '/auth/login', { username: 'anna', password: 'password123' })).status, 200);
    assert.equal((await ben('POST', '/auth/login', { username: 'ben', password: 'password123' })).status, 200);
    assert.equal((await carl('POST', '/auth/login', { username: 'carl', password: 'password123' })).status, 200);
});
test.after(async () => { await ctx.close(); });

test('ratings follow their visibility and notes stay private', async () => {
    const created = await anna('POST', '/anime', { title: 'Testserie', episodes: 12, kind: 'anime' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id;
    const a = await anna('PUT', `/anime/${id}/progress`, { status: 'Schaue', episodes_watched: 3, score: 9, notes: 'geheim', rating_visibility: 'anonymous', public_comment: 'gut' });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const b = await ben('PUT', `/anime/${id}/progress`, { status: 'Schaue', episodes_watched: 1, score: 7, rating_visibility: 'private' });
    assert.equal(b.status, 200, JSON.stringify(b.body));

    const forBen = (await ben('GET', `/anime/${id}/ratings`)).body;
    assert.equal(forBen.summary.count, 1, 'private rating of ben is not counted');
    const foreign = forBen.ratings.find((r) => !r.own);
    assert.equal(foreign.username, null);
    assert.equal(foreign.user_id, null);
    assert.equal(foreign.score, 9);
    assert.equal(forBen.ratings.filter((r) => r.own).length, 1);

    const forAnna = (await anna('GET', `/anime/${id}/ratings`)).body;
    assert.equal(forAnna.ratings.length, 1, 'anna does not see ben');

    const detail = (await ben('GET', `/anime/${id}`)).body;
    const annaRow = detail.progress.find((p) => p.username === 'anna');
    assert.equal(annaRow.score, null);
    assert.equal(annaRow.notes, null);
    assert.equal('rating_visibility' in annaRow, false, 'the visibility of others stays hidden');
    assert.equal('public_comment' in annaRow ? annaRow.public_comment : null, null);
    assert.equal(detail.community.average, 9);

    const list = (await ben('GET', '/anime')).body.find((x) => x.id === id);
    assert.equal(list.community.count, 1);
});

test('default visibility comes from the profile and bad values are refused', async () => {
    assert.equal((await ben('PUT', '/auth/profile', { default_anime_visibility: 'anonymous' })).status, 200);
    assert.equal((await ben('PUT', '/auth/profile', { default_anime_visibility: 'nope' })).status, 400);
    const id = (await ben('POST', '/anime', { title: 'Zweite', episodes: 5 })).body.id;
    assert.equal((await ben('PUT', `/anime/${id}/progress`, { status: 'Schaue', rating_visibility: 'nope' })).status, 400);
    assert.equal((await ben('PUT', `/anime/${id}/progress`, { status: 'Schaue', score: 8 })).body.rating_visibility, 'anonymous');
});

test('anonymous ratings point to nobody: no user or time, after the named ones, by score; a lone one stays out of an episode average', async () => {
    const id = (await carl('POST', '/anime', { title: 'Dritte', episodes: 12 })).body.id;
    const rate = async (client, body) => assert.equal((await client('PUT', `/anime/${id}/progress`, { status: 'Schaue', ...body })).status, 200);
    await rate(anna, { score: 4, rating_visibility: 'anonymous', public_comment: 'zäh', episode_scores: { 2: 6 } });
    await rate(ben, { score: 7, rating_visibility: 'public', episode_scores: { 2: 8 } });
    await rate(carl, { score: 9, rating_visibility: 'anonymous', episode_scores: { 3: 5 } });

    const forAdmin = (await admin('GET', `/anime/${id}/ratings`)).body;
    assert.deepEqual(forAdmin.ratings.map((r) => [r.username, r.score]), [['ben', 7], [null, 9], [null, 4]],
        'named first, the anonymous ones by score and not at the place of anna and carl in the name order');
    assert.deepEqual([forAdmin.ratings[0].visibility, 'updated_at' in forAdmin.ratings[0]], ['public', true]);
    for (const item of forAdmin.ratings.slice(1)) {
        assert.deepEqual(Object.keys(item).sort(), ['comment', 'own', 'score', 'user_id', 'username'], 'no visibility, no time');
        assert.equal(item.user_id, null);
    }
    assert.equal(forAdmin.ratings[2].comment, 'zäh');
    assert.deepEqual([forAdmin.summary.count, forAdmin.summary.average], [3, 6.7]);
    assert.deepEqual(forAdmin.episodes, { 2: { average: 8, count: 2 }, 3: { average: null, count: 1 } },
        'one anonymous rating of an episode counts but stays out of its average');

    const forCarl = (await carl('GET', `/anime/${id}/ratings`)).body.ratings;
    assert.deepEqual(forCarl.map((r) => [r.username, r.score, r.own]), [['ben', 7, false], ['carl', 9, true], [null, 4, false]], 'the own rating is named');

    const detail = (await admin('GET', `/anime/${id}`)).body;
    assert.deepEqual(detail.progress.map((p) => [p.username, p.score, p.updated_at, 'rating_visibility' in p]),
        [['anna', null, null, false], ['ben', 7, null, false], ['carl', null, null, false]], 'no row of another user tells when it changed');
    assert.deepEqual(detail.community.episodes, forAdmin.episodes);

    await rate(anna, { episode_scores: { 2: 6, 3: 7 } });
    assert.deepEqual((await admin('GET', `/anime/${id}/ratings`)).body.episodes, { 2: { average: 8, count: 2 }, 3: { average: 6, count: 2 } },
        'two anonymous ratings of one episode feed its average');
    assert.equal((await anna('GET', `/anime/${id}`)).body.my_progress.rating_visibility, 'anonymous', 'more ratings keep the visibility');
});

test('the default visibility applies when a row gets its first rating, not when the row was made', async () => {
    const id = (await carl('POST', '/anime', { title: 'Vierte', episodes: 6 })).body.id;
    assert.equal((await carl('GET', `/anime/${id}`)).body.my_progress.rating_visibility, 'public', 'the row of the adder');
    assert.equal((await carl('PUT', '/auth/profile', { default_anime_visibility: 'private' })).status, 200);
    let mine = (await carl('PUT', `/anime/${id}/progress`, { status: 'Schaue', episodes_watched: 2, score: 4 })).body;
    assert.equal(mine.rating_visibility, 'private');
    assert.deepEqual((await admin('GET', `/anime/${id}/ratings`)).body.ratings, [], 'nobody else sees it');
    assert.equal((await carl('PUT', '/auth/profile', { default_anime_visibility: 'anonymous' })).status, 200);
    mine = (await carl('PUT', `/anime/${id}/progress`, { score: 5 })).body;
    assert.equal(mine.rating_visibility, 'private', 'a rated row keeps its visibility');

    assert.equal((await anna('PUT', `/anime/${id}/progress`, { status: 'Geplant' })).body.rating_visibility, 'public');
    assert.equal((await anna('PUT', '/auth/profile', { default_anime_visibility: 'anonymous' })).status, 200);
    assert.equal((await anna('PUT', `/anime/${id}/progress`, { episode_scores: { 1: 8 } })).body.rating_visibility, 'anonymous', 'a first episode rating too');
    assert.equal((await ben('PUT', `/anime/${id}/progress`, { status: 'Schaue' })).body.rating_visibility, 'anonymous');
    assert.equal((await ben('PUT', '/auth/profile', { default_anime_visibility: 'private' })).status, 200);
    assert.equal((await ben('PUT', `/anime/${id}/progress`, { score: 6, rating_visibility: 'public' })).body.rating_visibility, 'public', 'a visibility sent along wins');
});

test('public_comment: up to 500 characters, anything else refused with its own message', async () => {
    const id = (await anna('POST', '/anime', { title: 'Fünfte', episodes: 3 })).body.id;
    let res = await anna('PUT', `/anime/${id}/progress`, { public_comment: 123 });
    assert.deepEqual([res.status, res.body.error], [400, 'Ungültiger Wert für Kommentar']);
    res = await anna('PUT', `/anime/${id}/progress`, { public_comment: 'x'.repeat(501) });
    assert.deepEqual([res.status, res.body.error, res.body.msg, res.body.params],
        [400, 'Kommentar ist zu lang (höchstens 500 Zeichen)', 'Kommentar ist zu lang (höchstens {max} Zeichen)', { max: 500 }]);
    res = await anna('PUT', `/anime/${id}/progress`, { public_comment: ` ${'x'.repeat(500)} ` });
    assert.deepEqual([res.status, res.body.public_comment.length], [200, 500]);
});

test('an admin acting for another user leaves the rating alone and gets the row as others see it', async () => {
    const id = (await anna('GET', '/anime')).body.find((a) => a.title === 'Testserie').id;
    const annaId = (await anna('GET', `/anime/${id}`)).body.my_progress.user_id;
    for (const body of [{ score: 5 }, { score: null }, { episode_scores: { 1: 5 } }, { rating_visibility: 'public' }, { public_comment: 'vom Admin' }]) {
        const res = await admin('PUT', `/anime/${id}/progress`, { user_id: annaId, ...body });
        assert.deepEqual([res.status, res.body.code], [403, 'FORBIDDEN'], JSON.stringify(body));
    }
    const res = await admin('PUT', `/anime/${id}/progress`, { user_id: annaId, episodes_watched: 4 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.user_id, res.body.episodes_watched, res.body.score, res.body.notes, res.body.public_comment, res.body.updated_at],
        [annaId, 4, null, null, null, null]);
    assert.equal('rating_visibility' in res.body, false);
    const own = (await anna('GET', `/anime/${id}`)).body.my_progress;
    assert.deepEqual([own.score, own.notes, own.rating_visibility, own.public_comment], [9, 'geheim', 'anonymous', 'gut'], 'her rating stays as she set it');

    const adminId = (await admin('GET', '/auth/me')).body.user.id;
    const self = await admin('PUT', `/anime/${id}/progress`, { user_id: adminId, score: 6, rating_visibility: 'private' });
    assert.deepEqual([self.status, self.body.score, self.body.rating_visibility], [200, 6, 'private'], 'the own id is the own row');
});
