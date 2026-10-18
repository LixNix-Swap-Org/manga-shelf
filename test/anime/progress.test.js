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
    save({ watched_episodes: [2, 4] });
    row = save({ status: 'Gesehen' });
    assert.deepEqual([row.status, row.episodes_watched, row.watched_episodes], ['Gesehen', 12, null]);
    row = save({ watched_episodes: [1, 3] });
    assert.deepEqual([row.status, row.episodes_watched], ['Schaue', 2], 'below the total Gesehen becomes Schaue');
    row = save({ status: 'Geplant' });
    assert.deepEqual([row.status, row.episodes_watched, row.watched_episodes], ['Geplant', 0, null]);
    row = save({ watched_episodes: range(1, 12) });
    assert.deepEqual([row.status, row.episodes_watched, row.watched_episodes], ['Gesehen', 12, null], 'every episode marked means Gesehen');
});

test('episode ratings: a rating marks its episode, unmarking drops the rating, above the total dropped, null clears them', () => {
    const { save } = setup(12);
    let row = save({ episode_scores: { 3: 8, 1: 10, 40: 5, 2: 11, 4: 7.5 } });
    assert.deepEqual(JSON.parse(row.episode_scores), { 1: 10, 3: 8 }, 'whole scores 1..10 within the episode count only');
    assert.deepEqual([row.status, row.episodes_watched, JSON.parse(row.watched_episodes)], ['Schaue', 2, [1, 3]], 'a rated episode is a watched one');
    row = save({ notes: 'x' });
    assert.deepEqual(JSON.parse(row.episode_scores), { 1: 10, 3: 8 }, 'other changes keep the ratings');
    row = save({ watched_episodes: [1, 2] });
    assert.deepEqual([row.episodes_watched, row.watched_episodes, JSON.parse(row.episode_scores)], [2, null, { 1: 10 }], 'an unmarked episode loses its rating');
    row = save({ watched_episodes: [1, 2], episode_scores: { 1: 10, 5: 6 } });
    assert.deepEqual([row.episodes_watched, JSON.parse(row.watched_episodes), JSON.parse(row.episode_scores)], [3, [1, 2, 5], { 1: 10, 5: 6 }],
        'a rating in the same change marks the episode');
    row = save({ episode_scores: { 2: 7 } });
    assert.deepEqual([row.episodes_watched, JSON.parse(row.watched_episodes), JSON.parse(row.episode_scores)], [3, [1, 2, 5], { 2: 7 }],
        'replacing the ratings never unmarks');
    row = save({ episode_scores: {} });
    assert.equal(row.episode_scores, null, 'an empty object stores NULL');
    save({ episode_scores: { 5: 6 } });
    row = save({ episode_scores: null });
    assert.deepEqual([row.episode_scores, row.episodes_watched], [null, 3]);
});

test('episode ratings: a lowered counter drops the ratings above it, Geplant drops all, a rise keeps them', () => {
    const { save } = setup(12);
    save({ episodes_watched: 6, episode_scores: { 2: 9, 6: 4 } });
    let row = save({ episodes_watched: 8 });
    assert.deepEqual([row.episodes_watched, JSON.parse(row.episode_scores)], [8, { 2: 9, 6: 4 }]);
    row = save({ episodes_watched: 4 });
    assert.deepEqual([row.episodes_watched, JSON.parse(row.episode_scores)], [4, { 2: 9 }]);
    row = save({ episodes_watched: 3, episode_scores: { 2: 9, 10: 5 } });
    assert.deepEqual([row.episodes_watched, row.watched_episodes, JSON.parse(row.episode_scores)], [3, null, { 2: 9 }], 'the lowered counter wins');
    row = save({ episodes_watched: 5, episode_scores: { 2: 9, 10: 5 } });
    assert.deepEqual([row.episodes_watched, JSON.parse(row.watched_episodes), JSON.parse(row.episode_scores)], [6, [1, 2, 3, 4, 5, 10], { 2: 9, 10: 5 }],
        'a rise fills the counter, the rated episode comes on top');
    row = save({ status: 'Geplant' });
    assert.deepEqual([row.episodes_watched, row.watched_episodes, row.episode_scores], [0, null, null]);
});

