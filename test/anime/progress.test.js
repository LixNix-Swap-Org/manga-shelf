// The progress rule of core/anime/progress.js: PUT progress, "Folge gesehen" (monotonic) and resume links.
const test = require('node:test');
const assert = require('node:assert/strict');
const { saveProgress } = require('../../core/anime/progress');
const { memoryWith, offline } = require('./helpers');

function setup(episodes = 28) {
    const core = memoryWith(async (url) => { throw offline(url); });
    const anime = Number(core.conn.prepare("INSERT INTO animes (title, episodes) VALUES ('Frieren', ?)").run(episodes).lastInsertRowid);
    return { core, anime, save: (change, options) => saveProgress(core.ctx, anime, 2, change, options) };
}

const URL7 = 'https://www.crunchyroll.com/watch/GG1U2Q0ZW/like-a-fairy-tale';

test('monotonic: a share raises the counter, a lower one changes nothing, the end means Gesehen', () => {
    const { save } = setup();
    let row = save({ episodes_watched: 7, resume_url: URL7, resume_episode: 7 }, { monotonic: true });
    assert.deepEqual([row.status, row.episodes_watched, row.resume_url, row.resume_episode], ['Schaue', 7, URL7, 7]);
    assert.ok(row.started_at);
    row = save({ episodes_watched: 5, resume_url: 'https://www.crunchyroll.com/watch/OLDER0001/x', resume_episode: 5 }, { monotonic: true });
    assert.deepEqual([row.episodes_watched, row.resume_url, row.resume_episode], [7, URL7, 7], 'an older episode never lowers or replaces');
    row = save({ episodes_watched: 30 }, { monotonic: true });
    assert.deepEqual([row.status, row.episodes_watched, row.resume_url], ['Gesehen', 28, null]);
    assert.ok(row.finished_at);
});

test('monotonic rise moves Pausiert and Abgebrochen to Schaue; the plain rule keeps them and may lower', () => {
    const { save } = setup();
    save({ status: 'Pausiert', episodes_watched: 3 });
    assert.equal(save({ episodes_watched: 4 }).status, 'Pausiert', 'PUT keeps the status');
    assert.equal(save({ episodes_watched: 4 }, { monotonic: true }).status, 'Pausiert', 'no rise, no change');
    assert.equal(save({ episodes_watched: 5 }, { monotonic: true }).status, 'Schaue');
    save({ status: 'Abgebrochen' });
    assert.equal(save({ episodes_watched: 6 }, { monotonic: true }).status, 'Schaue');
    assert.equal(save({ episodes_watched: 2 }).episodes_watched, 2, 'the explicit PUT may lower');
});

test('resume link: kept while the counter stays, dropped by any other counter change', () => {
    const { save } = setup();
    save({ episodes_watched: 7, resume_url: URL7, resume_episode: 7 }, { monotonic: true });
    let row = save({ score: 9 });
    assert.deepEqual([row.resume_url, row.score], [URL7, 9]);
    row = save({ episodes_watched: 8 });
    assert.deepEqual([row.resume_url, row.resume_episode], [null, null], '+1 clears it');
    row = save({ episodes_watched: 8, resume_url: URL7, resume_episode: 7 }, { monotonic: true });
    assert.deepEqual([row.episodes_watched, row.resume_url, row.resume_episode], [8, URL7, 7], 'the same count with a new link stores it');
});

test('Geplant: chosen explicitly it resets the counter and the dates, sent with a counter it means Schaue', () => {
    const { save } = setup();
    let row = save({ episodes_watched: 5 });
    assert.deepEqual([row.status, row.episodes_watched], ['Schaue', 5]);
    assert.ok(row.started_at);
    row = save({ status: 'Geplant' });
    assert.deepEqual([row.status, row.episodes_watched, row.started_at, row.finished_at], ['Geplant', 0, null, null]);
    row = save({ status: 'Geplant', episodes_watched: 3 });
    assert.deepEqual([row.status, row.episodes_watched], ['Schaue', 3]);
    assert.ok(row.started_at);
});

test('Geplant with progress from a monotonic write becomes Schaue and never resets', () => {
    const { save } = setup();
    save({ episodes_watched: 4 });
    let row = save({ status: 'Geplant', episodes_watched: 6 }, { monotonic: true });
    assert.deepEqual([row.status, row.episodes_watched], ['Schaue', 6]);
    row = save({ status: 'Geplant' }, { monotonic: true });
    assert.deepEqual([row.status, row.episodes_watched], ['Schaue', 6]);
});

