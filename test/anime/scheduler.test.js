// Scheduler hook that runs the anime refresh when it is due.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-anime-scheduler-'));
process.env.DATA_DIR = dataDir;
if (process.env.LOG_LEVEL === undefined) process.env.LOG_LEVEL = 'silent';
const { db, closeDb } = require('../../db');
const { runAnimeRefreshIfDue } = require('../../services/scheduler');
const gateway = require('../../core/anime/gateway');
const { fakeFetch, aniListFixtures } = require('./helpers');

const realFetch = global.fetch;
test.after(() => {
    global.fetch = realFetch;
    closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const schedule = { hour: 3, timeZone: 'UTC' };

test('scheduler: hourly only the airing entries, once a day (an hour after the backup) every due entry', async () => {
    const http = fakeFetch({ anilist: aniListFixtures });
    global.fetch = http.fetch;
    gateway.resetGatewayState();
    db.prepare("INSERT INTO animes (title, anilist_id, status, next_check_at, next_airing_at) VALUES ('One Piece', 21, 'RELEASING', 1, 100)").run();
    db.prepare("INSERT INTO animes (title, anilist_id, status, next_check_at) VALUES ('Frieren', 154587, 'FINISHED', 1)").run();

    const hourly = await runAnimeRefreshIfDue(new Date('2026-10-04T02:10:00Z'), schedule, { pauseMs: 0 });
    assert.deepEqual([hourly.due, hourly.updated], [1, 1], 'before 04:00 only the event-driven entry');
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key = 'anime_refresh_day'").get(), undefined);

    const daily = await runAnimeRefreshIfDue(new Date('2026-10-04T04:05:00Z'), schedule, { pauseMs: 0 });
    assert.deepEqual([daily.due, daily.updated], [1, 1]);
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key = 'anime_refresh_day'").get().value, '2026-10-04');
    const frieren = db.prepare('SELECT * FROM animes WHERE anilist_id = 154587').get();
    assert.equal(frieren.mal_id, 52991);
    assert.ok(frieren.next_check_at > Date.now() + 13 * 24 * 60 * 60 * 1000, 'finished: next check in 14 days');

    const again = await runAnimeRefreshIfDue(new Date('2026-10-04T05:05:00Z'), schedule, { pauseMs: 0 });
    assert.equal(again.due, 0);
    assert.equal(http.count('anilist'), 2);
});
