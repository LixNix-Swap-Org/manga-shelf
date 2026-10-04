// Render of the main screens in every UI language: German left on screen (umlaut/ß or German function words),
// recorded data excluded. Each language may leak at most its baseline (the lines that are content or product
// names, listed in the console report); the count may only shrink.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SCREENS, renderScreen } from './i18nScreens.jsx';
import fixtures from './fixtures/i18nScreens.json';
import { LANGUAGES, SOURCE_LANGUAGE, setLanguage, resetI18nForTests, getLanguage } from '../i18n/index.js';

// I18N-C, 2026-10-04: the Manga Passion gap message on the detail page (a 2xx payload text, shown raw until the
// payload package of wave D gives it a `message_msg`), twice: visible and in the status line
const LEAK_BASELINE = 2;
const GERMAN_WORDS = /\b(der|das|und|nicht|kein|keine|ist|sind|wird|werden|mit|für|von|zum|zur|auf|bei|noch|auch|nur|schon|jetzt|bitte|oder|einen|dieser|diese|Band|Bände|Reihe|Reihen|Sammlung|Einkaufsliste|Speichern|Schließen|Abbrechen|Löschen|Bearbeiten|Suchen|Zurück)\b/;
// Turkish writes ö and ü itself
const GERMAN_LETTERS = { tr: /[äÄß]/ };
const looksGerman = (code, text) => (GERMAN_LETTERS[code] || /[äöüÄÖÜß]/).test(text) || GERMAN_WORDS.test(text);
// the language select names every language in its own name ('Türkçe', 'Deutsch')
const AUTONYMS = new Set(LANGUAGES.map((l) => l.name));

// texts of the recorded data (titles, publishers, notes) are content, not UI
const content = new Set();
const collect = (value) => {
  if (typeof value === 'string') content.add(value.replace(/\s+/g, ' ').trim());
  else if (value && typeof value === 'object') Object.values(value).forEach(collect);
};
collect(fixtures.responses);
// longer recorded texts inside a UI line ('Note: <recorded note>') are content too
const longContent = [...content].filter((text) => text.length >= 8).sort((a, b) => b.length - a.length);
const withoutContent = (line) => longContent.reduce((rest, text) => (rest.includes(text) ? rest.split(text).join(' ') : rest), line);
const isLeak = (code, line) => !content.has(line) && !AUTONYMS.has(line) && looksGerman(code, withoutContent(line));

afterAll(() => resetI18nForTests());

for (const { code } of LANGUAGES.filter((l) => l.code !== SOURCE_LANGUAGE)) {
  describe(`${code} screens`, () => {
    const leaks = {};

    beforeAll(async () => {
      await setLanguage(code, { persist: false, env: { languages: [code] } });
    });

    afterAll(() => {
      const lines = Object.entries(leaks).flatMap(([s, list]) => list.map((l) => `  ${s}: ${l}`));
      console.info(`[i18n] ${code}: ${lines.length} Zeilen Deutsch${lines.length ? `\n${lines.join('\n')}` : ''}`);
    });

    for (const screen of SCREENS) {
      it(screen.name, async () => {
        expect(getLanguage()).toBe(code);
        const lines = await renderScreen(screen);
        leaks[screen.name] = lines.map((l) => l.replace(/^@[\w-]+: /, '')).filter((l) => isLeak(code, l));
      }, 20000);
    }

    it('leaks stay within the baseline', () => {
      const total = Object.values(leaks).reduce((n, list) => n + list.length, 0);
      expect(total).toBeLessThanOrEqual(LEAK_BASELINE);
    });
  });
}
