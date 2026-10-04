// Radar services (month labels, time zones, edition matching) against an isolated database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// the services load the database module: keep it away from the real data folder
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-radar-test-'));
process.env.DATA_DIR = dataDir;

const { countdownFor, buildShoppingList, buildReleaseRadar, monthGroupOf, zonedToday, monthKeyOf, isValidReleaseDate } = require('../services/radar');
const { enrichReleases, buildMatcher, mapRelease, detectDateChanges, findSeriesForImport } = require('../services/mangaPassionReleases');

test.after(() => {
    require('../db').closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const day = (y, m, d) => new Date(y, m - 1, d, 15, 30); // "today" at any time of day

test('countdownFor: days and labels, also across the year boundary', () => {
    const today = day(2026, 10, 3);
    assert.deepEqual(countdownFor('2026-10-03', today), { days_until: 0, countdown_label: 'Erscheint heute!' });
    assert.deepEqual(countdownFor('2026-10-04', today), { days_until: 1, countdown_label: 'Morgen!' });
    assert.equal(countdownFor('2026-10-20', today).countdown_label, 'In 17 Tagen');
    assert.equal(countdownFor('2026-10-02', today).countdown_label, 'Vor 1 Tag');
    assert.equal(countdownFor('2026-09-28', today).countdown_label, 'Vor 5 Tagen');
    assert.equal(countdownFor('2026-11-25', today).countdown_label, 'Nächsten Monat');
    assert.equal(countdownFor('2027-01-20', today).countdown_label, 'In 3 Monaten');
    // December -> January is "next month" too (was "In 1 Monaten")
    assert.equal(countdownFor('2027-01-15', day(2026, 12, 3)).countdown_label, 'Nächsten Monat');
    // 31 days but two calendar months ahead: never "In 1 Monaten"
    assert.equal(countdownFor('2026-12-01', day(2026, 10, 31)).countdown_label, 'In 2 Monaten');
});

test('countdownFor: a month-only date gets month labels, never a day count or an overdue label while the month runs', () => {
    const mid = day(2026, 10, 15);
    assert.deepEqual(countdownFor('2026-10', mid), { days_until: null, countdown_label: 'Diesen Monat', date_precision: 'month' });
    assert.deepEqual(countdownFor('2026-10', day(2026, 10, 1)), { days_until: null, countdown_label: 'Diesen Monat', date_precision: 'month' });
    assert.equal(countdownFor('2026-11', mid).countdown_label, 'Nächsten Monat');
    assert.equal(countdownFor('2026-11', mid).days_until, null);
    assert.equal(countdownFor('2027-02', mid).countdown_label, 'In 4 Monaten');
    assert.equal(countdownFor('2027-1', day(2026, 12, 20)).countdown_label, 'Nächsten Monat');
    assert.equal(countdownFor('2026-1', day(2026, 1, 20)).countdown_label, 'Diesen Monat');
    const past = countdownFor('2026-09', mid);
    assert.equal(past.countdown_label, 'Vor 1 Monat');
    assert.equal(past.days_until, -15);
    assert.equal(countdownFor('2026-07', mid).countdown_label, 'Vor 3 Monaten');
    assert.deepEqual(countdownFor('2026-13', mid), { days_until: null, countdown_label: null });
});

test('countdownFor: an impossible date gives nulls instead of rolling over', () => {
    assert.deepEqual(countdownFor('2026-13-45', day(2026, 10, 3)), { days_until: null, countdown_label: null });
    assert.deepEqual(countdownFor('2026-02-31', day(2026, 10, 3)), { days_until: null, countdown_label: null });
});

test('zonedToday: the app time zone decides the day, not the server clock', () => {
    // 23:30 UTC on 31 October is already 1 November in Berlin (CET, UTC+1)
    const now = new Date(Date.UTC(2026, 9, 31, 23, 30));
    const berlin = zonedToday(now, 'Europe/Berlin');
    assert.deepEqual([berlin.getFullYear(), berlin.getMonth() + 1, berlin.getDate()], [2026, 11, 1]);
    assert.equal(monthKeyOf(berlin), '2026-11');
    assert.equal(countdownFor('2026-11-01', berlin).countdown_label, 'Erscheint heute!');
    const utc = zonedToday(now, 'UTC');
    assert.deepEqual([utc.getFullYear(), utc.getMonth() + 1, utc.getDate()], [2026, 10, 31]);
    // an unknown zone falls back to the server's local day instead of throwing
    assert.ok(zonedToday(now, 'Nirgendwo/Stadt') instanceof Date);
});

test('isValidReleaseDate: real calendar dates or months only', () => {
    for (const ok of ['2026-11', '2026-11-05', '2024-02-29', ' 2026-12-31 ']) assert.equal(isValidReleaseDate(ok), true, ok);
    for (const bad of ['2026-13-01', '2026-00-10', '2026-99-99', '2026-02-31', '2023-02-29', '2026-13', '2026', 'morgen', '', null, ['2026-01-01'], '0000-01-01']) {
        assert.equal(isValidReleaseDate(bad), false, JSON.stringify(bad));
    }
});

test('countdownFor: no or unparseable date gives nulls', () => {
    assert.deepEqual(countdownFor(null), { days_until: null, countdown_label: null });
    assert.deepEqual(countdownFor('bald'), { days_until: null, countdown_label: null });
    assert.deepEqual(countdownFor(''), { days_until: null, countdown_label: null });
});

test('monthGroupOf: month label, year fallback, undated last', () => {
    assert.deepEqual(monthGroupOf({ release_date: '2026-03-15' }), { label: 'März 2026', sortKey: '2026-03' });
    assert.deepEqual(monthGroupOf({ release_date: '2026-12' }), { label: 'Dezember 2026', sortKey: '2026-12' });
    assert.deepEqual(monthGroupOf({ release_date: null, release_year: 2027 }), { label: 'Im Jahr 2027', sortKey: '2027-13' });
    assert.deepEqual(monthGroupOf({ release_date: '2026-13-01' }), { label: 'Ohne konkretes Datum', sortKey: '9999-99' });
    assert.deepEqual(monthGroupOf({}), { label: 'Ohne konkretes Datum', sortKey: '9999-99' });
});

test('buildShoppingList: totals and publisher chips (canonical names)', () => {
    const list = buildShoppingList([
        { id: 1, price: 7.5, effective_publisher: 'carlsen manga' },
        { id: 2, price: 8.1, effective_publisher: 'Carlsen Manga' },
        { id: 3, price: null, effective_publisher: 'Panini' }
    ]);
    assert.equal(list.total_missing, 3);
    assert.equal(list.total_cost, 15.6);
    assert.deepEqual(list.publishers, [
        { publisher: 'Carlsen Manga', count: 2, total_price: 15.6, wished_count: 0 },
        { publisher: 'Panini Verlags GmbH', count: 1, total_price: 0, wished_count: 0 }
    ]);
    assert.deepEqual([list.total_wished_series, list.wished_series], [0, []]);
});

test('buildShoppingList: wished series are appended unchanged in order, counted, and add publisher chips', () => {
    const list = buildShoppingList([{ id: 1, price: 7, effective_publisher: 'Carlsen Manga' }], [
        { id: 5, title: 'Hoch', cover_image: null, publisher: 'carlsen manga', wish_priority: 3, total_volumes: 10, manga_passion_id: 9, known_missing_count: 2, known_missing_cost: 13.999 },
        { id: 6, title: 'Neu', cover_image: '/uploads/n.jpg', publisher: null, wish_priority: 0, total_volumes: null, manga_passion_id: null, known_missing_count: 0, known_missing_cost: 0 }
    ]);
    assert.equal(list.total_wished_series, 2);
    assert.deepEqual(list.wished_series.map(s => [s.id, s.publisher, s.wish_priority, s.known_missing_count, s.known_missing_cost]), [
        [5, 'Carlsen Manga', 3, 2, 14], [6, 'Unbekannt', 0, 0, 0]
    ]);
    assert.deepEqual(list.publishers, [
        { publisher: 'Carlsen Manga', count: 1, total_price: 7, wished_count: 1 },
        { publisher: 'Unbekannt', count: 0, total_price: 0, wished_count: 1 }
    ]);
    assert.equal(list.total_missing, 1, 'wished series are no missing volumes');
});

test('enrichReleases: user_manga_wished only for a wished series without an owned volume, never for a spin-off', () => {
    const mangas = [
        { id: 1, title: 'Wunsch', wish_priority: 2, owned_count: 0 },
        { id: 2, title: 'Besitz', wish_priority: 3, owned_count: 1 },
        { id: 3, title: 'Normal', wish_priority: null, owned_count: 0 }
    ];
    const items = enrichReleases([
        { id: 11, title: 'Wunsch', volume_number: '1' },
        { id: 12, title: 'Besitz', volume_number: '1' },
        { id: 13, title: 'Normal', volume_number: '1' },
        { id: 14, title: 'Wunsch – Episode Zwei', volume_number: '1' }
    ], mangas, []);
    assert.deepEqual(items.map(i => [i.in_collection, i.user_manga_wished]), [[true, true], [true, false], [true, false], [true, false]]);
});

test('buildReleaseRadar: month groups in order, budgets, countdown per item', () => {
    const today = day(2026, 10, 3);
    const radar = buildReleaseRadar([
        { id: 1, status: 'Vorbestellt', price: 8, release_date: '2026-10-09', effective_publisher: 'Carlsen Manga' },
        { id: 2, status: 'Erscheint bald', price: 7, release_date: '2026-11-20', effective_publisher: 'Carlsen Manga' },
        { id: 3, status: 'Vorbestellt', price: 6.5, release_date: '2026-10-30', effective_publisher: 'Panini' },
        { id: 4, status: 'Erscheint bald', price: null, release_date: null, release_year: null, effective_publisher: 'Panini' }
    ], today);
    assert.equal(radar.total_releases, 4);
    assert.equal(radar.preordered_count, 2);
    assert.equal(radar.preordered_budget, 14.5);
    assert.equal(radar.total_budget, 21.5);
    assert.deepEqual(radar.groups.map(g => [g.label, g.count, g.total_price, g.preordered_count]), [
        ['Oktober 2026', 2, 14.5, 2], ['November 2026', 1, 7, 0], ['Ohne konkretes Datum', 1, 0, 0]
    ]);
    assert.equal(radar.items[0].countdown_label, 'In 6 Tagen');
    assert.equal(radar.items[3].countdown_label, null);
    const monthOnly = buildReleaseRadar([{ id: 5, status: 'Vorbestellt', price: 7, release_date: '2026-10', effective_publisher: 'X' }], day(2026, 10, 20));
    assert.equal(monthOnly.items[0].countdown_label, 'Diesen Monat');
    assert.equal(monthOnly.items[0].days_until, null);
    assert.deepEqual(radar.publishers.map(p => [p.publisher, p.count]), [['Carlsen Manga', 2], ['Panini Verlags GmbH', 2]]);
});

test('enrichReleases: matches series by title / alt title / prefix and the volume by number', () => {
    const mangas = [{ id: 1, title: 'Berserk', alt_title: null }, { id: 2, title: 'One Piece', alt_title: 'Wan Pīsu' }];
    const volumes = [{ id: 10, manga_id: 1, volume_number: '3', status: 'Vorhanden' }, { id: 11, manga_id: 1, volume_number: ' 4 ', status: 'Fehlt' }];
    const items = enrichReleases([
        { title: 'Berserk', volume_number: '3' },
        { title: 'BERSERK', volume_number: '4' },
        { title: 'Berserk: Ultimative Edition', volume_number: '9' },
        { title: 'Unbekannte Reihe', volume_number: '1' }
    ], mangas, volumes);
    assert.deepEqual(items.map(i => [i.in_collection, i.user_manga_id, i.user_volume_status, i.user_volume_id]), [
        [true, 1, 'Vorhanden', 10], [true, 1, 'Fehlt', 11], [true, 1, null, null], [false, null, null, null]
    ]);
});

test('mapRelease: digital flag, cleaned title, price in euros', () => {
    const r = mapRelease({ id: 5, number: 7, date: '2026-10-09T00:00:00+00:00', price: 750, edition: { id: 3, title: 'Berserk (eBook)', digital: false, publishers: [{ name: 'Panini Manga' }] } });
    assert.equal(r.title, 'Berserk');
    assert.equal(r.is_digital, true);
    assert.equal(r.price, 7.5);
    assert.equal(r.date, '2026-10-09');
    assert.equal(r.volume_number, '7');
});


const fields = (items) => items.map(i => [i.in_collection, i.user_manga_id, i.user_volume_status, i.user_volume_id]);

test('enrichReleases: a prefix match (spin-off, novel) marks the series but never borrows the volume', () => {
    const mangas = [{ id: 2, title: 'Blue Lock' }, { id: 3, title: 'One Piece' }];
    const volumes = [{ id: 20, manga_id: 2, volume_number: '3', status: 'Vorbestellt', release_date: '2026-11-05' }, { id: 30, manga_id: 3, volume_number: '1', status: 'Vorhanden' }];
    const items = enrichReleases([
        { id: 1, title: 'Blue Lock', volume_number: '3', date: '2026-11-05' },
        { id: 2, title: 'Blue Lock – Episode Nagi', volume_number: '3', date: '2026-11-19' },
        { id: 3, title: 'One Piece - Novel', volume_number: '1', date: '2026-11-19' }
    ], mangas, volumes);
    assert.deepEqual(fields(items), [[true, 2, 'Vorbestellt', 20], [true, 2, null, null], [true, 3, null, null]]);
    assert.deepEqual(items.map(i => i.match_kind), ['exact', 'prefix', 'prefix']);

    const pending = [{ id: 20, manga_id: 2, volume_number: '3', status: 'Vorbestellt', release_date: '2026-11-05' }];
    assert.deepEqual(detectDateChanges(pending, items), []);
    assert.deepEqual(detectDateChanges(pending, [...items].reverse()), []);
});

test('enrichReleases: the linked Manga Passion edition decides; another edition with the same title gets no volume', () => {
    const mangas = [{ id: 1, title: 'Berserk', manga_passion_id: 77 }];
    const volumes = [{ id: 10, manga_id: 1, volume_number: '5', status: 'Vorbestellt', release_date: '2026-11-05' }];
    const items = enrichReleases([
        { id: 1, edition_id: 77, title: 'Berserk: Ultimative Edition', volume_number: '5', date: '2026-12-03' },
        { id: 2, edition_id: 99, title: 'Berserk', volume_number: '5', date: '2026-11-20' }
    ], mangas, volumes);
    assert.deepEqual(fields(items), [[true, 1, 'Vorbestellt', 10], [true, 1, null, null]]);
    assert.deepEqual(items.map(i => i.match_kind), ['edition', 'other_edition']);
    // the linked edition still reports a real postponement although its title only matches by prefix
    const changes = detectDateChanges([{ id: 10, manga_id: 1, manga_title: 'Berserk', volume_number: '5', status: 'Vorbestellt', release_date: '2026-11-05' }], items);
    assert.deepEqual(changes.map(c => [c.volume_id, c.new_date]), [[10, '2026-12-03']]);
});

test('enrichReleases: a volume linked to the Manga Passion volume id is matched directly', () => {
    const mangas = [{ id: 1, title: 'Meine Reihe' }];
    const volumes = [{ id: 10, manga_id: 1, volume_number: '5', status: 'Vorbestellt', manga_passion_volume_id: 555 }];
    const items = enrichReleases([
        { id: 555, title: 'Ganz anderer Titel', volume_number: '5' },
        { id: 556, title: 'Meine Reihe', volume_number: '5' }
    ], mangas, volumes);
    assert.deepEqual(fields(items), [[true, 1, 'Vorbestellt', 10], [true, 1, null, null]]);
    assert.equal(items[0].match_kind, 'volume_id');
});

test('enrichReleases: two rows with the same Manga Passion id are told apart by type; the id alone only when one row has it', () => {
    const mangas = [{ id: 1, title: 'Kaiju Repro' }];
    const ce = { id: 1, manga_id: 1, volume_number: '4', type: 'special_edition', status: 'Vorbestellt', manga_passion_volume_id: 5150 };
    const regular = { id: 2, manga_id: 1, volume_number: '4', type: 'volume', status: 'Fehlt', manga_passion_volume_id: 5150 };
    const entry = { id: 5150, edition_id: 1, title: 'Kaiju Repro', volume_number: '4', type: 'volume' };
    for (const volumes of [[ce, regular], [regular, ce]]) {
        const [item] = buildMatcher(mangas, volumes).enrich([entry]);
        assert.deepEqual([item.match_kind, item.user_volume_id, item.user_volume_status], ['volume_id', 2, 'Fehlt']);
        const [edition] = buildMatcher(mangas, volumes).enrich([{ ...entry, type: 'special_edition' }]);
        assert.deepEqual([edition.user_volume_id, edition.user_volume_status], [1, 'Vorbestellt']);
    }
    // a single linked row still matches by id, whatever its type, while the series has no row of the entry's type
    const [single] = buildMatcher(mangas, [ce]).enrich([entry]);
    assert.deepEqual([single.match_kind, single.user_volume_id], ['volume_id', 1]);
    // ... but an unlinked regular volume 4 is the entry's row (the import links the id to one type only)
    const unlinked = { ...regular, manga_passion_volume_id: null };
    for (const volumes of [[ce, unlinked], [unlinked, ce]]) {
        const [own] = buildMatcher(mangas, volumes).enrich([entry]);
        assert.deepEqual([own.user_volume_id, own.user_volume_status], [2, 'Fehlt']);
    }
    // two rows of other types with that id: no id match, the regular volume is found by type + number
    const schuber = { id: 3, manga_id: 1, volume_number: 'Schuber 1', type: 'schuber', status: 'Fehlt', manga_passion_volume_id: 5150 };
    const [none] = buildMatcher(mangas, [ce, schuber]).enrich([entry]);
    assert.notEqual(none.match_kind, 'volume_id');
    assert.equal(none.user_volume_id, null);
});

test('enrichReleases: type + number identity, a special edition never stands in for the regular volume', () => {
    const mangas = [{ id: 1, title: 'Spy x Family' }];
    const seFirst = [
        { id: 7, manga_id: 1, volume_number: '5', status: 'Vorhanden', type: 'special_edition' },
        { id: 8, manga_id: 1, volume_number: '5', status: 'Vorbestellt', type: 'volume', release_date: '2026-11-05' },
        { id: 9, manga_id: 1, volume_number: '6', status: 'Fehlt', type: null }
    ];
    const items = enrichReleases([
        { id: 1, title: 'Spy x Family', volume_number: '5', date: '2026-12-03' },
        { id: 2, title: 'Spy x Family – Collectors Edition', raw_title: 'Spy x Family – Collectors Edition', volume_number: '5', date: '2026-11-20' },
        { id: 3, title: 'Spy x Family', volume_number: '6' }
    ], mangas, seFirst);
    assert.deepEqual(fields(items), [[true, 1, 'Vorbestellt', 8], [true, 1, 'Vorhanden', 7], [true, 1, 'Fehlt', 9]]);
    assert.deepEqual(items.map(i => i.type), ['volume', 'special_edition', 'volume']);
    assert.equal(items[1].match_kind, 'variant');
    const pending = [{ id: 8, manga_id: 1, manga_title: 'Spy x Family', volume_number: '5', status: 'Vorbestellt', release_date: '2026-11-05' }];
    assert.deepEqual(detectDateChanges(pending, items).map(c => [c.volume_id, c.new_date]), [[8, '2026-12-03']]);

    // only a special edition row exists: the regular entry stays unmatched; a legacy row is typed by its notes
    const onlySe = enrichReleases([{ title: 'Spy x Family', volume_number: '5' }, { title: 'Spy x Family', volume_number: '6' }], mangas, [
        { id: 7, manga_id: 1, volume_number: '5', status: 'Vorhanden', type: 'special_edition' },
        { id: 11, manga_id: 1, volume_number: '6', status: 'Vorhanden', type: null, notes: 'Limited Edition mit Poster' }
    ]);
    assert.deepEqual(fields(onlySe), [[true, 1, null, null], [true, 1, null, null]]);
});

test('enrichReleases: numberless specials are matched by title, not all under one "Special" key', () => {
    const mangas = [{ id: 1, title: 'One Piece' }];
    const volumes = [{ id: 40, manga_id: 1, volume_number: 'Artbook', type: 'special', status: 'Vorbestellt' }];
    const items = enrichReleases([
        mapRelease({ id: 900, number: null, title: 'Artbook', edition: { id: 3, title: 'One Piece' } }),
        mapRelease({ id: 901, number: null, title: 'Fanbook', edition: { id: 3, title: 'One Piece' } })
    ], mangas, volumes);
    assert.deepEqual(fields(items), [[true, 1, 'Vorbestellt', 40], [true, 1, null, null]]);
});

test('enrichReleases: empty and non-Latin titles never match an unrelated series; first title wins a key collision', () => {
    const mangas = [{ id: 2, title: 'Blue Lock', alt_title: 'ブルーロック' }, { id: 3, title: 'Mob Psycho', alt_title: 'Blue-Lock' }];
    const items = enrichReleases([
        mapRelease({ id: 1, edition: null, number: 1 }),
        { title: '進撃の巨人', volume_number: '1' },
        { title: 'ブルーロック', volume_number: '1' },
        { title: 'BLUE LOCK', volume_number: '1' }
    ], mangas, []);
    assert.deepEqual(items.map(i => i.user_manga_id), [null, null, 2, 2]);
    // Unicode-aware key: accents fold to the base letter on both sides
    assert.equal(enrichReleases([{ title: 'Wan Pisu', volume_number: '1' }], [{ id: 5, title: 'One Piece', alt_title: 'Wan Pīsu' }], [])[0].user_manga_id, 5);
});

test('buildMatcher: one matcher per request gives the same result as enrichReleases', () => {
    const mangas = [{ id: 1, title: 'Berserk', alt_title: null }, { id: 2, title: 'One Piece', alt_title: 'Wan Pīsu' }];
    const volumes = [{ id: 10, manga_id: 1, volume_number: '3', status: 'Vorhanden' }];
    const raw = [{ title: 'Berserk', volume_number: '3' }, { title: 'Berserk: Ultimative Edition', volume_number: '3' }, { title: 'wan pīsu', volume_number: '1' }];
    const matcher = buildMatcher(mangas, volumes);
    assert.deepEqual(matcher.enrich(raw), enrichReleases(raw, mangas, volumes));
    assert.deepEqual(matcher.enrich(raw.slice(0, 1)), enrichReleases(raw.slice(0, 1), mangas, volumes));
});

test('mapRelease: numberless entries keep their title and type, so two specials never share a key', () => {
    const artbook = mapRelease({ id: 900, number: null, title: 'Artbook', edition: { id: 3, title: 'One Piece' } });
    assert.equal(artbook.volume_number, 'Artbook');
    assert.equal(artbook.type, 'special');
    const box = mapRelease({ id: 901, number: null, title: 'East Blue Leerschuber', specialType: 1, edition: { id: 3, title: 'One Piece' } });
    assert.equal(box.volume_number, 'East Blue Leerschuber');
    assert.equal(box.type, 'schuber');
    const untitled = mapRelease({ id: 902, number: null, edition: { id: 3, title: 'One Piece' } });
    assert.equal(untitled.volume_number, 'Special 902');
    assert.equal(untitled.type, 'special');
    assert.equal(mapRelease({ id: 903, number: 5, edition: { id: 4, title: 'One Piece – Collectors Edition' } }).type, 'special_edition');
    assert.equal(mapRelease({ id: 904, number: 5, edition: { id: 4, title: 'One Piece' } }).type, 'volume');
    // Manga Passion's own type field: 3 = Collectors/Limited edition, 0 = regular volume whatever the title says
    assert.equal(mapRelease({ id: 905, number: 5, type: 3, specialType: 2, edition: { id: 4, title: 'One Piece' } }).type, 'special_edition');
    assert.equal(mapRelease({ id: 906, number: 5, type: 0, title: 'Der Boxer', edition: { id: 4, title: 'One Piece' } }).type, 'volume');
});

test('detectDateChanges: the "no date yet" placeholder is no new date; type and notes are passed on', () => {
    const pending = [{ id: 1, manga_id: 1, manga_title: 'X', volume_number: '5', type: 'special_edition', notes: 'Limited Edition', status: 'Vorbestellt', release_date: '2026-11-05' }];
    assert.deepEqual(detectDateChanges(pending, [{ user_volume_id: 1, date: '2999-12-31', is_digital: false }]), []);
    const [change] = detectDateChanges(pending, [{ user_volume_id: 1, date: '2027-02-10', is_digital: false }]);
    assert.equal(change.new_date, '2027-02-10');
    assert.equal(change.type, 'special_edition');
    assert.equal(change.notes, 'Limited Edition');
});

test('findSeriesForImport: same title or alt title, spelling independent, never the prefix rule', () => {
    const mangas = [{ id: 1, title: 'Brandneu Reihe' }, { id: 2, title: 'Äther', alt_title: null }, { id: 3, title: 'Andere', alt_title: 'Shingeki' }, { id: 4, title: 'ゆ' }];
    assert.equal(findSeriesForImport(mangas, ' brandneu reihe ').id, 1);
    assert.equal(findSeriesForImport(mangas, 'Brandneu-Reihe').id, 1);
    assert.equal(findSeriesForImport(mangas, 'äther').id, 2);
    assert.equal(findSeriesForImport(mangas, 'shingeki').id, 3);
    assert.equal(findSeriesForImport(mangas, 'Brandneu Reihe: Spin-off'), null);
    assert.equal(findSeriesForImport(mangas, 'よ'), null);
    assert.equal(findSeriesForImport(mangas, ''), null);
});

test('mapRelease + detectDateChanges: a month-only calendar date is compared by month', () => {
    assert.equal(mapRelease({ id: 1, number: 1, date: '2026-11-30T00:00:00+00:00', year: 2026, month: 11, day: null, edition: { id: 1, title: 'X' } }).date, '2026-11');
    assert.equal(mapRelease({ id: 2, number: 1, date: '2999-12-31T00:00:00+00:00', edition: { id: 1, title: 'X' } }).date, null);
    const pending = [{ id: 1, manga_id: 1, manga_title: 'X', volume_number: '1', status: 'Vorbestellt', release_date: '2026-11-05' }];
    assert.deepEqual(detectDateChanges(pending, [{ user_volume_id: 1, date: '2026-11', is_digital: false }]), []);
    assert.deepEqual(detectDateChanges(pending, [{ user_volume_id: 1, date: '2027-01', is_digital: false }]).map(c => c.new_date), ['2027-01']);
    const monthStored = [{ ...pending[0], release_date: '2026-1' }];
    assert.deepEqual(detectDateChanges(monthStored, [{ user_volume_id: 1, date: '2026-01-20', is_digital: false }]), []);
});

test('enrichReleases: two editions with the same title each find their own series; by title the unlinked one wins', () => {
    const mangas = [
        { id: 1, title: 'Vagabond', manga_passion_id: 10 },
        { id: 2, title: 'Vagabond', manga_passion_id: 20 },
        { id: 3, title: 'Vagabond' }
    ];
    const volumes = [
        { id: 11, manga_id: 1, volume_number: '3', status: 'Vorhanden' },
        { id: 21, manga_id: 2, volume_number: '3', status: 'Vorbestellt' },
        { id: 31, manga_id: 3, volume_number: '3', status: 'Fehlt' }
    ];
    const items = enrichReleases([
        { id: 1, edition_id: 20, title: 'Vagabond', volume_number: '3' },
        { id: 2, edition_id: 10, title: 'Vagabond', volume_number: '3' },
        { id: 3, edition_id: 30, title: 'Vagabond', volume_number: '3' }
    ], mangas, volumes);
    assert.deepEqual(fields(items), [[true, 2, 'Vorbestellt', 21], [true, 1, 'Vorhanden', 11], [true, 3, 'Fehlt', 31]]);
    assert.deepEqual(items.map(i => i.match_kind), ['edition', 'edition', 'exact']);
    // only linked series of other editions: the title still marks the series, never a volume
    const other = enrichReleases([{ id: 4, edition_id: 30, title: 'Vagabond', volume_number: '3' }], mangas.slice(0, 2), volumes);
    assert.deepEqual([other[0].match_kind, other[0].user_volume_id], ['other_edition', null]);
});

test('enrichReleases: "Band 14" in the collection is the calendar\'s "14"; a Collectors Edition 14 stays apart', () => {
    const mangas = [{ id: 1, title: 'Kingdom', manga_passion_id: 5 }];
    const volumes = [
        { id: 50, manga_id: 1, volume_number: 'Collectors Edition 14', status: 'Vorhanden', type: 'special_edition' },
        { id: 51, manga_id: 1, volume_number: 'Band 14', status: 'Vorbestellt', type: 'volume' },
        { id: 52, manga_id: 1, volume_number: 'Schuber 2', status: 'Fehlt', type: 'schuber' }
    ];
    const items = enrichReleases([
        { id: 1, edition_id: 5, title: 'Kingdom', volume_number: '14' },
        { id: 2, edition_id: 6, title: 'Kingdom – Collectors Edition', raw_title: 'Kingdom – Collectors Edition', volume_number: '14' },
        { id: 3, edition_id: 5, title: 'Kingdom', volume_number: '2', type: 'schuber' },
        { id: 4, edition_id: 5, title: 'Kingdom', volume_number: '2' }
    ], mangas, volumes);
    assert.deepEqual(items.map(i => [i.type, i.user_volume_id]), [['volume', 51], ['special_edition', 50], ['schuber', 52], ['volume', null]]);
});

test('buildMatcher: only the canonical label of a volume or Schuber matches a bare calendar number', () => {
    const mangas = [{ id: 1, title: 'Berserk' }];
    const match = (volume_number, type, calendar = { id: 900, title: 'Berserk', volume_number: '14' }) =>
        buildMatcher(mangas, [{ id: 10, manga_id: 1, volume_number, type, status: 'Vorhanden' }]).enrich([calendar])[0].user_volume_id;
    const prefixed = ['14', 'Band 14', 'band14', 'Bd. 14', 'Bd 14', 'Vol. 14', 'vol 14', 'Volume 14', 'Nr. 14', 'nr 14', 'No. 14',
        'Teil 14', 'Tome 14', 'Ausgabe 14', '#14', '# 14'];
    for (const label of prefixed) assert.equal(match(label, 'volume'), 10, label);
    for (const label of ['Ultimative Edition 14', 'Perfect Edition 14', 'Collectors Edition 14', 'Deluxe Ausgabe 14', 'Band 140', 'Box 14']) {
        assert.equal(match(label, 'volume'), null, label);
    }
    const schuber = { id: 901, title: 'Berserk', volume_number: '2', type: 'schuber' };
    assert.equal(match('Schuber 2', 'schuber', schuber), 10);
    for (const label of ['schuber2', 'Box 2', 'box2', 'Schuber Nr. 2', 'Box Nr 2', '2']) assert.equal(match(label, 'schuber', schuber), 10, label);
    assert.equal(match('Band 2', 'schuber', schuber), null);
    assert.equal(match('Vollschuber 2', 'schuber', schuber), null);
    const edition = { id: 902, title: 'Berserk', volume_number: '3', type: 'special_edition' };
    assert.equal(match('Collectors Edition 3', 'special_edition', edition), 10, 'a special edition keeps its own type');
    const ultimate = buildMatcher(mangas, [{ id: 10, manga_id: 1, volume_number: 'Ultimative Edition 14', type: 'volume', status: 'Vorhanden' }])
        .enrich([{ id: 900, title: 'Berserk', volume_number: '14' }])[0];
    assert.deepEqual([ultimate.in_collection, ultimate.user_volume_status], [true, null]);
});

test('enrichReleases: user_manga_collecting tells a dropped series apart; prefix matches carry none', () => {
    const mangas = [{ id: 1, title: 'Eden', collecting: 'abgebrochen' }, { id: 2, title: 'Blame' }];
    const items = enrichReleases([
        { title: 'Eden', volume_number: '1' },
        { title: 'Blame', volume_number: '1' },
        { title: 'Eden – It\'s an Endless World Novel', volume_number: '1' }
    ], mangas, []);
    assert.deepEqual(items.map(i => i.user_manga_collecting), ['abgebrochen', 'aktiv', null]);
});

test('findSeriesForImport: the linked edition first, then an unlinked series before one of another edition', () => {
    const mangas = [
        { id: 1, title: 'Monster', manga_passion_id: 7 },
        { id: 2, title: 'Monster' },
        { id: 3, title: 'Monster Perfect Edition', manga_passion_id: 8 }
    ];
    assert.equal(findSeriesForImport(mangas, 'Monster Neuauflage', 8).id, 3);
    assert.equal(findSeriesForImport(mangas, 'Monster', 9).id, 2);
    assert.equal(findSeriesForImport(mangas, 'Monster', 7).id, 1);
    // without an edition the old order stays
    assert.equal(findSeriesForImport(mangas, 'Monster').id, 1);
});
