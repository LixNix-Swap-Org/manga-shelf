// Copies the backend files listed in package.json "files" into a target folder (Docker build stage).
// Plain fs only: it runs before any dependency is installed.
const fs = require('fs');
const path = require('path');

const IGNORED_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

function readManifest(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) throw new Error('package.json hat kein "files"-Array');
  return pkg.files.map(entry => {
    const rel = String(entry).replace(/\\/g, '/').replace(/\/+$/, '');
    if (!rel || rel.startsWith('/') || rel.split('/').includes('..') || /[*?[\]{}!]/.test(rel)) {
      throw new Error(`Ungültiger Eintrag in package.json "files": ${entry}`);
    }
    return rel;
  });
}

function shippedFiles(root, manifest = readManifest(root)) {
  const out = [];
  const missing = [];
  const walk = rel => {
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        if (!IGNORED_NAMES.has(name)) walk(`${rel}/${name}`);
      }
    } else if (st.isFile()) {
      out.push(rel);
    }
  };
  for (const rel of manifest) {
    if (!fs.existsSync(path.join(root, rel))) missing.push(rel);
    else walk(rel);
  }
  if (missing.length) throw new Error(`In package.json "files" genannt, aber nicht vorhanden: ${missing.join(', ')}`);
  return out;
}

function stageBackend(root, target) {
  const files = shippedFiles(root);
  for (const rel of files) {
    const dest = path.join(target, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, rel), dest);
  }
  return files;
}

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error('Aufruf: node scripts/stage-backend.js <zielordner>');
    process.exit(2);
  }
  try {
    const files = stageBackend(path.join(__dirname, '..'), path.resolve(target));
    console.log(`${files.length} Backend-Dateien nach ${path.resolve(target)} kopiert`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { readManifest, shippedFiles, stageBackend };
