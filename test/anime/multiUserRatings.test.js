// Anime ratings of a shared entry: public (named), anonymous (counted, no name), private (hidden); notes are never shared.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../helpers');

let ctx;
let anna;
let ben;
let admin;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    anna = ctx.client();
    ben = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    for (const name of ['anna', 'ben']) {
        assert.equal((await admin('POST', '/users', { username: name, password: 'password123', role: 'editor' })).status, 200);
    }
    assert.equal((await anna('POST', '/auth/login', { username: 'anna', password: 'password123' })).status, 200);
    assert.equal((await ben('POST', '/auth/login', { username: 'ben', password: 'password123' })).status, 200);
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
