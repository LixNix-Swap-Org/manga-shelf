// i18n core: German source keys, interpolation, plural categories, language switch, boot detection, formatting.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  t, tn, tc, msg, richParts, setLanguage, initI18n, getLanguage, getLocaleTag, subscribe, matchLanguage, localeTagFor,
  deviceLanguage, followDevice, getStoredLanguage, LOCALE_KEY, LANGUAGES, __setCatalogForTests, resetI18nForTests
} from '../i18n/index.js';
import { formatCount, formatNumber, formatDate, formatRelative, getLocale } from '../utils/format.js';
import { serverText, CODE_TEXTS } from '../i18n/serverText.js';
import {
  statusLabel, mangaStatusLabel, conditionLabel, collectingLabel, volumeTypeLabel, genreLabel, animeProgressLabel, GENRE_NAMES
} from '../utils/enumLabels.js';
import { GENRE_DE } from '../utils/tags.js';
import { VOLUME_CONDITIONS } from '../utils/volumeHelpers.js';
import { PROGRESS_STATUSES } from '../utils/animeHelpers.js';
import { COLLECTING_OPTIONS } from '../utils/seriesMeta.js';

afterEach(() => {
  resetI18nForTests();
  localStorage.clear();
  document.documentElement.lang = 'de';
  document.head.innerHTML = '';
});

describe('t / tn in German (the source language)', () => {
  it('returns the source, fills {name} like JSX children and keeps unknown names', () => {
    expect(getLanguage()).toBe('de');
    expect(t('Zur Übersicht')).toBe('Zur Übersicht');
    expect(t('Mindestens {min} Zeichen', { min: 8 })).toBe('Mindestens 8 Zeichen');
    expect(t('{a} und {b}', { a: 'x' })).toBe('x und {b}');
    expect(t('Wert: {v}', { v: null })).toBe('Wert: ');
    expect(msg('Markiert')).toBe('Markiert');
    expect(tc('Verb', 'Lesen')).toBe('Lesen');
  });

  it('tn picks singular/plural by the German rules; {n} is the formatted number', () => {
    expect(tn('Band', 'Bände', 1)).toBe('Band');
    expect(tn('Band', 'Bände', 0)).toBe('Bände');
    expect(tn('Band', 'Bände', 1.5)).toBe('Bände');
    expect(tn('{n} Band', '{n} Bände', 1234)).toBe('1.234 Bände');
  });

  it('richParts splits at placeholders and keeps the raw values', () => {
    const node = { type: 'strong' };
    expect(richParts('Angemeldet als {name}.', { name: node })).toEqual(['Angemeldet als ', node, '.']);
  });
});

describe('catalog languages', () => {
  it('translates through the catalog, falls back to German for a missing key', () => {
    // jsdom reports en-US: a German device keeps the en-GB formats
    __setCatalogForTests('en', { 'Zur Übersicht': 'To the overview', 'Mindestens {min} Zeichen': 'At least {min} characters' }, { languages: ['de-DE'] });
    expect(t('Zur Übersicht')).toBe('To the overview');
    expect(t('Mindestens {min} Zeichen', { min: 8 })).toBe('At least 8 characters');
    expect(t('Nicht übersetzt')).toBe('Nicht übersetzt');
    expect(getLocaleTag()).toBe('en-GB');
  });

  it('tn uses every plural category of the language (pl one/few/many, ja only other)', () => {
    const key = 'Band|Bände';
    __setCatalogForTests('pl', { [key]: { one: '{n} tom', few: '{n} tomy', many: '{n} tomów', other: '{n} tomu' } });
    expect([1, 2, 5, 22, 1.5].map((n) => tn('Band', 'Bände', n))).toEqual(['1 tom', '2 tomy', '5 tomów', '22 tomy', '1,5 tomu']);
    __setCatalogForTests('ja', { [key]: { other: '{n}巻' } });
    expect(tn('Band', 'Bände', 1)).toBe('1巻');
    __setCatalogForTests('en', { [key]: { one: 'volume', other: 'volumes' } });
    expect(tn('Band', 'Bände', 1)).toBe('volume');
    expect(tn('Band', 'Bände', 3)).toBe('volumes');
  });

  it('tc reads `context::source` and otherwise the plain key', () => {
    __setCatalogForTests('en', { 'Verb::Lesen': 'Read (verb)', Lesen: 'Reading' });
    expect(tc('Verb', 'Lesen')).toBe('Read (verb)');
    expect(tc('Nomen', 'Lesen')).toBe('Reading');
  });

  it('format.js follows the language: numbers, dates, counts and "gerade eben"', () => {
    expect(formatCount(2, 'Band', 'Bände')).toBe('2 Bände');
    expect(formatNumber(1234.5, 1)).toBe('1.234,5');
    __setCatalogForTests('en', { 'Band|Bände': { one: 'volume', other: 'volumes' }, 'gerade eben': 'just now' }, { languages: ['de-DE'] });
    expect(getLocale()).toBe('en-GB');
    expect(formatCount(2, 'Band', 'Bände')).toBe('2 volumes');
    expect(formatCount(1, 'Band', 'Bände')).toBe('1 volume');
    expect(formatNumber(1234.5, 1)).toBe('1,234.5');
    expect(formatDate('2026-11-12')).toBe('12/11/2026');
    expect(formatRelative(Date.now())).toBe('just now');
    __setCatalogForTests('de');
    expect(formatCount(2, 'Band', 'Bände')).toBe('2 Bände');
  });
});

