// Frontend scan helpers (prefill, shopping rows, scan results), loaded as ESM.
const test = require('node:test');
const assert = require('node:assert');

let helpers;
test.before(async () => { helpers = await import('../frontend/src/utils/scanHelpers.js'); });

test('scan prefill uses the catalogue series before the volume title', () => {
  const p = helpers.buildScanPrefill({ title: 'Mein kleiner Bruder!', series: 'Kaguya-sama', volume_number: '2', volume_number_known: true, author: 'A', publisher: 'Carlsen', price: 7, pages: 192, release_year: 2021, cover_url: 'https://covers.openlibrary.org/b/isbn/9783551000000-L.jpg' }, '9783551000000');
  assert.strictEqual(p.form.title, 'Kaguya-sama');
  assert.strictEqual(p.form.cover_image, 'https://covers.openlibrary.org/b/isbn/9783551000000-L.jpg?default=false');
  assert.deepStrictEqual(
    [p.volume.volume_number, p.volume.price, p.volume.pages, p.volume.release_year, p.volume.isbn],
    ['2', '7', '192', '2021', '9783551000000']
  );
});

test('scan prefill leaves an unknown volume number empty instead of guessing "1"', () => {
  const p = helpers.buildScanPrefill({ title: 'Berserk', volume_number: '1', volume_number_known: false }, '9783551000000');
  assert.strictEqual(p.volume.volume_number, '');
  assert.strictEqual(p.form.cover_image, '');
});

test('scan volume payload carries the manga id and the cleaned fields', () => {
  const body = helpers.buildScanVolumePayload(5, { volume_number: ' 3 ', status: 'Fehlt', isbn: '978', price: '', pages: '', release_year: '', publisher: 'X' });
  assert.deepStrictEqual(body, { manga_id: 5, volume_number: '3', status: 'Fehlt', isbn: '978', price: null, pages: null, release_year: null, publisher: 'X' });
});

test('prefillTotalVolumes leaves the total open for running series', () => {
  assert.strictEqual(helpers.prefillTotalVolumes({ total_volumes: 1, status: 'Laufend' }, ''), '');
  assert.strictEqual(helpers.prefillTotalVolumes({ total_volumes: 1, status: 'Laufend' }, '5'), '5');
  assert.strictEqual(helpers.prefillTotalVolumes({ total_volumes: 12, status: 'Abgeschlossen' }, ''), '12');
  assert.strictEqual(helpers.prefillTotalVolumes({ status: 'Abgeschlossen' }, '3'), '3');
});

// Rows as GET /api/shopping-list sends them (services/radar.js buildShoppingList): manga_title, no title
const shopRow = (over = {}) => ({
  id: 7, manga_id: 3, volume_number: '3', isbn: '978-3-551-00003-1', price: 7, release_year: 2020, condition: null,
  vol_publisher: null, notes: null, status: 'Fehlt', type: 'volume', priority: 0, target_price: null,
  manga_title: 'Naruto', manga_cover: null, effective_publisher: 'Carlsen Manga', ...over
});

test('classifyShopScan: Einkaufsliste, vorhanden, prüfen, neu, unbekannt', () => {
  const items = [shopRow()];
  const c = (data, isbn = '9780000000002') => helpers.classifyShopScan(isbn, data, items);
  const buy = helpers.classifyShopScan('9783551000031', { found: true }, items);
  assert.deepStrictEqual([buy.kind, buy.itemId, buy.label], ['buy', 7, 'Naruto Band 3']);
  const viaMatch = c({ found: true, matched_manga: { title: 'X' }, matched_volume: { id: 7, status: 'Fehlt', volume_number: '3' }, book: {} });
  assert.deepStrictEqual([viaMatch.kind, viaMatch.label], ['buy', 'Naruto Band 3']);
  const owned = c({ found: true, matched_manga: { title: 'X' }, matched_volume: { id: 9, status: 'Vorhanden', volume_number: '1' }, book: {} });
  assert.deepStrictEqual([owned.kind, owned.label], ['owned', 'X Band 1']);
  const ordered = c({ found: true, matched_manga: { title: 'X' }, matched_volume: { id: 9, status: 'Vorbestellt', volume_number: '2' }, book: {} });
  assert.deepStrictEqual([ordered.kind, ordered.label], ['check', 'X Band 2 (Status Vorbestellt)']);
  assert.strictEqual(c({ found: true, matched_manga: { title: 'X' }, book: { volume_number_known: false } }).kind, 'check');
  assert.strictEqual(c({ found: true, matched_manga: { title: 'X' }, book: { volume_number: '4' } }).label,
    'X Band 4: fehlt noch und steht nicht auf der Einkaufsliste');
  const candidates = c({ found: true, book: { title: 'Mein kleiner Bruder!', series: 'Kaguya-sama' }, matched_candidates: [{ title: 'A' }, { title: 'B' }] });
  assert.deepStrictEqual([candidates.kind, candidates.label], ['check', 'Kaguya-sama passt zu mehreren Reihen (A, B)']);
  assert.strictEqual(c({ found: true, book: { title: 'Neu' } }).kind, 'new');
  const unknown = c({ found: false });
  assert.deepStrictEqual([unknown.kind, unknown.label], ['unknown', '9780000000002']);
});

