// The soft per-account lookup limit on the Express adapter: a history sync over the limit still answers with its ordinary
// result, it only adds nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startExpressCore, useAniList } = require('./harness');
const gateway = require('../../core/anime/gateway');
const { lookupLimiter, USER_LOOKUPS_PER_MINUTE } = require('../../middleware/userLimits');

test('over the lookup limit: 200 with the ordinary applied and an empty added; within it the show is added', async (t) => {
    const core = await startExpressCore();
    t.after(async () => {
        useAniList(null);
        lookupLimiter.reset();
        await core.close();
    });
    useAniList({
        media: [{
            id: 92001, type: 'ANIME', format: 'TV', episodes: 12, title: { romaji: 'Kern Grenze' }, synonyms: [], relations: { edges: [] },
            externalLinks: [{ site: 'Crunchyroll', url: 'https://www.crunchyroll.com/series/GKERNGRNZ1/kern-grenze' }]
        }],
        search: { 'Kern Grenze': [92001] }
    });
    gateway.resetGatewayState();
    const ed = core.client('ed');
    const id = (await ed('POST', '/anime', { title: 'Kern Gewohnt', episodes: 12 })).body.id;
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const body = (episode) => ({
        service: 'crunchyroll',
        auto_add: true,
        items: [
            { external_id: 'GKERNGRNZ1', series_title: 'Kern Grenze', season: 1, episode: 2, fully_watched: true, watched_at: recent },
            { external_id: 'GKERNGEWO1', series_title: 'Kern Gewohnt', season: 1, episode, fully_watched: true, watched_at: recent }
        ]
    });
    const req = { user: { id: core.users.find((u) => u.username === 'ed').id }, ip: '127.0.0.1', headers: {}, socket: {} };
    for (let i = 0; i < USER_LOOKUPS_PER_MINUTE; i++) lookupLimiter.tryConsume(req);
    assert.equal(lookupLimiter.tryConsume(req), false);

    const over = await ed('POST', '/anime/watch-sync', body(3));
    assert.equal(over.status, 200, JSON.stringify(over.body));
    assert.deepEqual([over.body.applied, over.body.added], [[{ anime_id: id, episodes_watched: 3, status: 'Schaue' }], []]);
    assert.deepEqual(over.body.unmatched.map((u) => u.external_id), ['GKERNGRNZ1']);

    lookupLimiter.reset();
    gateway.state().watchSync.clear();
    const within = await ed('POST', '/anime/watch-sync', body(4));
    assert.deepEqual([within.body.applied.length, within.body.added.map((a) => a.external_id)], [1, ['GKERNGRNZ1']]);
});
