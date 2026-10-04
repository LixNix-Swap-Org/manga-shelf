// Shared parts of the i18n extractor, codemod and guard test: Babel parsing, AST walking, the German-text heuristic.
// Babel comes from frontend/node_modules (pinned there as a devDependency); nothing here is shipped.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FRONTEND = path.join(ROOT, 'frontend');
export const SRC = path.join(FRONTEND, 'src');
const requireFrontend = createRequire(path.join(FRONTEND, 'package.json'));
const parser = requireFrontend('@babel/parser');

export const I18N_MODULE = /(^|\/)i18n\/index(\.js)?$/;
export const I18N_REACT = /(^|\/)i18n\/react(\.jsx)?$/;
export const WRAPPERS = ['t', 'tn', 'tc', 'rich', 'msg'];

/** Babel AST with comments and positions; JSX on for every file. */
export function parse(code, file = '') {
  const sourceType = /\.cjs$/.test(file) ? 'script' : 'unambiguous';
  return parser.parse(code, { sourceType, plugins: ['jsx'], errorRecovery: false, allowReturnOutsideFunction: true });
}

/** Non-test source files below a directory (.js/.jsx/.mjs). */
export function sourceFiles(dir = SRC) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === '__fixtures__' || entry.name === 'node_modules' || entry.name === 'locales') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

export const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens', 'range']);

/** Depth-first walk; visitor(node, parent, key, ancestors) may return false to skip the children. */
export function walk(node, visitor, parent = null, key = null, ancestors = []) {
  if (!node || typeof node.type !== 'string') return;
  if (visitor(node, parent, key, ancestors) === false) return;
  const next = [...ancestors, node];
  for (const k of Object.keys(node)) {
    if (SKIP_KEYS.has(k)) continue;
    const value = node[k];
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') walk(child, visitor, node, k, next);
    } else if (value && typeof value.type === 'string') {
      walk(value, visitor, node, k, next);
    }
  }
}

// --- German heuristic (shared with the guard test: one definition of "German text") ---

const STOP = new Set(('der die das den dem des und oder nicht kein keine keinen ein eine einen einem einer ist sind wird werden wurde wurden mit für von zu zum zur auf im in am an bei nach noch alle allen alles aus über unter vor seit bis auch nur schon jetzt hier dort dieser diese dieses diesem ihre ihr ihren sie du dein deine deinen bitte konnte konnten kann können muss müssen soll sollen gibt neu neue neuen neuer erst ohne wie was wer wann warum als dann denn doch mehr weniger beim vom ins mal es sich man wenn ob da so gerade eben heute morgen gestern band bände bänden reihe reihen').split(' '));
const UI_WORDS = new Set(('speichern abbrechen schließen löschen bearbeiten hinzufügen suchen zurück weiter fertig ja nein laden lade anlegen entfernen auswählen gekauft gelesen ungelesen vorbestellt wunschliste sammlung einkaufsliste statistik papierkorb verlag verlage autor autoren titel preis datum notiz notizen typ nummer fotos foto scannen benutzer konto passwort kennwort anmelden abmelden einstellungen sicherung wiederherstellen teilen kopieren drucken ansicht raster liste regal aktualisieren fehler erfolg hinweis warnung schuber sonderband sonderbände lücken lücke editionen kalender monat jahr tage tag woche quellen quelle schlüssel verbinden verbindung lokal profil neuer neues rolle gast leser besitzer sammelstand priorität hoch mittel niedrig').split(' '));

