// WCAG 2.x contrast of the dark theme's colour tokens, measured on the real backgrounds.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const FRONTEND = path.join(__dirname, '..', 'frontend');
const SRC = path.join(FRONTEND, 'src');
const CSS = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');

// Tailwind 3 default palette (the shades the app uses)
const PALETTE = {
  white: '#ffffff',
  black: '#000000',
  slate: { 300: '#cbd5e1', 400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a', 950: '#020617' },
  emerald: { 700: '#047857' },
  orange: { 700: '#c2410c' },
  pink: { 700: '#be185d' },
  yellow: { 400: '#facc15' },
  sky: { 700: '#0369a1' },
  amber: { 500: '#f59e0b', 700: '#b45309' },
  teal: { 700: '#0f766e' },
  purple: { 700: '#7e22ce' },
  rose: { 700: '#be123c' },
  fuchsia: { 700: '#a21caf' },
  indigo: { 600: '#4f46e5' },
  red: { 600: '#dc2626', 700: '#b91c1c' }
};
const BODY = '#0b0f19';

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const channel = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** `top` with opacity `alpha` composited over the opaque `bottom`. */
const over = (top, alpha, bottom) => toHex(rgb(top).map((v, i) => v * alpha + rgb(bottom)[i] * (1 - alpha)));
const mix = (a, b) => over(a, 0.5, b);

let brand;
const loadBrand = async () => {
  if (!brand) brand = (await import(pathToFileURL(path.join(FRONTEND, 'tailwind.config.js')).href)).default.theme.extend.colors.brand;
  return brand;
};
const color = async (token) => {
  const [name, shade] = token.split('-');
  if (name === 'white' || name === 'black') return PALETTE[name];
  const scale = name === 'brand' ? await loadBrand() : PALETTE[name];
  assert.ok(scale && scale[shade], `unknown colour ${token}`);
  return scale[shade];
};

const GLASS_PANEL = over(PALETTE.slate[900], 0.8, BODY);
const TOOLBAR = over(PALETTE.slate[950], 0.7, GLASS_PANEL);
const BACKGROUNDS = { body: BODY, 'glass-panel': GLASS_PANEL, toolbar: TOOLBAR, 'slate-900': PALETTE.slate[900] };

test('the WCAG formula gives the known reference values', () => {
  assert.equal(contrast('#000000', '#ffffff').toFixed(2), '21.00');
  assert.equal(contrast('#ffffff', '#ffffff'), 1);
  assert.equal(contrast('#767676', '#ffffff').toFixed(2), '4.54');
});

test('informational text colours reach 4.5:1 on every dark background', () => {
  for (const token of ['slate-300', 'slate-400']) {
    for (const [bgName, bg] of Object.entries(BACKGROUNDS)) {
      const ratio = contrast(PALETTE.slate[token.split('-')[1]], bg);
      assert.ok(ratio >= 4.5, `${token} on ${bgName}: ${ratio.toFixed(2)}`);
    }
  }
});

test('slate-500, kept for decorative marks only, still reaches 3:1 as a non-text colour', () => {
  for (const [bgName, bg] of Object.entries(BACKGROUNDS)) {
    const ratio = contrast(PALETTE.slate[500], bg);
    assert.ok(ratio >= 3, `slate-500 on ${bgName}: ${ratio.toFixed(2)}`);
  }
});

test('.input-field placeholders are readable on the field background', async () => {
  const rule = CSS.match(/\.input-field\s*\{[^}]*\}/)[0];
  const token = rule.match(/placeholder-([a-z]+-\d+)/)[1];
  const field = over(PALETTE.slate[950], 0.7, GLASS_PANEL);
  const ratio = contrast(await color(token), field);
  assert.ok(ratio >= 4.5, `${token} placeholder: ${ratio.toFixed(2)}`);
});

test('.btn-primary keeps white text at 4.5:1 across its gradient, also on hover', async () => {
  const rule = CSS.match(/\.btn-primary\s*\{[^}]*\}/)[0];
  assert.match(rule, /text-white/);
  const stop = (prefix) => {
    const m = rule.match(new RegExp(`(?:^|\\s)${prefix}(brand|[a-z]+)-(\\d+)(?=\\s)`));
    assert.ok(m, `no ${prefix} stop in .btn-primary`);
    return `${m[1]}-${m[2]}`;
  };
  for (const [from, to] of [[stop('from-'), stop('to-')], [stop('hover:from-'), stop('hover:to-')]]) {
    const [a, b] = [await color(from), await color(to)];
    for (const [label, bg] of [[from, a], [`${from}/${to} centre`, mix(a, b)], [to, b]]) {
      const ratio = contrast(PALETTE.white, bg);
      assert.ok(ratio >= 4.5, `white on ${label}: ${ratio.toFixed(2)}`);
    }
  }
});

