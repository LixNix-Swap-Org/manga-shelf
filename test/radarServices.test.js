const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// the services load the database module: keep it away from the real data folder
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-radar-test-'));
process.env.DATA_DIR = dataDir;

const { countdownFor, buildShoppingList, buildReleaseRadar, monthGroupOf } = require('../services/radar');
const { enrichReleases, mapRelease } = require('../services/mangaPassionReleases');

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
    // a month without a day counts as the 1st
    assert.equal(countdownFor('2026-11', today).days_until, 29);
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
        { publisher: 'Carlsen Manga', count: 2, total_price: 15.6 },
        { publisher: 'Panini Verlags GmbH', count: 1, total_price: 0 }
    ]);
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