test('classifyShopScan labels never contain undefined and show special editions', () => {
  const items = [
    shopRow(),
    shopRow({ id: 8, isbn: '9783551000048', volume_number: '3', type: 'special_edition', notes: 'Collectors Edition' })
  ];
  const ce = helpers.classifyShopScan('9783551000048', { found: false }, items);
  assert.strictEqual(ce.label, 'Naruto Band 3 (Collectors Edition)');
  for (const isbn of ['9783551000031', '9783551000048']) {
    assert.doesNotMatch(helpers.classifyShopScan(isbn, { found: false }, items).label, /undefined/);
  }
  const viaMatch = helpers.classifyShopScan('9780000000002', { found: true, matched_volume: { id: 8, status: 'Fehlt' } }, items);
  assert.strictEqual(viaMatch.label, 'Naruto Band 3 (Collectors Edition)');
});

test('classifyShopScan: legacy Gelesen counts as owned, partner-owned volumes are not mine', () => {
  const data = (mv) => ({ found: true, matched_manga: { title: 'Naruto' }, matched_volume: { id: 4, volume_number: '4', ...mv }, book: {} });
  const read = helpers.classifyShopScan('9783551762948', data({ status: 'Gelesen' }), []);
  assert.deepStrictEqual([read.kind, read.label], ['owned', 'Naruto Band 4']);
  const partner = helpers.classifyShopScan('9783551762948', data({ status: 'Vorhanden', owned_by_me: false, owners: ['admin'] }), []);
  assert.deepStrictEqual([partner.kind, partner.label], ['partner', 'Naruto Band 4: bei admin vorhanden']);
  const objOwners = helpers.classifyShopScan('9783551762948', data({ status: 'Vorhanden', owned_by_me: false, owners: [{ user_id: 2, username: 'ed' }] }), []);
  assert.strictEqual(objOwners.label, 'Naruto Band 4: bei ed vorhanden');
  assert.strictEqual(helpers.classifyShopScan('9783551762948', data({ status: 'Vorhanden', owned_by_me: true }), []).kind, 'owned');
  assert.strictEqual(helpers.classifyShopScan('9783551762948', data({ status: 'Vorhanden' }), []).kind, 'owned');
});

test('toIsbn13 strips hyphens and converts valid ISBN-10 only', () => {
  assert.strictEqual(helpers.toIsbn13('978-3-551-76293-1'), '9783551762931');
  assert.strictEqual(helpers.toIsbn13('3-551-76293-7'), '9783551762931');
  assert.strictEqual(helpers.toIsbn13('1234567890'), '1234567890');
});

test('offline classifier uses the offline copy: owned, hyphenated and ISBN-10 stored, miss is offline', () => {
  const details = {
    3: { id: 3, title: 'Naruto', volumes: [
      { id: 31, volume_number: '1', isbn: '978-3-551-76293-1', status: 'Vorhanden', owned_by_me: true, owners: [{ username: 'me' }] },
      { id: 32, volume_number: '2', isbn: '3-551-76294-5', status: 'Vorhanden', owned_by_me: true },
      { id: 33, volume_number: '3', isbn: '9783551762955', status: 'Vorhanden', owned_by_me: false, owners: [{ username: 'ed' }] },
      { id: 34, volume_number: '4', isbn: null, status: 'Fehlt' }
    ] }
  };
  const index = helpers.buildIsbnIndex(details);
  assert.strictEqual(helpers.findVolumeByIsbn(index, '9783551762931').volume.id, 31);
  const owned = helpers.classifyShopScanOffline('9783551762931', index, []);
  assert.deepStrictEqual([owned.kind, owned.label, owned.offline], ['owned', 'Naruto Band 1 (offline geprüft)', true]);
  // stored as ISBN-10, scanned as EAN-13
  assert.strictEqual(helpers.classifyShopScanOffline('9783551762948', index, []).kind, 'owned');
  assert.strictEqual(helpers.classifyShopScanOffline('9783551762955', index, []).kind, 'partner');
  const miss = helpers.classifyShopScanOffline('9780000000002', index, []);
  assert.deepStrictEqual([miss.kind, miss.offline], ['offline', true]);
  assert.notStrictEqual(miss.kind, 'unknown');
  assert.strictEqual(helpers.classifyShopScanOffline('9780000000002', null, []).kind, 'offline');
  const listed = helpers.classifyShopScanOffline('9783551000031', index, [shopRow()]);
  assert.deepStrictEqual([listed.kind, listed.itemId], ['buy', 7]);
});

