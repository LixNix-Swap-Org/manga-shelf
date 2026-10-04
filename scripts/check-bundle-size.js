// Compares the gzip size of every built JS/CSS chunk (frontend/dist/.vite/manifest.json) with
// frontend/bundle-budget.json and fails when one grows more than the tolerance. `--update` rewrites the budget.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DIST = path.join(ROOT, 'frontend', 'dist');
const DEFAULT_BUDGET = path.join(ROOT, 'frontend', 'bundle-budget.json');
const DEFAULT_TOLERANCE = 0.15;
const DEFAULT_NEW_CHUNK_LIMIT = 20 * 1024;
// a few hundred bytes are noise for tiny chunks (icons), where 15 % would be a handful of bytes
const DEFAULT_MIN_SLACK = 512;
const INITIAL_KEY = 'initial-load';

// Shared chunks are keyed by their hashed file name (`_Button-AbC123.js`), dependencies by their path
function normalizeKey(key) {
  const nm = key.lastIndexOf('node_modules/');
  if (nm !== -1) return key.slice(nm);
  return key.replace(/^_(.+)-[\w-]{8}(\.\w+)$/, '_$1$2');
}

function gzipSize(file) {
  return zlib.gzipSync(fs.readFileSync(file), { level: 9 }).length;
}

function collectSizes(distDir) {
  const manifestPath = path.join(distDir, '.vite', 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`${manifestPath} fehlt (build.manifest in vite.config.js, zuerst bauen)`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const fileSize = new Map();
  const sizeOf = rel => {
    if (!fileSize.has(rel)) fileSize.set(rel, gzipSize(path.join(distDir, rel)));
    return fileSize.get(rel);
  };
  const chunks = {};
  const add = (key, bytes) => { chunks[key] = (chunks[key] || 0) + bytes; };
  for (const [key, chunk] of Object.entries(manifest)) {
    const name = normalizeKey(key);
    if (/\.(js|mjs|css)$/.test(chunk.file)) add(name, sizeOf(chunk.file));
    for (const css of chunk.css || []) add(`${name} (css)`, sizeOf(css));
  }

  const initialFiles = new Set();
  const visit = key => {
    const chunk = manifest[key];
    if (!chunk || initialFiles.has(chunk.file)) return;
    initialFiles.add(chunk.file);
    for (const css of chunk.css || []) initialFiles.add(css);
    for (const dep of chunk.imports || []) visit(dep);
  };
  for (const [key, chunk] of Object.entries(manifest)) if (chunk.isEntry) visit(key);
  chunks[INITIAL_KEY] = [...initialFiles].filter(f => /\.(js|mjs|css)$/.test(f)).reduce((sum, f) => sum + sizeOf(f), 0);
  return chunks;
}

function compareToBudget(sizes, budget) {
  const tolerance = budget.tolerance ?? DEFAULT_TOLERANCE;
  const newChunkLimit = budget.newChunkLimit ?? DEFAULT_NEW_CHUNK_LIMIT;
  const minSlack = budget.minSlack ?? DEFAULT_MIN_SLACK;
  const limits = budget.chunks || {};
  const rows = [];
  for (const [key, bytes] of Object.entries(sizes)) {
    const base = limits[key];
    if (base === undefined) {
      rows.push({ key, bytes, base: null, limit: newChunkLimit, status: bytes > newChunkLimit ? 'zu groß (neu)' : 'neu' });
    } else {
      const limit = Math.max(Math.floor(base * (1 + tolerance)), base + minSlack);
      rows.push({ key, bytes, base, limit, status: bytes > limit ? 'zu groß' : 'ok' });
    }
  }
  for (const [key, base] of Object.entries(limits)) {
    if (!(key in sizes)) rows.push({ key, bytes: null, base, limit: null, status: 'entfallen' });
  }
  rows.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  return { rows, failed: rows.filter(r => r.status.startsWith('zu groß')) };
}

function formatTable(rows) {
  const kb = n => (n === null ? '-' : `${(n / 1024).toFixed(1)} KB`);
  const width = Math.max(10, ...rows.map(r => r.key.length));
  const lines = [`${'Chunk'.padEnd(width)}  ${'gzip'.padStart(10)}  ${'Budget'.padStart(10)}  ${'Grenze'.padStart(10)}  Status`];
  for (const r of rows) {
    lines.push(`${r.key.padEnd(width)}  ${kb(r.bytes).padStart(10)}  ${kb(r.base).padStart(10)}  ${kb(r.limit).padStart(10)}  ${r.status}`);
  }
  return lines.join('\n');
}

function updateBudget(budgetPath, sizes, previous = {}) {
  const next = {
    tolerance: previous.tolerance ?? DEFAULT_TOLERANCE,
    newChunkLimit: previous.newChunkLimit ?? DEFAULT_NEW_CHUNK_LIMIT,
    minSlack: previous.minSlack ?? DEFAULT_MIN_SLACK,
    chunks: Object.fromEntries(Object.entries(sizes).sort(([a], [b]) => a.localeCompare(b)))
  };
  fs.writeFileSync(budgetPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function main(argv) {
  const arg = name => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
  const distDir = path.resolve(arg('--dist') || DEFAULT_DIST);
  const budgetPath = path.resolve(arg('--budget') || DEFAULT_BUDGET);
  const sizes = collectSizes(distDir);
  const budget = fs.existsSync(budgetPath) ? JSON.parse(fs.readFileSync(budgetPath, 'utf8')) : null;
  if (argv.includes('--update')) {
    updateBudget(budgetPath, sizes, budget || {});
    console.log(`Budget aktualisiert: ${budgetPath}`);
    return 0;
  }
  if (!budget) throw new Error(`${budgetPath} fehlt (mit --update anlegen)`);
  const { rows, failed } = compareToBudget(sizes, budget);
  console.log(formatTable(rows));
  if (failed.length) {
    console.error(`\nBundle-Budget überschritten: ${failed.map(r => r.key).join(', ')}. ` +
      'Gewollt? Dann `npm run check:bundle -- --update` nach dem Build und frontend/bundle-budget.json committen.');
    return 1;
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { normalizeKey, collectSizes, compareToBudget, updateBudget, formatTable, INITIAL_KEY };
