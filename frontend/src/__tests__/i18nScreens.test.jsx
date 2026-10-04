// German render-text baseline of the main screens: wrapping texts in t()/tn()/rich() must not change one byte.
// Update the baseline only for intended text changes: UPDATE_I18N_BASELINE=1 npx vitest run src/__tests__/i18nScreens.test.jsx
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SCREENS, renderScreen } from './i18nScreens.jsx';
import { getLanguage } from '../i18n/index.js';

const BASELINE = path.join(import.meta.dirname, '__snapshots__', 'i18nScreens.de.json');
const update = import.meta.env.UPDATE_I18N_BASELINE === '1' || globalThis.process?.env.UPDATE_I18N_BASELINE === '1';
const stored = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {};
const fresh = {};

afterAll(() => {
  if (update) fs.writeFileSync(BASELINE, `${JSON.stringify(fresh, null, 1)}\n`);
});

describe('German screen texts stay byte-identical', () => {
  for (const screen of SCREENS) {
    it(screen.name, async () => {
      expect(getLanguage()).toBe('de');
      const lines = await renderScreen(screen);
      expect(lines.length).toBeGreaterThan(2);
      fresh[screen.name] = lines;
      if (!update) expect(lines).toEqual(stored[screen.name]);
    }, 20000);
  }
});
