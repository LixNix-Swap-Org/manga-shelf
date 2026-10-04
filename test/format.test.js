// Pure formatting helpers of the frontend (frontend/src/utils/format.js), loaded without a browser.
const test = require('node:test');
const assert = require('node:assert/strict');

let f;
let collection;
test.before(async () => {
  f = await import('../frontend/src/utils/format.js');
  collection = await import('../frontend/src/utils/collectionHelpers.js');
});

const plain = (s) => s.replace(/\u00a0/g, ' ');

test('formatEuro: German currency, empty for null, blank or non-numeric prices', () => {
  assert.equal(plain(f.formatEuro(7.5)), '7,50 €');
  assert.equal(plain(f.formatEuro('7.5')), '7,50 €');
  assert.equal(plain(f.formatEuro(1234.5)), '1.234,50 €');
  assert.equal(plain(f.formatEuro(0)), '0,00 €');
  assert.equal(f.formatEuro(null), '');
  assert.equal(f.formatEuro(undefined), '');
  assert.equal(f.formatEuro('  '), '');
  assert.equal(f.formatEuro('abc'), '');
  assert.equal(f.formatEuro(null, { empty: '–' }), '–');
  assert.match(f.formatEuro(7.5), /7,50\u00a0€/, 'no line break between amount and sign');
});

test('formatNumber and formatPercent', () => {
  assert.equal(f.formatNumber(1234), '1.234');
  assert.equal(f.formatNumber(5.486, 2), '5,49');
  assert.equal(f.formatNumber(5, 2, { fixed: true }), '5,00');
  assert.equal(f.formatNumber(null), '');
  assert.equal(f.formatPercent(12.54), '12,5%');
  assert.equal(f.formatMegabytes(1.5 * 1024 * 1024), '1,50 MB');
});

test('formatCount: singular only for exactly one', () => {
  assert.equal(f.formatCount(1, 'Band', 'Bände'), '1 Band');
  assert.equal(f.formatCount(0, 'Band', 'Bände'), '0 Bände');
  assert.equal(f.formatCount(2, 'Band', 'Bände'), '2 Bände');
  assert.equal(f.formatCount(1234, 'Band', 'Bände'), '1.234 Bände');
  assert.equal(f.formatCount(null, 'Lücke', 'Lücken'), '0 Lücken');
  assert.equal(f.formatCount('1', 'Reihe', 'Reihen'), '1 Reihe');
});

test('formatDate: full, month-only and year-only dates without a UTC shift', () => {
  assert.equal(f.formatDate('2026-11-12'), '12.11.2026');
  assert.equal(f.formatDate('2026-01-01'), '01.01.2026');
  assert.equal(f.formatDate('2026-11'), '11/2026');
  assert.equal(f.formatDate('2026'), '2026');
  assert.equal(f.formatDate(' 2026-11-12 '), '12.11.2026');
  assert.equal(f.formatDate('2026-02-30'), '2026-02-30', 'impossible dates stay as typed');
  assert.equal(f.formatDate('demnächst'), 'demnächst');
  assert.equal(f.formatDate(null), '');
  assert.equal(f.formatDate('2026-10-02', { long: true }), 'Freitag, 02. Oktober 2026');
  assert.equal(f.formatDate('2026-11', { long: true }), 'November 2026');
});

test('formatGermanDate stays a thin wrapper', () => {
  assert.equal(collection.formatGermanDate('2026-10-02'), 'Freitag, 02. Oktober 2026');
  assert.equal(collection.formatGermanDate('2026-10'), '2026-10');
  assert.equal(collection.formatGermanDate(''), '');
  assert.equal(collection.GERMAN_MONTHS.length, 12);
  assert.equal(collection.GERMAN_MONTHS[2], 'März');
});

test('month names and labels come from Intl', () => {
  assert.deepEqual(f.monthNames('short').slice(0, 3), ['Jan', 'Feb', 'Mär']);
  assert.equal(f.monthNames('long')[11], 'Dezember');
  assert.equal(f.formatMonth('2026-03'), 'März 2026');
  assert.equal(f.formatMonth('2026-03', { style: 'short' }), 'Mär 2026');
  assert.equal(f.formatMonth('2026-03', { style: 'short', year: false }), 'Mär');
  assert.equal(f.formatMonth(5), 'Mai');
  assert.equal(f.formatMonth('kein Monat'), 'kein Monat');
});

test('date and time of a timestamp', () => {
  const d = new Date(2026, 9, 2, 14, 5);
  assert.equal(f.formatDateTime(d), '02.10.2026, 14:05');
  assert.equal(f.formatDay(d), '02.10.2026');
  assert.equal(f.formatTime(d), '14:05');
  assert.equal(f.formatDayMonth(d, new Date(2026, 11, 31)), '02.10.');
  assert.equal(f.formatDayMonth(d, new Date(2027, 0, 1)), '02.10.2026');
  assert.equal(f.formatDateTime('kaputt'), '');
});

test('formatRelative: short German ages, plural days, null for unknown input', () => {
  const now = Date.UTC(2026, 9, 3, 12, 0);
  assert.equal(f.formatRelative(now - 10 * 1000, now), 'gerade eben');
  assert.equal(f.formatRelative(now - 5 * 60 * 1000, now), 'vor 5 Min.');
  assert.equal(f.formatRelative(now - 3 * 3600 * 1000, now), 'vor 3 Std.');
  assert.equal(f.formatRelative(now - 30 * 3600 * 1000, now), 'vor 1 Tag');
  assert.equal(f.formatRelative(now - 49 * 3600 * 1000, now), 'vor 2 Tagen');
  assert.equal(f.formatRelative(new Date(now - 7 * 60 * 1000).toISOString(), now), 'vor 7 Min.');
  assert.equal(f.formatRelative(null, now), null);
  assert.equal(f.formatRelative('kein datum', now), null);
});

test('getLocale is the single locale source', () => {
  assert.equal(f.getLocale(), 'de-DE');
});
