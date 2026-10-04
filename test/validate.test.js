const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../utils/validate');

test('parsePrice: German and plain prices, empty clears, junk and out-of-range are errors', () => {
    assert.deepEqual(v.parsePrice('7,50'), { value: 7.5 });
    assert.deepEqual(v.parsePrice('€ 7,99'), { value: 7.99 });
    assert.deepEqual(v.parsePrice('1.234,56'), { value: 1234.56 });
    assert.deepEqual(v.parsePrice(7.999), { value: 8 });
    assert.deepEqual(v.parsePrice(' '), { value: null });
    assert.deepEqual(v.parsePrice('EUR'), { value: null });
    for (const bad of ['abc', '7,555', -1, 100000, {}, '1e3']) assert.deepEqual(v.parsePrice(bad), { error: true }, String(bad));
});

test('parsePriority: 0 to 3, empty is 0, anything else null', () => {
    assert.equal(v.parsePriority(undefined), 0);
    assert.equal(v.parsePriority(''), 0);
    assert.equal(v.parsePriority('3'), 3);
    assert.equal(v.parsePriority(2), 2);
    for (const bad of [4, -1, 1.5, 'x']) assert.equal(v.parsePriority(bad), null, String(bad));
});

test('parseWishPriority: null or empty means not wished, 0 to 3 as number or digit, rest is an error', () => {
    assert.deepEqual(v.parseWishPriority(null), { value: null });
    assert.deepEqual(v.parseWishPriority(''), { value: null });
    assert.deepEqual(v.parseWishPriority(' '), { value: null });
    assert.deepEqual(v.parseWishPriority(0), { value: 0 });
    assert.deepEqual(v.parseWishPriority(' 3 '), { value: 3 });
    for (const bad of [4, -1, 1.5, '2a', true, {}, []]) assert.deepEqual(v.parseWishPriority(bad), { error: true }, JSON.stringify(bad));
});

test('dates: YYYY, YYYY-MM, YYYY-MM-DD that exist; read_at as SQLite writes it', () => {
    for (const ok of ['', null, '2024', '2024-02', '2024-02-29', ' 2024-01-01 ']) assert.equal(v.isValidDate(ok), true, String(ok));
    for (const bad of ['2023-02-29', '1899', '2024-13', '24-01-01', {}]) assert.equal(v.isValidDate(bad), false, String(bad));
    assert.deepEqual(v.parseDate(' 2024-05 '), { value: '2024-05' });
    assert.deepEqual(v.parseDate(''), { value: null });
    assert.deepEqual(v.parseDate('morgen'), { error: true });
    assert.equal(v.isValidReadAt('2024-05-01 13:45:00'), true);
    assert.equal(v.isValidReadAt('2024-05-01 24:00:00'), false);
    assert.equal(v.isValidReadAt('2024-05-01T13:45:00'), false);
});

test('integers and ids: ranges, digit strings only, optional ids', () => {
    assert.deepEqual(v.parsePages('120'), { value: 120 });
    assert.deepEqual(v.parsePages(0), { error: true });
    assert.deepEqual(v.parseYear(1899), { error: true });
    assert.deepEqual(v.parseYear(''), { value: null });
    assert.equal(v.parseWholeNumber(' 12 '), 12);
    assert.equal(v.parseWholeNumber('12abc'), null);
    assert.equal(v.parsePositiveInt('0'), null);
    assert.equal(v.parsePositiveInt(1.5), null);
    assert.equal(v.parsePositiveInt('7'), 7);
    assert.deepEqual(v.parseOptionalId(0), { value: null });
    assert.deepEqual(v.parseOptionalId('42'), { value: 42 });
    assert.deepEqual(v.parseOptionalId('x'), { error: true });
});

test('flags: lenient parseFlag for volume routes, strict parseTrueFlag with a fallback', () => {
    for (const no of [false, 0, null, 'false', '0', 'nein', 'NO', '']) assert.equal(v.parseFlag(no), false, String(no));
    for (const yes of [true, 1, 'true', 'ja', 'x']) assert.equal(v.parseFlag(yes), true, String(yes));
    assert.equal(v.parseTrueFlag(undefined, true), true);
    assert.equal(v.parseTrueFlag('ja', true), false);
    assert.equal(v.parseTrueFlag('1', false), true);
});

test('status whitelists are shared', () => {
    assert.deepEqual(v.VOLUME_STATUSES, ['Vorhanden', 'Fehlt', 'Vorbestellt', 'Erscheint bald', 'Bestellt']);
    assert.ok(v.MANGA_STATUSES.includes('Geplant') && v.MANGA_STATUSES.includes('Abgebrochen'));
    assert.deepEqual(v.VOLUME_TYPES, ['volume', 'special_edition', 'schuber', 'special']);
});

test('bulk helpers: id lists, condition and the set object of a bulk edit', () => {
    assert.deepEqual(v.parseIdList([3, '4', 3], 5), { value: [3, 4] });
    for (const bad of [[], [0], ['1x'], [1.5], 'x', null, [1, 2, 3]]) assert.deepEqual(v.parseIdList(bad, 2), { error: true }, JSON.stringify(bad));
    assert.deepEqual(v.parseCondition(' Neu '), { value: 'Neu' });
    assert.deepEqual(v.parseCondition(''), { value: null });
    assert.deepEqual(v.parseCondition(5), { error: true });
    assert.deepEqual(v.parseCondition('x'.repeat(201)), { error: true });

    assert.deepEqual(v.parseBulkSet(undefined), { value: {} });
    assert.deepEqual(
        v.parseBulkSet({ status: 'Vorhanden', price: '7,50', purchase_date: '2024-06', condition: '', priority: '2', target_price: null, release_date: '' }),
        { value: { status: 'Vorhanden', price: 7.5, purchase_date: '2024-06', condition: null, priority: 2, target_price: null, release_date: null } }
    );
    assert.deepEqual(v.parseBulkSet({ status: 'Gelesen' }), { error: 'status' });
    assert.deepEqual(v.parseBulkSet({ priority: 5 }), { error: 'priority' });
    assert.deepEqual(v.parseBulkSet({ notes: 'x' }), { error: 'notes' });
    assert.deepEqual(v.parseBulkSet([]), { error: 'set' });
    assert.deepEqual(v.BULK_SET_FIELDS, ['status', 'price', 'purchase_date', 'condition', 'priority', 'target_price', 'release_date']);
});
