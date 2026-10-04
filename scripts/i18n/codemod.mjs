#!/usr/bin/env node
// i18n codemod: wraps German UI text in t() / tn() / rich() by splicing the source at node positions (untouched bytes stay).
// Each edit is self-checked (the rendered German must equal the original); failing or ambiguous cases go to the MANUAL list.
// Usage: node scripts/i18n/codemod.mjs [--files <path|dir>[,…]] [--report out.json] [--write]  (default: frontend/src, dry run)
// Rules: JSX text, sentence runs, display attributes, templates, messages, `// i18n` markers, n === 1 plurals, stored values.
import fs from 'node:fs';
import path from 'node:path';
import {
  SRC, parse, sourceFiles, rel, walk, isGerman, looksLikeCode, cleanJsxText, commentIndex, i18nImports, isI18nSource, STORED_VALUES,
  I18N_MODULE, I18N_REACT
} from './lib.mjs';

const DISPLAY_ATTRS = new Set(['aria-label', 'title', 'placeholder', 'alt', 'label', 'aria-valuetext', 'aria-description', 'aria-roledescription', 'aria-placeholder']);
const TEXT_PROPS = new Set(['subtitle', 'question', 'buttonText', 'confirmLabel', 'cancelLabel', 'scannerTitle', 'describe', 'heading', 'description', 'emptyText', 'hint', 'message', 'actionLabel', 'busyLabel']);
const INLINE_TAGS = new Set(['strong', 'em', 'b', 'i', 'code', 'kbd', 'span', 'a', 'Link', 'mark', 'small', 'u']);
const LABEL_KEYS = /^(label|title|text|message|hint|description|placeholder|error|tooltip|caption|subtitle|heading|short|long|empty|emptyText|confirm|question|help|note|intro|buttonText|actionLabel|aria|fallback)$/;
const MESSAGE_FN = /(Text|Message|Label|Hint|Title|Error|Notice|Reason|Summary|Description|Caption|Tooltip)$/;
const SETTER = /^set\w*(Error|Message|Notice|Status|Text|Hint|Warning|Info|Title|Label)$/;
const ERROR_CTOR = /^(Error|TypeError|RangeError|ApiError|HttpError|\w+Error)$/;
const COMPARE_CALLS = new Set(['includes', 'has', 'indexOf', 'lastIndexOf', 'startsWith', 'endsWith', 'get', 'set', 'delete', 'getItem', 'setItem', 'removeItem', 'querySelector', 'querySelectorAll', 'getElementById', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'matchMedia', 'add', 'test', 'match', 'replace', 'split', 'localeCompare', 'find', 'findIndex', 'filter', 'some', 'every', 'getAttribute', 'setAttribute', 'setProperty', 'removeProperty', 'closest', 'matches', 'createElement', 'postMessage', 'register', 'invoke', 'send', 'sendSync', 'on', 'emit']);
const FORMAT_NAMES = {
  formatCount: 'count', countLabel: 'count', formatNumber: 'number', fmtNumber: 'number', formatEuro: 'price', fmtEuro: 'price',
  formatDate: 'date', formatDay: 'date', formatDateTime: 'date', fmtDateTime: 'date', formatShortDate: 'date', formatDayMonth: 'date',
  formatMonth: 'month', monthLabel: 'month', formatPercent: 'percent', fmtPct: 'percent', formatRelative: 'time', formatAge: 'age',
  formatTime: 'time', formatMegabytes: 'size', formatMb: 'size'
};
const EXCLUDED_ATTRS = /^(className|id|key|style|to|href|src|type|role|name|value|defaultValue|htmlFor|lang|rel|target|method|action|autoComplete|inputMode|accept|pattern|form|data-.*|aria-controls|aria-describedby|aria-labelledby|aria-owns|aria-activedescendant|aria-haspopup|aria-current|aria-live|aria-hidden|aria-expanded|aria-pressed|aria-selected|aria-checked|aria-busy|aria-invalid|aria-modal|aria-orientation|aria-sort|aria-atomic|aria-relevant|dir|enterKeyHint|capture|download|sizes|srcSet|loading|decoding|crossOrigin|referrerPolicy|sandbox|allow|as|variant|kind|tone|size|color|icon|mode|scope|provider|initialTab|prefix)$/;

const COUNTISH = /^(n|count|total|days|years|months|weeks|hours|extras|episodes|number|amount|items|entries|files|rows|volumes|series|pages|users)$/;
const STORED_LIST = /(STATUS|CONDITION|PROGRESS|COLLECTING|[Ss]tatus|[Cc]ondition|[Pp]rogress)(ES|S|List|Values|VALUES|es|s)?$/;
const quote = (text) => `'${String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}'`;
const isIdent = (s) => /^[A-Za-z_$][\w$]*$/.test(s);
const RESERVED = new Set(['default', 'class', 'new', 'delete', 'in', 'for', 'if', 'do', 'var', 'let', 'const', 'function', 'return', 'this', 'typeof', 'void', 'with', 'yield', 'case', 'catch', 'try', 'switch', 'while', 'break', 'continue', 'else', 'enum', 'export', 'import', 'super', 'throw', 'true', 'false', 'null', 'finally', 'instanceof', 'debugger', 'extends', 'static', 'await']);