test('classifyLocalHit: a hit of the offline-copy index carries its source and note; a buy is provisional too', () => {
  const hit = { manga: { id: 3, title: 'Naruto' }, volume: { id: 31, status: 'Vorhanden', owned_by_me: true, display_title: 'Band 1 (Collectors Edition)' } };
  const owned = helpers.classifyLocalHit('9783551762931', hit, [], { note: helpers.localSourceNote('vor 3 Min.'), source: 'local' });
  assert.deepStrictEqual(
    [owned.kind, owned.label, owned.offline, owned.source],
    ['owned', 'Naruto Band 1 (Collectors Edition) (Stand Offline-Kopie vor 3 Min.)', true, 'local']
  );
  const partner = helpers.classifyLocalHit('9783551762931', { ...hit, volume: { ...hit.volume, owned_by_me: false, owners: ['ed'] } }, []);
  assert.deepStrictEqual([partner.kind, partner.source], ['partner', 'offline']);
  assert.match(partner.label, /bei ed vorhanden \(offline geprüft\)$/);
  const missing = { ...hit, volume: { id: 7, status: 'Fehlt', display_title: 'Band 3' } };
  const buy = helpers.classifyLocalHit('9783551000031', missing, [shopRow()], { source: 'local' });
  assert.deepStrictEqual([buy.kind, buy.offline, buy.source, buy.itemId], ['buy', true, 'local', 7]);
  assert.match(buy.label, /\(offline geprüft\)$/);
  assert.strictEqual(helpers.isBookable(buy), false, 'a provisional buy waits for the server');
  const confirmed = helpers.mergeScanEntry([buy], helpers.classifyShopScan('9783551000031', { found: false }, [shopRow()]));
  assert.deepStrictEqual([confirmed[0].kind, confirmed[0].offline], ['buy', undefined], 'the server answer replaces it');
  assert.strictEqual(helpers.isBookable(confirmed[0]), true);
  assert.strictEqual(helpers.isBookable({ ...confirmed[0], done: true }), false);
  assert.strictEqual(helpers.localSourceNote(''), 'Stand Offline-Kopie');
  assert.strictEqual(helpers.classifyShopScanOffline('9783551762931', hit, []).label, 'Naruto Band 1 (Collectors Edition) (offline geprüft)');
});

test('parseSharedScan: first ISBN with a valid check digit, else a manga-passion.de link', () => {
  assert.deepStrictEqual(helpers.parseSharedScan({ text: 'Schau mal: ISBN 978-3-551-75451-6, 7,50 €' }), { isbn: '9783551754516' });
  assert.deepStrictEqual(helpers.parseSharedScan({ text: 'ISBN-10 3551754519' }), { isbn: '9783551754516' });
  assert.deepStrictEqual(helpers.parseSharedScan({ text: 'Bestellnr. 9783551754517' }), null);
  assert.deepStrictEqual(
    helpers.parseSharedScan({ text: 'Band 3', url: 'https://www.manga-passion.de/volumes/12345' }),
    { mpUrl: 'https://www.manga-passion.de/volumes/12345' }
  );
  assert.deepStrictEqual(
    helpers.parseSharedScan({ text: '9783551754516 https://manga-passion.de/volumes/1' }),
    { isbn: '9783551754516' }
  );
  assert.strictEqual(helpers.parseSharedScan({}), null);
  assert.strictEqual(helpers.parseSharedScan(), null);
});

