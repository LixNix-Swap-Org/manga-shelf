// core/lib/language.js: one normalisation of edition languages, regions, currencies and work keys.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseLanguage, normalizeLanguage, normalizeRegion, normalizeCurrency, isWorkKey, workKeyOfHit, preferredWorkKey, isMpLanguage,
    isManualWorkKey, isLanguageCode, manualWorkKey
} = require('../core/lib/language');

test('names, codes and BCP-47 tags become ISO 639-1 codes; a tag names the region', () => {
    const cases = [
        ['Deutsch', 'de', null], ['german', 'de', null], ['GER', 'de', null], ['Englisch', 'en', null], ['English', 'en', null],
        ['eng', 'en', null], ['ja', 'ja', null], ['JP', 'ja', null], ['Japanisch', 'ja', null], ['日本語', 'ja', null],
        ['Französisch', 'fr', null], ['Franzoesisch', 'fr', null], ['français', 'fr', null], ['Español', 'es', null],
        ['Koreanisch', 'ko', null], ['Chinesisch', 'zh', null], ['Niederländisch', 'nl', null], ['  FR ', 'fr', null],
        ['en-US', 'en', 'US'], ['de_DE', 'de', 'DE'], ['pt-BR', 'pt', 'BR'], ['zh-Hans-CN', 'zh', 'CN'], ['zh-Hant', 'zh', null],
        ['es-419', 'es', null], ['sw', 'sw', null], ['Türkçe', 'tr', null], ['Turkce', 'tr', null], ['Türkisch', 'tr', null]
    ];
    for (const [raw, language, region] of cases) assert.deepEqual(parseLanguage(raw), { language, region }, raw);
});

test('empty input means "not given", unknown text is null and falls back to the default', () => {
    for (const raw of [undefined, null, '', '   ']) assert.deepEqual(parseLanguage(raw), { language: null, region: null });
    for (const raw of ['Klingonisch', 'x-klingon', 'en-', 'Deutsch!', 42, {}]) assert.equal(parseLanguage(raw), null, String(raw));
    for (const raw of ['xx', 'zz', 'QQ', 'xx-US']) assert.equal(parseLanguage(raw), null, `${raw} is no ISO 639-1 code`);
    assert.ok(isLanguageCode('de') && isLanguageCode('zu') && !isLanguageCode('xx') && !isLanguageCode('DE'));
    assert.equal(normalizeLanguage('Klingonisch'), 'de');
    assert.equal(normalizeLanguage(null), 'de');
    assert.equal(normalizeLanguage('', 'en'), 'en');
    assert.equal(normalizeLanguage('Englisch', 'ja'), 'en');
});

test('regions are two letters, currencies three, both upper case', () => {
    assert.equal(normalizeRegion(' us '), 'US');
    for (const raw of ['USA', 'u', '', null, 12]) assert.equal(normalizeRegion(raw), null, String(raw));
    assert.equal(normalizeCurrency('usd'), 'USD');
    assert.equal(normalizeCurrency(' JPY'), 'JPY');
    for (const raw of ['€', 'EURO', 'EU', '', null]) assert.equal(normalizeCurrency(raw), null, String(raw));
});

test('work keys: allowed forms, lookup hits, and which key a merged group keeps', () => {
    for (const key of ['anilist:30002', 'mal:2', 'manual:17']) assert.ok(isWorkKey(key), key);
    for (const key of ['anilist:', 'kitsu:1', 'manual:a b', '', null, 'anilist:' + '1'.repeat(65)]) assert.ok(!isWorkKey(key), String(key));
    assert.equal(workKeyOfHit({ id: 'al_30002', source: 'anilist', mal_id: 2 }), 'anilist:30002', 'AniList before MyAnimeList');
    assert.equal(workKeyOfHit({ id: 'mal_2', source: 'mal' }), 'mal:2');
    assert.equal(workKeyOfHit({ id: 'mp_9', mal_id: 7 }), 'mal:7');
    assert.equal(workKeyOfHit({ id: 'mp_9' }), null);
    assert.equal(workKeyOfHit(null), null);
    assert.equal(preferredWorkKey('anilist:1', 'manual:5'), 'anilist:1', 'an AniList key wins');
    assert.equal(preferredWorkKey('mal:1', 'anilist:2'), 'anilist:2');
    assert.equal(preferredWorkKey('anilist:1', 'anilist:2'), 'anilist:2', 'else the target keeps its key');
    assert.equal(preferredWorkKey('mal:1', 'manual:5'), 'manual:5');
    assert.equal(preferredWorkKey(null, 'manual:5'), 'manual:5');
    assert.equal(preferredWorkKey('mal:1', null), 'mal:1');
    assert.equal(preferredWorkKey(null, null), null);
});

test('manual work keys are fresh random hex, never a series id', () => {
    const key = manualWorkKey('0f1e2d3c-4b5a-4968-8776-655443322110');
    assert.equal(key, 'manual:0f1e2d3c4b5a496887766554');
    assert.ok(isWorkKey(key) && isManualWorkKey(key));
    assert.ok(!isManualWorkKey('anilist:1') && !isManualWorkKey('manual:') && !isManualWorkKey(null));
});

test('Manga Passion only for German editions (a missing language counts as German)', () => {
    assert.ok(isMpLanguage('de'));
    assert.ok(isMpLanguage(null));
    assert.ok(!isMpLanguage('en'));
});