function textOf(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

const COUNT_CALL = (e) => e.type === 'CallExpression' && e.callee.type === 'Identifier' && ['formatCount', 'countLabel'].includes(e.callee.name);
// a lowercase word next to a counted noun is a sentence part ('${formatCount(n, …)} korrigiert'), not data
const countSentence = (node) => node.expressions.some(COUNT_CALL) && node.quasis.some((q) => /[a-zäöüß]{3,}/.test(q.value.cooked ?? ''));
const germanTemplate = (node) => node.type === 'TemplateLiteral' && (node.quasis.some((q) => isGerman(q.value.cooked ?? '') || (node.expressions.length > 0 && isGerman(node.quasis.map((x) => x.value.cooked).join(' x ')))) || countSentence(node));

/** Texts worth translating in JSX children: German, or lower-case words that are not code. */
function displayText(text) {
  const s = String(text).trim();
  // a single lowercase word shown as JSX text ('manuell') is a label, though looksLikeCode takes it for an id
  if (/^[a-zäöüß]{4,}$/.test(s)) return true;
  if (!s || looksLikeCode(s)) return false;
  if (isGerman(s)) return true;
  return /[a-zäöüß]{2,}/.test(s) && /\s/.test(s);
}

/** All binding names of a file (to avoid shadowing t/tn/rich with the import). */
function bindings(ast) {
  const names = new Set();
  const addPattern = (p) => {
    if (!p) return;
    if (p.type === 'Identifier') names.add(p.name);
    else if (p.type === 'ObjectPattern') p.properties.forEach((q) => addPattern(q.type === 'RestElement' ? q.argument : q.value));
    else if (p.type === 'ArrayPattern') p.elements.forEach(addPattern);
    else if (p.type === 'AssignmentPattern') addPattern(p.left);
    else if (p.type === 'RestElement') addPattern(p.argument);
  };
  walk(ast.program, (node) => {
    if (node.type === 'VariableDeclarator') addPattern(node.id);
    if (/Function/.test(node.type)) { if (node.id) names.add(node.id.name); node.params.forEach(addPattern); }
    if (node.type === 'CatchClause') addPattern(node.param);
    if (node.type === 'ClassDeclaration' && node.id) names.add(node.id.name);
    if (node.type === 'ImportDeclaration') node.specifiers.forEach((s) => names.add(s.local.name));
  });
  return names;
}

const memberName = (node) => {
  if (node.type === 'Identifier') return node.name;
  if ((node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression')) {
    if (!node.computed) return node.property.name;
    if (node.property.type === 'StringLiteral' && isIdent(node.property.value)) return node.property.value;
  }
  return null;
};

function simpleExpr(node) {
  if (!node) return false;
  if (['Identifier', 'NumericLiteral', 'ThisExpression'].includes(node.type)) return true;
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') return simpleExpr(node.object) && (!node.computed || ['StringLiteral', 'NumericLiteral', 'Identifier'].includes(node.property.type));
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && FORMAT_NAMES[node.callee.name]) return true;
  if (node.type === 'TemplateLiteral') return !germanTemplate(node) && node.expressions.every(simpleExpr);
  return false;
}

function placeholderName(node, code) {
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && FORMAT_NAMES[node.callee.name]) return FORMAT_NAMES[node.callee.name];
  if (node.type === 'JSXElement') {
    const inner = node.children.find((c) => c.type === 'JSXExpressionContainer');
    return inner ? placeholderName(inner.expression, code) : null;
  }
  const name = memberName(node);
  return name && isIdent(name) && !RESERVED.has(name) && !/^[A-Z_]+$/.test(name) ? name : name && /^[A-Z_]+$/.test(name) ? name.toLowerCase().replace(/_([a-z])/g, (m, c) => c.toUpperCase()) : null;
}

/** Placeholder names for a list of expression nodes: equal sources share one name, clashes get a number. */
function nameExpressions(nodes, code) {
  const bySource = new Map();
  const used = new Set();
  let counter = 0;
  return nodes.map((node) => {
    const source = code.slice(node.start, node.end);
    if (bySource.has(source)) return bySource.get(source);
    let name = placeholderName(node, code);
    if (!name) name = `p${++counter}`;
    let unique = name;
    for (let i = 2; used.has(unique); i++) unique = `${name}${i}`;
    used.add(unique);
    bySource.set(source, unique);
    return unique;
  });
}

const varsObject = (names, sources) => {
  const seen = new Set();
  const parts = [];
  names.forEach((name, i) => {
    if (seen.has(name)) return;
    seen.add(name);
    parts.push(sources[i] === name ? name : `${name}: ${sources[i]}`);
  });
  return `{ ${parts.join(', ')} }`;
};

// --- signatures: the German text an expression or JSX subtree renders, with computed parts as «source» ---

function interpolateSig(key, vars) {
  return key.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? vars[name] : whole));
}

