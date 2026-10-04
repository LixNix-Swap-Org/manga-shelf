const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startTestServer } = require('./helpers');
const { fakeFetch, aniListFixtures, jikanFixtures } = require('./anime/helpers');

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const realFetch = global.fetch;

let ctx;
let admin;
let editor;
let visitor;
let db;
let sources;

test.before(async () => {
    ctx = await startTestServer();
    sources = fakeFetch({ anilist: aniListFixtures, jikan: jikanFixtures });
    global.fetch = (url, init) => (String(url).startsWith(ctx.root) ? realFetch(url, init) : sources.fetch(url, init));
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    for (const [name, role] of [['kim', 'editor'], ['gast', 'visitor']]) {
        assert.equal((await admin('POST', '/users', { username: name, password: 'password123', role })).status, 200);
    }
    editor = ctx.client();
    await editor('POST', '/auth/login', { username: 'kim', password: 'password123' });
    visitor = ctx.client();
    await visitor('POST', '/auth/login', { username: 'gast', password: 'password123' });
    db = require('../db').db;
    const safeFetch = require('../utils/safeFetch');
    safeFetch.fetchRemoteImage = async () => ({ buffer: PNG, ext: '.png' });
});

test.after(async () => {
    global.fetch = realFetch;
    await ctx.close();
});

const kimId = () => db.prepare("SELECT id FROM users WHERE username = 'kim'").get().id;

test('search: 2 to 100 characters, hits carry in_collection_id; visitors may search', async () => {
    assert.equal((await editor('GET', '/anime/search?q=F')).status, 400);
    const res = await visitor('GET', '/anime/search?q=Frieren');
    assert.equal(res.status, 200);
    assert.ok(res.body.results.length > 0);
    assert.equal(res.body.results[0].in_collection_id, null);
    assert.deepEqual(res.body.sources_used.sort(), ['anilist', 'jikan']);
});

test('create from AniList: cover downloaded into the uploads, 409 for a second time, manga link checked', async () => {
    assert.equal((await visitor('POST', '/anime', { anilist_id: 154587 })).status, 403);
    assert.equal((await editor('POST', '/anime', { anilist_id: 154587, manga_id: 999 })).status, 404);
    const res = await editor('POST', '/anime', { anilist_id: 154587 });
    assert.equal(res.status, 201);
    assert.equal(res.body.anilist_id, 154587);
    assert.equal(res.body.mal_id, 52991);
    assert.equal(res.body.episodes, 28);
    assert.match(res.body.cover_image, /^\/uploads\/[\w-]+\.png$/);
    assert.ok(fs.existsSync(path.join(ctx.dataDir, 'uploads', path.basename(res.body.cover_image))));
    assert.ok(res.body.relations.length > 0);
    assert.equal(res.body.my_progress, null);

    const again = await admin('POST', '/anime', { mal_id: 52991 });
    assert.equal(again.status, 409);
    assert.equal(again.body.id, res.body.id);
    const hit = await editor('GET', '/anime/search?q=Frieren');
    assert.equal(hit.body.results.find((r) => r.anilist_id === 154587).in_collection_id, res.body.id);
});

test('manual entries: title 1-200 characters, episodes >= 0, editable episode count', async () => {
    assert.equal((await editor('POST', '/anime', { title: '' })).status, 400);
    assert.equal((await editor('POST', '/anime', { title: 'x'.repeat(201) })).status, 400);
    assert.equal((await editor('POST', '/anime', { title: 'Heimvideo', episodes: -1 })).status, 400);
    const res = await editor('POST', '/anime', { title: 'Heimvideo', episodes: 3 });
    assert.equal(res.status, 201);
    assert.equal(res.body.manual, true);
    const changed = await editor('PUT', `/anime/${res.body.id}`, { episodes: 4, title_de: 'Heimkino', notes: 'DVD' });
    assert.equal(changed.status, 200);
    assert.deepEqual([changed.body.episodes, changed.body.title_de, changed.body.notes], [4, 'Heimkino', 'DVD']);
    const frieren = db.prepare('SELECT id FROM animes WHERE anilist_id = 154587').get().id;
    assert.equal((await editor('PUT', `/anime/${frieren}`, { episodes: 3 })).status, 400, 'only manual entries');
    assert.equal((await visitor('PUT', `/anime/${res.body.id}`, { title: 'X' })).status, 403);
    const manga = await admin('POST', '/mangas', { title: 'Frieren', alt_title: 'Sousou no Frieren' });
    const linked = await editor('PUT', `/anime/${frieren}`, { manga_id: manga.body.id });
    assert.deepEqual(linked.body.manga, { id: manga.body.id, title: 'Frieren' });
    assert.equal((await editor('PUT', `/anime/${frieren}`, { manga_id: null })).body.manga, null);
});