/** Identifiers, keys, CSS classes, URLs, MIME types, file names, log prefixes: not text. */
export function looksLikeCode(text) {
  const s = String(text).trim();
  if (!s) return true;
  if (!/[A-Za-zÄÖÜäöüß]/.test(s)) return true;
  if (/^(https?:|mailto:|data:|blob:|\/|\.\/|\.\.\/|#|@|\$\{)/.test(s)) return true;
  if (/^[a-z0-9_.:\-/[\]()%&>!*=,#'"]+$/.test(s) && !/\s/.test(s)) return true;
  if (/^Bearer /.test(s)) return true;
  if (/^\[[A-Za-z]+\]/.test(s)) return true;
  if (/^[A-Z0-9_]+$/.test(s)) return true;
  const words = s.split(' ');
  if (words.length > 1 && /^[a-zA-Z0-9_\-:/[\].!%&>~@()=,']+( [a-zA-Z0-9_\-:/[\].!%&>~@()=,']+)+$/.test(s)
    && words.every((w) => /[-:[]/.test(w) || /^[a-z0-9]+$/.test(w)) && !words.some((w) => STOP.has(w.toLowerCase()))) return true;
  if (/^[a-z]+\/[a-z0-9.+-]+/.test(s)) return true;
  if (/^[\w-]+\.(js|jsx|mjs|png|svg|json|css|webp|jpg|zip|csv|db|wasm)$/.test(s)) return true;
  return false;
}

/** Heuristic: German UI text (umlaut/ß, stop words, UI words, capitalised words). Single lowercase tokens are data. */
export function isGerman(text) {
  const s = String(text).trim();
  if (looksLikeCode(s)) return false;
  if (/[äöüÄÖÜß]/.test(s)) return true;
  const words = s.toLowerCase().match(/[a-zäöüß]+/g) || [];
  if (words.some((w) => STOP.has(w) || UI_WORDS.has(w))) return true;
  if (/^[A-ZÄÖÜ][a-zäöüß]+/.test(s) && /\s/.test(s)) return true;
  if (/^[A-ZÄÖÜ][a-zäöüß]{2,}[.…:!?]*$/.test(s)) return true;
  // German abbreviation 'z. B.' and capitalised hyphenated compounds ('Admin-Benutzername'); HTTP header names are code
  if (/(^|\s)z\. ?B\./.test(s)) return true;
  if (/^[A-ZÄÖÜ][a-zäöüß]+(-[A-ZÄÖÜa-zäöüß][a-zäöüß]+)+[.…:!?]*$/.test(s) && !HEADER_NAME.test(s)) return true;
  return false;
}

const HEADER_NAME = /^(Content|Accept|Cache|Cross|If|Last|Retry|Set|User|Access|Strict|Referrer|Permissions|Origin|Service|Upgrade|Keep)-/;

/** Stored German values (API, CSV, offline copy): compared as values, displayed only through utils/enumLabels.js. */
export const STORED_VALUES = new Set([
  'Vorhanden', 'Fehlt', 'Vorbestellt', 'Erscheint bald', 'Bestellt', 'Gelesen', 'Ungelesen',
  'Laufend', 'Abgeschlossen', 'Pausiert', 'Abgebrochen', 'Geplant', 'Unbekannt',
  'Neuwertig', 'Sehr gut', 'Gut', 'Akzeptabel', 'Mängelexemplar',
  'Schaue', 'Gesehen', 'Alle', 'Ohne Status', 'Deutsch'
]);

/** Text of a template literal with {name} placeholders, or null when a quasi holds a literal brace. */
export function templateKey(node, names) {
  let key = '';
  node.quasis.forEach((q, i) => {
    key += q.value.cooked ?? q.value.raw;
    if (i < node.expressions.length) key += `{${names[i]}}`;
  });
  return key;
}

/** JSX whitespace rule (Babel's cleanJSXElementLiteralChild): '' when the text vanishes. */
export function cleanJsxText(value) {
  const lines = value.split(/\r\n|\n|\r/);
  let lastNonEmpty = 0;
  for (let i = 0; i < lines.length; i++) if (/[^ \t]/.test(lines[i])) lastNonEmpty = i;
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const isFirst = i === 0;
    const isLast = i === lines.length - 1;
    const isLastNonEmpty = i === lastNonEmpty;
    let line = lines[i].replace(/\t/g, ' ');
    if (!isFirst) line = line.replace(/^[ ]+/, '');
    if (!isLast) line = line.replace(/[ ]+$/, '');
    if (line) {
      if (!isLastNonEmpty) line += ' ';
      out += line;
    }
  }
  return out;
}

/** Leading `// i18n` (marked declaration) or `i18n-ignore` comments of a node; `lineComments` maps line -> text. */
export function commentIndex(ast) {
  const byLine = new Map();
  for (const c of ast.comments || []) {
    const value = c.value.trim();
    for (let line = c.loc.start.line; line <= c.loc.end.line; line++) byLine.set(line, [...(byLine.get(line) || []), value]);
  }
  const has = (line, re) => (byLine.get(line) || []).some((v) => re.test(v));
  return {
    /** `// i18n` on the line right above (declarations: the marker the extractor collects). */
    marked: (node) => has(node.loc.start.line - 1, /^i18n$/),
    /** `i18n-ignore` on the node's line or the line above. */
    ignored: (node) => has(node.loc.start.line, /^i18n-ignore\b/) || has(node.loc.start.line - 1, /^i18n-ignore\b/),
    /** `i18n-dynamic` on the line or above: a t(x) whose sources are collected elsewhere. */
    dynamic: (node) => has(node.loc.start.line, /^i18n-dynamic\b/) || has(node.loc.start.line - 1, /^i18n-dynamic\b/)
  };
}

/** Whether an import source names frontend/src/i18n/index.js or react.jsx (resolved against the importing file). */
export function isI18nSource(source, file) {
  if (file && source.startsWith('.')) {
    const target = path.resolve(path.dirname(file), source).replace(/\.(js|jsx)$/, '');
    return target === path.join(SRC, 'i18n', 'index') || target === path.join(SRC, 'i18n', 'react');
  }
  return I18N_MODULE.test(source) || I18N_REACT.test(source);
}

/** Local names of t/tn/tc/rich/msg imported from the i18n modules: { local -> imported }. */
export function i18nImports(ast, file) {
  const names = new Map();
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration') continue;
    const source = node.source.value;
    if (!isI18nSource(source, file)) continue;
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportSpecifier' && WRAPPERS.includes(spec.imported.name)) names.set(spec.local.name, spec.imported.name);
    }
  }
  return names;
}

export const stringValue = (node) => {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
};

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

/** Sorted, two-space JSON with a final newline (stable diffs). */
export function writeSortedJson(file, object) {
  const sorted = {};
  for (const key of Object.keys(object).sort()) sorted[key] = object[key];
  fs.writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`);
}