function makeSig(code, names) {
  const src = (node) => `«${code.slice(node.start, node.end).replace(/\s+/g, '')}»`;
  const sigExpr = (node) => {
    if (!node) return '';
    switch (node.type) {
      case 'StringLiteral': return node.value;
      case 'TemplateLiteral': return node.quasis.map((q, i) => q.value.cooked + (i < node.expressions.length ? sigExpr(node.expressions[i]) : '')).join('');
      case 'ConditionalExpression': {
        const t = node.test;
        if (t.type === 'BinaryExpression' && ['===', '!=='].includes(t.operator) && [t.left, t.right].some((s) => s.type === 'NumericLiteral' && s.value === 1)) {
          const n = t.left.type === 'NumericLiteral' ? t.right : t.left;
          const [one, other] = t.operator === '===' ? [node.consequent, node.alternate] : [node.alternate, node.consequent];
          return `plural(${src(n)},${sigExpr(one)},${sigExpr(other)})`;
        }
        return `(${src(node.test)}?${sigExpr(node.consequent)}:${sigExpr(node.alternate)})`;
      }
      case 'LogicalExpression': return `(${sigExpr(node.left)}${node.operator}${sigExpr(node.right)})`;
      case 'JSXElement': case 'JSXFragment': return sigElement(node);
      case 'CallExpression': {
        const callee = node.callee.type === 'Identifier' ? names.get(node.callee.name) : null;
        if (callee && ['t', 'rich', 'msg'].includes(callee) && node.arguments[0]?.type === 'StringLiteral') {
          const vars = {};
          for (const p of node.arguments[1]?.type === 'ObjectExpression' ? node.arguments[1].properties : []) {
            const key = p.key?.name ?? p.key?.value;
            vars[key] = sigExpr(p.value);
          }
          return interpolateSig(node.arguments[0].value, vars);
        }
        if (callee === 'tn' && node.arguments.length >= 3) return `plural(${src(node.arguments[2])},${sigExpr(node.arguments[0])},${sigExpr(node.arguments[1])})`;
        return src(node);
      }
      default: return src(node);
    }
  };
  const sigChildren = (children) => children.map((c) => {
    if (c.type === 'JSXText') return cleanJsxText(c.value);
    if (c.type === 'JSXExpressionContainer') return c.expression.type === 'JSXEmptyExpression' ? '' : sigExpr(c.expression);
    if (c.type === 'JSXElement' || c.type === 'JSXFragment') return sigElement(c);
    return src(c);
  }).join('');
  const sigElement = (el) => {
    const tag = el.type === 'JSXFragment' ? '' : code.slice(el.openingElement.name.start, el.openingElement.name.end);
    return `<${tag}>${sigChildren(el.children)}</${tag}>`;
  };
  return { sigExpr, sigChildren, sigElement };
}

// --- the transform ---

