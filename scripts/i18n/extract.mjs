#!/usr/bin/env node
// i18n key extractor. Collects every source text the UI translates:
//   - literal first arguments of t / tc (key `context::text`) / rich / msg, tn pairs and formatCount/countLabel pairs
//   - German strings in declarations marked with a `// i18n` line comment (label maps, exported constants)
//   - the API-key guides (core/sources/guides.js), the takeover texts (frontend/src/app/takeoverTexts.js)
//   - server error texts (literal messages, notFound subjects, msg() templates), which the client looks up by text
// Usage: node scripts/i18n/extract.mjs [--write] [--prune] [--merge a.json,b.json] [--context out.json] [--check]
//   --write    adds missing keys to every catalog in frontend/src/i18n/locales ('' = still missing)
//   --prune    drops catalog keys no source uses any more
//   --merge    takes translations from fragment files (wave B: reports/i18n/en.<package>.json) into en.json
//   --context  writes { key: [{ file, line, component }] } for translators
//   --check    exit code 1 for invalid calls (computed keys) and, with --strict, for missing translations
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, SRC, parse, sourceFiles, rel, walk, isGerman, looksLikeCode, commentIndex, i18nImports, stringValue, readJson,
  writeSortedJson
} from './lib.mjs';

export const LOCALES_DIR = path.join(SRC, 'i18n', 'locales');
const PLURAL_HELPERS = new Set(['formatCount', 'countLabel']);
const GUIDE_TEXT_KEYS = new Set(['benefit', 'secretLabel', 'secretHint', 'formatError', 'warning', 'text', 'inputLabel', 'check', 'validity']);
const SERVER_DIRS = ['core', 'routes', 'middleware', 'services', 'utils'];
const ERROR_CALLS = new Set(['badRequest', 'conflict', 'forbidden', 'httpError', 'HttpError', 'sendError']);

function componentOf(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];
    if (node.type === 'FunctionDeclaration' && node.id) return node.id.name;
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') return node.id.name;
    if (node.type === 'ClassDeclaration' && node.id) return node.id.name;
  }
  return null;
}

function createCollector() {
  const keys = new Map();
  const problems = [];
  const add = (key, { file, line, component = null, plural = false, origin = 'ui' }) => {
    if (typeof key !== 'string' || !key.trim()) return;
    let entry = keys.get(key);
    if (!entry) {
      entry = { plural, origin, sources: [] };
      keys.set(key, entry);
    }
    if (plural) entry.plural = true;
    if (origin === 'ui') entry.origin = 'ui';
    if (entry.sources.length < 5) entry.sources.push({ file, line, component });
  };
  return { keys, problems, add };
}

/** German strings of a marked declaration: values only (object keys are ids). */
function collectMarked(init, file, collect, component) {
  walk(init, (node, parent, key) => {
    if (parent?.type === 'ObjectProperty' && key === 'key') return;
    const text = node.type === 'StringLiteral' ? node.value : node.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : null;
    if (text !== null && !looksLikeCode(text) && /[A-Za-zÄÖÜäöüß]/.test(text)) collect.add(text, { file, line: node.loc.start.line, component });
  });
}

/** Frontend source file: wrapper calls, plural helpers and marked declarations. */
export function extractFile(file, code, collect) {
  const name = rel(file);
  let ast;
  try {
    ast = parse(code, file);
  } catch (err) {
    collect.problems.push({ file: name, line: err.loc?.line ?? 0, reason: `Parserfehler: ${err.message}` });
    return;
  }
  const comments = commentIndex(ast);
  const aliases = i18nImports(ast, file);
  walk(ast.program, (node, parent, key, ancestors) => {
    const where = () => ({ file: name, line: node.loc.start.line, component: componentOf(ancestors) });
    if ((node.type === 'VariableDeclaration' || node.type === 'ExportNamedDeclaration') && comments.marked(node)) {
      const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
      for (const d of decl?.declarations || []) if (d.init) collectMarked(d.init, name, collect, d.id?.name || null);
      return;
    }
    if (node.type !== 'CallExpression') return;
    const callee = node.callee.type === 'Identifier' ? node.callee.name : null;
    if (!callee) return;
    const imported = aliases.get(callee);
    if (PLURAL_HELPERS.has(callee)) {
      const [one, other] = [stringValue(node.arguments[1]), stringValue(node.arguments[2])];
      if (one !== null && other !== null) collect.add(`${one}|${other}`, { ...where(), plural: true });
      return;
    }
    if (!imported) return;
    const args = node.arguments;
    if (imported === 'tn') {
      const [one, other] = [stringValue(args[0]), stringValue(args[1])];
      if (one !== null && other !== null) collect.add(`${one}|${other}`, { ...where(), plural: true });
      else if (!comments.dynamic(node)) collect.problems.push({ ...where(), reason: 'tn() ohne wörtliche Formen' });
      return;
    }
    const first = imported === 'tc' ? args[1] : args[0];
    const text = stringValue(first);
    if (text !== null) {
      collect.add(imported === 'tc' ? `${stringValue(args[0])}::${text}` : text, where());
      return;
    }
    // t(CONST) / t(option.label): the source is a marked declaration; a computed key cannot be in any catalog
    const computed = first && (first.type === 'TemplateLiteral' || first.type === 'BinaryExpression');
    if (computed && !comments.dynamic(node)) collect.problems.push({ ...where(), reason: `${imported}() mit berechnetem Schlüssel` });
  });
}