describe('language detection and switching', () => {
  it('matches the nearest language: exact tag, then primary subtag, else null', () => {
    expect(matchLanguage(['en-US'])).toBe('en');
    expect(matchLanguage(['sv-SE', 'en-AU'])).toBe('en');
    expect(matchLanguage(['fr-FR', 'en-AU'])).toBe('fr');
    expect(matchLanguage(['de-AT'])).toBe('de');
    expect(matchLanguage(['pt-PT'])).toBe('pt-BR');
    expect(matchLanguage(['zh-CN'])).toBe('zh-Hans');
    expect(matchLanguage(['zh-hans'])).toBe('zh-Hans');
    expect(matchLanguage(['sv'])).toBe(null);
    expect(deviceLanguage({ languages: ['sv-SE'] })).toBe('de');
    expect(LANGUAGES.map((l) => l.name)).toEqual(['Deutsch', 'English', 'Français', 'Español', 'Italiano', 'Português (Brasil)',
      'Nederlands', 'Polski', '日本語', '한국어', '简体中文', 'Русский', 'Türkçe']);
  });

  it('every language has the formatting tag of contract decision 1', () => {
    const tags = Object.fromEntries(LANGUAGES.map((l) => [l.code, l.tag]));
    expect(tags).toEqual({
      de: 'de-DE', en: 'en-GB', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', 'pt-BR': 'pt-BR', nl: 'nl-NL',
      pl: 'pl-PL', ja: 'ja-JP', ko: 'ko-KR', 'zh-Hans': 'zh-CN', ru: 'ru-RU', tr: 'tr-TR'
    });
    for (const { code, tag } of LANGUAGES) expect(localeTagFor(code, 'en-US'), code).toBe(code === 'en' ? 'en-US' : tag);
  });

  it('English formats as en-GB unless the device says en-<REGION>', () => {
    expect(localeTagFor('en', 'en-US')).toBe('en-US');
    expect(localeTagFor('en', 'de-DE')).toBe('en-GB');
    expect(localeTagFor('de', 'en-US')).toBe('de-DE');
  });

  it('importing never detects: a stubbed English browser stays German until initI18n', async () => {
    vi.stubGlobal('navigator', { ...navigator, languages: ['en-US'], language: 'en-US' });
    vi.resetModules();
    const fresh = await import('../i18n/index.js');
    expect(fresh.getLanguage()).toBe('de');
    expect(fresh.t('Sprache')).toBe('Sprache');
  });

  it('initI18n: stored choice, then the device languages, then German', async () => {
    expect(await initI18n({ env: { languages: ['en-US'] } })).toBe('en');
    expect(getStoredLanguage()).toBe(null);
    expect(getLocaleTag()).toBe('en-US');
    expect(await initI18n({ env: { languages: ['sv-SE'] } })).toBe('de');
    expect(await initI18n({ env: { languages: ['ja-JP'] } })).toBe('ja');
    expect(getLocaleTag()).toBe('ja-JP');
    localStorage.setItem(LOCALE_KEY, 'en');
    expect(await initI18n({ env: { languages: ['de-DE'] } })).toBe('en');
    localStorage.setItem(LOCALE_KEY, 'xx');
    expect(await initI18n({ env: { languages: [] } })).toBe('de');
  });

  it('the Electron bridge locale comes before navigator.languages', async () => {
    window.mangashelfDesktop = { locale: 'en-GB' };
    try {
      vi.stubGlobal('navigator', { ...navigator, languages: ['de-DE'], language: 'de-DE' });
      expect(await initI18n()).toBe('en');
    } finally {
      delete window.mangashelfDesktop;
    }
  });

  it('setLanguage loads the catalog first, then notifies, sets <html lang>, the manifest link and the stored choice', async () => {
    document.head.innerHTML = '<link rel="manifest" href="/manifest.json">';
    const seen = [];
    const off = subscribe((code) => seen.push([code, t('Sprache'), document.documentElement.lang]));
    await setLanguage('en');
    expect(seen).toEqual([['en', t('Sprache'), 'en']]);
    expect(document.querySelector('link[rel=manifest]').getAttribute('href')).toBe('/manifest.en.json');
    expect(localStorage.getItem(LOCALE_KEY)).toBe('en');
    await setLanguage('de');
    expect(document.querySelector('link[rel=manifest]').getAttribute('href')).toBe('/manifest.json');
    expect(document.documentElement.lang).toBe('de');
    off();
    await setLanguage('en', { persist: false });
    expect(seen).toHaveLength(2);
    expect(localStorage.getItem(LOCALE_KEY)).toBe('de');
  });

  it('the app build keeps its relative manifest path; followDevice forgets the choice', async () => {
    document.head.innerHTML = '<link rel="manifest" href="./manifest.json">';
    await setLanguage('en');
    expect(document.querySelector('link[rel=manifest]').getAttribute('href')).toBe('./manifest.en.json');
    await followDevice({ env: { languages: ['de-CH'] } });
    expect(getLanguage()).toBe('de');
    expect(localStorage.getItem(LOCALE_KEY)).toBe(null);
  });

  it('an unknown code falls back to German', async () => {
    expect(await setLanguage('klingon')).toBe('de');
  });
});

