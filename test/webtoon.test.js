// Webtoons over HTTP: the lookup suggestion of AniList and MyAnimeList, the CSV round trip of format, chapter count and
// chapter progress, the Manga Passion calendar without webtoons and the quality check.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');
const { mapAniListMedia } = require('../core/anilist');
const { mangaLookupResult } = require('../core/anime/jikan');

const PW = 'password123';
let ctx;
let admin;
let anna;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: PW })).status, 200);
    const res = await admin('POST', '/users', { username: 'anna', password: PW, role: 'editor' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    anna = ctx.client();
    assert.equal((await anna('POST', '/auth/login', { username: 'anna', password: PW })).status, 200);
});

test.after(async () => { await ctx.close(); });

const wipe = () => require('../db').db.exec('DELETE FROM chapter_progress; DELETE FROM volumes; DELETE FROM mangas; DELETE FROM trash;');
const exportCsv = async (client = admin) => (await fetch(ctx.base + '/export/csv', { headers: { Cookie: client.cookie } })).text();

test('AniList and MyAnimeList hits of Korean and Chinese comics suggest the webtoon format with their chapter count', () => {
    const base = { id: 1, title: { romaji: 'Na Honjaman Level Up', english: 'Solo Leveling' }, format: 'MANGA', status: 'FINISHED', volumes: 14, chapters: 201 };
    const korean = mapAniListMedia({ ...base, countryOfOrigin: 'KR' });
    assert.deepEqual([korean.series_format, korean.format_label, korean.total_chapters, korean.total_volumes], ['webtoon', 'Manhwa', 201, 14]);
    assert.equal(mapAniListMedia({ ...base, countryOfOrigin: 'CN' }).format_label, 'Manhua');
    const japanese = mapAniListMedia({ ...base, countryOfOrigin: 'JP', chapters: null });
    assert.deepEqual([japanese.series_format, japanese.format_label, japanese.total_chapters], [undefined, null, null]);
    assert.equal(mapAniListMedia({ ...base, format: 'NOVEL', countryOfOrigin: 'KR' }).series_format, undefined, 'a Korean novel is no webtoon');

    const mal = mangaLookupResult({ mal_id: 5, title: 'Solo Leveling', type: 'Manhwa', chapters: 201, volumes: 14 });
    assert.deepEqual([mal.series_format, mal.format_label, mal.total_chapters], ['webtoon', 'Manhwa', 201]);
    assert.equal(mangaLookupResult({ mal_id: 6, title: 'One Piece', type: 'Manga', chapters: null }).series_format, undefined);
});

test('CSV: format, chapter count and chapter progress go out and come back; the import keeps the name rules of readers', async () => {
    wipe();
    const id = (await admin('POST', '/mangas', { title: 'Webtoon Rundlauf', format: 'webtoon', total_chapters: 200 })).body.id;
    await admin('POST', '/mangas', { title: 'Druck Rundlauf' });
    await admin('PUT', `/mangas/${id}/chapters`, { chapters_read: 150 });
    await anna('PUT', `/mangas/${id}/chapters`, { chapters_read: 30 });

    const csv = await exportCsv();
    const { parseCsv } = require('../core/csvExchange');
    const [header, ...rows] = parseCsv(csv.charCodeAt(0) === 0xFEFF ? csv.slice(1) : csv);
    const cell = (row, name) => row[header.indexOf(name)];
    const webtoon = rows.find(r => cell(r, 'Reihe') === 'Webtoon Rundlauf');
    const print = rows.find(r => cell(r, 'Reihe') === 'Druck Rundlauf');
    assert.deepEqual([cell(webtoon, 'Format'), cell(webtoon, 'Gesamtkapitel'), cell(webtoon, 'Kapitel gelesen von')], ['webtoon', '200', 'admin: 150, anna: 30']);
    assert.deepEqual([cell(print, 'Format'), cell(print, 'Kapitel gelesen von')], ['', ''], 'print is the default and stays empty');

    wipe();
    const dry = await admin('POST', '/import/csv', { csv, dry_run: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.deepEqual(dry.body.warnings, []);
    assert.equal((await admin('POST', '/import/csv', { csv })).body.created_series, 2);
    const back = (await admin('GET', '/mangas')).body.find(m => m.title === 'Webtoon Rundlauf');
    assert.deepEqual([back.format, back.total_chapters, back.chapters_read], ['webtoon', 200, 150]);
    const detail = (await admin('GET', `/mangas/${back.id}`)).body;
    assert.deepEqual(detail.chapter_progress.map(p => [p.username, p.chapters_read]), [['admin', 150], ['anna', 30]]);

    // an editor enters only themself; unknown names, names above the total and a broken cell are warnings
    wipe();
    const file = 'Reihe;Bandnummer;Format;Gesamtkapitel;Kapitel gelesen von\n'
        + 'Anna Webtoon;;webtoon;100;anna: 40, admin: 90, niemand: 3\n'
        + 'Hoch Webtoon;;webtoon;10;anna: 11\n'
        + 'Kaputt Webtoon;;Rolle;;anna vierzig\n';
    const imported = await anna('POST', '/import/csv', { csv: file });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.deepEqual(imported.body.warnings.map(w => [w.line, w.message]).sort(), [
        [2, 'Andere Benutzer als dich selbst kann nur ein Admin eintragen (ignoriert)'],
        [2, 'Unbekannter Leser „niemand“ (ignoriert)'],
        [3, 'Kapitelstand von „anna“ liegt über der Gesamtkapitelzahl (ignoriert)'],
        [4, 'Ungültiger Wert „Rolle“ in „Format“ (print, webtoon) wird ignoriert'],
        [4, 'Ungültiger Wert „anna vierzig“ in „Kapitel gelesen von“ (Name: Kapitel, z. B. anna: 150) wird ignoriert']
    ]);
    const list = (await anna('GET', '/mangas')).body;
    assert.deepEqual(list.map(m => [m.title, m.format, m.chapters_read]).sort(),
        [['Anna Webtoon', 'webtoon', 40], ['Hoch Webtoon', 'webtoon', 0], ['Kaputt Webtoon', 'print', 0]]);
});

test('the Manga Passion calendar and the quality check leave webtoons out', async () => {
    wipe();
    const webtoon = (await admin('POST', '/mangas', { title: 'Kalender Webtoon', format: 'webtoon' })).body.id;
    const print = (await admin('POST', '/mangas', { title: 'Kalender Druck' })).body.id;
    const { loadUserMangas } = require('../core/handlers/radar');
    const { createCtx } = require('../db');
    const user = (await admin('GET', '/auth/me')).body.user;
    const seen = loadUserMangas(createCtx({ user })).map(m => m.id);
    assert.ok(seen.includes(print) && !seen.includes(webtoon));
    const quality = (await admin('GET', '/maintenance/quality')).body;
    const mpCheck = quality.checks.find(c => c.id === 'series_without_mp_link');
    assert.deepEqual(mpCheck.items.map(i => i.id), [print]);
    assert.equal((await admin('POST', '/manga-passion/import', { manga_id: webtoon, title: 'Kalender Webtoon', volume_number: '1' })).body.code, 'MP_WEBTOON');
});