test('progress: clamped to the episode count, "Gesehen" automatic, start and finish dates, score 1-10', async () => {
    const id = db.prepare('SELECT id FROM animes WHERE anilist_id = 154587').get().id;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
    let res = await editor('PUT', `/anime/${id}/progress`, { episodes_watched: 3 });
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.status, res.body.episodes_watched, res.body.started_at, res.body.finished_at], ['Schaue', 3, today, null]);
    res = await editor('PUT', `/anime/${id}/progress`, { episodes_watched: 99 });
    assert.deepEqual([res.body.status, res.body.episodes_watched, res.body.finished_at], ['Gesehen', 28, today]);
    res = await editor('PUT', `/anime/${id}/progress`, { status: 'Pausiert', episodes_watched: 10 });
    assert.deepEqual([res.body.status, res.body.episodes_watched], ['Pausiert', 10]);
    res = await editor('PUT', `/anime/${id}/progress`, { status: 'Gesehen' });
    assert.equal(res.body.episodes_watched, 28, '"Gesehen" fills the counter');
    assert.equal((await editor('PUT', `/anime/${id}/progress`, { score: 11 })).status, 400);
    assert.equal((await editor('PUT', `/anime/${id}/progress`, { episodes_watched: 1.5 })).status, 400);
    assert.equal((await editor('PUT', `/anime/${id}/progress`, { status: 'Fertig' })).status, 400);
    assert.equal((await editor('PUT', `/anime/${id}/progress`, { score: 9, notes: 'Toll' })).body.score, 9);
    assert.equal((await visitor('PUT', `/anime/${id}/progress`, { episodes_watched: 1 })).status, 403);

    const manual = db.prepare("SELECT id FROM animes WHERE title = 'Heimvideo'").get().id;
    db.prepare('UPDATE animes SET episodes = NULL WHERE id = ?').run(manual);
    res = await editor('PUT', `/anime/${manual}/progress`, { episodes_watched: 500 });
    assert.deepEqual([res.body.status, res.body.episodes_watched], ['Schaue', 500], 'no limit without a known count');
});

