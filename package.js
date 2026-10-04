// Builds the Pterodactyl ZIP: package.json, the lockfile, .env.example, the backend files listed in package.json
// "files" (the same list the Docker image uses, see scripts/stage-backend.js) and the built frontend.
// Needs a built frontend: `npm run package` runs `build:frontend` first.
const fs = require('fs');
const path = require('path');
const { ZipArchive } = require('archiver');
const { readManifest, shippedFiles } = require('./scripts/stage-backend');

const ZIP_NAME = 'pterodactyl-manga-shelf.zip';
// package-lock.json makes the egg's `npm install --omit=dev` install the tested dependency tree
const PACKAGE_FILES = ['package.json', 'package-lock.json', '.env.example'];
const FRONTEND_DIST = 'frontend/dist';
const FRONTEND_INDEX = `${FRONTEND_DIST}/index.html`;

function missingInputs(root) {
  const missing = [...PACKAGE_FILES, FRONTEND_INDEX].filter(rel => !fs.existsSync(path.join(root, rel)));
  if (missing.includes('package.json')) return missing;
  const declared = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).files || [];
  readManifest(root).forEach((rel, i) => {
    if (!fs.existsSync(path.join(root, rel))) missing.push(declared[i]);
  });
  return missing;
}

/**
 * Writes the ZIP to a temp file and only replaces <outDir>/pterodactyl-manga-shelf.zip (and the copy in the root)
 * when every input exists and the archive holds the required entries, so a failed run never clobbers the last good ZIP.
 */
async function buildPackage({ root = __dirname, outDir = path.join(root, 'dist_pack'), copyToRoot = true } = {}) {
  const missing = missingInputs(root);
  if (missing.length) {
    throw new Error(`Fehlende Dateien für die ZIP: ${missing.join(', ')}` +
      (missing.some(m => m.startsWith(FRONTEND_DIST)) ? ' (zuerst `npm run build:frontend`)' : ''));
  }
  const backend = shippedFiles(root);
  const required = [...PACKAGE_FILES, ...backend, FRONTEND_INDEX];

  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, ZIP_NAME);
  const tmpPath = `${zipPath}.tmp`;
  const entries = [];

  try {
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(tmpPath);
      const archive = new ZipArchive({ zlib: { level: 9 } });
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('warning', reject);
      archive.on('error', reject);
      archive.on('entry', entry => entries.push(entry.name));
      archive.pipe(output);
      for (const rel of [...PACKAGE_FILES, ...backend]) archive.file(path.join(root, rel), { name: rel });
      archive.directory(path.join(root, FRONTEND_DIST), FRONTEND_DIST);
      archive.finalize();
    });
    const absent = required.filter(name => !entries.includes(name));
    if (absent.length) throw new Error(`Die ZIP enthält nicht alles Nötige: ${absent.join(', ')}`);
    fs.renameSync(tmpPath, zipPath);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }

  if (copyToRoot) fs.copyFileSync(zipPath, path.join(root, ZIP_NAME));
  return { zipPath, entries };
}

if (require.main === module) {
  buildPackage()
    .then(({ zipPath, entries }) => {
      console.log(`Packaging complete: ${zipPath} (${entries.length} Dateien, ${fs.statSync(zipPath).size} Bytes)`);
      console.log(`Also updated ${path.join(__dirname, ZIP_NAME)}. Upload this ZIP to your Pterodactyl server.`);
    })
    .catch(err => {
      console.error(`Packaging failed: ${err.message}`);
      process.exitCode = 1;
    });
}

module.exports = { buildPackage, PACKAGE_FILES, FRONTEND_DIST, ZIP_NAME };
