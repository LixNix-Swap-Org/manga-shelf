// Guard: German UI text outside t()/tn()/tc()/rich()/msg(), `// i18n`-marked declarations and `i18n-ignore` lines.
// Counted with the codemod's own analysis (what it would wrap plus its MANUAL cases). Strict since the end of wave
// I18N-B: any open text fails; mark text that must stay German with `// i18n-ignore` and a reason.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { transform } from '../../../scripts/i18n/codemod.mjs';
import { sourceFiles, rel } from '../../../scripts/i18n/lib.mjs';

// I18N-A, 2026-10-04: 2406 open (2007 codemod edits + 399 MANUAL cases); I18N-B integration, 2026-10-04: 0, strict
const OPEN_BASELINE = 0;

describe('i18n guard', () => {
  it('no German UI literal is left untranslated (strict)', () => {
    const perFile = [];
    let total = 0;
    for (const file of sourceFiles()) {
      const result = transform(file, fs.readFileSync(file, 'utf8'));
      expect(result.error, rel(file)).toBeUndefined();
      const open = result.edits.length + result.manual.length;
      if (open) perFile.push([rel(file), open]);
      total += open;
    }
    perFile.sort((a, b) => b[1] - a[1]);
    const detail = perFile.slice(0, 25).map(([f, n]) => `${String(n).padStart(4)} ${f}`).join('\n');
    expect(total, `offene deutsche Texte: ${total} (Grenze ${OPEN_BASELINE}); node scripts/i18n/codemod.mjs zeigt sie:\n${detail}`).toBeLessThanOrEqual(OPEN_BASELINE);
  }, 60000);

  it('the i18n modules themselves have nothing open', () => {
    for (const file of sourceFiles().filter((f) => /\/i18n\/|enumLabels|LanguageSelect|OfflineBanner/.test(f))) {
      const result = transform(file, fs.readFileSync(file, 'utf8'));
      expect([rel(file), result.edits.length, result.manual.length]).toEqual([rel(file), 0, 0]);
    }
  });
});