export function transform(file, code) {
  const result = { file: rel(file), edits: [], manual: [], markers: 0 };
  let ast;
  try {
    ast = parse(code, file);
  } catch (err) {
    result.error = `Parserfehler: ${err.message}`;
    return { ...result, output: code };
  }
  const comments = commentIndex(ast);
  const existing = i18nImports(ast, file);
  const taken = bindings(ast);
  const localOf = (name) => {
    for (const [local, imported] of existing) if (imported === name) return local;
    for (const candidate of [name, `${name}r`, `i18n${name[0].toUpperCase()}${name.slice(1)}`]) if (!taken.has(candidate)) return candidate;
    return `i18n_${name}`;
  };
  const names = { t: localOf('t'), tn: localOf('tn'), rich: localOf('rich') };
  const used = new Set();
  const edits = [];
  const claimed = [];
  const lineOf = (pos) => code.slice(0, pos).split('\n').length;
  const manual = (node, rule, reason) => result.manual.push({ line: node.loc?.start.line ?? lineOf(node.start), rule, reason, text: code.slice(node.start, Math.min(node.end, node.start + 160)) });
  const overlaps = (start, end) => claimed.some(([s, e]) => start < e && end > s);
  const addEdit = (start, end, text, rule, node, check) => {
    if (overlaps(start, end)) return false;
    if (check && !check()) {
      manual(node, rule, 'Selbstprüfung: der deutsche Text wäre nicht gleich');
      return false;
    }
    claimed.push([start, end]);
    edits.push({ start, end, text, rule, line: node.loc.start.line, before: code.slice(start, end) });
    return true;
  };
  const allNames = new Map([[names.t, 't'], [names.tn, 'tn'], [names.rich, 'rich'], ...existing]);
  const sig = makeSig(code, allNames);
  const reparse = (snippet) => {
    try {
      const program = parse(`(${snippet});`).program;
      return program.body[0].expression;
    } catch (_) {
      return null;
    }
  };
  const sigOfSnippet = (snippet, kind) => {
    const node = reparse(kind === 'children' ? `<>${snippet}</>` : snippet);
    if (!node) return null;
    const local = makeSig(kind === 'children' ? `(<>${snippet}</>);` : `(${snippet});`, allNames);
    // reparse offsets start at 1 because of the parenthesis
    return kind === 'children' ? local.sigChildren(node.children) : local.sigExpr(node);
  };
  // reparse offsets: the snippet starts after '(' (and after '<>' for children)
  const fixOffsets = (snippet, kind) => (kind === 'children' ? `(<>${snippet}</>);` : `(${snippet});`);
  void fixOffsets;

  const tCall = (key, vars) => {
    used.add('t');
    return vars ? `${names.t}(${quote(key)}, ${vars})` : `${names.t}(${quote(key)})`;
  };

  /** Edits that translate German leaves of a display expression; returns true when something was handled. */
  function leafEdits(node, rule, { allowStored = true } = {}) {
    if (!node || comments.ignored(node)) return;
    switch (node.type) {
      case 'StringLiteral': {
        if (!isGerman(node.value)) return;
        if (STORED_VALUES.has(node.value) && !allowStored) {
          manual(node, 'R8', 'gespeicherter Wert: Anzeige über utils/enumLabels.js, Vergleiche bleiben');
          return;
        }
        const text = tCall(node.value);
        addEdit(node.start, node.end, text, rule, node, () => sigOfSnippet(text, 'expr') === node.value);
        return;
      }
      case 'TemplateLiteral': {
        if (!germanTemplate(node)) return;
        templateEdit(node, rule);
        return;
      }
      case 'ConditionalExpression': {
        if (pluralEdit(node)) return;
        leafEdits(node.consequent, rule, { allowStored });
        leafEdits(node.alternate, rule, { allowStored });
        return;
      }
      case 'LogicalExpression':
        leafEdits(node.left, rule, { allowStored });
        leafEdits(node.right, rule, { allowStored });
        return;
      case 'BinaryExpression':
        if (node.operator === '+' && containsGerman(node)) manual(node, 'R7', 'Verkettung: als Template mit {Platzhaltern} umschreiben, dann t()');
        return;
      default:
    }
  }

  // literals inside t()/tn()/tc()/rich()/msg() and the plural helpers are handled already
  const handledCall = (n) => n.type === 'CallExpression' && n.callee.type === 'Identifier'
    && (allNames.has(n.callee.name) || n.callee.name === 'formatCount' || n.callee.name === 'countLabel');
  function containsGerman(node) {
    let found = false;
    walk(node, (n) => {
      if (found) return false;
      if (/Function/.test(n.type) || handledCall(n)) return false;
      if ((n.type === 'StringLiteral' && isGerman(n.value)) || (n.type === 'TemplateLiteral' && germanTemplate(n))) found = true;
      return undefined;
    });
    return found;
  }

  /** R4: `ISBN ${isbn} wird gesucht` -> t('ISBN {isbn} wird gesucht', { isbn }); nested German leaves first. */
  function templateEdit(node, rule) {
    if (node.quasis.some((q) => /[{}]/.test(q.value.cooked ?? ''))) {
      manual(node, 'R4', 'Template mit geschweiften Klammern im Text');
      return;
    }
    const exprNames = nameExpressions(node.expressions, code);
    const sources = node.expressions.map((e) => rewriteSlice(e));
    let key = '';
    node.quasis.forEach((q, i) => {
      key += q.value.cooked;
      if (i < node.expressions.length) key += `{${exprNames[i]}}`;
    });
    const text = node.expressions.length ? tCall(key, varsObject(exprNames, sources)) : tCall(key);
    const original = sig.sigExpr(node);
    addEdit(node.start, node.end, text, rule, node, () => sigOfSnippet(text, 'expr') === original);
  }

  /** Source of a sub-expression with the German leaves inside it translated (for template/vars values). */
  function rewriteSlice(node) {
    const before = edits.length;
    const claimedBefore = claimed.length;
    leafEdits(node, 'R4');
    const inner = edits.splice(before);
    claimed.splice(claimedBefore);
    let out = code.slice(node.start, node.end);
    for (const e of inner.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start - node.start) + e.text + out.slice(e.end - node.start);
    return out;
  }

  /** R7: n === 1 ? 'Band' : 'Bände' -> tn('Band', 'Bände', n). */
  function pluralEdit(node) {
    const t = node.test;
    if (t.type !== 'BinaryExpression' || !['===', '!=='].includes(t.operator)) return false;
    const one = [t.left, t.right].find((s) => s.type === 'NumericLiteral' && s.value === 1);
    if (!one) return false;
    const n = t.left === one ? t.right : t.left;
    const [singular, plural] = t.operator === '===' ? [node.consequent, node.alternate] : [node.alternate, node.consequent];
    const a = textOf(singular);
    const b = textOf(plural);
    if (a === null || b === null || !(isGerman(a) || isGerman(b))) return false;
    used.add('tn');
    const text = `${names.tn}(${quote(a)}, ${quote(b)}, ${code.slice(n.start, n.end)})`;
    addEdit(node.start, node.end, text, 'R7', node, () => sigOfSnippet(text, 'expr') === sig.sigExpr(node));
    return true;
  }

  // --- JSX children (R1, R2, rich) ---
  function classifyChild(child) {
    if (child.type === 'JSXText') {
      const cleaned = cleanJsxText(child.value);
      if (!cleaned) return 'ws';
      if (comments.ignored(child)) return 'element';
      return displayText(cleaned) ? 'text' : 'plain';
    }
    if (child.type === 'JSXExpressionContainer') {
      const e = child.expression;
      if (e.type === 'JSXEmptyExpression') return 'ws';
      if (e.type === 'StringLiteral') return e.value.trim() === '' ? 'space' : isGerman(e.value) ? 'strexpr' : 'expr-literal';
      if (simpleExpr(e)) return 'expr';
      return 'complex';
    }
    if (child.type === 'JSXElement') {
      const tag = child.openingElement.name.type === 'JSXIdentifier' ? child.openingElement.name.name : null;
      if (tag === 'br') return 'element';
      const inner = child.children.filter((c) => !(c.type === 'JSXText' && !cleanJsxText(c.value)));
      if (tag && INLINE_TAGS.has(tag) && inner.length === 1 && inner[0].type === 'JSXExpressionContainer' && simpleExpr(inner[0].expression)) return 'inline';
      if (tag && INLINE_TAGS.has(tag) && inner.some((c) => c.type === 'JSXText' && /[A-Za-zÄÖÜäöüß]/.test(cleanJsxText(c.value)))) return 'inline-text';
      return 'element';
    }
    return 'complex';
  }

  function processChildren(el) {
    const children = el.children;
    const kinds = children.map(classifyChild);
    let segment = [];
    const flush = () => {
      const seg = segment;
      segment = [];
      const meaningful = seg.filter((i) => kinds[i] !== 'ws');
      if (!meaningful.some((i) => kinds[i] === 'text' || kinds[i] === 'strexpr')) return;
      const span = [children[meaningful[0]].start, children[meaningful[meaningful.length - 1]].end];
      // a sentence around an inline element with its own text cannot be one key automatically
      if (meaningful.some((i) => kinds[i] === 'complex')) {
        manual(children[meaningful[0]], 'R2', 'Satz mit berechnetem Teil (Ternär, Aufruf): Satz als Ganzes mit t()/rich() schreiben');
        manualSpans.push(span);
        return;
      }
      if (meaningful.some((i) => kinds[i] === 'inline-text')) {
        manual(children[meaningful[0]], 'R2', 'Satz mit Inline-Element, das eigenen Text hat: rich() von Hand');
        manualSpans.push(span);
        return;
      }
      runEdit(el, meaningful);
    };
    children.forEach((child, i) => {
      if (kinds[i] === 'element') { flush(); return; }
      segment.push(i);
    });
    flush();
  }

  function runEdit(el, indices) {
    const children = el.children;
    const first = children[indices[0]];
    const last = children[indices[indices.length - 1]];
    const pieces = [];
    const exprNodes = [];
    const exprSlots = [];
    let lead = '';
    let trail = '';
    let start = first.start;
    let end = last.end;
    indices.forEach((i, pos) => {
      const c = children[i];
      const kind = classifyChild(c);
      if (c.type === 'JSXText') {
        let raw = c.value;
        let rawStart = c.start;
        let rawEnd = c.end;
        if (pos === 0) {
          const m = /^\s*/.exec(raw)[0];
          lead = code.slice(c.start, c.start + m.length);
          raw = raw.slice(m.length);
          rawStart += m.length;
          start = c.start;
        }
        if (pos === indices.length - 1) {
          const m = /\s*$/.exec(raw)[0];
          trail = m;
          raw = raw.slice(0, raw.length - m.length);
          rawEnd -= m.length;
          end = c.end;
        }
        // the cleaned text of the whole node, cut to the same edges
        let cleaned = cleanJsxText(c.value);
        if (pos === 0) cleaned = cleaned.replace(/^\s+/, '');
        if (pos === indices.length - 1) cleaned = cleaned.replace(/\s+$/, '');
        void rawStart; void rawEnd;
        pieces.push({ text: cleaned });
        return;
      }
      if (kind === 'space') { pieces.push({ text: c.expression.value }); return; }
      if (kind === 'strexpr' || kind === 'expr-literal') { pieces.push({ text: c.expression.value }); return; }
      const node = c.type === 'JSXElement' ? c : c.expression;
      exprSlots.push(pieces.length);
      exprNodes.push(node);
      pieces.push({ expr: node });
    });
    if (exprNodes.some((n) => n.type !== 'JSXElement') && pieces.some((p) => p.text !== undefined && /[{}]/.test(p.text))) {
      manual(first, 'R2', 'Text mit geschweiften Klammern');
      return;
    }
    if (pieces.some((p) => p.text !== undefined && /[{}]/.test(p.text))) {
      manual(first, 'R1', 'Text mit geschweiften Klammern');
      return;
    }
    const exprNames = nameExpressions(exprNodes, code);
    const sources = exprNodes.map((n) => (n.type === 'JSXElement' ? code.slice(n.start, n.end) : rewriteSlice(n)));
    let key = '';
    let k = 0;
    for (const p of pieces) key += p.text !== undefined ? p.text : `{${exprNames[k++]}}`;
    if (!key.trim()) return;
    const hasInline = exprNodes.some((n) => n.type === 'JSXElement');
    let call;
    if (hasInline) {
      used.add('rich');
      call = `${names.rich}(${quote(key)}, ${varsObject(exprNames, sources)})`;
    } else {
      call = exprNodes.length ? tCall(key, varsObject(exprNames, sources)) : tCall(key);
    }
    const replacement = `${lead}{${call}}${trail}`;
    const originalSig = sig.sigChildren(el.children);
    const check = () => {
      const elSource = code.slice(el.start, start) + replacement + code.slice(end, el.end);
      const node = reparse(elSource);
      if (!node) return false;
      const local = makeSig(`(${elSource});`, allNames);
      return local.sigChildren(node.children) === originalSig;
    };
    addEdit(start, end, replacement, exprNodes.length ? (hasInline ? 'R2-rich' : 'R2') : 'R1', first, check);
  }

  // --- attributes (R3) ---
  function attributeEdit(attr) {
    const name = attr.name.type === 'JSXIdentifier' ? attr.name.name : `${attr.name.namespace.name}:${attr.name.name.name}`;
    if (EXCLUDED_ATTRS.test(name) || !attr.value || comments.ignored(attr)) return;
    const display = DISPLAY_ATTRS.has(name) || TEXT_PROPS.has(name);
    const value = attr.value;
    if (value.type === 'StringLiteral') {
      if (!isGerman(value.value)) return;
      if (!display) { manual(attr, 'R3', `Text in der Eigenschaft ${name}: Anzeige? dann {t('…')}`); return; }
      const text = `{${tCall(value.value)}}`;
      addEdit(value.start, value.end, text, 'R3', attr, () => sigOfSnippet(tCall(value.value), 'expr') === value.value);
      return;
    }
    if (value.type === 'JSXExpressionContainer') {
      if (!containsGerman(value.expression)) return;
      if (!display) { manual(attr, 'R3', `Text in der Eigenschaft ${name}: Anzeige? dann t() an den Blättern`); return; }
      leafEdits(value.expression, 'R3');
    }
  }

  // --- module level (R6) ---
  const isFunctionLike = (node) => node && (/Function/.test(node.type) || (node.type === 'CallExpression' && node.arguments.some((a) => /Function/.test(a.type))) || node.type === 'ClassExpression');

  function markDeclaration(stmt) {
    if (comments.marked(stmt)) return;
    const lineStart = code.lastIndexOf('\n', stmt.start - 1) + 1;
    const indent = /^[ \t]*/.exec(code.slice(lineStart))[0];
    if (overlaps(lineStart, lineStart)) return;
    edits.push({ start: lineStart, end: lineStart, text: `${indent}// i18n\n`, rule: 'R6', line: stmt.loc.start.line, before: '' });
    result.markers++;
  }

  function germanOutsideFunctions(node) {
    let found = false;
    walk(node, (n, parent, key) => {
      if (found) return false;
      if (/Function/.test(n.type)) return false;
      if (parent?.type === 'ObjectProperty' && key === 'key') return undefined;
      if ((n.type === 'StringLiteral' && isGerman(n.value) && !excludedLiteral(n, parent, key, [])) || (n.type === 'TemplateLiteral' && germanTemplate(n))) found = true;
      return undefined;
    });
    return found;
  }

  function excludedLiteral(node, parent, key, ancestors) {
    if (!parent) return false;
    if (parent.type === 'ObjectProperty' && key === 'key') return true;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(parent.type)) return true;
    if (parent.type === 'BinaryExpression' && ['===', '!==', '==', '!=', 'in', 'instanceof'].includes(parent.operator)) return true;
    if (parent.type === 'SwitchCase' && key === 'test') return true;
    if (parent.type === 'JSXAttribute') return true;
    if (parent.type === 'TaggedTemplateExpression' || parent.type === 'TemplateLiteral') return false;
    if ((parent.type === 'CallExpression' || parent.type === 'NewExpression') && key === 'arguments') {
      const c = parent.callee;
      const prop = c.type === 'MemberExpression' && !c.computed ? c.property.name : c.type === 'Identifier' ? c.name : null;
      const object = c.type === 'MemberExpression' && c.object.type === 'Identifier' ? c.object.name : null;
      if (object === 'console') return true;
      if (prop && COMPARE_CALLS.has(prop)) return true;
      if (prop && ['RegExp', 'CustomEvent', 'Event', 'URL', 'URLSearchParams', 'require', 'fetch', 'apiFetch', 'lazy', 'Symbol'].includes(prop)) return true;
      // the word pairs of formatCount/countLabel are translated inside format.js
      if (prop && ['formatCount', 'countLabel'].includes(prop)) return true;
      if (object === 'api' || object === 'window' && prop === 'open') return true;
      if (prop && allNames.has(prop)) return true;
    }
    for (const a of ancestors) {
      if (a.type === 'CallExpression' && a.callee.type === 'MemberExpression' && a.callee.object.type === 'Identifier' && a.callee.object.name === 'console') return true;
      if (a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && EXCLUDED_ATTRS.test(a.name.name)) return true;
    }
    return false;
  }

  // --- main walk ---
  const handledJsx = new Set();
  const manualSpans = [];
  for (const stmt of ast.program.body) {
    const decl = stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration' ? stmt.declaration : stmt;
    if (decl?.type === 'VariableDeclaration' && !comments.ignored(stmt)) {
      const data = decl.declarations.filter((d) => d.init && !isFunctionLike(d.init));
      if (data.some((d) => germanOutsideFunctions(d.init))) markDeclaration(stmt);
    }
  }

  walk(ast.program, (node, parent, key, ancestors) => {
    if (comments.ignored(node) && node.type !== 'Program') return false;
    const inFunction = ancestors.some((a) => /Function/.test(a.type) || a.type === 'ClassMethod' || a.type === 'ClassProperty');
    // already-translated calls: nothing inside them
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && allNames.has(node.callee.name)) {
      if (allNames.get(node.callee.name) === 't') countBeforeNoun(node);
      return false;
    }
    if (node.type === 'JSXElement' || node.type === 'JSXFragment') {
      if (node.type === 'JSXElement') for (const attr of node.openingElement.attributes) if (attr.type === 'JSXAttribute') attributeEdit(attr);
      if (!handledJsx.has(node)) {
        handledJsx.add(node);
        processChildren(node);
        // R8: a stored value rendered as it is; R6 use sites: label-map entries and exported text constants
        for (const c of node.children) {
          if (c.type !== 'JSXExpressionContainer') continue;
          const e = c.expression;
          const member = /^(Member|OptionalMember)Expression$/.test(e.type) ? memberName(e) || '' : '';
          if (/^(status|condition|collecting|my_status)$/.test(member) || storedListItem(node, e, ancestors)) {
            manual(c, 'R8', 'gespeicherter Wert direkt angezeigt: statusLabel()/mangaStatusLabel()/conditionLabel()/collectingLabel()/animeProgressLabel()');
          } else if (/^(label|short|full|hint|subtitle|intro|text)$/.test(member)) {
            manual(c, 'R6', `Label-Map-Eintrag angezeigt: {t(${code.slice(e.start, e.end)})} (Quelle mit // i18n markiert?)`);
          } else if (e.type === 'Identifier' && /^[A-Z][A-Z0-9_]{2,}$/.test(e.name)) {
            manual(c, 'R6', `Textkonstante angezeigt: {t(${e.name})} (Konstante bleibt deutsch, Tests vergleichen sie)`);
          }
        }
      }
      // JSX child expressions: German leaves of ternaries and && (R5 in markup)
      for (const c of node.children) {
        if (c.type === 'JSXExpressionContainer' && !['StringLiteral', 'JSXEmptyExpression'].includes(c.expression.type) && !simpleExpr(c.expression)) {
          if (['ConditionalExpression', 'LogicalExpression', 'TemplateLiteral'].includes(c.expression.type)) leafEdits(c.expression, 'R5');
        }
      }
      return undefined;
    }
    if (!inFunction) return undefined;
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const c = node.callee;
      const prop = c.type === 'MemberExpression' && !c.computed ? c.property.name : null;
      const object = c.type === 'MemberExpression' && c.object.type === 'Identifier' ? c.object.name : null;
      const fn = c.type === 'Identifier' ? c.name : null;
      const args = node.arguments;
      if (object === 'notify' && ['error', 'success', 'info', 'update'].includes(prop)) {
        leafEdits(args[prop === 'update' ? 1 : 0], 'R5', { allowStored: false });
        const options = args[prop === 'update' ? 2 : 1];
        if (options?.type === 'ObjectExpression') optionLeaves(options);
      } else if (fn === 'notifyResponseError' || fn === 'errorFromResponse') {
        leafEdits(args[1], 'R5', { allowStored: false });
      } else if (fn === 'confirm' || (object === 'window' && prop === 'confirm') || fn === 'useDocumentTitle' || fn === 'codedError' || (fn && SETTER.test(fn)) || fn === 'fail') {
        leafEdits(args[0], 'R5', { allowStored: false });
      } else if (node.type === 'NewExpression' && fn && ERROR_CTOR.test(fn)) {
        leafEdits(args[0], 'R5', { allowStored: false });
      }
      return undefined;
    }
    if (node.type === 'LogicalExpression' && ['||', '??'].includes(node.operator) && !ancestors.some((a) => a.type === 'JSXAttribute')) {
      if (node.right.type === 'StringLiteral' || node.right.type === 'TemplateLiteral') leafEdits(node.right, 'R5', { allowStored: false });
      return undefined;
    }
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && memberName(node.left) === 'title' && node.left.object.type === 'Identifier' && node.left.object.name === 'document') {
      leafEdits(node.right, 'R5');
      return undefined;
    }
    if (node.type === 'ReturnStatement' && node.argument) {
      const owner = [...ancestors].reverse().find((a) => /Function/.test(a.type));
      const ownerName = functionName(owner, ancestors);
      if (ownerName && MESSAGE_FN.test(ownerName)) leafEdits(node.argument, 'R5', { allowStored: false });
      return undefined;
    }
    if (node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement') {
      const ownerName = functionName(node, ancestors);
      if (ownerName && MESSAGE_FN.test(ownerName)) leafEdits(node.body, 'R5', { allowStored: false });
      return undefined;
    }
    if (node.type === 'ObjectProperty' && !node.computed && LABEL_KEYS.test(node.key.name ?? node.key.value ?? '')) {
      if (['StringLiteral', 'TemplateLiteral', 'ConditionalExpression'].includes(node.value.type)) leafEdits(node.value, 'R5', { allowStored: false });
      return undefined;
    }
    return undefined;
  });

  // R9: a raw number right before a noun ('{count} Bände') needs tn(); formatCount/countLabel output brings its noun
  function countBeforeNoun(call) {
    const [keyNode, varsNode] = call.arguments;
    if (keyNode?.type !== 'StringLiteral' || varsNode?.type !== 'ObjectExpression' || comments.ignored(call)) return;
    for (const m of keyNode.value.matchAll(/\{(\w+)\} ([A-ZÄÖÜ][a-zäöüß]+)(?![.\wäöüß])/g)) {
      if (STORED_VALUES.has(m[2])) continue;
      const prop = varsNode.properties.find((p) => p.type === 'ObjectProperty' && (p.key.name ?? p.key.value) === m[1]);
      if (prop && numericValue(prop.value, m[1])) {
        manual(call, 'R9', `Zahl vor Nomen ({${m[1]}} ${m[2]}): tn('…', '…', n) statt t()`);
        return;
      }
    }
  }

  function numericValue(node, placeholder) {
    if (['NumericLiteral', 'BinaryExpression', 'UnaryExpression'].includes(node.type)) return true;
    if (node.type === 'LogicalExpression') return numericValue(node.left, placeholder) || numericValue(node.right, placeholder);
    if (node.type === 'CallExpression') return node.callee.type === 'Identifier' && ['formatNumber', 'fmtNumber', 'Number'].includes(node.callee.name);
    const name = memberName(node);
    if (!name) return false;
    return COUNTISH.test(placeholder) || COUNTISH.test(name) || /(Count|_count|Total|_total|length)$/.test(name);
  }

  // R8: `{x}` of an <option> or a badge span where x is the item of a .map() over a list of stored values
  function storedListItem(el, expr, ancestors) {
    if (expr.type !== 'Identifier' || el.type !== 'JSXElement') return false;
    const tag = el.openingElement.name.type === 'JSXIdentifier' ? el.openingElement.name.name : '';
    if (tag !== 'option' && tag !== 'span') return false;
    const fn = [...ancestors].reverse().find((a) => a.type === 'ArrowFunctionExpression' || a.type === 'FunctionExpression');
    if (!fn || fn.params[0]?.type !== 'Identifier' || fn.params[0].name !== expr.name) return false;
    const call = ancestors[ancestors.indexOf(fn) - 1];
    if (call?.type !== 'CallExpression' || call.callee.type !== 'MemberExpression' || memberName(call.callee) !== 'map') return false;
    const list = memberName(call.callee.object) || '';
    return STORED_LIST.test(list);
  }

  function optionLeaves(options) {
    for (const p of options.properties) {
      if (p.type !== 'ObjectProperty') continue;
      const name = p.key.name ?? p.key.value;
      if (name === 'fallback') leafEdits(p.value, 'R5');
      if (name === 'action' && p.value.type === 'ObjectExpression') {
        for (const q of p.value.properties) if (q.type === 'ObjectProperty' && (q.key.name ?? q.key.value) === 'label') leafEdits(q.value, 'R5');
      }
    }
  }

  function functionName(fn, ancestors) {
    if (!fn) return null;
    if (fn.id) return fn.id.name;
    const i = ancestors.indexOf(fn);
    const parent = i > 0 ? ancestors[i - 1] : ancestors[ancestors.length - 1];
    if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
    if (parent?.type === 'ObjectProperty') return parent.key.name ?? parent.key.value;
    return null;
  }

  // anything German left inside functions is MANUAL (and counted by the guard)
  walk(ast.program, (node, parent, key, ancestors) => {
    if (comments.ignored(node)) return false;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && allNames.has(node.callee.name)) return false;
    const text = node.type === 'StringLiteral' ? node.value : node.type === 'JSXText' ? cleanJsxText(node.value) : node.type === 'TemplateLiteral' && germanTemplate(node) ? node.quasis.map((q) => q.value.cooked).join('{x}') : null;
    if (text === null || overlaps(node.start, node.end)) return undefined;
    if (manualSpans.some(([a, b]) => node.start >= a && node.end <= b)) return undefined;
    if (node.type === 'JSXText' ? !displayText(text) : !isGerman(text)) return undefined;
    if (node.type !== 'JSXText' && excludedLiteral(node, parent, key, ancestors)) return undefined;
    const inFunction = ancestors.some((a) => /Function/.test(a.type) || a.type === 'ClassMethod');
    const stmt = ancestors[1];
    const markedTop = stmt && (comments.marked(stmt) || edits.some((e) => e.rule === 'R6' && e.line === stmt.loc.start.line));
    if (!inFunction && markedTop) return undefined;
    if (STORED_VALUES.has(text) && node.type === 'StringLiteral') return undefined;
    if (result.manual.some((m) => m.line === node.loc.start.line && code.slice(node.start, node.end).startsWith(m.text.slice(0, 20)))) return undefined;
    manual(node, inFunction ? 'R0' : 'R6', inFunction ? 'deutscher Text an einer Stelle ohne Regel: Anzeige? dann t() zur Laufzeit' : 'Modulebene außerhalb einer Deklaration');
    return undefined;
  });

  // imports for the wrappers that were used
  const missing = ['t', 'tn'].filter((n) => used.has(n) && ![...existing.values()].includes(n));
  const importEdits = [];
  const lastImport = [...ast.program.body].reverse().find((n) => n.type === 'ImportDeclaration');
  const dir = path.dirname(file);
  const relPath = (target) => {
    let p = path.relative(dir, path.join(SRC, 'i18n', target)).split(path.sep).join('/');
    if (!p.startsWith('.')) p = `./${p}`;
    return p;
  };
  const addImport = (wanted, module, test) => {
    if (!wanted.length) return;
    const decl = ast.program.body.find((n) => n.type === 'ImportDeclaration' && isI18nSource(n.source.value, file) && test.test(path.resolve(path.dirname(file), n.source.value).replace(/\.(js|jsx)$/, '')));
    const spec = (n) => (names[n] === n ? n : `${n} as ${names[n]}`);
    if (decl && decl.specifiers.length && decl.specifiers.every((s) => s.type === 'ImportSpecifier')) {
      const lastSpec = decl.specifiers[decl.specifiers.length - 1];
      importEdits.push({ start: lastSpec.end, end: lastSpec.end, text: `, ${wanted.map(spec).join(', ')}`, rule: 'import', line: decl.loc.start.line, before: '' });
      return;
    }
    const at = lastImport ? lastImport.end : 0;
    const semi = /;\s*$/.test(code.slice(lastImport?.start ?? 0, lastImport?.end ?? 0)) || !lastImport ? ';' : '';
    const line = `import { ${wanted.map(spec).join(', ')} } from '${relPath(module)}'${semi}`;
    importEdits.push({ start: at, end: at, text: lastImport ? `\n${line}` : `${line}\n`, rule: 'import', line: lastImport ? lastImport.loc.end.line + 1 : 1, before: '' });
  };
  addImport(missing, 'index.js', I18N_MODULE);
  if (used.has('rich') && ![...existing.values()].includes('rich')) addImport(['rich'], 'react.jsx', I18N_REACT);

  const all = [...edits, ...importEdits].sort((a, b) => b.start - a.start || b.end - a.end);
  let output = code;
  for (const e of all) output = output.slice(0, e.start) + e.text + output.slice(e.end);
  try {
    parse(output, file);
  } catch (err) {
    result.error = `Ergebnis lässt sich nicht parsen: ${err.message}`;
    output = code;
  }
  result.edits = [...edits].sort((a, b) => a.start - b.start).map(({ rule, line, before, text }) => ({ rule, line, before, after: text }));
  result.imports = importEdits.map((e) => e.text.trim());
  result.manual.sort((a, b) => a.line - b.line);
  result.output = output;
  return result;
}