test('lookupFailureKind: only gateway/server failures count as offline', () => {
  assert.strictEqual(helpers.lookupFailureKind(503), 'offline');
  assert.strictEqual(helpers.lookupFailureKind(500), 'offline');
  assert.strictEqual(helpers.lookupFailureKind(429), 'offline');
  assert.strictEqual(helpers.lookupFailureKind(401), 'auth');
  assert.strictEqual(helpers.lookupFailureKind(400), 'error');
});

test('mergeScanEntry replaces unknown/offline/pending in place and keeps results and booked entries', () => {
  const a = { isbn: '1', kind: 'owned', label: 'A' };
  const off = { isbn: '2', kind: 'offline', label: '2', offline: true };
  const unknown = { isbn: '3', kind: 'unknown', label: '3' };
  let list = [a, off, unknown];
  list = helpers.mergeScanEntry(list, { isbn: '2', kind: 'owned', label: 'B' });
  assert.deepStrictEqual(list.map((e) => e.kind), ['owned', 'owned', 'unknown']);
  list = helpers.mergeScanEntry(list, { isbn: '3', kind: 'buy', label: 'C', itemId: 5 });
  assert.strictEqual(list[2].kind, 'buy');
  // same-kind duplicate of a real result is ignored
  assert.strictEqual(helpers.mergeScanEntry(list, { isbn: '1', kind: 'owned', label: 'other' }), list);
  // done/booking buy entries are never replaced
  const done = [{ isbn: '4', kind: 'buy', done: true }, { isbn: '5', kind: 'unknown', booking: true }];
  assert.strictEqual(helpers.mergeScanEntry(done, { isbn: '4', kind: 'owned' }), done);
  assert.strictEqual(helpers.mergeScanEntry(done, { isbn: '5', kind: 'owned' }), done);
  // pending placeholder: blocks a second lookup, is replaced by the result
  let p = helpers.mergeScanEntry([], { isbn: '6', kind: 'pending', label: '6' });
  assert.strictEqual(helpers.canStartLookup(p, '6'), false);
  assert.strictEqual(helpers.mergeScanEntry(p, { isbn: '6', kind: 'pending' }), p);
  p = helpers.mergeScanEntry(p, { isbn: '6', kind: 'offline', label: '6', offline: true });
  assert.strictEqual(p[0].kind, 'offline');
  assert.strictEqual(helpers.canStartLookup(p, '6'), true);
  assert.strictEqual(helpers.canStartLookup([a], '1'), false);
  // a still-offline rescan does not churn the entry
  assert.strictEqual(helpers.mergeScanEntry(p, { isbn: '6', kind: 'offline', offline: true }), p);
});

test('applyBookingResults marks only successes done; summary counts failures', () => {
  const list = [
    { isbn: '1', kind: 'buy', itemId: 1, booking: true },
    { isbn: '2', kind: 'buy', itemId: 2, booking: true },
    { isbn: '3', kind: 'buy', itemId: 3, booking: true },
    { isbn: '4', kind: 'buy', itemId: 4 }
  ];
  const results = [
    { isbn: '1', status: 'ok' },
    { isbn: '2', status: 'queued' },
    { isbn: '3', status: 'failed', error: 'Sitzung abgelaufen' }
  ];
  const next = helpers.applyBookingResults(list, results);
  assert.deepStrictEqual(next.map((e) => Boolean(e.done)), [true, true, false, false]);
  assert.strictEqual(next[1].queued, true);
  assert.deepStrictEqual([next[2].failed, next[2].error, next[2].booking], [true, 'Sitzung abgelaufen', undefined]);
  assert.strictEqual(next[3], list[3]);
  // a retry that succeeds clears the error
  const retried = helpers.applyBookingResults(next, [{ isbn: '3', status: 'ok' }]);
  assert.deepStrictEqual([retried[2].done, retried[2].failed, retried[2].error], [true, undefined, undefined]);
  assert.strictEqual(helpers.bookingSummary(results, 4), '2 von 4 gebucht, 1 vorgemerkt, 1 nicht versucht. Fehler: Sitzung abgelaufen');
  assert.strictEqual(helpers.bookingSummary([{ isbn: '1', status: 'ok' }], 1), '');
});

