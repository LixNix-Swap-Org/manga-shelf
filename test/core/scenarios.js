// Handler scenarios run against both adapters (test/core/express.test.js and test/core/memory.test.js): the same
// requests, the same assertions. Each scenario works on its own series, so they can share one database.
const assert = require('node:assert/strict');

const pad = (n) => String(n).padStart(2, '0');
function monthFromNow(offset) {
    const d = new Date();
    const m = new Date(d.getFullYear(), d.getMonth() + offset, 1);
    return `${m.getFullYear()}-${pad(m.getMonth() + 1)}`;
}

// both harnesses run in this process: forgets the per-user watch-sync throttle (30 s) and lookup caps between steps
const watchSyncAgain = () => {
    const state = require('../../core/anime/gateway').state();
    state.watchSync?.clear();
    state.watchCaps?.clear();
};
// a watch-sync answer without its `watch` object (the sync state)
const ran = (body) => Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'watch'));

/** An AniList Media of the fake AniList (harness useAniList) with Crunchyroll links. */
const aniListMedia = (id, title, links) => ({
    id, idMal: null, type: 'ANIME', format: 'TV', status: 'FINISHED', episodes: 12, seasonYear: 2025, title: { romaji: title, english: null, native: null },
    synonyms: [], coverImage: { large: null }, genres: [], studios: { nodes: [] }, description: '', streamingEpisodes: [], relations: { edges: [] },
    externalLinks: links.map((url) => ({ site: 'Crunchyroll', url, type: 'STREAMING' }))
});

async function newSeries(api, title, extra = {}) {
    const res = await api('POST', '/mangas', { title, ...extra });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.id;
}

async function newVolume(api, mangaId, volume_number, extra = {}) {
    const res = await api('POST', '/volumes', { manga_id: mangaId, volume_number, ...extra });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.id;
}

