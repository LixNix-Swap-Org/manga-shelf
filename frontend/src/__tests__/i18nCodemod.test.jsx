// The i18n tooling on its fixture: codemod output byte for byte, MANUAL cases, German render unchanged, idempotence,
// and the extractor's keys (scripts/i18n/codemod.mjs, extract.mjs).
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render, cleanup } from '@testing-library/react';
import { transform } from '../../../scripts/i18n/codemod.mjs';
import { extract } from '../../../scripts/i18n/extract.mjs';
import { cleanJsxText, isGerman } from '../../../scripts/i18n/lib.mjs';
import Input from '../i18n/__fixtures__/codemod.input.jsx';
import Expected from '../i18n/__fixtures__/codemod.expected.jsx';
import { dumpText } from './i18nScreens.jsx';
import { __setCatalogForTests, resetI18nForTests } from '../i18n/index.js';

const DIR = path.join(import.meta.dirname, '..', 'i18n', '__fixtures__');
const INPUT = path.join(DIR, 'codemod.input.jsx');
const EXPECTED = path.join(DIR, 'codemod.expected.jsx');

afterEach(() => {
  cleanup();
  resetI18nForTests();
});

describe('codemod', () => {
  it('writes exactly the expected file and lists the cases it leaves to a person', () => {
    const result = transform(INPUT, fs.readFileSync(INPUT, 'utf8'));
    expect(result.error).toBeUndefined();
    expect(result.output).toBe(fs.readFileSync(EXPECTED, 'utf8'));
    expect(result.markers).toBe(2);
    expect(result.manual.map((m) => [m.line, m.rule])).toEqual([[36, 'R2'], [37, 'R8'], [39, 'R6'], [44, 'R2']]);
    expect(new Set(result.edits.map((e) => e.rule))).toEqual(new Set(['R1', 'R2', 'R2-rich', 'R3', 'R5', 'R6', 'R7']));
  });

  it('is idempotent: the output has nothing left to wrap', () => {
    const again = transform(EXPECTED, fs.readFileSync(EXPECTED, 'utf8'));
    expect(again.edits).toEqual([]);
    expect(again.output).toBe(fs.readFileSync(EXPECTED, 'utf8'));
  });

  it('renders the same German text before and after', () => {
    const props = { count: 3, busy: false };
    const before = dumpText(render(<Input {...props} />).container);
    cleanup();
    const after = dumpText(render(<Expected {...props} />).container);
    expect(after).toEqual(before);
    cleanup();
    const one = dumpText(render(<Expected count={1} busy />).container);
    cleanup();
    expect(one).toEqual(dumpText(render(<Input count={1} busy />).container));
  });

  it('the wrapped file follows the catalog in another language', () => {
    __setCatalogForTests('en', { Einstellungen: 'Settings', 'Angemeldet als {username}.': 'Signed in as {username}.', 'Band|Bände': { one: 'volume', other: 'volumes' } }, { languages: ['en-GB'] });
    const { container } = render(<Expected count={2} />);
    const text = dumpText(container);
    expect(text).toContain('Settings');
    expect(text).toContain('Signed in as');
    expect(text).toContain('volumes');
  });

  it('aliases t when the file already binds the name', () => {
    const code = "export default function A({ items }) {\n  return <ul>{items.map((t) => <li key={t}>Eintrag {t}</li>)}</ul>;\n}\n";
    const result = transform(path.join(DIR, 'alias.jsx'), code);
    expect(result.output).toContain("import { t as tr } from '../index.js';");
    expect(result.output).toContain("{tr('Eintrag {t}', { t })}");
  });

  it('keeps JSX whitespace rules and the German heuristic in step with JSX', () => {
    expect(cleanJsxText('\n    Hallo\n    Welt\n  ')).toBe('Hallo Welt');
    expect(cleanJsxText(' Nur Ansicht ')).toBe(' Nur Ansicht ');
    expect(cleanJsxText('  \n  ')).toBe('');
    expect(['Speichern', 'Speichert…', 'Gespeichert.', 'Zur Übersicht', 'bitte warten'].every(isGerman)).toBe(true);
    expect(['flex items-center gap-2', 'aktiv', 'ALL', '/api/mangas', 'image/png', 'mangashelf_locale'].some(isGerman)).toBe(false);
  });
});

describe('extractor', () => {
  it('collects wrapped texts, plural pairs and marked declarations', () => {
    const { keys, problems } = extract({ files: [EXPECTED], server: false });
    expect(problems).toEqual([]);
    for (const key of ['Einstellungen', 'Angemeldet als {username}.', 'Du hast {count} für {price} im Regal.', 'Titel A–Z', 'Gespeichert.', 'Rückgängig']) {
      expect(keys.has(key), key).toBe(true);
    }
    expect(keys.get('Band|Bände').plural).toBe(true);
    expect(keys.get('Ein Band fehlt|Mehrere Bände fehlen').plural).toBe(true);
    expect(keys.get('Einstellungen').sources[0]).toMatchObject({ file: 'frontend/src/i18n/__fixtures__/codemod.expected.jsx', component: 'CodemodSample' });
  });

  it('collects the guides, the takeover texts and the server messages the client looks up', () => {
    const { keys } = extract({ files: [] });
    expect(keys.has('Zugriffstoken')).toBe(true);
    expect(keys.has('Auf Server übertragen')).toBe(true);
    expect(keys.has('Band nicht gefunden')).toBe(true);
    expect(keys.has('Unbekannte Sprache')).toBe(true);
    expect(keys.get('Band nicht gefunden').origin).toBe('server');
  });
});