test('progress for another user: admins only; list and detail show everybody, mine separately', async () => {
    const id = db.prepare('SELECT id FROM animes WHERE anilist_id = 154587').get().id;
    const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
    assert.equal((await editor('PUT', `/anime/${id}/progress`, { user_id: adminId, status: 'Geplant' })).status, 403);
    const res = await admin('PUT', `/anime/${id}/progress`, { user_id: kimId(), notes: 'vom Admin' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user_id, kimId());
    await admin('PUT', `/anime/${id}/progress`, { status: 'Geplant' });

    const list = await visitor('GET', '/anime');
    assert.equal(list.status, 200);
    const entry = list.body.find((a) => a.id === id);
    assert.equal(entry.my_progress, null);
    assert.deepEqual(entry.progress_users.map((p) => p.username).sort(), ['admin', 'kim']);
    assert.equal(entry.description, undefined, 'the list stays slim');
    const detail = await editor('GET', `/anime/${id}`);
    assert.equal(detail.body.my_progress.notes, 'vom Admin');
    assert.equal(detail.body.progress.length, 2);
    assert.equal(detail.body.stale, false);

    assert.equal((await editor('DELETE', `/anime/${id}/progress`)).body.removed, true);
    assert.equal((await editor('GET', `/anime/${id}`)).body.my_progress, null);
    await editor('PUT', `/anime/${id}/progress`, { episodes_watched: 2 });
});

test('stats: anime block only with entries, watch time from episodes x duration', async () => {
    const stats = await admin('GET', '/stats');
    const anime = stats.body.anime;
    assert.equal(anime.total, 2);
    assert.equal(anime.planned, 1);
    const kim = anime.per_user.find((u) => u.username === 'kim');
    assert.equal(kim.watch_minutes, 2 * 24 + 500 * 0);
});

test('CSV export: semicolons, BOM, formula guard, the caller\'s progress', async () => {
    await editor('POST', '/anime', { title: '=HYPERLINK("x")', episodes: 1 });
    const res = await realFetch(`${ctx.base}/export/anime.csv`, { headers: { Cookie: editor.cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /manga-shelf-anime-\d{4}-\d{2}-\d{2}\.csv/);
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
    assert.ok(text.startsWith('﻿Titel;Deutscher Titel;AniList-ID;MAL-ID;Format;Folgen;Status;Jahr;Studios;Genres;Mein Status;Gesehene Folgen;Bewertung;Notizen'));
    assert.match(text, /'=HYPERLINK/);
    const frieren = text.split('\r\n').find((l) => l.includes('154587'));
    assert.match(frieren, /;52991;TV;28;FINISHED;2023;/);
    assert.match(frieren, /;Schaue;2;;$/, 'progress row was recreated without a score');
});

test('adaptations of a series and the sources state', async () => {
    const manga = db.prepare("SELECT id FROM mangas WHERE title = 'Frieren'").get().id;
    const res = await visitor('GET', `/mangas/${manga}/adaptations`);
    assert.equal(res.status, 200);
    assert.equal(res.body.source, 'anilist');
    assert.equal(res.body.results.length, 3);
    assert.equal(res.body.results.find((r) => r.anilist_id === 154587).in_collection_id, db.prepare('SELECT id FROM animes WHERE anilist_id = 154587').get().id);
    assert.equal((await visitor('GET', '/mangas/99999/adaptations')).status, 404);
    const state = await visitor('GET', '/anime/sources');
    assert.equal(state.status, 200);
    assert.equal(state.body.anilist.enabled, true);
    assert.equal(state.body.mal.adapter, 'jikan');
    assert.equal(typeof state.body.anilist.remaining, 'number');
});

test('orphan cleanup keeps anime covers; deleting a user keeps the entries and drops the progress', async () => {
    const cover = db.prepare('SELECT cover_image FROM animes WHERE anilist_id = 154587').get().cover_image;
    const file = path.join(ctx.dataDir, 'uploads', path.basename(cover));
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(file, old, old);
    const { cleanOrphanUploads } = require('../services/uploadCleanup');
    assert.ok(!cleanOrphanUploads({ dryRun: true }).files.includes(path.basename(cover)));

    const id = kimId();
    assert.ok(db.prepare('SELECT count(*) AS n FROM animes WHERE updated_by = ?').get(id).n > 0);
    assert.equal((await admin('DELETE', `/users/${id}`)).status, 200);
    assert.equal(db.prepare('SELECT count(*) AS n FROM anime_progress WHERE user_id = ?').get(id).n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM animes WHERE updated_by IS NULL').get().n, 3);
});

test('delete: editors only, progress goes with the entry', async () => {
    const id = db.prepare('SELECT id FROM animes WHERE anilist_id = 154587').get().id;
    assert.equal((await visitor('DELETE', `/anime/${id}`)).status, 403);
    assert.equal((await admin('DELETE', `/anime/${id}`)).status, 200);
    assert.equal((await admin('DELETE', `/anime/${id}`)).status, 404);
    assert.equal(db.prepare('SELECT count(*) AS n FROM anime_progress WHERE anime_id = ?').get(id).n, 0);
    assert.equal((await admin('GET', `/anime/${id}`)).status, 404);
});
