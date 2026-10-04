// Catalogs against the extracted keys (scripts/i18n/extract.mjs), per UI language of LANGUAGES: every key translated,
// no stale keys, same placeholders, every plural category of the language, no German left in a translation.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { extract, catalogFiles, pluralCategories, missingTranslations } from '../../../scripts/i18n/extract.mjs';
import { readJson } from '../../../scripts/i18n/lib.mjs';
import { LANGUAGES, SOURCE_LANGUAGE } from '../i18n/index.js';
import { VOLUME_STATUS_VALUES, MANGA_STATUS_VALUES, CONDITION_VALUES, ANIME_PROGRESS_VALUES, GENRE_NAMES } from '../utils/enumLabels.js';

const STRICT = true;
const { UI_LOCALES } = createRequire(import.meta.url)('../../../core/lib/locales.js');
const { keys, problems } = extract();
const files = catalogFiles();
const translated = LANGUAGES.filter((l) => l.code !== SOURCE_LANGUAGE);
const catalogs = translated.map(({ code }) => ({ lang: code, catalog: readJson(files.find((f) => f.lang === code)?.file, {}) }));

const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
// unambiguous German function words (English shares in, an, so, die …)
const GERMAN_WORDS = /\b(der|das|und|nicht|kein|keine|ist|sind|wird|werden|mit|für|von|zum|zur|auf|bei|noch|auch|nur|schon|jetzt|bitte|oder|einen|einem|eines|dieser|diese|wurde|können|müssen|gibt|ohne|beim|vom)\b/i;
// Turkish writes ö and ü itself
const GERMAN_LETTERS = { tr: /[äÄß]/ };
const looksGerman = (lang, text) => (GERMAN_LETTERS[lang] || /[äöüÄÖÜß]/).test(text) || GERMAN_WORDS.test(text);

describe('i18n catalogs', () => {
  it('every UI language has a catalog and is a language the server accepts, and every catalog is a UI language', () => {
    for (const { code } of LANGUAGES) expect(UI_LOCALES, code).toContain(code);
    expect([...UI_LOCALES].sort()).toEqual(LANGUAGES.map((l) => l.code).sort());
    expect(files.map((f) => f.lang).sort()).toEqual(translated.map((l) => l.code).sort());
  });

  it('every language has its own name, a valid formatting tag and plural rules', () => {
    for (const { code, name, tag } of LANGUAGES) {
      expect(name, code).toBeTruthy();
      expect(Intl.getCanonicalLocales(tag)[0], code).toBe(tag);
      expect(pluralCategories(code), code).toContain('other');
    }
    expect(new Set(LANGUAGES.map((l) => l.name)).size).toBe(LANGUAGES.length);
  });

  it('the extractor finds no computed keys and every stored value of enumLabels', () => {
    expect(problems).toEqual([]);
    for (const value of [...VOLUME_STATUS_VALUES, ...MANGA_STATUS_VALUES, ...CONDITION_VALUES, ...ANIME_PROGRESS_VALUES, ...GENRE_NAMES]) {
      expect(keys.has(value), value).toBe(true);
    }
  });

  for (const { lang, catalog } of catalogs) {
    describe(lang, () => {
      it('has no stale keys', () => {
        expect(Object.keys(catalog).filter((key) => !keys.has(key))).toEqual([]);
      });

      it('keeps the placeholders and the plural categories of the language', () => {
        const categories = pluralCategories(lang);
        for (const [key, value] of Object.entries(catalog)) {
          const entry = keys.get(key);
          if (!entry) continue;
          if (entry.plural) {
            expect(value !== null && typeof value === 'object', key).toBe(true);
            const filled = Object.values(value).some(Boolean);
            if (filled) {
              expect(Object.keys(value).sort(), key).toEqual([...categories].sort());
              for (const form of Object.values(value)) expect(placeholders(form).filter((p) => p !== 'n'), key).toEqual(placeholders(key.split('|')[0]).filter((p) => p !== 'n'));
            }
          } else if (value) {
            expect(placeholders(value), key).toEqual(placeholders(key));
          }
        }
      });

      it('translations contain no German', () => {
        const german = Object.entries(catalog).filter(([, value]) => (typeof value === 'string' ? [value] : Object.values(value || {})).some((v) => v && looksGerman(lang, v)));
        expect(german.map(([key]) => key)).toEqual([]);
      });

      it(`translations are complete${STRICT ? '' : ' (report-only)'}`, () => {
        const missing = missingTranslations(keys, catalog);
        if (STRICT) expect(missing).toEqual([]);
        else expect(missing.length).toBeLessThanOrEqual(keys.size);
      });
    });
  }
});