describe('server texts', () => {
  it('German: always the server text byte for byte', () => {
    expect(serverText({ error: 'Band nicht gefunden', code: 'NOT_FOUND' })).toBe('Band nicht gefunden');
    expect(serverText({ error: 'Zu viele (maximal 5)', msg: 'Zu viele (maximal {max})', params: { max: 5 } })).toBe('Zu viele (maximal 5)');
    expect(serverText({ code: 'X' })).toBe('');
    expect(serverText(null)).toBe('');
  });

  it('other languages: owned code text, then msg template with params, then the exact text, else German', () => {
    __setCatalogForTests('en', {
      'Band nicht gefunden': 'Volume not found',
      'Zu viele (maximal {max})': 'Too many (at most {max})',
      [CODE_TEXTS.SESSION_INVALID]: 'Session expired',
      Alternativtitel: 'Alternative title',
      '{field} ist zu lang': '{field} is too long'
    });
    expect(serverText({ error: 'Band nicht gefunden', code: 'NOT_FOUND' })).toBe('Volume not found');
    expect(serverText({ error: 'Zu viele (maximal 1000)', msg: 'Zu viele (maximal {max})', params: { max: 1000 } })).toBe('Too many (at most 1,000)');
    expect(serverText({ error: 'Alternativtitel ist zu lang', msg: '{field} ist zu lang', params: { field: { msg: 'Alternativtitel', params: {} } } })).toBe('Alternative title is too long');
    expect(serverText({ error: CODE_TEXTS.SESSION_INVALID, code: 'SESSION_INVALID' })).toBe('Session expired');
    expect(serverText({ error: 'Unbekannter Text' })).toBe('Unbekannter Text');
  });

  it('a nested message param ({ msg, params }, a cause inside a sentence) is filled like the outer one', () => {
    __setCatalogForTests('en', {
      'Fehler beim Wiederherstellen: {reason}': 'Restore failed: {reason}',
      'Kein Platz (frei: {free})': 'No space (free: {free})',
      'Archiv ungültig': 'Invalid archive'
    });
    const nested = { error: 'Fehler beim Wiederherstellen: Kein Platz (frei: 3 MB)', msg: 'Fehler beim Wiederherstellen: {reason}', params: { reason: { msg: 'Kein Platz (frei: {free})', params: { free: '3 MB' } } } };
    expect(serverText(nested)).toBe('Restore failed: No space (free: 3 MB)');
    expect(serverText({ error: 'Fehler beim Wiederherstellen: Archiv ungültig', msg: 'Fehler beim Wiederherstellen: {reason}', params: { reason: { msg: 'Archiv ungültig', params: {} } } })).toBe('Restore failed: Invalid archive');
    __setCatalogForTests('de');
    expect(serverText(nested)).toBe('Fehler beim Wiederherstellen: Kein Platz (frei: 3 MB)');
  });
});