/** core/sources/guides.js: the texts of GUIDES (also shown by the frontend through GET /sources/guides). */
export function extractGuides(file, collect) {
  const ast = parse(fs.readFileSync(file, 'utf8'), file);
  walk(ast.program, (node) => {
    if (node.type !== 'ObjectProperty' || node.key.type !== 'Identifier' || !GUIDE_TEXT_KEYS.has(node.key.name)) return;
    const text = stringValue(node.value);
    if (text !== null && isGerman(text)) collect.add(text, { file: rel(file), line: node.loc.start.line, component: 'guides', origin: 'guides' });
  });
}

/** frontend/src/app/takeoverTexts.js: every string of TAKEOVER. */
export function extractTakeover(file, collect) {
  const ast = parse(fs.readFileSync(file, 'utf8'), file);
  walk(ast.program, (node, parent, key) => {
    if (parent?.type === 'ObjectProperty' && key === 'key') return;
    const text = node.type === 'StringLiteral' ? node.value : null;
    if (text !== null && isGerman(text)) collect.add(text, { file: rel(file), line: node.loc.start.line, component: 'TAKEOVER' });
  });
}

const messageArg = (name, args) => (name === 'sendError' ? args[2] : name === 'HttpError' || name === 'httpError' ? args[1] : args[0]);

/** Server texts the client translates by exact lookup: literal error messages, notFound subjects, msg() templates. */
export function extractServer(file, collect) {
  let ast;
  try { ast = parse(fs.readFileSync(file, 'utf8'), file); } catch (_) { return; }
  const consts = new Map();
  for (const node of ast.program.body) {
    if (node.type !== 'VariableDeclaration') continue;
    for (const d of node.declarations) {
      const text = stringValue(d.init);
      if (d.id.type === 'Identifier' && text !== null) consts.set(d.id.name, text);
      // text tables such as AUTH_TEXTS / CLIENT_ERROR_TEXTS
      if (d.id.type === 'Identifier' && /_(TEXTS|ERRORS)$/.test(d.id.name) && d.init?.type === 'ObjectExpression') {
        for (const p of d.init.properties) {
          const value = p.type === 'ObjectProperty' ? stringValue(p.value) : null;
          if (value !== null && isGerman(value)) collect.add(value, { file: rel(file), line: p.loc.start.line, component: d.id.name, origin: 'server' });
        }
      }
    }
  }
  const resolve = (arg) => stringValue(arg) ?? (arg?.type === 'Identifier' ? consts.get(arg.name) ?? null : null);
  walk(ast.program, (node) => {
    if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return;
    const callee = node.callee.type === 'Identifier' ? node.callee.name : node.callee.type === 'MemberExpression' && !node.callee.computed ? node.callee.property.name : null;
    if (!callee) return;
    const at = { file: rel(file), line: node.loc.start.line, component: callee, origin: 'server' };
    if (callee === 'msg') {
      const text = stringValue(node.arguments[0]);
      if (text !== null) collect.add(text, at);
      return;
    }
    if (callee === 'notFound') {
      const subject = node.arguments.length ? resolve(node.arguments[0]) : 'Eintrag';
      if (subject !== null) collect.add(`${subject} nicht gefunden`, at);
      return;
    }
    if (!ERROR_CALLS.has(callee)) return;
    const text = resolve(messageArg(callee, node.arguments));
    if (text !== null && isGerman(text)) collect.add(text, at);
  });
}

function serverFiles() {
  const files = [path.join(ROOT, 'index.js'), path.join(ROOT, 'db.js')];
  const walkDir = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkDir(full);
      else if (/\.js$/.test(entry.name)) files.push(full);
    }
  };
  for (const dir of SERVER_DIRS) walkDir(path.join(ROOT, dir));
  // the device answers the server-only routes itself
  for (const name of ['localServer.js', 'runtime.js', 'http.js', 'store.js']) files.push(path.join(SRC, 'local', name));
  return files.filter((f) => fs.existsSync(f));
}

