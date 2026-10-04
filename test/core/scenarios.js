// Handler scenarios run against both adapters (test/core/express.test.js and test/core/memory.test.js): the same
// requests, the same assertions. Each scenario works on its own series, so they can share one database.
const assert = require('node:assert/strict');

const pad = (n) => String(n).padStart(2, '0');
function monthFromNow(offset) {
    const d = new Date();
    const m = new Date(d.getFullYear(), d.getMonth() + offset, 1);
    return `${m.getFullYear()}-${pad(m.getMonth() + 1)}`;
}

// both harnesses run in this process: forgets the per-user watch-sync throttle (30 s) between steps
const watchSyncAgain = () => require('../../core/anime/gateway').state().watchSync?.clear();

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
            assert.equal((await ed('PUT', `/anime/${id}`, { notes: 'DVD' })).body.notes, 'DVD');
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
            assert.deepEqual([watched.body.previous, watched.body.entry_episodes], [null, 28]);
            const again = await ed('POST', `/anime/${id}/watched`, { episode: 3 });
            assert.deepEqual([again.body.progress.episodes_watched, again.body.previous.episodes_watched], [7, 7]);
            assert.deepEqual(resolved.body.entry, { id, title: 'Kern Frieren', episodes: 28, my_status: null, my_episodes: null });
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
            assert.deepEqual((await ed('POST', '/anime/watch-sync', lower)).body, { applied: [], unmatched: [], throttled: true });
            watchSyncAgain();
            assert.deepEqual((await ed('POST', '/anime/watch-sync', lower)).body, { applied: [], unmatched: [], unchanged: 1 });

            await ed('POST', `/anime/${other}/watched`, { episode: 2, remember: { service: 'crunchyroll', external_id: 'GKERNBUCH1', season: 1 } });
            watchSyncAgain();
            const mapped = await ed('POST', '/anime/watch-sync', { service: 'crunchyroll', items: [item({ external_id: 'GKERNBUCH1', series_title: 'Kern Verlaufsbuch', episode: 12, fully_watched: true, resume_url: null })] });
            assert.deepEqual(mapped.body, { applied: [{ anime_id: other, episodes_watched: 12, status: 'Gesehen' }], unmatched: [], unchanged: 0 });
            assert.equal((await ed('DELETE', `/anime/${id}`)).status, 200);
            assert.equal((await ed('DELETE', `/anime/${other}`)).status, 200);
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
            run('INSERT INTO app_settings (key, value) VALUES (?, ?)', `calendar_feed:${hash}`, JSON.stringify({ user_id: 2, created_at: new Date().toISOString(), last_used_at: null }));

            const feed = await anonymous.raw('GET', `/radar/feed.ics?token=${token}`);
            assert.equal(feed.status, 200);
            const type = Object.entries(feed.headers).find(([k]) => k.toLowerCase() === 'content-type')[1];
            assert.match(type, /^text\/calendar/);
            assert.ok(feed.text.startsWith('BEGIN:VCALENDAR'));
            assert.ok(feed.text.includes('Kern Reihe Kalender'));
            const wrong = await anonymous('GET', `/radar/feed.ics?token=${'B'.repeat(43)}`);
            assert.deepEqual([wrong.status, wrong.body.code], [404, 'NOT_FOUND']);
            assert.equal((await anonymous('GET', '/radar/feed.ics')).status, 404);
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