test('selected chips and tabs keep white text at 4.5:1', async () => {
  const tokens = ['brand-700', 'brand-800', 'emerald-700', 'sky-700', 'amber-700', 'teal-700', 'purple-700', 'rose-700', 'fuchsia-700', 'indigo-600', 'red-600'];
  for (const token of tokens) {
    const ratio = contrast(PALETTE.white, await color(token));
    assert.ok(ratio >= 4.5, `white on ${token}: ${ratio.toFixed(2)}`);
  }
});

test('the focus outline (brand-400) reaches 3:1 against every background', async () => {
  assert.match(CSS, /:focus-visible\s*\{\s*outline:\s*2px solid theme\('colors\.brand\.400'\)/);
  const ring = await color('brand-400');
  for (const [bgName, bg] of Object.entries(BACKGROUNDS)) {
    const ratio = contrast(ring, bg);
    assert.ok(ratio >= 3, `brand-400 on ${bgName}: ${ratio.toFixed(2)}`);
  }
});

const sourceFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
  return /\.jsx?$/.test(entry.name) ? [full] : [];
});
const readSource = (file) => ({ file: path.relative(SRC, file), text: fs.readFileSync(file, 'utf8') });
const SOURCES = sourceFiles(SRC).filter((file) => file.endsWith('.jsx')).map(readSource);
// class strings built in helpers (e.g. the shelf spine themes) end up on elements as well
const UTIL_SOURCES = sourceFiles(path.join(SRC, 'utils')).map(readSource);

/** The JSX opening tag around `index` (from its `<` to the closing `>`, braces respected). */
function openingTag(text, index) {
  const start = text.lastIndexOf('<', index);
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    else if (text[i] === '>' && depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

test('no component uses the low-contrast text colours', () => {
  const offenders = [];
  for (const { file, text } of SOURCES) {
    for (const m of text.matchAll(/(?<![\w:/-])(text-slate-600|placeholder-slate-[56]00)(?![\w/])/g)) {
      offenders.push(`${file}: ${m[1]}`);
    }
    for (const m of text.matchAll(/(?<![\w:/-])text-slate-500(?![\w/])/g)) {
      const tag = openingTag(text, m.index);
      // icons (components) and aria-hidden marks are decorative; text needs slate-400 or lighter
      if (/^<[A-Z]/.test(tag) || /aria-hidden="true"/.test(tag)) continue;
      offenders.push(`${file}: text-slate-500 on ${tag.slice(0, 60)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('white text never sits on a mid-tone solid background', () => {
  const offenders = [];
  for (const { file, text } of [...SOURCES, ...UTIL_SOURCES]) {
    text.split('\n').forEach((line, i) => {
      if (!/(?<![\w:-])text-white(?![\w/])/.test(line)) return;
      const m = line.match(/(?<![\w:/!-])(?:hover:)?bg-(brand|sky|emerald|teal|purple|rose|amber|fuchsia|red|orange|green|blue|cyan|pink|violet|yellow|lime)-(300|400|500|600)(?![\w/])/);
      if (m && !(m[1] === 'red' && m[2] === '600')) offenders.push(`${file}:${i + 1}: ${m[0]}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('gradients under white text keep 4.5:1 at every stop', async () => {
  const offenders = [];
  let checked = 0;
  for (const { file, text } of [...SOURCES, ...UTIL_SOURCES]) {
    for (const [i, line] of text.split('\n').entries()) {
      if (!/(?<![\w:-])text-white(?![\w/])/.test(line)) continue;
      const stops = [...line.matchAll(/(?<![\w:/-])(?:from|via|to)-([a-z]+-\d+)(?![\w/])/g)].map((m) => m[1]);
      for (const token of stops) {
        checked++;
        const ratio = contrast(PALETTE.white, await color(token));
        if (ratio < 4.5) offenders.push(`${file}:${i + 1}: ${token} ${ratio.toFixed(2)}`);
      }
    }
  }
  assert.ok(checked >= 2, `only ${checked} gradient stops found`);
  assert.deepEqual(offenders, []);
});

test('shelf spine publisher badges keep their text at 4.5:1', async () => {
  const helpers = fs.readFileSync(path.join(SRC, 'utils', 'volumeHelpers.js'), 'utf8');
  const badges = [...helpers.matchAll(/accentBadge:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(badges.length >= 10, `found ${badges.length} badges`);
  for (const badge of badges) {
    const bg = badge.match(/(?:^|\s)bg-([a-z]+(?:-\d+)?)(?=\s|$)/)[1];
    const fg = badge.match(/(?:^|\s)text-([a-z]+(?:-\d+)?)(?=\s|$)/)[1];
    const ratio = contrast(await color(fg), await color(bg));
    assert.ok(ratio >= 4.5, `${badge}: ${ratio.toFixed(2)}`);
  }
});
