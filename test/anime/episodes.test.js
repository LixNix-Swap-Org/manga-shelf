// The pure helpers of core/anime/episodes.js: one model for "watched" (marks or the plain counter), ratings and seasons.
const test = require('node:test');
const assert = require('node:assert/strict');
const episodes = require('../../core/anime/episodes');

const gaps = { episodes_watched: 3, watched_episodes: [1, 2, 10] };
const stored = { episodes_watched: 3, watched_episodes: '[1,2,10]' };
const plain = { episodes_watched: 5, watched_episodes: null };

test('isWatched, firstUnwatched, watermark and lastWatched read marks and the plain counter alike', () => {
    for (const progress of [gaps, stored]) {
        assert.deepEqual([1, 2, 3, 10, 11].map((n) => episodes.isWatched(progress, n)), [true, true, false, true, false]);
        assert.deepEqual([episodes.firstUnwatched(progress), episodes.watermark(progress), episodes.lastWatched(progress)], [3, 2, 10]);
    }
    assert.deepEqual([0, 1, 5, 6].map((n) => episodes.isWatched(plain, n)), [false, true, true, false]);
    assert.deepEqual([episodes.firstUnwatched(plain), episodes.watermark(plain), episodes.lastWatched(plain)], [6, 5, 5]);
    const late = { episodes_watched: 2, watched_episodes: [4, 5] };
    assert.deepEqual([episodes.firstUnwatched(late), episodes.watermark(late), episodes.lastWatched(late)], [1, 0, 5]);
    for (const none of [null, undefined, { episodes_watched: 0, watched_episodes: null }]) {
        assert.deepEqual([episodes.isWatched(none, 1), episodes.firstUnwatched(none), episodes.watermark(none), episodes.lastWatched(none)], [false, 1, 0, 0]);
    }
    const big = { episodes_watched: 80000, watched_episodes: null };
    assert.deepEqual([episodes.isWatched(big, 79999), episodes.firstUnwatched(big), episodes.watermark(big)], [true, 80001, 80000], 'no cap on the plain counter');
});

test('addEpisodes: the union with the marks (a plain row counts as 1..n), cleaned to the total', () => {
    assert.deepEqual(episodes.addEpisodes(gaps, [3, 10, 3]), [1, 2, 3, 10]);
    assert.deepEqual(episodes.addEpisodes(gaps, [11, 40], 12), [1, 2, 10, 11]);
    assert.deepEqual(episodes.addEpisodes(gaps, []), [1, 2, 10]);
    assert.deepEqual(episodes.addEpisodes(plain, [8]), [1, 2, 3, 4, 5, 8]);
    assert.deepEqual(episodes.addEpisodes(plain, [2, 6]), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(episodes.addEpisodes(null, [2]), [2]);
    assert.deepEqual(episodes.addEpisodes({ episodes_watched: 3, watched_episodes: [1, 2, 15] }, [4], 12), [1, 2, 4], 'stored marks above the total go');
});

test('more than MAX_MARKS marks fall back to the plain counter up to the highest episode involved', () => {
    const { MAX_MARKS } = episodes;
    assert.equal(MAX_MARKS, 5000);
    const full = { episodes_watched: MAX_MARKS, watched_episodes: null };
    assert.deepEqual(episodes.withEpisodes(full, [MAX_MARKS + 2]), { episodes_watched: MAX_MARKS + 2, watched_episodes: null });
    assert.equal(episodes.addEpisodes(full, [MAX_MARKS + 2]).length, MAX_MARKS + 2, 'addEpisodes answers the plain counter as 1..n');
    assert.deepEqual(episodes.withThrough({ episodes_watched: 2, watched_episodes: [2, 9000] }, 6000), { episodes_watched: 9000, watched_episodes: null });
    assert.deepEqual(episodes.withCount({ episodes_watched: 2, watched_episodes: [1, 3] }, 6000), { episodes_watched: 6000, watched_episodes: null });
    assert.deepEqual(episodes.withCount({ episodes_watched: 2, watched_episodes: [1, 3] }, 4), { episodes_watched: 4, watched_episodes: null }, '1..n is the plain counter');
    const many = Array.from({ length: MAX_MARKS }, (_, i) => 2 * i + 2);
    assert.deepEqual(episodes.withEpisodes({ episodes_watched: MAX_MARKS, watched_episodes: many }, [1]),
        { episodes_watched: 2 * MAX_MARKS, watched_episodes: null });
});

test('withThrough and withCount: "watched up to N" adds 1..N, a counter fills the lowest gaps or drops the highest marks', () => {
    assert.deepEqual(episodes.withThrough(gaps, 5), { episodes_watched: 6, watched_episodes: [1, 2, 3, 4, 5, 10] });
    assert.deepEqual(episodes.withThrough(gaps, 12), { episodes_watched: 12, watched_episodes: null });
    assert.deepEqual(episodes.withThrough(plain, 3), { episodes_watched: 5, watched_episodes: null }, 'never lower');
    assert.deepEqual(episodes.withCount(gaps, 4), { episodes_watched: 4, watched_episodes: [1, 2, 3, 10] });
    assert.deepEqual(episodes.withCount(gaps, 2), { episodes_watched: 2, watched_episodes: null });
    assert.deepEqual(episodes.withCount(plain, 9), { episodes_watched: 9, watched_episodes: null });
});

test('ratings: canonical episode keys only, whole scores 1..10, within the total', () => {
    assert.deepEqual(episodes.cleanScores({ 1: 10, '07': 5, '007': 4, 0: 3, 3: 11, 4: 7.5, 12: 6, 13: 2 }, 12), { 1: 10, 12: 6 });
    assert.ok(episodes.EPISODE_KEY.test('70') && !episodes.EPISODE_KEY.test('07') && !episodes.EPISODE_KEY.test('1.0'));
    assert.deepEqual(episodes.parseScores('{"2":8}'), { 2: 8 });
    assert.deepEqual(episodes.parseScores('{broken'), {});
});

test('seasons: TMDb names are cut to the stored length, empty names become null, unreadable columns are empty', () => {
    const long = 'x'.repeat(episodes.MAX_SEASON_NAME + 20);
    assert.deepEqual(episodes.seasonsFromCounts([{ season_number: 1, episode_count: 12, name: ` ${long} ` }, { season_number: 2, episode_count: 0, name: 'Leer' },
        { season_number: 3, episode_count: 10, name: '  ' }]), [
        { start: 1, name: 'x'.repeat(episodes.MAX_SEASON_NAME), episodes: 12, season_number: 1 },
        { start: 13, name: null, episodes: 10, season_number: 3 }
    ]);
    assert.deepEqual(episodes.cleanSeasons([{ start: 5 }, null, { start: 1, name: ' A ' }, { start: 5, name: 'doppelt' }]), [{ start: 1, name: 'A' }, { start: 5, name: null }]);
    assert.deepEqual(episodes.parseSeasons('{not json'), []);
});