function resolveFiles(arg) {
  if (!arg) return sourceFiles();
  const files = [];
  for (const part of arg.split(',').filter(Boolean)) {
    const full = path.resolve(part);
    if (fs.statSync(full).isDirectory()) files.push(...sourceFiles(full));
    else files.push(full);
  }
  return files;
}

function main(argv) {
  const valueOf = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : null;
  };
  const write = argv.includes('--write');
  const files = resolveFiles(valueOf('--files'));
  const report = { generated: new Date().toISOString(), mode: write ? 'write' : 'dry-run', totals: { files: 0, edits: 0, manual: 0, markers: 0, errors: 0 }, files: [] };
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    const res = transform(file, code);
    const { output, ...entry } = res;
    report.totals.files++;
    report.totals.edits += entry.edits.length;
    report.totals.manual += entry.manual.length;
    report.totals.markers += entry.markers;
    if (entry.error) report.totals.errors++;
    if (entry.edits.length || entry.manual.length || entry.error) report.files.push(entry);
    if (write && !entry.error && output !== code) fs.writeFileSync(file, output);
  }
  const out = valueOf('--report');
  if (out) fs.writeFileSync(path.resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  const t = report.totals;
  console.log(`${report.mode}: ${t.files} Dateien, ${t.edits} Änderungen (davon ${t.markers} Marker), ${t.manual} MANUAL, ${t.errors} Fehler${out ? ` → ${out}` : ''}`);
  for (const f of report.files.filter((x) => x.error)) console.log(`FEHLER ${f.file}: ${f.error}`);
  if (t.errors) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