test('finished_at only on Gesehen: going back to Geplant or Pausiert clears it', () => {
    const { save } = setup();
    let row = save({ status: 'Gesehen' });
    assert.deepEqual([row.status, row.episodes_watched], ['Gesehen', 28]);
    assert.ok(row.finished_at);
    row = save({ status: 'Pausiert' });
    assert.deepEqual([row.status, row.finished_at], ['Pausiert', null]);
    save({ status: 'Gesehen' });
    row = save({ status: 'Geplant' });
    assert.deepEqual([row.status, row.episodes_watched, row.started_at, row.finished_at], ['Geplant', 0, null, null]);
});

test('Gesehen: a lowered counter means Schaue, a counter at the known total stays Gesehen', () => {
    const { save } = setup();
    save({ status: 'Gesehen' });
    let row = save({ episodes_watched: 28 });
    assert.equal(row.status, 'Gesehen');
    row = save({ episodes_watched: 30 });
    assert.deepEqual([row.status, row.episodes_watched], ['Gesehen', 28]);
    row = save({ episodes_watched: 20 });
    assert.deepEqual([row.status, row.episodes_watched, row.finished_at], ['Schaue', 20, null]);
    row = save({ episodes_watched: 28 });
    assert.equal(row.status, 'Gesehen');
    assert.ok(row.finished_at);
});

test('Gesehen without a known total: +1 means Schaue, a status change alone keeps the counter', () => {
    const { save } = setup(null);
    let row = save({ status: 'Gesehen', episodes_watched: 12 });
    assert.deepEqual([row.status, row.episodes_watched], ['Gesehen', 12]);
    row = save({ score: 8 });
    assert.equal(row.status, 'Gesehen');
    row = save({ episodes_watched: 13 });
    assert.deepEqual([row.status, row.episodes_watched], ['Schaue', 13]);
    row = save({ episodes_watched: 14 }, { monotonic: true });
    assert.deepEqual([row.status, row.episodes_watched], ['Schaue', 14]);
});

test('unknown entry: null, nothing written', () => {
    const { core } = setup();
    assert.equal(saveProgress(core.ctx, 999, 2, { episodes_watched: 1 }), null);
    assert.equal(core.conn.prepare('SELECT count(*) AS n FROM anime_progress').get().n, 0);
});

test('single episodes: the marks set the counter, gaps stay, Gesehen and Geplant fill or clear them', () => {
    const { save } = setup(12);
    let row = save({ watched_episodes: [5, 1, 2, 2, 40] });
    assert.deepEqual([row.status, row.episodes_watched, JSON.parse(row.watched_episodes)], ['Schaue', 3, [1, 2, 5]], 'sorted, unique, above the total dropped');
    row = save({ watched_episodes: [1, 2, 3] });
    assert.deepEqual([row.episodes_watched, row.watched_episodes], [3, null], '1..n is the plain counter again');
    row = save({ watched_episodes: [2, 4] });
    row = save({ status: 'Gesehen' });
    assert.deepEqual([row.status, row.episodes_watched, row.watched_episodes], ['Gesehen', 12, null]);
    row = save({ watched_episodes: [1, 3] });
    assert.deepEqual([row.status, row.episodes_watched], ['Schaue', 2], 'below the total Gesehen becomes Schaue');
    row = save({ status: 'Geplant' });
    assert.deepEqual([row.status, row.episodes_watched, row.watched_episodes], ['Geplant', 0, null]);
    row = save({ watched_episodes: range(1, 12) });
    assert.deepEqual([row.status, row.episodes_watched, row.watched_episodes], ['Gesehen', 12, null], 'every episode marked means Gesehen');
});

test('single episodes: +1 fills the first gap, lowering drops the highest marks, null goes back to the counter', () => {
    const { save } = setup(12);
    save({ watched_episodes: [1, 2, 5] });
    let row = save({ episodes_watched: 4 });
    assert.deepEqual([row.episodes_watched, JSON.parse(row.watched_episodes)], [4, [1, 2, 3, 5]]);
    row = save({ episodes_watched: 2 });
    assert.deepEqual([row.episodes_watched, row.watched_episodes], [2, null]);
    save({ watched_episodes: [3, 7] });
    row = save({ episodes_watched: 5, watched_episodes: null });
    assert.deepEqual([row.episodes_watched, row.watched_episodes], [5, null]);
});

test('single episodes: a monotonic "watched up to N" adds 1..N and never removes a mark', () => {
    const { save } = setup(12);
    save({ watched_episodes: [1, 2, 10] });
    let row = save({ episodes_watched: 5 }, { monotonic: true });
    assert.deepEqual([row.episodes_watched, JSON.parse(row.watched_episodes)], [6, [1, 2, 3, 4, 5, 10]]);
    row = save({ episodes_watched: 2 }, { monotonic: true });
    assert.equal(row.episodes_watched, 6, 'an episode already covered changes nothing');
    row = save({ episodes_watched: 30 }, { monotonic: true });
    assert.deepEqual([row.status, row.episodes_watched, row.watched_episodes], ['Gesehen', 12, null]);
});

function range(from, to) {
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