const scenarios = [
    {
        name: 'mangas: create, validate, list, detail, edit, delete',
        async run({ admin, ed, vis }) {
            assert.deepEqual(
                [(await ed('POST', '/mangas', { title: '  ' })).body.error, (await ed('POST', '/mangas', { title: 'x'.repeat(301) })).status],
                ['Titel darf nicht leer sein', 400]
            );
            assert.equal((await vis('POST', '/mangas', { title: 'Besucher' })).status, 403);
            const id = await newSeries(ed, 'Kern Reihe A', { publisher: 'carlsen manga', total_volumes: '12', status: 'Unbekannt' });
            const row = (await vis('GET', '/mangas')).body.find(m => m.id === id);
            assert.equal(row.title, 'Kern Reihe A');
            assert.equal(row.status, 'Laufend');
            assert.equal(row.total_volumes, 12);
            assert.equal(row.owned_volumes, 0);

            const bad = await ed('PUT', `/mangas/${id}`, { total_volumes: 'zwölf' });
            assert.deepEqual([bad.status, bad.body.code], [400, 'BAD_REQUEST']);
            assert.equal((await ed('PUT', `/mangas/${id}`, { author: 'Autorin', wish_priority: 2 })).status, 200);
            const detail = (await vis('GET', `/mangas/${id}`)).body;
            assert.deepEqual([detail.author, detail.wish_priority, detail.wished, detail.volumes], ['Autorin', 2, 1, []]);
            assert.equal(detail.reader_stats.length, 3);

            assert.equal((await ed('DELETE', `/mangas/${id}`)).status, 200);
            const gone = await ed('GET', `/mangas/${id}`);
            assert.deepEqual([gone.status, gone.body.error, gone.body.code], [404, 'Manga nicht gefunden', 'NOT_FOUND']);
            assert.equal((await ed('DELETE', `/mangas/${id}`)).status, 404);
        }
    },
    {
        name: 'volumes: create, duplicate 409, batch, edit, delete',
        async run({ ed, vis }) {
            const id = await newSeries(ed, 'Kern Reihe B');
            const v1 = await newVolume(ed, id, '1', { price: '7,50', isbn: '978-3-551-74581-1' });
            const dup = await ed('POST', '/volumes', { manga_id: id, volume_number: 'Band 1' });
            assert.deepEqual([dup.status, dup.body.code, dup.body.existing_id], [409, 'VOLUME_DUPLICATE', v1]);
            assert.equal((await ed('POST', '/volumes', { manga_id: id, volume_number: '1', type: 'special_edition' })).status, 200);
            assert.equal((await ed('POST', '/volumes', { manga_id: id, volume_number: '2', status: 'Weg' })).status, 400);
            assert.equal((await vis('POST', '/volumes', { manga_id: id, volume_number: '3' })).status, 403);

            const batch = await ed('POST', '/volumes/batch', { manga_id: id, from: 1, to: 4, status: 'Fehlt' });
            assert.deepEqual(batch.body, { success: true, created: 3, skipped: ['1'] });
            assert.equal((await ed('POST', '/volumes/batch', { manga_id: id, from: 5, to: 400 })).status, 400);

            const detail = (await ed('GET', `/mangas/${id}`)).body;
            const two = detail.volumes.find(v => v.volume_number === '2' && v.type === 'volume');
            assert.equal((await ed('PUT', `/volumes/${two.id}`, { volume_number: '1' })).status, 409);
            assert.equal((await ed('PUT', `/volumes/${two.id}`, { notes: 'Erstauflage', status: 'Vorbestellt' })).status, 200);
            const after = (await ed('GET', `/mangas/${id}`)).body.volumes.find(v => v.id === two.id);
            assert.deepEqual([after.notes, after.status], ['Erstauflage', 'Vorbestellt']);
            const first = (await ed('GET', `/mangas/${id}`)).body.volumes.find(v => v.id === v1);
            assert.deepEqual([first.price, first.isbn, first.owners.map(o => o.username)], [7.5, '9783551745811', ['ed']]);

            assert.equal((await ed('DELETE', `/volumes/${two.id}`)).status, 200);
            assert.deepEqual((await ed('DELETE', `/volumes/${two.id}`)).body.error, 'Band nicht gefunden');
        }
    },
    {
        name: 'volumes: special placed after a regular volume (sort_after), Band 0 and half volumes in order',
        async run({ ed }) {
            const id = await newSeries(ed, 'Kern Reihe Sonderband');
            for (const n of ['1', '2', '3', '0', '2.5']) await newVolume(ed, id, n);
            await newVolume(ed, id, '2', { type: 'special_edition' });
            const guide = await newVolume(ed, id, 'Guidebook', { type: 'special', sort_after: '2' });
            await newVolume(ed, id, 'Fanbook', { type: 'special' });
            const box = await newVolume(ed, id, '1', { type: 'schuber', sort_after: '1' });
            const order = async () => (await ed('GET', `/mangas/${id}`)).body.volumes.map(v => `${v.type}:${v.volume_number}`);
            assert.deepEqual(await order(), [
                'volume:0', 'volume:1', 'volume:2', 'special_edition:2', 'special:Guidebook', 'volume:2.5', 'volume:3',
                'schuber:1', 'special:Fanbook'
            ]);
            const stored = (await ed('GET', `/mangas/${id}`)).body.volumes;
            assert.deepEqual([stored.find(v => v.id === guide).sort_after, stored.find(v => v.id === box).sort_after], [2, null],
                'only a special keeps sort_after');

            const bad = await ed('PUT', `/volumes/${guide}`, { sort_after: '-1' });
            assert.deepEqual([bad.status, bad.body.error], [400, 'Ungültige Position (Bandnummer von 0 bis 5000)']);
            assert.equal((await ed('PUT', `/volumes/${guide}`, { sort_after: '0,5' })).status, 200);
            assert.equal((await order()).indexOf('special:Guidebook'), 1, 'after Band 0, before Band 1');
            assert.equal((await ed('PUT', `/volumes/${guide}`, { sort_after: '' })).status, 200);
            assert.equal((await order()).at(-1), 'special:Guidebook', 'empty = after everything');
            assert.equal((await ed('PUT', `/volumes/${guide}`, { sort_after: '3', type: 'volume', volume_number: '4' })).status, 200);
            assert.equal((await ed('GET', `/mangas/${id}`)).body.volumes.find(v => v.id === guide).sort_after, null, 'a retyped entry drops it');
        }
    },
    {
        name: 'owners: toggle, dates, rights',
        async run({ admin, ed, vis, users }) {
            const id = await newSeries(admin, 'Kern Reihe C');
            const vid = await newVolume(admin, id, '1', { status: 'Fehlt' });
            const buy = await ed('POST', `/volumes/${vid}/owners`, { owned: true, purchase_date: '2025-03-04', price: 6 });
            assert.equal(buy.status, 200);
            assert.deepEqual([buy.body.status, buy.body.owned_by_me, buy.body.purchase_date, buy.body.previous_purchase_date], ['Vorhanden', true, '2025-03-04', null]);
            assert.deepEqual(buy.body.owners.map(o => [o.username, o.price, o.purchase_date]), [['ed', 6, '2025-03-04']]);
            const other = await ed('POST', `/volumes/${vid}/owners`, { owned: true, user_id: users.find(u => u.username === 'admin').id });
            assert.deepEqual([other.status, other.body.code], [403, 'FORBIDDEN']);
            assert.equal((await vis('POST', `/volumes/${vid}/owners`, { owned: true })).status, 403);
            const forVis = await admin('POST', `/volumes/${vid}/owners`, { owned: true, user_id: users.find(u => u.username === 'vis').id, purchase_date: '2025-05-05' });
            assert.deepEqual(forVis.body.owners.map(o => o.username), ['ed', 'vis']);
            const listed = (await ed('GET', '/mangas')).body.find(m => m.id === id);
            const ids = ['ed', 'vis'].map(n => users.find(u => u.username === n).id).sort((a, b) => a - b);
            assert.deepEqual(listed.owners.split('\n').map(p => Number(p.split('\t')[0])), ids, 'the list names who owns a volume');
            const leave = await ed('POST', `/volumes/${vid}/owners`, { owned: false });
            assert.deepEqual([leave.body.status, leave.body.purchase_date, leave.body.removed_owner.purchase_date], ['Vorhanden', '2025-05-05', '2025-03-04']);
            assert.equal((await ed('POST', '/volumes/999999/owners', {})).status, 404);
            assert.equal((await ed('POST', `/volumes/${vid}/owners`, { purchase_date: 'gestern' })).status, 400);
        }
    },
    {
        name: 'reads: toggle with undo date, batch read, personal statistics',
        async run({ ed, vis, users }) {
            const id = await newSeries(ed, 'Kern Reihe D');
            const ids = [];
            for (const n of ['1', '2', '3', '4']) ids.push(await newVolume(ed, id, n, { pages: 200 }));
            const on = await ed('POST', `/volumes/${ids[0]}/read`, {});
            assert.deepEqual([on.body.is_read, on.body.read_users.map(r => r.username)], [true, ['ed']]);
            const off = await ed('POST', `/volumes/${ids[0]}/read`, {});
            assert.equal(off.body.is_read, false);
            assert.match(off.body.previous_read_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
            assert.equal((await ed('POST', `/volumes/${ids[0]}/read`, { read: true, read_at: 'heute' })).status, 400);

            const batch = await ed('POST', '/volumes/batch-read', { manga_id: id, up_to_volume: '3' });
            assert.deepEqual([batch.body.count, batch.body.changed_ids.length], [3, 3]);
            const undo = await ed('POST', '/volumes/batch-read', { manga_id: id, up_to_volume: 3, read: false });
            assert.equal(Object.keys(undo.body.previous_read_at).length, 3);
            await ed('POST', '/volumes/batch-read', { manga_id: id, up_to_volume: 2 });

            const edId = users.find(u => u.username === 'ed').id;
            const stats = (await vis('GET', `/users/${edId}/stats`)).body;
            const mine = stats.stats.readMangas.find(m => m.id === id);
            assert.deepEqual([stats.user.username, mine.volumes.length], ['ed', 2]);
            assert.ok(stats.stats.totalPages >= 400);
            assert.equal((await vis('GET', '/users/999999/stats')).status, 404);
            assert.equal((await vis('POST', `/volumes/${ids[1]}/read`, {})).status, 403);
        }
    },
    {
        name: 'stats and settings',
        async run({ admin, ed }) {
            const before = (await ed('GET', '/stats')).body.summary;
            const id = await newSeries(ed, 'Kern Reihe E', { total_volumes: 2 });
            await newVolume(ed, id, '1', { price: 10, purchase_date: '2024-02-03' });
            await newVolume(ed, id, '2', { price: 5, status: 'Fehlt' });
            const after = (await ed('GET', '/stats')).body;
            assert.equal(after.summary.total_series, before.total_series + 1);
            assert.equal(after.summary.total_owned_volumes, before.total_owned_volumes + 1);
            assert.equal(after.summary.total_missing_volumes, before.total_missing_volumes + 1);
            assert.equal(after.spending.by_month.length, 12);
            assert.ok(after.spending.by_year.some(y => y.year === 2024 && y.total >= 10));

            assert.equal((await ed('PUT', '/stats/settings', { collection_start_date: '2020-01-01' })).status, 403);
            assert.equal((await admin('PUT', '/stats/settings', { collection_start_date: '2999-01-01' })).body.error, 'Das Startdatum darf nicht in der Zukunft liegen');
            assert.equal((await admin('PUT', '/stats/settings', {})).body.error, 'Kein Startdatum angegeben');
            assert.equal((await admin('PUT', '/stats/settings', { start_date: '2020-01-01' })).status, 200);
            assert.equal((await ed('GET', '/stats')).body.summary.collection_start_date, '2020-01-01');
        }
    },
    {
        name: 'shopping list, wished series and what others own',
        async run({ admin, ed }) {
            const id = await newSeries(ed, 'Kern Reihe F', { publisher: 'Tokyopop' });
            const own = await newVolume(ed, id, '1');
            const missing = await newVolume(ed, id, '2', { status: 'Fehlt', price: 8 });
            const wished = await newSeries(ed, 'Kern Wunsch F', { wish_priority: 3 });
            const list = (await admin('GET', '/shopping-list')).body;
            assert.ok(list.items.some(v => v.id === missing && v.effective_publisher === 'TOKYOPOP'));
            assert.ok(list.wished_series.some(s => s.id === wished && s.wish_priority === 3));
            assert.equal(list.others, undefined);
            const adminOwn = await newVolume(admin, id, '3');
            const others = (await admin('GET', '/shopping-list?include_others=1')).body.others;
            assert.ok(others.some(o => o.id === own && o.owned_by_others === 'ed'));
            assert.ok(!others.some(o => o.id === adminOwn));
        }
    },
    {
        name: 'release radar and dashboard counts',
        async run({ ed }) {
            const before = (await ed('GET', '/dashboard-summary')).body;
            const id = await newSeries(ed, 'Kern Reihe G');
            const next = monthFromNow(1);
            const pre = await newVolume(ed, id, '5', { status: 'Vorbestellt', release_date: `${next}-15`, price: 7 });
            await newVolume(ed, id, '6', { status: 'Fehlt', release_date: monthFromNow(2) });
            const radar = (await ed('GET', '/release-radar')).body;
            assert.equal(radar.items, undefined, 'only the groups');
            const group = radar.groups.find(g => g.key === next);
            assert.ok(group.items.some(i => i.id === pre && i.days_until > 0));
            const after = (await ed('GET', '/dashboard-summary')).body;
            assert.deepEqual(
                [after.total_releases - before.total_releases, after.preordered_count - before.preordered_count, after.total_missing - before.total_missing],
                [2, 1, 1]
            );
        }
    },
    {
        name: 'Manga Passion: calendar import, gap check and searches without network',
        async run({ ed, vis }) {
            const body = { title: 'Kern Kalender H (eBook)', volume_number: '3', target_status: 'Vorbestellt', release_date: monthFromNow(1), price: '7.5', publisher: 'carlsen manga' };
            const first = await ed('POST', '/manga-passion/import', body);
            assert.deepEqual(
                [first.status, first.body.series_created, first.body.type, first.body.status, first.body.skipped_owned],
                [200, true, 'volume', 'Vorbestellt', false]
            );
            const again = await ed('POST', '/manga-passion/import', { ...body, target_status: 'Fehlt' });
            assert.deepEqual([again.body.volume_id, again.body.skipped_ordered, again.body.series_created], [first.body.volume_id, true, false]);
            const series = (await ed('GET', `/mangas/${first.body.manga_id}`)).body;
            assert.deepEqual([series.title, series.publisher, series.volumes[0].price], ['Kern Kalender H', 'Carlsen Manga', 7.5]);
            assert.equal((await ed('POST', '/manga-passion/import', { ...body, target_status: 'Vorhanden' })).status, 400);
            assert.equal((await vis('POST', '/manga-passion/import', body)).status, 403);

            assert.equal((await vis('GET', '/mangas/999999/gaps')).status, 404);
            const gaps = await vis('GET', `/mangas/${first.body.manga_id}/gaps`);
            assert.deepEqual([gaps.status, gaps.body.success, gaps.body.unavailable], [200, false, true]);
            assert.equal((await ed('POST', `/mangas/${first.body.manga_id}/sync-edition`, {})).body.error, 'edition_id ist erforderlich');
            const unconfirmed = await ed('POST', `/mangas/${first.body.manga_id}/batch-import-gaps`, { volume_numbers: ['4'], edition_id: 77 });
            assert.deepEqual([unconfirmed.status, unconfirmed.body.code, unconfirmed.body.needs_confirmation], [409, 'EDITION_NOT_CONFIRMED', true]);

            const editions = await vis('GET', '/manga-passion/editions?title=Kern%20Offline%20Suche');
            assert.deepEqual([editions.status, editions.body.code], [503, 'MP_UNAVAILABLE']);
            assert.equal((await vis('GET', '/manga-passion/editions')).status, 400);
            assert.equal((await ed('GET', '/volumes/lookup')).body.error, 'Band-Nummer, ISBN oder URL erforderlich');
            assert.equal((await vis('GET', '/volumes/lookup?volume_number=1')).status, 403);
            assert.equal((await vis('GET', '/manga-passion/releases?month=13')).body.error, 'Ungültiges Jahr oder Monat');
            const releases = await vis('GET', `/manga-passion/releases?year=${new Date().getFullYear() - 1}&month=7`);
            assert.deepEqual([releases.status, releases.body.code, releases.body.error], [503, 'MP_UNAVAILABLE', 'Fehler beim Abrufen der Manga-Passion-Neuerscheinungen']);
        }
    },
    {
        name: 'lookups: ISBN from the collection, invalid input, remote image errors',
        async run({ ed, vis }) {
            const id = await newSeries(ed, 'Kern Reihe I');
            await newVolume(ed, id, '7', { isbn: '9783551023452' });
            const scan = (await ed('GET', '/lookup/isbn?isbn=978-3-551-02345-2')).body;
            assert.deepEqual(
                [scan.found, scan.match_reason, scan.matched_manga.id, scan.matched_volume.owned_by_me, scan.matched_volume.owners, scan.book.volume_number],
                [true, 'isbn', id, true, ['ed'], '7']
            );
            assert.equal((await vis('GET', '/lookup/isbn?isbn=9783551023452')).body.matched_volume.owned_by_me, false);
            assert.equal((await vis('GET', '/lookup/isbn?isbn=9783551023453')).status, 400);
            assert.equal((await vis('GET', '/lookup/isbn?isbn=123')).body.error, 'Ungültiges ISBN-Format (muss 10 oder 13 Zeichen lang sein)');
            assert.equal((await vis('GET', '/lookup/manga?q=%20')).body.error, 'Suchbegriff erforderlich');
            const offline = await vis('GET', '/lookup/manga?q=Kern%20Offline');
            assert.deepEqual([offline.status, offline.body.code], [503, 'SOURCES_UNAVAILABLE'], 'no network is not "no hits"');
            assert.equal((await ed('POST', '/upload-remote', { url: 'ftp://x' })).body.error, 'Ungültige Bild-URL');
            const unreachable = await ed('POST', '/upload-remote', { url: 'https://does-not-exist.invalid/cover.jpg' });
            assert.deepEqual([unreachable.status, unreachable.body.error], [400, 'Bild-URL nicht erreichbar oder nicht erlaubt']);
            assert.equal((await vis('POST', '/upload-remote', { url: 'https://example.com/a.jpg' })).status, 403);
        }
    },
    {
        name: 'CSV: export and import (dry run, then for real)',
        async run({ ed, vis }) {
            const id = await newSeries(ed, 'Kern Reihe J', { publisher: 'Egmont' });
            await newVolume(ed, id, '1', { price: 9.95, notes: '=Formel' });
            const res = await vis.raw('GET', '/export/csv');
            assert.equal(res.status, 200);
            const type = Object.entries(res.headers).find(([k]) => k.toLowerCase() === 'content-type')[1];
            assert.equal(type, 'text/csv; charset=utf-8');
            assert.ok(res.text.startsWith('﻿Reihe;Reihenverlag;Verlag'));
            assert.ok(res.text.includes('Kern Reihe J'));
            assert.ok(res.text.includes("'=Formel"), 'formula protection');

            const csv = 'Reihe;Verlag;Bandnummer;Status;Preis\nKern CSV K;Carlsen;1;Vorhanden;6,95\nKern CSV K;Carlsen;2;Fehlt;6,95\n';
            assert.equal((await vis('POST', '/import/csv', { csv })).status, 403);
            const dry = (await ed('POST', '/import/csv', { csv, dry_run: true })).body;
            assert.deepEqual([dry.dry_run, dry.created_series, dry.created_volumes], [true, 1, 2]);
            assert.ok(!(await ed('GET', '/mangas')).body.some(m => m.title === 'Kern CSV K'));
            const real = (await ed('POST', '/import/csv', { csv })).body;
            assert.deepEqual([real.dry_run, real.created_series, real.created_volumes], [false, 1, 2]);
            assert.equal((await ed('POST', '/import/csv', { csv })).body.skipped_existing, 2);
            assert.equal((await ed('POST', '/import/csv', { csv: ' ' })).body.error, 'CSV-Text fehlt');
        }
    },
    {
        name: 'offline snapshot: list and every detail for the caller',
        async run({ ed, vis, users }) {
            const id = await newSeries(ed, 'Kern Reihe L');
            const vid = await newVolume(ed, id, '1');
            await ed('POST', `/volumes/${vid}/read`, {});
            const snap = (await ed('GET', '/offline-snapshot')).body;
            assert.deepEqual(snap.user, { id: users.find(u => u.username === 'ed').id, username: 'ed', role: 'editor' });
            assert.ok(snap.mangas.some(m => m.id === id));
            assert.equal(snap.details[id].volumes[0].is_read, true);
            assert.match(snap.generated_at, /^\d{4}-\d{2}-\d{2}T/);
            const visSnap = (await vis('GET', '/offline-snapshot')).body;
            assert.equal(visSnap.details[id].volumes[0].is_read, false);
        }
    },
    {
        name: 'anime: manual entry, progress, list, export, sources and searches without network',
        async run({ admin, ed, vis, users }) {
            assert.equal((await ed('POST', '/anime', { title: '' })).status, 400);
            assert.equal((await vis('POST', '/anime', { title: 'Kern Anime' })).status, 403);
            const created = await ed('POST', '/anime', { title: 'Kern Anime', episodes: 3 });
            assert.deepEqual([created.status, created.body.manual, created.body.episodes], [201, true, 3]);
            const id = created.body.id;

            const watched = await ed('PUT', `/anime/${id}/progress`, { episodes_watched: 9 });
            assert.deepEqual([watched.status, watched.body.status, watched.body.episodes_watched], [200, 'Gesehen', 3]);
            assert.equal((await ed('PUT', `/anime/${id}/progress`, { user_id: users.find(u => u.username === 'vis').id, status: 'Geplant' })).status, 403);
            const entry = (await vis('GET', '/anime')).body.find(a => a.id === id);
            assert.deepEqual([entry.my_progress, entry.progress_users.map(p => p.username)], [null, ['ed']]);
            assert.equal((await ed('GET', `/anime/${id}`)).body.my_progress.status, 'Gesehen');
            assert.equal((await ed('PUT', `/anime/${id}`, { notes: 'DVD' })).body.my_progress.notes, 'DVD');
            assert.equal((await vis('GET', '/export/anime.csv')).status, 200);
            assert.equal((await ed('POST', `/anime/${id}/refresh`, {})).status, 400, 'manual entries have no source');

            const sources = await vis('GET', '/anime/sources');
            assert.equal(sources.status, 200);
            assert.equal(typeof sources.body.anilist.enabled, 'boolean');
            const search = await vis('GET', '/anime/search?q=Kern%20Offline');
            assert.deepEqual([search.status, search.body.code], [503, 'SOURCES_UNAVAILABLE']);
            assert.equal((await vis('GET', '/sources/guides')).status, 200);

            assert.equal((await ed('DELETE', `/anime/${id}/progress`)).status, 200);
            assert.equal((await admin('DELETE', `/anime/${id}`)).status, 200);
            assert.equal((await vis('GET', `/anime/${id}`)).status, 404);
        }
    },
    {
        name: 'anime watch: shared link without network, monotonic watched, resume link, sync state',
        async run({ ed, vis }) {
            const created = await ed('POST', '/anime', { title: 'Kern Frieren', episodes: 28 });
            const id = created.body.id;
            const url = 'https://www.crunchyroll.com/kern-frieren/episode-7-like-a-fairy-tale-911417';
            assert.equal((await vis('POST', '/anime/resolve-link', { url })).status, 403);
            const resolved = await ed('POST', '/anime/resolve-link', { url });
            assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
            assert.deepEqual([resolved.body.kind, resolved.body.episode, resolved.body.episode_source, resolved.body.anime_id, resolved.body.page_checked],
                ['legacy', 7, 'slug', id, false]);
            assert.equal((await ed('POST', '/anime/resolve-link', { url: 'https://example.org/x' })).body.code, 'UNSUPPORTED_LINK');

            const watched = await ed('POST', `/anime/${id}/watched`, { episode: 7, url, remember: { service: 'crunchyroll', external_id: 'GKERN0001' } });
            assert.deepEqual([watched.status, watched.body.progress.episodes_watched, watched.body.progress.resume_episode], [200, 7, 7]);
            assert.deepEqual([watched.body.previous.status, watched.body.previous.episodes_watched, watched.body.entry_episodes], ['Geplant', 0, 28]);
            const again = await ed('POST', `/anime/${id}/watched`, { episode: 3 });
            assert.deepEqual([again.body.progress.episodes_watched, again.body.previous.episodes_watched], [7, 7]);
            assert.deepEqual(resolved.body.entry, { id, title: 'Kern Frieren', episodes: 28, my_status: 'Geplant', my_episodes: 0 });
            const above = await ed('POST', `/anime/${id}/watched`, { episode: 29 });
            assert.deepEqual([above.status, above.body.code, above.body.episodes], [400, 'EPISODE_ABOVE_TOTAL', 28]);
            assert.equal((await ed('POST', `/anime/${id}/watched`, { episode: 8, url: 'https://www.crunchyroll.com/series/GKERN0001' })).body.code, 'UNSUPPORTED_LINK');
            assert.equal((await vis('GET', `/anime/${id}`)).body.progress[0].resume_url, null);
            const entry = (await ed('GET', '/anime')).body.find(a => a.id === id);
            assert.deepEqual(entry.watch, { next_url: url, series_url: 'https://www.crunchyroll.com/series/GKERN0001', search_url: 'https://www.crunchyroll.com/search?q=Kern%20Frieren' });
            assert.equal((await ed('PUT', `/anime/${id}/progress`, { episodes_watched: 8 })).body.resume_url, null);
            assert.deepEqual((await ed('GET', '/anime/sync')).body.anilist.enabled, false);
            assert.equal((await ed('POST', '/anime/sync/run', {})).body.anilist.ran, false);
            assert.equal((await ed('DELETE', `/anime/${id}`)).status, 200);
        }
    },
    {
        name: 'anime watch-sync: history items from the app, monotonic, unmatched with candidates, season link from a confirmation',
        async run({ ed, vis }) {
            const id = (await ed('POST', '/anime', { title: 'Kern Verlauf Serie', episodes: 12 })).body.id;
            const other = (await ed('POST', '/anime', { title: 'Das Kern Verlaufsbuch Zwei', episodes: 12 })).body.id;
            const item = (fields) => ({ external_id: 'GKERNVERL1', series_title: 'Kern Verlauf Serie', season: 1, episode: 4, fully_watched: false,
                resume_url: 'https://www.crunchyroll.com/watch/GKERNVEP04/folge-vier', resume_episode: 4, watched_at: '2026-10-01T20:00:00Z', ...fields });
            assert.equal((await vis('POST', '/anime/watch-sync', { service: 'crunchyroll', items: [item({})] })).status, 403);
            assert.equal((await ed('POST', '/anime/watch-sync', { service: 'crunchyroll', items: [{ episode: 1 }] })).status, 400);

            const first = await ed('POST', '/anime/watch-sync', { service: 'crunchyroll', items: [item({}), item({ external_id: 'GKERNBUCH1', series_title: 'Kern Verlaufsbuch', episode: 2, fully_watched: true, resume_url: null })] });
            assert.equal(first.status, 200, JSON.stringify(first.body));
            assert.deepEqual(first.body.applied, [{ anime_id: id, episodes_watched: 3, status: 'Schaue' }]);
            assert.deepEqual(first.body.unmatched.map(u => [u.external_id, u.reason, u.episodes_watched, u.candidates.map(c => c.id)]), [['GKERNBUCH1', 'no_match', 2, [other]]]);
            assert.deepEqual(first.body.unmatched[0].candidates.map(c => c.season), [1]);
            const mine = (await ed('GET', `/anime/${id}`)).body.my_progress;
            assert.deepEqual([mine.episodes_watched, mine.resume_url, mine.resume_episode], [3, 'https://www.crunchyroll.com/watch/GKERNVEP04/folge-vier', 4]);
            const lower = { service: 'crunchyroll', items: [item({ episode: 2, fully_watched: true, resume_url: null })] };
            const throttled = (await ed('POST', '/anime/watch-sync', lower)).body;
            assert.deepEqual({ ...throttled, retry_after: Number.isInteger(throttled.retry_after) && throttled.retry_after >= 1 && throttled.retry_after <= 30 },
                { applied: [], unmatched: [], added: [], throttled: true, retry_after: true });
            watchSyncAgain();
            assert.deepEqual(ran((await ed('POST', '/anime/watch-sync', lower)).body), { applied: [], unmatched: [], unchanged: 1, added: [] });

            await ed('POST', `/anime/${other}/watched`, { episode: 2, remember: { service: 'crunchyroll', external_id: 'GKERNBUCH1', season: 1 } });
            watchSyncAgain();
            const mapped = await ed('POST', '/anime/watch-sync', { service: 'crunchyroll', items: [item({ external_id: 'GKERNBUCH1', series_title: 'Kern Verlaufsbuch', episode: 12, fully_watched: true, resume_url: null })] });
            assert.deepEqual(ran(mapped.body), { applied: [{ anime_id: other, episodes_watched: 12, status: 'Gesehen' }], unmatched: [], unchanged: 0, added: [] });
            assert.deepEqual((await ed('GET', '/anime/sync')).body.watch, { auto_add: true, last_at: mapped.body.watch.last_at, last_platform: null, last_applied: 1, last_added: 0 });
            assert.equal((await ed('DELETE', `/anime/${id}`)).status, 200);
            assert.equal((await ed('DELETE', `/anime/${other}`)).status, 200);
        }
    },
    {
        name: 'anime watch-sync: automatic adding, its undo and an AniList entry already in the list (fake AniList)',
        async run({ ed, vis, run }) {
            const { useAniList } = require('./harness');
            require('../../core/anime/gateway').resetGatewayState();
            useAniList({
                media: [
                    aniListMedia(91001, 'Kern Automatik', ['https://www.crunchyroll.com/series/GKERNAUTO1/kern-automatik']),
                    aniListMedia(91002, 'Kern Duplikat', ['https://www.crunchyroll.com/series/GKERNDUPL1/kern-duplikat'])
                ],
                search: { 'Kern Automatik': [91001], 'Kern Duplikat': [91002] }
            });
            try {
                const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
                const started = { external_id: 'GKERNAUTO1', series_title: 'Kern Automatik', season: 1, episode: 1, fully_watched: false,
                    resume_url: 'https://www.crunchyroll.com/watch/GKERNAEP01/eins', resume_episode: 1, watched_at: recent };
                const body = (items) => ({ service: 'crunchyroll', items, auto_add: true, platform: 'linux' });
                const first = await ed('POST', '/anime/watch-sync', body([started]));
                assert.equal(first.status, 200, JSON.stringify(first.body));
                const [added] = first.body.added;
                assert.deepEqual({ ...added, anime_id: typeof added.anime_id },
                    { anime_id: 'number', title: 'Kern Automatik', external_id: 'GKERNAUTO1', season: 1, episodes_watched: 0, status: 'Schaue' });
                assert.deepEqual([first.body.applied, first.body.watch.last_platform, first.body.watch.last_added], [[], 'linux', 1]);
                const mine = (await ed('GET', `/anime/${added.anime_id}`)).body.my_progress;
                assert.deepEqual([mine.status, mine.episodes_watched, mine.resume_episode], ['Schaue', 0, 1]);

                const keyed = { anime_id: added.anime_id, external_id: added.external_id, season: added.season };
                assert.equal((await vis('POST', '/anime/watch-sync/undo', keyed)).status, 403);
                assert.deepEqual((await ed('POST', '/anime/watch-sync/undo', keyed)).body, { removed: 'entry' });
                assert.equal((await ed('GET', `/anime/${added.anime_id}`)).status, 404);
                assert.equal((await ed('POST', '/anime/watch-sync/undo', keyed)).status, 404);
                watchSyncAgain();
                const declined = await ed('POST', '/anime/watch-sync', body([{ ...started, episode: 2, fully_watched: true }]));
                assert.deepEqual([declined.body.added, declined.body.unmatched.map(u => u.reason)], [[], ['declined']]);

                run("INSERT INTO animes (title, anilist_id, episodes) VALUES ('Ganz anders benannt', 91002, 12)");
                const id = (await ed('GET', '/anime')).body.find(a => a.anilist_id === 91002).id;
                watchSyncAgain();
                const dup = await ed('POST', '/anime/watch-sync', body([{ ...started, external_id: 'GKERNDUPL1', series_title: 'Kern Duplikat', episode: 3, fully_watched: true, resume_url: null }]));
                assert.deepEqual([dup.body.added, dup.body.applied], [[], [{ anime_id: id, episodes_watched: 3, status: 'Schaue' }]]);
                watchSyncAgain();
                const linked = await ed('POST', '/anime/watch-sync', { service: 'crunchyroll', items: [{ ...started, external_id: 'GKERNDUPL1', series_title: null, episode: 4, fully_watched: true, resume_url: null }] });
                assert.deepEqual(linked.body.applied, [{ anime_id: id, episodes_watched: 4, status: 'Schaue' }], 'the season link was learned');
                assert.equal((await ed('DELETE', `/anime/${id}`)).status, 200);
            } finally {
                useAniList(null);
                watchSyncAgain();
            }
        }
    },
    {
        name: 'volumes bulk: set status and priority, undo by token, validation, rights',
        async run({ admin, ed, vis }) {
            const id = await newSeries(ed, 'Kern Reihe Bulk');
            const ids = [];
            for (const n of ['1', '2', '3']) ids.push(await newVolume(ed, id, n, { status: 'Fehlt' }));
            const volumes = async () => (await ed('GET', `/mangas/${id}`)).body.volumes;

            assert.equal((await vis('POST', '/volumes/bulk', { ids, set: { priority: 1 } })).status, 403);
            assert.deepEqual([(await ed('POST', '/volumes/bulk', { ids: [], set: { priority: 1 } })).body.code], ['BULK_IDS']);
            const unknown = await ed('POST', '/volumes/bulk', { ids, set: { title: 'x' } });
            assert.deepEqual([unknown.status, unknown.body.code], [400, 'BULK_FIELD']);

            const done = await ed('POST', '/volumes/bulk', { ids: ids.slice(0, 2), set: { status: 'Vorhanden', priority: 2 } });
            assert.equal(done.status, 200, JSON.stringify(done.body));
            assert.deepEqual([done.body.success, done.body.updated, done.body.not_found, 'previous' in done.body], [true, 2, [], false]);
            assert.equal(typeof done.body.undo_token, 'string');
            let after = await volumes();
            assert.deepEqual(after.map(v => [v.status, v.priority, v.owners.map(o => o.username)]), [
                ['Vorhanden', 2, ['ed']], ['Vorhanden', 2, ['ed']], ['Fehlt', 0, []]
            ]);

            const forged = await ed('POST', '/volumes/bulk', { revert: [{ id: ids[0], volume: { status: 'Fehlt' }, owners: [] }] });
            assert.deepEqual([forged.status, forged.body.code], [400, 'BULK_REVERT']);
            assert.deepEqual([(await admin('POST', '/volumes/bulk', { revert: done.body.undo_token })).body.code], ['BULK_UNDO_FORBIDDEN']);
            const reverted = await ed('POST', '/volumes/bulk', { revert: done.body.undo_token });
            assert.equal(reverted.status, 200, JSON.stringify(reverted.body));
            assert.deepEqual([reverted.body.restored, reverted.body.conflicts], [ids.slice(0, 2), []]);
            after = await volumes();
            assert.deepEqual(after.map(v => [v.status, v.priority, v.owners.length]), [['Fehlt', 0, 0], ['Fehlt', 0, 0], ['Fehlt', 0, 0]]);
            const again = await ed('POST', '/volumes/bulk', { revert: done.body.undo_token });
            assert.deepEqual([again.status, again.body.code], [410, 'BULK_UNDO_EXPIRED']);
            assert.equal((await ed('POST', '/volumes/bulk', { revert: 'kaputt' })).status, 410);
        }
    },
    {
        name: 'volumes bulk: delete and undo bring back ids, owners of every user and reads',
        async run({ admin, ed }) {
            const id = await newSeries(ed, 'Kern Reihe Bulk Löschen');
            const a = await newVolume(ed, id, '1', { price: 7, purchase_date: '2024-01-01' });
            const b = await newVolume(ed, id, '2', { status: 'Fehlt' });
            await admin('POST', `/volumes/${a}/owners`, { owned: true, purchase_date: '2024-02-02', price: 6 });
            await ed('POST', `/volumes/${a}/read`, { read: true, read_at: '2024-03-03 12:00:00' });
            await admin('POST', `/volumes/${a}/read`, { read: true, read_at: '2024-04-04 12:00:00' });
            const before = (await ed('GET', `/mangas/${id}`)).body.volumes;

            const removed = await ed('POST', '/volumes/bulk', { ids: [a, b], delete: true });
            assert.deepEqual([removed.status, removed.body.deleted], [200, true]);
            assert.equal((await ed('GET', `/mangas/${id}`)).body.volumes.length, 0);
            assert.ok((await ed('GET', '/trash')).body.items.some(t => t.kind === 'volume' && t.ref_id === a));
            const undo = await ed('POST', '/volumes/bulk', { revert: removed.body.undo_token });
            assert.deepEqual([undo.status, undo.body.restored, undo.body.not_found], [200, [a, b], []]);
            const back = (await ed('GET', `/mangas/${id}`)).body.volumes;
            const view = (list) => list.map(v => [v.id, v.status, v.price, v.owners.map(o => [o.username, o.price, o.purchase_date]), v.read_users.map(r => [r.username, r.read_at])]);
            assert.deepEqual(view(back), view(before));
            assert.ok(!(await ed('GET', '/trash')).body.items.some(t => t.kind === 'volume' && [a, b].includes(t.ref_id)), 'the trash entries went with the undo');
        }
    },
    {
        name: 'trash: a deleted series and a deleted volume come back with their ids',
        async run({ ed, vis }) {
            const id = await newSeries(ed, 'Kern Reihe Papierkorb', { publisher: 'Carlsen', tags: 'Adventure' });
            const keep = await newVolume(ed, id, '1', { price: 5 });
            const gone = await newVolume(ed, id, '2', { status: 'Fehlt' });
            await ed('POST', `/volumes/${keep}/read`, { read: true, read_at: '2025-01-01 09:00:00' });
            const before = (await ed('GET', `/mangas/${id}`)).body;

            const volumeDelete = await ed('DELETE', `/volumes/${gone}`);
            assert.equal(typeof volumeDelete.body.trash_id, 'number');
            assert.equal((await vis('POST', `/trash/${volumeDelete.body.trash_id}/restore`)).status, 403);
            const volumeBack = await ed('POST', `/trash/${volumeDelete.body.trash_id}/restore`);
            assert.deepEqual([volumeBack.status, volumeBack.body.kind, volumeBack.body.id], [200, 'volume', gone]);

            const seriesDelete = await ed('DELETE', `/mangas/${id}`);
            assert.equal((await ed('GET', `/mangas/${id}`)).status, 404);
            const listed = (await vis('GET', '/trash')).body;
            const entry = listed.items.find(t => t.id === seriesDelete.body.trash_id);
            assert.deepEqual([entry.kind, entry.title, entry.restorable, listed.retention_days], ['manga', 'Kern Reihe Papierkorb', true, 30]);
            const seriesBack = await ed('POST', `/trash/${seriesDelete.body.trash_id}/restore`);
            assert.deepEqual([seriesBack.status, seriesBack.body.id], [200, id]);
            const after = (await ed('GET', `/mangas/${id}`)).body;
            const view = (m) => [m.title, m.tags, m.volumes.map(v => [v.id, v.volume_number, v.status, v.price, v.is_read, v.owners.map(o => o.username)])];
            assert.deepEqual(view(after), view(before));
            assert.equal((await ed('POST', `/trash/${seriesDelete.body.trash_id}/restore`)).status, 404);
        }
    },
    {
        name: 'reading over time, tags and data quality',
        async run({ ed, vis, run }) {
            const id = await newSeries(ed, 'Kern Reihe Lesen', { tags: 'Adventure; Slice of Life, adventure' });
            const tags = (await vis('GET', '/tags')).body.tags;
            assert.ok(tags.some(t => t.tag === 'Abenteuer' && t.count >= 1));
            assert.ok(tags.some(t => t.tag === 'Alltag'));
            assert.equal((await vis('GET', `/mangas/${id}`)).body.tags, 'Abenteuer, Alltag');

            const ids = [];
            for (const n of ['1', '2', '3']) ids.push(await newVolume(ed, id, n, { pages: 180 }));
            const month = monthFromNow(0);
            await ed('POST', `/volumes/${ids[0]}/read`, { read: true, read_at: `${month}-01 10:00:00` });
            const reading = (await vis('GET', '/stats/reading?user_id=2')).body;
            assert.deepEqual([reading.user.username, reading.months, reading.by_month.length], ['ed', 24, 24]);
            const thisMonth = reading.by_month.find(m => m.month === month);
            assert.ok(thisMonth.volumes >= 1 && thisMonth.pages >= 180);
            const next = reading.continue_reading.find(c => c.manga_id === id);
            assert.equal(next.next_volume.id, ids[1]);
            assert.equal((await vis('GET', '/stats/reading?user_id=999999')).status, 404);

            const legacy = await newVolume(ed, id, '4', { status: 'Fehlt' });
            run("UPDATE volumes SET status = 'Gelesen' WHERE id = ?", legacy);
            const quality = (await vis('GET', '/maintenance/quality')).body;
            const check = (name) => quality.checks.find(c => c.id === name);
            assert.ok(check('series_without_cover').items.some(m => m.id === id));
            assert.ok(check('legacy_read_status').items.some(v => v.id === legacy));
            assert.equal(check('legacy_read_status').fix, 'legacy_read');
            assert.equal((await vis('POST', '/maintenance/fix', { check: 'legacy_read' })).status, 403);
            assert.equal((await ed('POST', '/maintenance/fix', { check: 'nope' })).body.code, 'FIX_UNKNOWN');
            const fixed = await ed('POST', '/maintenance/fix', { check: 'legacy_read' });
            assert.ok(fixed.body.changed >= 1);
            assert.ok(!(await vis('GET', '/maintenance/quality')).body.checks.find(c => c.id === 'legacy_read_status').items.some(v => v.id === legacy));
        }
    },
    {
        name: 'calendar feed: the token in the query is the credential',
        async run({ ed, anonymous, run }) {
            const id = await newSeries(ed, 'Kern Reihe Kalender');
            await newVolume(ed, id, '9', { status: 'Vorbestellt', release_date: `${monthFromNow(1)}-10`, price: 8 });
            const token = `kern${'A'.repeat(36)}${Date.now().toString(36)}`.replace(/[^A-Za-z0-9_-]/g, 'x');
            const hash = require('crypto').createHash('sha256').update(token, 'utf8').digest('hex');
            run("INSERT INTO calendar_feeds (token_hash, user_id, scope, created_at) VALUES (?, 2, 'radar', ?)", hash, new Date().toISOString());

            const feed = await anonymous.raw('GET', `/radar/feed.ics?token=${token}`);
            assert.equal(feed.status, 200);
            const type = Object.entries(feed.headers).find(([k]) => k.toLowerCase() === 'content-type')[1];
            assert.match(type, /^text\/calendar/);
            assert.ok(feed.text.startsWith('BEGIN:VCALENDAR'));
            assert.ok(feed.text.includes('Kern Reihe Kalender'));
            const wrong = await anonymous('GET', `/radar/feed.ics?token=${'B'.repeat(43)}`);
            assert.deepEqual([wrong.status, wrong.body.code], [404, 'NOT_FOUND']);
            assert.equal((await anonymous('GET', '/radar/feed.ics')).status, 404);

            // a token opens only the feed of its scope
            assert.equal((await anonymous('GET', `/anime/feed.ics?token=${token}`)).status, 404);
            const animeToken = token.replace(/^kern/, 'anim');
            const animeHash = require('crypto').createHash('sha256').update(animeToken, 'utf8').digest('hex');
            run("INSERT INTO calendar_feeds (token_hash, user_id, scope, created_at) VALUES (?, 2, 'anime', ?)", animeHash, new Date().toISOString());
            const anime = await anonymous.raw('GET', `/anime/feed.ics?token=${animeToken}`);
            assert.equal(anime.status, 200);
            assert.ok(anime.text.startsWith('BEGIN:VCALENDAR'));
            assert.equal((await anonymous('GET', `/radar/feed.ics?token=${animeToken}`)).status, 404);
        }
    },
    {
        name: 'editions: language codes, linked editions, work groups, Manga Passion only for German editions',
        async run({ ed, vis }) {
            const de = await newSeries(ed, 'Kern Ausgabe DE', { language: 'Deutsch', author: 'Oda', total_volumes: 5, tags: 'Abenteuer' });
            const row = (await vis('GET', '/mangas')).body.find(m => m.id === de);
            assert.deepEqual([row.language, row.region, row.work_key, row.currency], ['de', null, null, 'EUR']);
            assert.deepEqual((await vis('GET', `/mangas/${de}`)).body.editions, []);
            const unknown = await ed('POST', '/mangas', { title: 'Kern Ausgabe X', language: 'Klingonisch' });
            assert.deepEqual([unknown.status, unknown.body.code, unknown.body.error], [400, 'LANGUAGE_INVALID', 'Unbekannte Sprache']);
            assert.equal((await ed('POST', '/mangas', { title: 'Kern Ausgabe X', region: 'USA' })).body.error, 'Ungültige Region (zwei Buchstaben, z. B. US)');
            assert.equal((await ed('POST', '/mangas', { title: 'Kern Ausgabe X', currency: '€' })).body.error, 'Ungültige Währung (drei Buchstaben, z. B. EUR)');
            assert.equal((await ed('POST', '/mangas', { title: 'Kern Ausgabe X', work_key: 'kitsu:1' })).body.error, 'Ungültiger Werk-Schlüssel');
            const manual = await ed('POST', '/mangas', { title: 'Kern Ausgabe X', work_key: `manual:${de}` });
            assert.deepEqual([manual.status, manual.body.code], [400, 'WORK_KEY_INVALID'], 'manual groups only through /editions and /work');

            const created = await ed('POST', `/mangas/${de}/editions`, { language: 'en-US', currency: 'usd', title: 'Kern Edition EN' });
            assert.equal(created.status, 201);
            assert.match(created.body.work_key, /^manual:[0-9a-f]{24}$/, 'a fresh key, not the series id');
            const en = created.body.id;
            const enDetail = (await vis('GET', `/mangas/${en}`)).body;
            assert.deepEqual(
                [enDetail.title, enDetail.language, enDetail.region, enDetail.currency, enDetail.author, enDetail.total_volumes, enDetail.tags, enDetail.status],
                ['Kern Edition EN', 'en', 'US', 'USD', 'Oda', 5, 'Abenteuer', 'Laufend']
            );
            assert.deepEqual(enDetail.editions.map(e => [e.id, e.language]), [[de, 'de']]);
            assert.deepEqual((await vis('GET', `/mangas/${de}`)).body.editions,
                [{ id: en, title: 'Kern Edition EN', language: 'en', region: 'US', currency: 'USD', publisher: null, cover_image: null, owned_volumes: 0, volume_count: 0 }]);
            assert.equal((await vis('POST', `/mangas/${de}/editions`, { language: 'en' })).status, 403);
            assert.equal((await ed('POST', `/mangas/${de}/editions`, {})).body.code, 'LANGUAGE_INVALID');
            assert.equal((await ed('POST', '/mangas/999999/editions', { language: 'en' })).status, 404);

            const ja = await newSeries(ed, 'Kern Ausgabe JA', { language: 'ja', work_key: 'anilist:30013' });
            const linked = await ed('PUT', `/mangas/${de}/work`, { link_to: ja });
            assert.deepEqual([linked.status, linked.body.work_key, linked.body.editions.map(e => e.id)], [200, 'anilist:30013', [en, ja]], 'the AniList key wins, the groups merge');
            const keys = (await vis('GET', '/mangas')).body.filter(m => [de, en, ja].includes(m.id)).map(m => m.work_key);
            assert.deepEqual(keys, ['anilist:30013', 'anilist:30013', 'anilist:30013']);
            assert.equal((await ed('PUT', `/mangas/${de}/work`, { link_to: de })).status, 400);
            assert.equal((await ed('PUT', `/mangas/${de}/work`, { link_to: 999999 })).status, 404);
            assert.equal((await ed('PUT', `/mangas/${de}/work`, {})).status, 400);
            assert.equal((await vis('PUT', `/mangas/${de}/work`, { link_to: null })).status, 403);
            const unlinked = await ed('PUT', `/mangas/${en}/work`, { link_to: null });
            assert.deepEqual([unlinked.body.work_key, unlinked.body.editions], [null, []]);
            assert.deepEqual((await vis('GET', `/mangas/${de}`)).body.editions.map(e => e.id), [ja]);

            // an unlinked series never pulls its former partner back: unlink -> new edition -> new group of two
            const solo = await newSeries(ed, 'Kern Solo DE');
            const soloEn = (await ed('POST', `/mangas/${solo}/editions`, { language: 'en' })).body.id;
            const left = await ed('PUT', `/mangas/${solo}/work`, { link_to: null });
            assert.deepEqual([left.body.work_key, left.body.editions], [null, []]);
            assert.deepEqual((await vis('GET', `/mangas/${soloEn}`)).body.editions, [], 'a group of one is dissolved');
            assert.equal((await vis('GET', '/mangas')).body.find(m => m.id === soloEn).work_key, null);
            const soloJa = (await ed('POST', `/mangas/${solo}/editions`, { language: 'ja' })).body.id;
            assert.deepEqual((await vis('GET', `/mangas/${solo}`)).body.editions.map(e => e.id), [soloJa]);
            const trio = await newSeries(ed, 'Kern Trio DE');
            const trioEn = (await ed('POST', `/mangas/${trio}/editions`, { language: 'en' })).body.id;
            const trioFr = (await ed('POST', `/mangas/${trio}/editions`, { language: 'fr' })).body.id;
            await ed('PUT', `/mangas/${trio}/work`, { link_to: null });
            const trioJa = (await ed('POST', `/mangas/${trio}/editions`, { language: 'ja' })).body.id;
            assert.deepEqual((await vis('GET', `/mangas/${trio}`)).body.editions.map(e => e.id), [trioJa], 'the old partners stay apart');
            assert.deepEqual((await vis('GET', `/mangas/${trioEn}`)).body.editions.map(e => e.id), [trioFr]);
            const relinked = await ed('PUT', `/mangas/${soloEn}/work`, { link_to: ja });
            assert.deepEqual(relinked.body.editions.map(e => e.id).sort((a, b) => a - b), [de, ja].sort((a, b) => a - b), 'only the picked group');

            const vol = await newVolume(ed, de, '1', { language: 'English', price: 7 });
            assert.equal((await vis('GET', `/mangas/${de}`)).body.volumes[0].language, 'en');
            assert.equal((await ed('PUT', `/volumes/${vol}`, { language: '' })).status, 200);
            assert.equal((await vis('GET', `/mangas/${de}`)).body.volumes[0].language, null);
            assert.equal((await ed('PUT', `/volumes/${vol}`, { language: 'Klingonisch' })).body.code, 'LANGUAGE_INVALID');
            assert.equal((await ed('PUT', `/mangas/${ja}`, { language: 'Japanisch', region: 'jp', currency: 'jpy' })).status, 200);
            const jaRow = (await vis('GET', `/mangas/${ja}`)).body;
            assert.deepEqual([jaRow.language, jaRow.region, jaRow.currency], ['ja', 'JP', 'JPY']);

            for (const [method, url, body] of [
                ['GET', `/mangas/${ja}/gaps`], ['POST', `/mangas/${ja}/sync-edition`, { edition_id: 5 }],
                ['POST', `/mangas/${ja}/batch-import-gaps`, { volume_numbers: ['1'] }], ['POST', `/mangas/${ja}/autofill-volumes`, {}],
                ['GET', `/volumes/lookup?manga_id=${ja}&volume_number=1`],
                ['POST', '/manga-passion/import', { manga_id: ja, title: 'Kern Ausgabe JA', volume_number: '2' }]
            ]) {
                const res = await ed(method, url, body);
                assert.deepEqual([res.status, res.body.code, res.body.error], [409, 'MP_LANGUAGE', 'Manga Passion kennt nur deutsche Ausgaben'], url);
            }

            await newVolume(ed, en, '1', { status: 'Fehlt', price: 12 });
            const shopping = (await vis('GET', '/shopping-list')).body;
            assert.deepEqual(shopping.other_currencies, [{ currency: 'USD', count: 1, total: 12 }]);
            const item = shopping.items.find(i => i.manga_id === en);
            assert.deepEqual([item.language, item.currency], ['en', 'USD']);
            const snap = (await ed('GET', '/offline-snapshot')).body;
            assert.deepEqual(snap.details[de].editions, (await ed('GET', `/mangas/${de}`)).body.editions);
            assert.equal(snap.mangas.find(m => m.id === ja).currency, 'JPY');
            const stats = (await vis('GET', '/stats')).body;
            assert.ok(stats.languages.some(l => l.language === 'ja' && l.series >= 1));
            assert.ok(stats.currencies.some(c => c.currency === 'USD' && c.missing_value === 12));
            assert.equal(stats.currencies[0].currency, 'EUR');
        }
    },
    {
        name: 'webtoons: format, own chapter progress, Manga Passion off, trash',
        async run({ admin, ed, vis }) {
            assert.equal((await ed('POST', '/mangas', { title: 'Kern Webtoon X', format: 'scroll' })).body.error, 'Ungültiges Format (erlaubt: print, webtoon)');
            const badTotal = await ed('POST', '/mangas', { title: 'Kern Webtoon X', total_chapters: 'viele' });
            assert.deepEqual([badTotal.status, badTotal.body.error], [400, 'Gesamtkapitel muss eine ganze Zahl zwischen 1 und 99999 sein']);
            const id = await newSeries(ed, 'Kern Webtoon', { format: 'Webtoon', total_chapters: '200', manga_passion_id: 77 });
            const row = (await ed('GET', '/mangas')).body.find(m => m.id === id);
            assert.deepEqual([row.format, row.total_chapters, row.chapters_read], ['webtoon', 200, 0]);
            const fresh = (await ed('GET', `/mangas/${id}`)).body;
            assert.deepEqual([fresh.manga_passion_id, fresh.chapters_read, fresh.chapter_progress], [null, 0, []], 'Manga Passion knows no webtoons');

            const chapters = (body, api = ed) => api('PUT', `/mangas/${id}/chapters`, body);
            assert.deepEqual((await chapters({ add: 1 })).body, { success: true, manga_id: id, chapters_read: 1, previous: 0, total_chapters: 200 });
            assert.deepEqual([(await chapters({ chapters_read: 150 })).body.chapters_read, (await chapters({ chapters_read: 120, monotonic: true })).body.chapters_read], [150, 150]);
            const above = await chapters({ chapters_read: 201 });
            assert.deepEqual([above.status, above.body.code, above.body.total_chapters, above.body.error],
                [400, 'CHAPTER_ABOVE_TOTAL', 200, 'Kapitel 201 gibt es bei dieser Reihe nicht (sie hat 200 Kapitel).']);
            for (const body of [{}, { chapters_read: 1, add: 1 }, { add: 0 }, { chapters_read: -1 }, { chapters_read: 'drei' }]) {
                assert.equal((await chapters(body)).status, 400, JSON.stringify(body));
            }
            assert.equal((await chapters({ add: 1 }, vis)).status, 403);
            assert.equal((await ed('PUT', '/mangas/999999/chapters', { add: 1 })).status, 404);
            assert.equal((await chapters({ chapters_read: 10 }, admin)).body.chapters_read, 10, 'everyone has their own chapter');
            const detail = (await vis('GET', `/mangas/${id}`)).body;
            assert.deepEqual(detail.chapter_progress.map(p => [p.username, p.chapters_read]).sort(), [['admin', 10], ['ed', 150]]);
            assert.equal(detail.chapters_read, 0, 'the visitor has read nothing');
            assert.equal((await ed('GET', '/mangas')).body.find(m => m.id === id).chapters_read, 150);
            assert.equal((await ed('GET', '/offline-snapshot')).body.details[id].chapters_read, 150);

            // a total lowered below a stored chapter: going down stays possible, going up does not
            assert.equal((await ed('PUT', `/mangas/${id}`, { total_chapters: 100 })).status, 200);
            assert.equal((await chapters({ chapters_read: 140 })).body.chapters_read, 140);
            assert.equal((await chapters({ add: 1 })).body.code, 'CHAPTER_ABOVE_TOTAL');
            assert.deepEqual((await ed('GET', '/stats/reading')).body.chapters, { series: 1, read: 140, finished: 1 });
            assert.deepEqual((await chapters({ chapters_read: 0 })).body.previous, 140);
            assert.deepEqual((await ed('GET', `/mangas/${id}`)).body.chapter_progress.map(p => p.username), ['admin'], '0 removes the row');

            for (const [method, url, body] of [
                ['GET', `/mangas/${id}/gaps`], ['POST', `/mangas/${id}/autofill-volumes`, {}], ['GET', `/volumes/lookup?manga_id=${id}&volume_number=1`]
            ]) {
                const res = await ed(method, url, body);
                assert.deepEqual([res.status, res.body.code], [409, 'MP_WEBTOON'], url);
            }

            await chapters({ chapters_read: 50 });
            const trashed = (await ed('DELETE', `/mangas/${id}`)).body.trash_id;
            assert.equal((await ed('PUT', `/mangas/${id}/chapters`, { add: 1 })).status, 404);
            assert.equal((await ed('POST', `/trash/${trashed}/restore`)).status, 200);
            const back = (await ed('GET', `/mangas/${id}`)).body;
            assert.deepEqual([back.format, back.total_chapters, back.chapters_read, back.chapter_progress.length], ['webtoon', 100, 50, 2]);
            assert.equal((await ed('PUT', `/mangas/${id}`, { format: 'print' })).status, 200);
            assert.equal((await ed('GET', `/mangas/${id}`)).body.format, 'print');
        }
    },
    {
        name: 'anime linked to the work: each shelf sees its own edition and links on its own, a foreign link stays hidden, the work outlives the series',
        async run({ admin, ed, vis }) {
            const work = 'anilist:990001';
            const shelfOf = async (api, name) => {
                const res = await api('POST', '/shelves', { name });
                assert.equal(res.status, 201, JSON.stringify(res.body));
                return res.body.id;
            };
            const edShelf = await shelfOf(ed, 'Kern Werk Regal Ed');
            const adminShelf = await shelfOf(admin, 'Kern Werk Regal Admin');
            const edSeries = await newSeries(ed, 'Kern Werk Ed', { work_key: work, shelf_id: edShelf });
            const adminEn = await newSeries(admin, 'Kern Werk Admin EN', { work_key: work, shelf_id: adminShelf, language: 'en' });
            const adminDe = await newSeries(admin, 'Kern Werk Admin DE', { work_key: work, shelf_id: adminShelf, language: 'de' });
            assert.ok(adminEn < adminDe);
            // one work with a numeric id for every edition that shares the key, in the list and the detail
            const rows = (await admin('GET', '/mangas')).body.filter((m) => [adminEn, adminDe].includes(m.id));
            assert.equal(rows.length, 2);
            assert.ok(Number.isInteger(rows[0].work_id) && rows[0].work_id === rows[1].work_id, JSON.stringify(rows.map((m) => m.work_id)));
            assert.equal((await ed('GET', `/mangas/${edSeries}`)).body.work_id, rows[0].work_id);

            const created = await ed('POST', '/anime', { title: 'Kern Werk Anime', episodes: 12, manga_id: edSeries });
            assert.equal(created.status, 201, JSON.stringify(created.body));
            const id = created.body.id;
            const fields = (answer) => Object.fromEntries(Object.entries(answer).filter(([key]) => key.startsWith('manga')));
            const listed = async (api) => fields((await api('GET', '/anime')).body.find((a) => a.id === id));
            const detail = async (api) => fields((await api('GET', `/anime/${id}`)).body);

            // the link names the work: the shelf that linked sees its edition, everyone else their own edition of the work
            assert.deepEqual(await listed(ed), { manga_id: edSeries });
            assert.deepEqual(await detail(ed), { manga_id: edSeries, manga: { id: edSeries, title: 'Kern Werk Ed' } });
            assert.deepEqual(await listed(admin), { manga_id: adminDe }, 'their default language before the lower id');
            assert.deepEqual(await detail(admin), { manga_id: adminDe, manga: { id: adminDe, title: 'Kern Werk Admin DE' } });
            assert.doesNotMatch(JSON.stringify((await admin('GET', `/anime/${id}`)).body), /Kern Werk Ed/);
            // no edition in a shelf of their own: nothing, not even a hint
            assert.deepEqual(await listed(vis), { manga_id: null });
            assert.deepEqual(await detail(vis), { manga_id: null, manga: null });

            // each shelf decides for itself: unlinking hides the link there, linking pins that edition there
            assert.equal((await admin('PUT', `/anime/${id}`, { manga_id: null })).status, 200);
            assert.deepEqual(await listed(admin), { manga_id: null });
            assert.deepEqual(await listed(ed), { manga_id: edSeries }, 'the other shelf keeps its link');
            const pinned = await admin('PUT', `/anime/${id}`, { manga_id: adminEn });
            assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
            assert.deepEqual(fields(pinned.body), { manga_id: adminEn, manga: { id: adminEn, title: 'Kern Werk Admin EN' } }, 'the edition picked, not the default language');
            assert.deepEqual(await listed(ed), { manga_id: edSeries });
            assert.equal((await admin('PUT', `/anime/${id}`, { manga_id: edSeries })).status, 404, 'a series of a foreign shelf cannot be linked');

            // the linked series goes: its shelf sees nothing, the work still links the other editions
            const trashed = await ed('DELETE', `/mangas/${edSeries}`);
            assert.equal(trashed.status, 200);
            assert.deepEqual(await listed(ed), { manga_id: null });
            assert.deepEqual(await listed(admin), { manga_id: adminEn });
            // "Keine Verknüpfung" from a caller who sees none changes nothing
            assert.equal((await ed('PUT', `/anime/${id}`, { manga_id: null })).status, 200);
            assert.deepEqual(await listed(admin), { manga_id: adminEn });
            // every edition of the work is in the caller's shelves now: unlinking takes the link away for everyone
            const unlinked = await admin('PUT', `/anime/${id}`, { manga_id: null });
            assert.equal(unlinked.status, 200, JSON.stringify(unlinked.body));
            assert.deepEqual(fields(unlinked.body), { manga_id: null, manga: null });
            assert.deepEqual(await listed(admin), { manga_id: null });
            const relinked = await admin('PUT', `/anime/${id}`, { manga_id: adminEn });
            assert.equal(relinked.status, 200, JSON.stringify(relinked.body));
            assert.deepEqual(fields(relinked.body), { manga_id: adminEn, manga: { id: adminEn, title: 'Kern Werk Admin EN' } });
            // the restored series is an edition of the work again, its shelf sees the link
            assert.equal((await ed('POST', `/trash/${trashed.body.trash_id}/restore`)).status, 200);
            assert.deepEqual(await listed(ed), { manga_id: edSeries });
            assert.equal((await admin('DELETE', `/anime/${id}`)).status, 200);
        }
    },
    {
        name: 'catalog overlay: alone with an edition a shelf writes the catalog, a shared edition keeps changes local, catalog changes reach every row that did not set the field, reset, and nothing tells about a shelf the caller does not belong to',
        async run({ admin, ed, run }) {
            const shelfOf = async (api, name) => {
                const res = await api('POST', '/shelves', { name });
                assert.equal(res.status, 201, JSON.stringify(res.body));
                return res.body.id;
            };
            const detail = async (api, id) => (await api('GET', `/mangas/${id}`)).body;
            const flags = (d) => [d.catalog.editable, d.catalog.resettable, d.catalog.local_fields];
            const entryOf = (table, id) => `(SELECT ${table === 'mangas' ? 'catalog_series_id' : 'catalog_volume_id'} FROM ${table} WHERE id = ${Number(id)})`;
            const edShelf = await shelfOf(ed, 'Kern Katalog Regal Ed');
            const adminShelf = await shelfOf(admin, 'Kern Katalog Regal Admin');

            const edId = await newSeries(ed, 'Kern Katalog Reihe', { publisher: 'Kern Katalog Verlag', description: 'Text von Ed', shelf_id: edShelf });
            let mine = await detail(ed, edId);
            assert.deepEqual(flags(mine), [true, true, []]);
            assert.deepEqual(Object.keys(mine.catalog).sort(), ['editable', 'local_fields', 'resettable'], 'no catalog id');
            assert.equal('local_fields' in mine, false);
            // alone with the edition: the change goes to the catalog (and the catalog keeps matching the new title)
            assert.equal((await ed('PUT', `/mangas/${edId}`, { title: 'Kern Katalog Reihe Neu' })).status, 200);
            mine = await detail(ed, edId);
            assert.deepEqual([mine.title, mine.catalog.local_fields], ['Kern Katalog Reihe Neu', []]);

            // the same edition in a shelf ed does not belong to: one catalog entry, no text of ed's shelf shows up, and
            // neither answer tells that the other shelf exists
            const adminId = await newSeries(admin, 'Kern Katalog Reihe Neu', { publisher: 'Kern Katalog Verlag', shelf_id: adminShelf });
            let theirs = await detail(admin, adminId);
            assert.equal(theirs.description, null);
            assert.deepEqual(flags(theirs), [true, true, []]);
            assert.deepEqual(flags(await detail(ed, edId)), [true, true, []]);

            // shared: a change stays in the shelf that made it
            assert.equal((await ed('PUT', `/mangas/${edId}`, { author: 'Autorin Ed' })).status, 200);
            mine = await detail(ed, edId);
            assert.deepEqual([mine.author, mine.catalog.local_fields], ['Autorin Ed', []]);
            assert.equal((await detail(admin, adminId)).author, null);

            // a catalog change (as a source writes it) reaches every row that did not set the field itself
            run(`UPDATE catalog_series SET total_volumes = 21, author = ?, source_fields = '["author","total_volumes"]' WHERE id = ${entryOf('mangas', edId)}`, 'Kern Quelle');
            mine = await detail(ed, edId);
            theirs = await detail(admin, adminId);
            assert.deepEqual([mine.total_volumes, mine.author], [21, 'Autorin Ed']);
            assert.deepEqual([theirs.total_volumes, theirs.author], [21, 'Kern Quelle']);

            // a reset takes nothing while the entry has a row in a shelf the caller does not see (its values may come
            // from there), and answers as for an entry without local fields
            for (const [api, id] of [[ed, edId], [admin, adminId]]) {
                const quiet = await api('POST', `/mangas/${id}/catalog-reset`, {});
                assert.deepEqual([quiet.status, quiet.body.local_fields], [200, []], JSON.stringify(quiet.body));
            }
            assert.equal((await detail(ed, edId)).author, 'Autorin Ed');
            assert.equal((await ed('POST', `/mangas/${edId}/catalog-reset`, { fields: ['shelf_id'] })).status, 400);

            // volumes follow the same rule (the detail names no local fields of a volume)
            const edVol = await newVolume(ed, edId, '1', { pages: 180 });
            const adminVol = await newVolume(admin, adminId, '1');
            const volumeOf = async (api, mangaId, id) => (await detail(api, mangaId)).volumes.find((v) => v.id === id);
            let theirVol = await volumeOf(admin, adminId, adminVol);
            assert.deepEqual([theirVol.pages, 'local_fields' in theirVol], [null, false]);
            assert.equal((await admin('PUT', `/volumes/${adminVol}`, { pages: 200 })).status, 200);
            assert.equal((await volumeOf(ed, edId, edVol)).pages, 180, 'a shared volume keeps the change in its shelf');
            run(`UPDATE catalog_volumes SET release_date = '2026-01-02' WHERE id = ${entryOf('volumes', edVol)}`);
            theirVol = await volumeOf(admin, adminId, adminVol);
            assert.deepEqual([theirVol.release_date, theirVol.pages], ['2026-01-02', 200]);
            assert.equal((await volumeOf(ed, edId, edVol)).release_date, '2026-01-02');
            const quietVol = await admin('POST', `/volumes/${adminVol}/catalog-reset`, {});
            assert.deepEqual([quietVol.status, quietVol.body.local_fields], [200, []]);
            assert.equal((await volumeOf(admin, adminId, adminVol)).pages, 200);

            // once ed reads the other shelf, it is no secret any more: ed's edit form says a change stays local, and the
            // local fields show
            assert.equal((await admin('POST', `/shelves/${adminShelf}/members`, { username: 'ed', role: 'viewer' })).status, 201);
            assert.deepEqual(flags(await detail(ed, edId)), [false, true, ['author']]);
            assert.deepEqual(flags(await detail(admin, adminId)), [true, true, []], 'the admin still does not belong to ed\'s shelf');
            assert.equal((await admin('DELETE', `/shelves/${adminShelf}/members/2`)).status, 200);

            // alone again: the shelf sees its own values and may take the catalog values back
            assert.equal((await admin('DELETE', `/mangas/${adminId}`)).status, 200);
            mine = await detail(ed, edId);
            assert.deepEqual(flags(mine), [true, true, ['author']]);
            const reset = await ed('POST', `/mangas/${edId}/catalog-reset`, { fields: ['author'] });
            assert.equal(reset.status, 200, JSON.stringify(reset.body));
            assert.deepEqual(reset.body.local_fields, []);
            assert.equal((await detail(ed, edId)).author, 'Kern Quelle');

            // a value a shelf wrote is never offered back, not even once that shelf is gone: ed writes a text alone (it
            // goes to the catalog), the admin joins, ed leaves; the admin's reset takes nothing of ed's
            assert.equal((await ed('PUT', `/mangas/${edId}`, { description: 'Geheimtext von Ed' })).status, 200);
            const joinId = await newSeries(admin, 'Kern Katalog Reihe Neu', { publisher: 'Kern Katalog Verlag', shelf_id: adminShelf });
            assert.equal((await ed('DELETE', `/mangas/${edId}`)).status, 200);
            // only the source values are offered (author and volume count), never ed's text
            assert.deepEqual(flags(await detail(admin, joinId)), [true, true, ['author', 'total_volumes']]);
            assert.deepEqual((await admin('POST', `/mangas/${joinId}/catalog-reset`, {})).body.local_fields, []);
            const joined = await detail(admin, joinId);
            assert.deepEqual([joined.description, joined.author, joined.total_volumes], [null, 'Kern Quelle', 21]);
            assert.equal((await admin('DELETE', `/mangas/${joinId}`)).status, 200);

            // an entry nobody shows any more takes the values of the next holder: nothing of the series deleted before stays
            const orphan = await newSeries(ed, 'Kern Katalog Waise', { description: 'Text der Waise', author: 'Autorin Waise', shelf_id: edShelf });
            assert.equal((await ed('DELETE', `/mangas/${orphan}`)).status, 200);
            const heir = await newSeries(admin, 'Kern Katalog Waise', { shelf_id: adminShelf });
            const heirDetail = await detail(admin, heir);
            assert.deepEqual([heirDetail.description, heirDetail.author, heirDetail.catalog.local_fields], [null, null, []]);
            // the catalog entry itself holds the heir's values (an update that matches only such a row changes one)
            assert.equal(Number(run(`UPDATE catalog_series SET pub_status = pub_status WHERE id = ${entryOf('mangas', heir)} AND description IS NULL AND author IS NULL`).changes), 1);
            assert.equal((await admin('DELETE', `/mangas/${heir}`)).status, 200);
        }
    },
    {
        name: 'catalog copy: a series and its volumes from another own shelf, never anything of a shelf the caller does not belong to',
        async run({ admin, ed }) {
            const shelfOf = async (api, name) => {
                const res = await api('POST', '/shelves', { name });
                assert.equal(res.status, 201, JSON.stringify(res.body));
                return res.body.id;
            };
            const detail = async (api, id) => (await api('GET', `/mangas/${id}`)).body;
            const shelfA = await shelfOf(ed, 'Kern Kopie A');
            const shelfB = await shelfOf(ed, 'Kern Kopie B');
            const adminShelf = await shelfOf(admin, 'Kern Kopie Fremd');
            const sourceId = await newSeries(ed, 'Kern Kopie Reihe', {
                publisher: 'Kern Kopie Verlag', description: 'Text von Ed', author: 'Autorin Kopie', total_volumes: 9, wish_priority: 2, shelf_id: shelfA,
                work_key: 'anilist:990077'
            });
            await newVolume(ed, sourceId, '1', { pages: 180, isbn: '9783551000002', status: 'Vorhanden' });
            await newVolume(ed, sourceId, '2', { notes: 'meine Notiz' });
            await newVolume(ed, sourceId, '3', { status: 'Erscheint bald', release_date: '2027-03' });
            const foreignId = await newSeries(admin, 'Kern Kopie Reihe Fremd', { description: 'Text von Admin', shelf_id: adminShelf });

            // the search sees ed's own shelves only and leaves out what the target shelf already holds
            const search = async (q, shelfId) => (await ed('GET', `/mangas/copy-candidates?q=${encodeURIComponent(q)}&shelf_id=${shelfId}`)).body;
            let found = await search('kern kopie', shelfB);
            assert.deepEqual(found.results.map(r => [r.id, r.shelf_id, r.shelf_name, r.volume_count]), [[sourceId, shelfA, 'Kern Kopie A', 3]]);
            assert.equal('catalog_series_id' in found.results[0], false, 'no catalog id');
            assert.deepEqual((await search('kern kopie', shelfA)).results, []);
            assert.deepEqual((await search('k', shelfB)).results, [], 'too short');
            assert.equal((await ed('GET', `/mangas/copy-candidates?q=kern&shelf_id=${adminShelf}`)).status, 404, 'a foreign target shelf');
            assert.ok(!(await admin('GET', `/mangas/copy-candidates?q=kern%20kopie&shelf_id=${adminShelf}`)).body.results.some(r => r.id === sourceId));

            // the copy: ed's values, no wish, every volume missing (an announced one stays announced), nothing per person
            assert.equal((await ed('POST', '/mangas/copy', { from: foreignId, shelf_id: shelfB })).status, 404);
            assert.equal((await ed('POST', '/mangas/copy', { from: sourceId, shelf_id: adminShelf })).status, 404);
            assert.equal((await ed('POST', '/mangas/copy', { from: sourceId, shelf_id: shelfB, volumes: 'ja' })).status, 400);
            const copied = await ed('POST', '/mangas/copy', { from: sourceId, shelf_id: shelfB, volumes: true });
            assert.equal(copied.status, 201, JSON.stringify(copied.body));
            assert.deepEqual([copied.body.shelf_id, copied.body.volumes_created], [shelfB, 3]);
            const copy = await detail(ed, copied.body.id);
            assert.deepEqual([copy.title, copy.description, copy.author, copy.total_volumes, copy.wish_priority, copy.shelf_id],
                ['Kern Kopie Reihe', 'Text von Ed', 'Autorin Kopie', 9, null, shelfB]);
            assert.deepEqual(copy.volumes.map(v => [v.volume_number, v.status, v.pages, v.notes, v.owners.length]),
                [['1', 'Fehlt', 180, null, 0], ['2', 'Fehlt', null, null, 0], ['3', 'Erscheint bald', null, null, 0]]);
            assert.deepEqual(copy.catalog.local_fields, []);
            // scanning the ISBN matches the missing copy in shelf B rather than the already-owned copy in shelf A
            const isbnScan = await ed('GET', '/lookup/isbn?isbn=9783551000002');
            assert.equal(isbnScan.status, 200);
            assert.deepEqual([isbnScan.body.matched_manga.id, isbnScan.body.matched_volume.status], [copied.body.id, 'Fehlt']);
            // the same edition in another shelf is no other edition; an English edition of the work is one for both rows
            assert.deepEqual([copy.editions, (await detail(ed, sourceId)).editions], [[], []]);
            const english = await ed('POST', `/mangas/${sourceId}/editions`, { language: 'en' });
            assert.equal(english.status, 201, JSON.stringify(english.body));
            assert.deepEqual((await detail(ed, copied.body.id)).editions.map(e => [e.id, e.language]), [[english.body.id, 'en']]);
            assert.deepEqual((await detail(ed, sourceId)).editions.map(e => e.id), [english.body.id]);
            assert.equal('catalog_series_id' in (await detail(ed, sourceId)).editions[0], false);
            // shelf B holds the German edition now: only the English one is still offered
            assert.deepEqual((await search('kern kopie', shelfB)).results.map(r => [r.id, r.language]), [[english.body.id, 'en']]);
            assert.equal((await ed('POST', '/mangas/copy', { from: sourceId, shelf_id: shelfB })).body.code, 'COPY_EXISTS');
            assert.equal((await ed('POST', '/mangas/copy', { from: copied.body.id, shelf_id: shelfB })).status, 409);

            // both rows are ed's: an edit of one reaches the other through the catalog
            assert.equal((await ed('PUT', `/mangas/${sourceId}`, { description: 'Neuer Text' })).status, 200);
            assert.equal((await detail(ed, copied.body.id)).description, 'Neuer Text');

            // volumes the copy lacks, from the other row of the same edition
            const sources = async (id) => (await ed('GET', `/mangas/${id}/volume-sources`)).body.sources;
            assert.deepEqual(await sources(copied.body.id), []);
            await newVolume(ed, sourceId, '4');
            await newVolume(ed, sourceId, 'Artbook', { type: 'special' });
            let offered = await sources(copied.body.id);
            assert.deepEqual(offered.map(s => [s.manga_id, s.shelf_name, s.volumes.map(v => v.volume_number)]), [[sourceId, 'Kern Kopie A', ['4', 'Artbook']]]);
            assert.equal((await ed('POST', `/mangas/${copied.body.id}/volumes/copy`, { from: foreignId })).status, 404);
            assert.equal((await ed('POST', `/mangas/${copied.body.id}/volumes/copy`, { from: sourceId, volume_ids: 'x' })).status, 400);
            const one = await ed('POST', `/mangas/${copied.body.id}/volumes/copy`, { from: sourceId, volume_ids: [offered[0].volumes[1].id] });
            assert.equal(one.status, 200, JSON.stringify(one.body));
            assert.equal(one.body.created.length, 1);
            offered = await sources(copied.body.id);
            assert.deepEqual(offered[0].volumes.map(v => v.volume_number), ['4']);
            assert.equal((await ed('POST', `/mangas/${copied.body.id}/volumes/copy`, { from: sourceId })).body.created.length, 1);
            assert.deepEqual(await sources(copied.body.id), []);
            assert.equal((await ed('POST', `/mangas/${copied.body.id}/volumes/copy`, { from: sourceId })).status, 400);
            // the source also lacks nothing now that the copy has the same volumes
            assert.deepEqual(await sources(sourceId), []);
            assert.equal((await admin('GET', `/mangas/${copied.body.id}/volume-sources`)).status, 404);
        }
    },
    {
        name: 'copies: price, date and condition per copy, lending to an account or a person, the lent list, and the trash keeps it',
        async run({ admin, ed, run }) {
            const shelf = (await ed('POST', '/shelves', { name: 'Kern Exemplar Regal' })).body.id;
            const ids = Object.fromEntries((await ed('GET', '/users/directory')).body.users.map(u => [u.username, u.id]));
            const series = await newSeries(ed, 'Kern Exemplar Reihe', { shelf_id: shelf });
            const volumeId = await newVolume(ed, series, '1', { status: 'Vorhanden', price: 7 });
            const copiesOf = async () => (await ed('GET', `/mangas/${series}`)).body.volumes.find(v => v.id === volumeId).copies;
            let [copy] = await copiesOf();
            assert.deepEqual({ ...copy, id: 0 }, {
                id: 0, owner_user_id: ids.ed, owner: 'ed', price: 7, purchase_date: null, condition: null,
                lent_to_user_id: null, lent_to: null, lent_at: null
            });
            const put = (api, body, id = copy.id) => api('PUT', `/volumes/${volumeId}/copies/${id}`, body);

            let res = await put(ed, { price: '6,50', purchase_date: '2025-03-01', condition: 'Gut' });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual([res.body.copy.price, res.body.copy.purchase_date, res.body.copy.condition], [6.5, '2025-03-01', 'Gut']);
            assert.equal((await put(ed, { price: 'viel' })).status, 400);

            res = await put(ed, { lent: { user_id: ids.admin, at: '2026-01-02' } });
            assert.deepEqual([res.body.copy.lent_to_user_id, res.body.copy.lent_to, res.body.copy.lent_at], [ids.admin, 'admin', '2026-01-02']);
            assert.equal((await put(ed, { lent: { user_id: ids.ed } })).status, 400, 'not to the owner');
            assert.equal((await put(admin, { price: 1 })).status, 404, 'admin is no member of the shelf');
            assert.equal((await put(ed, { price: 1 }, copy.id + 999)).status, 404);

            const lentOut = (await ed('GET', '/copies/lent')).body;
            assert.deepEqual(lentOut.lent_out.map(c => [c.copy_id, c.title, c.lent_to, c.manga_id]), [[copy.id, 'Kern Exemplar Reihe', 'admin', series]]);
            const borrowed = (await admin('GET', '/copies/lent')).body.borrowed;
            assert.deepEqual(borrowed.map(c => [c.title, c.volume_number, c.owner, c.manga_id, c.shelf_name]), [['Kern Exemplar Reihe', '1', 'ed', null, null]],
                'admin sees what was lent to him, without a way into a shelf he does not belong to');

            // a volume in the trash comes back with its lent copy
            const trashId = (await ed('DELETE', `/volumes/${volumeId}`)).body.trash_id;
            assert.equal((await ed('POST', `/trash/${trashId}/restore`)).status, 200);
            [copy] = await copiesOf();
            assert.deepEqual([copy.owner, copy.price, copy.condition, copy.lent_to, copy.lent_at], ['ed', 6.5, 'Gut', 'admin', '2026-01-02']);

            // a bulk edit undo and an owner toggle undo keep the copy's lending and condition
            const bulkRes = await ed('POST', '/volumes/bulk', { ids: [volumeId], set: { status: 'Fehlt' } });
            assert.equal(bulkRes.status, 200, JSON.stringify(bulkRes.body));
            assert.equal((await ed('POST', '/volumes/bulk', { revert: bulkRes.body.undo_token })).status, 200);
            [copy] = await copiesOf();
            assert.deepEqual([copy.owner, copy.price, copy.condition, copy.lent_to, copy.lent_at], ['ed', 6.5, 'Gut', 'admin', '2026-01-02']);

            const unown = await ed('POST', `/volumes/${volumeId}/owners`, { owned: false });
            assert.equal(unown.status, 200);
            assert.deepEqual([unown.body.removed_owner.condition, unown.body.removed_owner.lent_to_user_id, unown.body.removed_owner.lent_at], ['Gut', ids.admin, '2026-01-02']);
            assert.equal((await ed('POST', `/volumes/${volumeId}/owners`, {
                owned: true, price: unown.body.removed_owner.price, purchase_date: unown.body.removed_owner.purchase_date,
                condition: unown.body.removed_owner.condition, lent: { user_id: unown.body.removed_owner.lent_to_user_id, at: unown.body.removed_owner.lent_at }
            })).status, 200);
            [copy] = await copiesOf();
            assert.deepEqual([copy.owner, copy.price, copy.condition, copy.lent_to, copy.lent_at], ['ed', 6.5, 'Gut', 'admin', '2026-01-02']);

            // ?shelf_id narrows lent_out to that shelf
            const emptyShelf = (await ed('POST', '/shelves', { name: 'Kern Exemplar Leer' })).body.id;
            assert.equal((await ed('GET', `/copies/lent?shelf_id=${shelf}`)).body.lent_out.length, 1);
            assert.deepEqual((await ed('GET', `/copies/lent?shelf_id=${emptyShelf}`)).body.lent_out, []);

            // claiming a household copy via POST /volumes/:id/owners keeps its price, condition and lending
            const hhVol = await newVolume(ed, series, '2', { status: 'Fehlt' });
            run("UPDATE volumes SET status = 'Vorhanden' WHERE id = ?", hhVol);
            const [hhCopy] = (await ed('GET', `/mangas/${series}`)).body.volumes.find(v => v.id === hhVol).copies;
            assert.equal(hhCopy.owner_user_id, null);
            assert.equal((await ed('PUT', `/volumes/${hhVol}/copies/${hhCopy.id}`, {
                price: '12,00', purchase_date: '2025-05-05', condition: 'Sehr gut', lent: { name: 'Opa Karl', at: '2026-02-01' }
            })).status, 200);
            assert.equal((await ed('POST', `/volumes/${hhVol}/owners`, {})).status, 200);
            const [claimedCopy] = (await ed('GET', `/mangas/${series}`)).body.volumes.find(v => v.id === hhVol).copies;
            assert.deepEqual([claimedCopy.owner, claimedCopy.price, claimedCopy.purchase_date, claimedCopy.condition, claimedCopy.lent_to, claimedCopy.lent_at],
                ['ed', 12, '2025-05-05', 'Sehr gut', 'Opa Karl', '2026-02-01']);

            res = await put(ed, { lent: { name: 'Oma Erika' } });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual([res.body.copy.lent_to_user_id, res.body.copy.lent_to, /^\d{4}-\d{2}-\d{2}$/.test(res.body.copy.lent_at)], [null, 'Oma Erika', true]);
            assert.equal((await put(ed, { lent: { name: 'x'.repeat(65) } })).status, 400);
            res = await put(ed, { lent: null });
            assert.deepEqual([res.body.copy.lent_to, res.body.copy.lent_at], [null, null]);
            assert.deepEqual((await admin('GET', '/copies/lent')).body.borrowed, []);
        }
    },
    {
        name: 'owned elsewhere: the shopping list and the ISBN lookup warn about an edition volume owned or ordered in another own shelf, never in a foreign one',
        async run({ admin, ed }) {
            const shelfOf = async (api, name) => {
                const res = await api('POST', '/shelves', { name });
                assert.equal(res.status, 201, JSON.stringify(res.body));
                return res.body.id;
            };
            const shelfA = await shelfOf(ed, 'Kern Doppelt A');
            const shelfB = await shelfOf(ed, 'Kern Doppelt B');
            const foreign = await shelfOf(admin, 'Kern Doppelt Fremd');
            const fields = { publisher: 'Kern Doppelt Verlag' };
            const inA = await newSeries(ed, 'Kern Doppelt Reihe', { ...fields, shelf_id: shelfA });
            const inB = await newSeries(ed, 'Kern Doppelt Reihe', { ...fields, shelf_id: shelfB });
            const inForeign = await newSeries(admin, 'Kern Doppelt Reihe', { ...fields, shelf_id: foreign });
            const a1 = await newVolume(ed, inA, '1', { isbn: '9783551000019', status: 'Fehlt' });
            const a2 = await newVolume(ed, inA, '2', { status: 'Fehlt' });
            const a3 = await newVolume(ed, inA, '3', { status: 'Fehlt' });
            await newVolume(ed, inB, '1', { status: 'Vorhanden' });
            await newVolume(ed, inB, '2', { status: 'Vorbestellt' });
            await newVolume(admin, inForeign, '3', { status: 'Vorhanden' });

            const list = await ed('GET', `/shopping-list?shelf_id=${shelfA}`);
            assert.equal(list.status, 200);
            const item = (id) => list.body.items.find(i => i.id === id);
            assert.deepEqual(item(a1).owned_elsewhere, [{ shelf_id: shelfB, shelf_name: 'Kern Doppelt B', status: 'owned', owners: ['ed'] }]);
            assert.deepEqual(item(a2).owned_elsewhere, [{ shelf_id: shelfB, shelf_name: 'Kern Doppelt B', status: 'ordered', owners: [] }]);
            assert.equal('owned_elsewhere' in item(a3), false, "volume 3 is owned only in admin's shelf, which ed does not see");

            const scan = await ed('GET', '/lookup/isbn?isbn=9783551000019');
            assert.equal(scan.status, 200, JSON.stringify(scan.body));
            assert.equal(scan.body.matched_volume.id, a1);
            assert.deepEqual(scan.body.matched_volume.owned_elsewhere, [{ shelf_id: shelfB, shelf_name: 'Kern Doppelt B', status: 'owned', owners: ['ed'] }]);
            assert.equal(JSON.stringify((await ed('GET', '/shopping-list')).body).includes('Kern Doppelt Fremd'), false);
        }
    },
    {
        name: 'todo: gaps, overdue orders and volumes owned in another own shelf, one entry per series and kind',
        async run({ admin, ed }) {
            const shelfOf = async (api, name) => {
                const res = await api('POST', '/shelves', { name });
                assert.equal(res.status, 201, JSON.stringify(res.body));
                return res.body.id;
            };
            const shelfA = await shelfOf(ed, 'Kern Todo A');
            const shelfB = await shelfOf(ed, 'Kern Todo B');
            const foreign = await shelfOf(admin, 'Kern Todo Fremd');
            const fields = { publisher: 'Kern Todo Verlag' };
            const inA = await newSeries(ed, 'Kern Todo Reihe', { ...fields, shelf_id: shelfA });
            const inB = await newSeries(ed, 'Kern Todo Reihe', { ...fields, shelf_id: shelfB });
            const inForeign = await newSeries(admin, 'Kern Todo Reihe', { ...fields, shelf_id: foreign });
            await newVolume(ed, inA, '1', { status: 'Vorhanden' });
            await newVolume(ed, inA, '2', { status: 'Fehlt' });
            await newVolume(ed, inA, '3', { status: 'Fehlt' });
            await newVolume(ed, inA, '4', { status: 'Fehlt' });
            await newVolume(ed, inA, '5', { status: 'Vorbestellt', release_date: '2020-01-10' });
            await newVolume(ed, inA, '6', { status: 'Vorbestellt', release_date: '2999-01-10' });
            await newVolume(ed, inB, '2', { status: 'Vorhanden' });
            await newVolume(admin, inForeign, '3', { status: 'Vorhanden' });
            // a wished series without owned volumes and a dropped one are no gaps
            const wished = await newSeries(ed, 'Kern Todo Wunsch', { shelf_id: shelfA });
            await newVolume(ed, wished, '1', { status: 'Fehlt' });
            const dropped = await newSeries(ed, 'Kern Todo Abgebrochen', { shelf_id: shelfA, collecting: 'abgebrochen' });
            await newVolume(ed, dropped, '1', { status: 'Vorhanden' });
            await newVolume(ed, dropped, '2', { status: 'Fehlt' });
            // volume 1 lent out long ago is a reminder, a lending from today is not
            const owned = (await ed('GET', `/mangas/${inA}`)).body.volumes.find(v => v.volume_number === '1');
            const lend = await ed('PUT', `/volumes/${owned.id}/copies/${owned.copies[0].id}`, { lent: { name: 'Mia', at: '2020-01-01' } });
            assert.equal(lend.status, 200, JSON.stringify(lend.body));
            const recent = await newSeries(ed, 'Kern Todo Frisch', { shelf_id: shelfA });
            const fresh = await newVolume(ed, recent, '1', { status: 'Vorhanden' });
            const freshCopy = (await ed('GET', `/mangas/${recent}`)).body.volumes[0].copies[0].id;
            assert.equal((await ed('PUT', `/volumes/${fresh}/copies/${freshCopy}`, { lent: { name: 'Mia' } })).status, 200);

            const res = await ed('GET', `/todo?shelf_id=${shelfA}`);
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual(res.body.items.map(i => [i.kind, i.manga_id, i.count, i.volumes]), [
                ['elsewhere', inA, 1, ['2']],
                ['overdue', inA, 1, ['5']],
                ['lent', inA, 1, ['1']],
                ['gap', inA, 2, ['3', '4']]
            ]);
            assert.equal(res.body.items[0].shelf_name, 'Kern Todo B');
            assert.deepEqual([res.body.items[2].lent_to, res.body.items[2].lent_at], ['Mia', '2020-01-01']);
            assert.ok(res.body.items[2].days > 90);
            assert.equal(res.body.total, 4);
            assert.equal(JSON.stringify((await ed('GET', '/todo')).body).includes('Kern Todo Fremd'), false);
            assert.equal((await ed('GET', '/todo?shelf_id=' + foreign)).status, 404);
        }
    },
    {
        name: 'saved filters: own list, the same filters once, the newest 8, only own entries deleted',
        async run({ admin, ed }) {
            const f = (publisher, extra = {}) => ({ status: 'ALL', publisher, collect: 'ALL', author: '', tags: [], lang: 'ALL', shelf: 'ALL', person: 'ALL', sort: 'title_asc', group: 'none', ...extra });
            const first = await ed('POST', '/saved-filters', { label: 'Carlsen', filters: f('Carlsen', { tags: ['Action'] }) });
            assert.equal(first.status, 201, JSON.stringify(first.body));
            assert.deepEqual(first.body.items.map(i => i.label), ['Carlsen']);
            assert.deepEqual(first.body.items[0].filters.tags, ['Action']);
            assert.equal(first.body.limit, 8);
            // the same choice in another key order keeps the one entry
            const again = await ed('POST', '/saved-filters', { label: 'Anders', filters: { ...f('Carlsen', { tags: ['Action'] }), group: 'none', status: 'ALL' } });
            assert.equal(again.status, 200);
            assert.deepEqual(again.body.items.map(i => i.label), ['Carlsen']);
            // other accounts see nothing of it and cannot delete it
            assert.deepEqual((await admin('GET', '/saved-filters')).body.items, []);
            assert.equal((await admin('DELETE', `/saved-filters/${first.body.items[0].id}`)).status, 404);
            for (let i = 1; i <= 8; i++) await ed('POST', '/saved-filters', { label: `P${i}`, filters: f(`P${i}`) });
            const list = (await ed('GET', '/saved-filters')).body.items;
            assert.deepEqual(list.map(i => i.label), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']);
            const gone = await ed('DELETE', `/saved-filters/${list[0].id}`);
            assert.equal(gone.status, 200);
            assert.equal(gone.body.items.length, 7);
            assert.equal((await ed('DELETE', `/saved-filters/${list[0].id}`)).status, 404);
            assert.equal((await ed('DELETE', '/saved-filters/abc')).status, 400);
            assert.equal((await ed('POST', '/saved-filters', { label: '  ', filters: f('X') })).status, 400);
            assert.equal((await ed('POST', '/saved-filters', { label: 'X', filters: [] })).status, 400);
            assert.equal((await ed('POST', '/saved-filters', { label: 'X', filters: f('X', { tags: 'Action' }) })).status, 400);
            assert.equal((await ed('POST', '/saved-filters', { label: 'X', filters: f('X', { status: { a: 1 } }) })).status, 400);
        }
    },
    {
        name: 'roles: unknown paths, signed-out callers',
        async run({ anonymous }) {
            const res = await anonymous('GET', '/mangas');
            assert.deepEqual([res.status, res.body.code, res.body.error], [401, 'AUTH_REQUIRED', 'Nicht angemeldet']);
            assert.equal((await anonymous('POST', '/volumes', {})).status, 401);
        }
    }
];

module.exports = { scenarios };