test('visibility: the default goes to a new row and to the first score or episode score, a rated row keeps its own', () => {
    const { core, save } = setup(12);
    const setDefault = (value) => core.conn.prepare('UPDATE users SET default_anime_visibility = ? WHERE id = 2').run(value);
    assert.equal(save({ status: 'Geplant' }).rating_visibility, 'public', 'a new row');
    setDefault('private');
    assert.equal(save({ episodes_watched: 2 }).rating_visibility, 'public', 'no rating yet, nothing changes');
    assert.equal(save({ episodes_watched: 1, episode_scores: { 5: 8 } }).rating_visibility, 'public', 'a rating the lowered counter drops is none');
    assert.equal(save({ episode_scores: { 1: 8 } }).rating_visibility, 'private', 'the first episode score');
    setDefault('anonymous');
    assert.equal(save({ score: 7 }).rating_visibility, 'private', 'a rated row keeps its visibility');
    save({ score: null, episode_scores: null });
    assert.equal(save({ score: 6 }).rating_visibility, 'anonymous', 'rated again after its ratings went: the default of now');
    save({ score: null });
    assert.equal(save({ score: 5, rating_visibility: 'public' }).rating_visibility, 'public', 'a visibility sent along wins');
});

test('add_episodes: the union with the marks, never lower; nothing new keeps the counter but takes the resume link', () => {
    const { save } = setup(12);
    save({ watched_episodes: [1, 2, 10] });
    let row = save({ add_episodes: [3, 10, 40] }, { monotonic: true });
    assert.deepEqual([row.episodes_watched, JSON.parse(row.watched_episodes)], [4, [1, 2, 3, 10]], 'above the total dropped');
    row = save({ add_episodes: [2], resume_url: URL7, resume_episode: 2 }, { monotonic: true });
    assert.deepEqual([row.episodes_watched, JSON.parse(row.watched_episodes), row.resume_url, row.resume_episode], [4, [1, 2, 3, 10], URL7, 2]);
    row = save({ add_episodes: [5] }, { monotonic: true });
    assert.deepEqual([row.episodes_watched, row.resume_url], [5, null], 'a new mark without a link drops the old one');
    save({ status: 'Pausiert' });
    row = save({ add_episodes: [4, 6, 7, 8, 9, 11, 12] }, { monotonic: true });
    assert.deepEqual([row.status, row.episodes_watched, row.watched_episodes], ['Gesehen', 12, null], 'every episode marked means Gesehen');

    const plain = setup(12);
    plain.save({ episodes_watched: 3 });
    row = plain.save({ add_episodes: [5] }, { monotonic: true });
    assert.deepEqual([row.episodes_watched, JSON.parse(row.watched_episodes)], [4, [1, 2, 3, 5]], 'a plain row counts as 1..n');
    row = plain.save({ add_episodes: [4] }, { monotonic: true });
    assert.deepEqual([row.episodes_watched, row.watched_episodes], [5, null]);
});

test('more than MAX_MARKS marks fall back to the plain counter up to the highest episode', () => {
    const { save } = setup(null);
    save({ watched_episodes: [1, 3] });
    let row = save({ episodes_watched: 6000 });
    assert.deepEqual([row.episodes_watched, row.watched_episodes], [6000, null], 'a counter change above the cap');
    save({ episodes_watched: 5000 });
    row = save({ add_episodes: [5002] }, { monotonic: true });
    assert.deepEqual([row.episodes_watched, row.watched_episodes], [5002, null], 'a union above the cap');
    save({ watched_episodes: [2, 9000] });
    row = save({ episodes_watched: 6000 }, { monotonic: true });
    assert.deepEqual([row.episodes_watched, row.watched_episodes], [9000, null], '"watched up to N" above the cap');
    save({ watched_episodes: [2] });
    row = save({ episodes_watched: 5000, episode_scores: { 7000: 8 } });
    assert.deepEqual([row.episodes_watched, row.watched_episodes, JSON.parse(row.episode_scores)], [7000, null, { 7000: 8 }], 'a rating above the cap');
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
    let row = save({ episodes_watched: 5, resume_url: URL7, resume_episode: 5 }, { monotonic: true });
    assert.deepEqual([row.episodes_watched, JSON.parse(row.watched_episodes), row.resume_url], [6, [1, 2, 3, 4, 5, 10], URL7]);
    row = save({ episodes_watched: 2, resume_url: 'https://www.crunchyroll.com/watch/OLDER0001/x', resume_episode: 2 }, { monotonic: true });
    assert.deepEqual([row.episodes_watched, row.resume_url], [6, URL7], 'an episode already covered changes nothing, not even the link');
    row = save({ episodes_watched: 30 }, { monotonic: true });
    assert.deepEqual([row.status, row.episodes_watched, row.watched_episodes], ['Gesehen', 12, null]);
});

function range(from, to) {
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