test('normalizeBuyOutcome and shouldStopBooking', () => {
  assert.deepStrictEqual(helpers.normalizeBuyOutcome('ok'), { status: 'ok', error: '', httpStatus: null, batch: false });
  assert.strictEqual(helpers.normalizeBuyOutcome(undefined).status, 'failed');
  const legacyFail = helpers.normalizeBuyOutcome('failed');
  assert.strictEqual(helpers.shouldStopBooking(legacyFail), true);
  const conflict = helpers.normalizeBuyOutcome({ status: 'failed', error: 'x', httpStatus: 409 });
  assert.strictEqual(helpers.shouldStopBooking(conflict), false);
  assert.strictEqual(helpers.shouldStopBooking(helpers.normalizeBuyOutcome({ status: 'failed', httpStatus: 401 })), true);
  assert.strictEqual(helpers.shouldStopBooking(helpers.normalizeBuyOutcome('queued')), false);
});

const memoryStorage = () => {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map };
};

test('scan list persistence: round trip, ttl, other user, broken JSON, throwing storage', () => {
  const s = memoryStorage();
  const entries = [{ isbn: '1', kind: 'buy', itemId: 1, booking: true }, { isbn: '2', kind: 'pending', label: '2' }];
  assert.strictEqual(helpers.saveScanList(s, entries, { userId: 1, now: 1000 }), true);
  const back = helpers.loadScanList(s, { userId: 1, now: 2000 });
  assert.deepStrictEqual(back[0], { isbn: '1', kind: 'buy', itemId: 1 });
  assert.strictEqual(back[1].kind, 'offline');
  assert.deepStrictEqual(helpers.loadScanList(s, { userId: 2, now: 2000 }), []);
  assert.deepStrictEqual(helpers.loadScanList(s, { userId: 1, now: 1000 + helpers.SCAN_LIST_TTL_MS + 1 }), []);
  helpers.saveScanList(s, [], { userId: 1 });
  assert.strictEqual(s.map.has(helpers.SCAN_LIST_KEY), false);
  s.setItem(helpers.SCAN_LIST_KEY, '{broken');
  assert.deepStrictEqual(helpers.loadScanList(s), []);
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('x'); } };
  assert.deepStrictEqual(helpers.loadScanList(throwing), []);
  assert.strictEqual(helpers.saveScanList(throwing, entries), false);
  assert.strictEqual(helpers.saveScanList(null, entries), false);
});

test('reconcileScanList drops open buy entries that left the shopping list', () => {
  const list = [
    { isbn: '1', kind: 'buy', itemId: 1 },
    { isbn: '2', kind: 'buy', itemId: 2 },
    { isbn: '3', kind: 'buy', itemId: 3, done: true },
    { isbn: '4', kind: 'buy', itemId: 4, booking: true },
    { isbn: '5', kind: 'owned' }
  ];
  assert.deepStrictEqual(helpers.reconcileScanList(list, [{ id: 1 }]).map((e) => e.isbn), ['1', '3', '4', '5']);
  assert.strictEqual(helpers.reconcileScanList(list, [{ id: 1 }, { id: 2 }]), list);
  assert.strictEqual(helpers.reconcileScanList(list, undefined), list);
});

test('filterShoppingItems: search, publisher chip, priority sort without mutating', () => {
  const norm = (p) => (p === 'Carlsen Manga!' ? 'Carlsen Manga' : p);
  const items = [
    shopRow({ id: 1, manga_title: 'Naruto', effective_publisher: 'Carlsen Manga!', priority: 1 }),
    shopRow({ id: 2, manga_title: 'One Piece', volume_number: '12', effective_publisher: 'Carlsen Manga', priority: 3 }),
    shopRow({ id: 3, manga_title: 'Berserk', effective_publisher: 'Panini', type: 'special_edition', notes: 'Collectors Edition' })
  ];
  const copy = items.slice();
  const ids = (opts) => helpers.filterShoppingItems(items, { normalizePubName: norm, ...opts }).map((i) => i.id);
  assert.deepStrictEqual(ids({ publisherFilter: 'Carlsen Manga' }), [1, 2]);
  assert.deepStrictEqual(ids({ search: 'piece' }), [2]);
  assert.deepStrictEqual(ids({ search: 'zzzz' }), []);
  assert.deepStrictEqual(ids({ search: 'collectors' }), [3]);
  assert.deepStrictEqual(ids({ search: 'one piece 12' }), [2]);
  assert.deepStrictEqual(ids({ search: 'carlsen naruto' }), [1]);
  assert.deepStrictEqual(ids({ prioritySort: true }), [2, 1, 3]);
  assert.deepStrictEqual(items, copy);
});

