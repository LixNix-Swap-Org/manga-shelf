// Anime request helper: error flags for refused AniList answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestJson, SourceError } = require('../core/anime/request');

const answer = (status, body) => ({ http: { fetch: async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }) } });
const errorOf = (ctx) => requestJson(ctx, 'https://graphql.anilist.co', {}, { label: 'AniList' }).then(() => assert.fail('resolved'), (err) => err);

test('anime requestJson: a refused answer with GraphQL error messages carries graphql: true, other bad answers do not', async () => {
    const graphql = await errorOf(answer(400, { errors: [{ message: 'Validation error' }], data: null }));
    assert.ok(graphql instanceof SourceError);
    assert.deepEqual([graphql.kind, graphql.status, graphql.graphql], ['bad', 400, true]);
    assert.match(graphql.message, /\(HTTP 400: Validation error\)$/);

    for (const ctx of [answer(400, ''), answer(400, { errors: [] }), answer(200, 'kein JSON'), answer(400, { errors: [{ status: 400 }] })]) {
        const err = await errorOf(ctx);
        assert.deepEqual([err.kind, err.graphql], ['bad', false]);
    }
    assert.equal((await errorOf(answer(400, { errors: [{ message: 'Invalid token' }] }))).kind, 'auth');
    assert.equal(new SourceError('bad', 'x').graphql, false);
});