describe('labels of stored values', () => {
  it('show the stored value in German and pass unknown values through', () => {
    expect(statusLabel('Vorhanden')).toBe('Vorhanden');
    expect(mangaStatusLabel('Laufend')).toBe('Laufend');
    expect(conditionLabel('frei getippt')).toBe('frei getippt');
    expect(collectingLabel('abgebrochen')).toBe('Nicht mehr gesammelt');
    expect(volumeTypeLabel('special')).toBe('Special / Extra');
    expect(genreLabel('Eigener Tag')).toBe('Eigener Tag');
  });

  it('translate in another language; values stay untouched', () => {
    __setCatalogForTests('en', { Vorhanden: 'Owned', Abenteuer: 'Adventure', 'Wird gesammelt': 'Collecting', Schaue: 'Watching' });
    expect(statusLabel('Vorhanden')).toBe('Owned');
    expect(genreLabel('Abenteuer')).toBe('Adventure');
    expect(collectingLabel('aktiv')).toBe('Collecting');
    expect(animeProgressLabel('Schaue')).toBe('Watching');
    expect(statusLabel('Fehlt')).toBe('Fehlt');
  });

  it('cover every stored value of the frontend lists', () => {
    expect(GENRE_NAMES.slice().sort()).toEqual([...new Set(Object.values(GENRE_DE))].sort());
    expect(VOLUME_CONDITIONS.every((c) => conditionLabel(c) === c)).toBe(true);
    expect(PROGRESS_STATUSES.every((s) => animeProgressLabel(s) === s)).toBe(true);
    expect(COLLECTING_OPTIONS.map((o) => collectingLabel(o.value))).toEqual(COLLECTING_OPTIONS.map((o) => o.label));
  });
});

describe('PWA manifest per language', () => {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'public', name), 'utf8'));

  const strip = (m) => ({ ...m, name: '', description: '', lang: '', shortcuts: m.shortcuts.map((s) => ({ ...s, name: '', short_name: '', description: '' })) });
  const texts = (m) => JSON.stringify([m.name, m.description, m.shortcuts.map((s) => [s.name, s.short_name, s.description])]);

  for (const { code } of LANGUAGES.filter((l) => l.code !== 'de')) {
    it(`manifest.${code}.json is manifest.json with ${code} texts only`, () => {
      const de = read('manifest.json');
      const own = read(`manifest.${code}.json`);
      expect(strip(own)).toEqual(strip(de));
      expect(own.lang).toBe(code);
      // Turkish writes ö and ü itself
      expect(texts(own)).not.toMatch(code === 'tr' ? /[äß]|Sammlung|Bände/ : /[äöüß]|Sammlung|Bände/);
    });
  }

  it('every language with a manifest file switches the manifest link to it', async () => {
    const files = fs.readdirSync(path.join(import.meta.dirname, '..', '..', 'public')).map((f) => /^manifest\.(.+)\.json$/.exec(f)?.[1]).filter(Boolean);
    expect(files.sort()).toEqual(LANGUAGES.filter((l) => l.code !== 'de').map((l) => l.code).sort());
    for (const code of files) {
      document.head.innerHTML = '<link rel="manifest" href="/manifest.json">';
      __setCatalogForTests(code, {});
      expect(document.querySelector('link[rel=manifest]').getAttribute('href'), code).toBe(`/manifest.${code}.json`);
    }
    __setCatalogForTests('de');
  });
});