test('filterShoppingItems: folded, token-based search (accents, hyphens, one typo)', () => {
  const items = [
    shopRow({ id: 1, manga_title: 'Pokémon Adventures' }),
    shopRow({ id: 2, manga_title: 'One-Punch Man' }),
    shopRow({ id: 3, manga_title: 'Attack on Titan' })
  ];
  const ids = (search) => helpers.filterShoppingItems(items, { search }).map((i) => i.id);
  assert.deepStrictEqual(ids('pokemon'), [1]);
  assert.deepStrictEqual(ids('one punch'), [2]);
  assert.deepStrictEqual(ids('atack'), [3]);
  assert.deepStrictEqual(ids('   '), [1, 2, 3]);
});

test('scan session: 12 h in localStorage under its own key', () => {
  assert.strictEqual(helpers.SCAN_LIST_KEY, 'mangashelf_shop_session');
  assert.strictEqual(helpers.SCAN_LIST_TTL_MS, 12 * 60 * 60 * 1000);
});

test('recountPublishers and resolvePublisherFilter follow the remaining items', () => {
  const norm = (p) => (p === 'Carlsen Manga!' ? 'Carlsen Manga' : p);
  const data = {
    publishers: [{ publisher: 'Carlsen Manga', count: 2 }, { publisher: 'Panini', count: 1 }, { publisher: 'Unbekannt', count: 1 }],
    items: [shopRow({ id: 1, effective_publisher: 'Carlsen Manga!' }), shopRow({ id: 2, effective_publisher: null })]
  };
  const chips = helpers.recountPublishers(data, norm);
  assert.deepStrictEqual(chips.map((p) => [p.publisher, p.count]), [['Carlsen Manga', 1], ['Unbekannt', 1]]);
  assert.deepStrictEqual(helpers.filterShoppingItems(data.items, { publisherFilter: 'Unbekannt', normalizePubName: norm }).map((i) => i.id), [2]);
  assert.strictEqual(helpers.resolvePublisherFilter('Panini', chips), 'ALL');
  assert.strictEqual(helpers.resolvePublisherFilter('carlsen manga', chips), 'carlsen manga');
  assert.strictEqual(helpers.resolvePublisherFilter('ALL', []), 'ALL');
});

test('formatShoppingStand shows the day when the cache is not from today', () => {
  const now = new Date(2026, 9, 3, 18, 0);
  assert.strictEqual(helpers.formatShoppingStand(new Date(2026, 9, 3, 14, 5).getTime(), now), 'heute, 14:05 Uhr');
  assert.strictEqual(helpers.formatShoppingStand(new Date(2026, 8, 28, 9, 7).getTime(), now), '28.09., 09:07 Uhr');
  assert.strictEqual(helpers.formatShoppingStand(new Date(2025, 11, 31, 9, 7).getTime(), now), '31.12.2025, 09:07 Uhr');
  assert.strictEqual(helpers.formatShoppingStand(null, now), '');
});

test('pickIsbnBarcode prefers the ISBN over price stickers and code 128', () => {
  assert.strictEqual(helpers.pickIsbnBarcode([
    { rawValue: '4012345000009', format: 'ean_13' },
    { rawValue: 'PRICE-0799', format: 'code_128' },
    { rawValue: '9783551762931', format: 'ean_13' }
  ]), '9783551762931');
  assert.strictEqual(helpers.pickIsbnBarcode([{ rawValue: 'X1', format: 'code_128' }, { rawValue: '9791032705384', format: 'ean_13' }]), '9791032705384');
  assert.strictEqual(helpers.pickIsbnBarcode([{ rawValue: 'X1', format: 'code_128' }, { rawValue: '4012345000009', format: 'ean_13' }]), '4012345000009');
  assert.strictEqual(helpers.pickIsbnBarcode([{ rawValue: 'X1', format: 'code_128' }]), 'X1');
  assert.strictEqual(helpers.pickIsbnBarcode([]), null);
  assert.strictEqual(helpers.pickIsbnBarcode(undefined), null);
});

test('computeScaledSize keeps the aspect ratio and never upscales', () => {
  assert.deepStrictEqual(helpers.computeScaledSize(4032, 3024, 1600), { width: 1600, height: 1200 });
  assert.deepStrictEqual(helpers.computeScaledSize(3024, 4032, 1600), { width: 1200, height: 1600 });
  assert.deepStrictEqual(helpers.computeScaledSize(800, 600, 1600), { width: 800, height: 600 });
  assert.deepStrictEqual(helpers.computeScaledSize(0, 0, 1600), { width: 1, height: 1 });
});