/** All keys: Map key -> { plural, origin, sources }, plus problems (computed keys, parser errors). */
export function extract({ files = sourceFiles(), server = true } = {}) {
  const collect = createCollector();
  for (const file of files) extractFile(file, fs.readFileSync(file, 'utf8'), collect);
  extractGuides(path.join(ROOT, 'core', 'sources', 'guides.js'), collect);
  extractTakeover(path.join(SRC, 'app', 'takeoverTexts.js'), collect);
  if (server) for (const file of serverFiles()) extractServer(file, collect);
  return { keys: collect.keys, problems: collect.problems };
}

/** Plural categories of a language as Intl.PluralRules knows them ('one'/'other' for en, 'other' for ja). */
export const pluralCategories = (lang) => new Intl.PluralRules(lang).resolvedOptions().pluralCategories;

export function catalogFiles() {
  if (!fs.existsSync(LOCALES_DIR)) return [];
  return fs.readdirSync(LOCALES_DIR).filter((f) => /^[a-zA-Z-]+\.json$/.test(f)).map((f) => ({ lang: f.replace(/\.json$/, ''), file: path.join(LOCALES_DIR, f) }));
}

const emptyValue = (entry, lang) => (entry.plural ? Object.fromEntries(pluralCategories(lang).map((c) => [c, ''])) : '');

/** Adds missing keys (empty values), drops stale ones with prune, merges fragments; returns a change summary. */
export function updateCatalog({ lang, file }, keys, { prune = false, fragments = [] } = {}) {
  const catalog = readJson(file, {});
  const summary = { lang, added: 0, pruned: 0, merged: 0, conflicts: [] };
  for (const [key, entry] of keys) {
    if (!(key in catalog)) {
      catalog[key] = emptyValue(entry, lang);
      summary.added++;
    }
  }
  if (prune) {
    for (const key of Object.keys(catalog)) {
      if (!keys.has(key)) {
        delete catalog[key];
        summary.pruned++;
      }
    }
  }
  for (const fragment of fragments) {
    const values = readJson(fragment, {});
    for (const [key, value] of Object.entries(values)) {
      if (!keys.has(key)) continue;
      const current = catalog[key];
      const filled = typeof current === 'string' ? current !== '' : current && Object.values(current).some(Boolean);
      if (filled && JSON.stringify(current) !== JSON.stringify(value)) summary.conflicts.push({ key, current, value, fragment: path.basename(fragment) });
      else {
        catalog[key] = value;
        summary.merged++;
      }
    }
  }
  writeSortedJson(file, catalog);
  return summary;
}

export function missingTranslations(keys, catalog) {
  const missing = [];
  for (const [key, entry] of keys) {
    const value = catalog[key];
    const empty = entry.plural ? !value || typeof value !== 'object' || !value.other : typeof value !== 'string' || value === '';
    if (empty) missing.push(key);
  }
  return missing;
}

function main(argv) {
  const has = (flag) => argv.includes(flag);
  const valueOf = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : null;
  };
  const { keys, problems } = extract();
  const counts = { keys: keys.size, plural: [...keys.values()].filter((e) => e.plural).length, server: [...keys.values()].filter((e) => e.origin === 'server').length };
  console.log(`i18n: ${counts.keys} Schlüssel (${counts.plural} Pluralpaare, ${counts.server} nur vom Server)`);
  const contextFile = valueOf('--context');
  if (contextFile) {
    const context = {};
    for (const [key, entry] of keys) context[key] = entry.sources;
    writeSortedJson(path.resolve(contextFile), context);
    console.log(`Kontext: ${contextFile}`);
  }
  const fragments = (valueOf('--merge') || '').split(',').filter(Boolean).map((f) => path.resolve(f));
  if (has('--write') || has('--prune') || fragments.length) {
    for (const target of catalogFiles()) {
      const summary = updateCatalog(target, keys, { prune: has('--prune'), fragments: target.lang === 'en' ? fragments : [] });
      console.log(`${summary.lang}.json: +${summary.added} neu, -${summary.pruned} entfernt, ${summary.merged} übernommen`);
      for (const c of summary.conflicts) console.log(`  Konflikt ${JSON.stringify(c.key)}: ${JSON.stringify(c.current)} ≠ ${JSON.stringify(c.value)} (${c.fragment}) → tc() oder eine Fassung wählen`);
    }
  }
  for (const p of problems) console.log(`FEHLER ${p.file}:${p.line} ${p.reason}`);
  let failed = problems.length > 0;
  if (has('--strict')) {
    for (const target of catalogFiles()) {
      const missing = missingTranslations(keys, readJson(target.file, {}));
      if (missing.length) {
        console.log(`${target.lang}.json: ${missing.length} Übersetzungen fehlen`);
        failed = true;
      }
    }
  }
  if (has('--check') && failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
