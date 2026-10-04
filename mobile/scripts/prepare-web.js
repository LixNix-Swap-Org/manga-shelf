#!/usr/bin/env node
// Assembles mobile/www (Capacitor's webDir): the frontend's app build plus native-bridge.js, loaded before the app.
//   node scripts/prepare-web.js            copies ../frontend/dist-app
//   node scripts/prepare-web.js --build    runs `npm run build:app` in ../frontend first
//   node scripts/prepare-web.js --from <dir>
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MOBILE_DIR = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.resolve(MOBILE_DIR, '..', 'frontend');
const WWW_DIR = path.join(MOBILE_DIR, 'www');
const BRIDGE_FILE = 'native-bridge.js';
const BRIDGE_TAG = `<script src="./${BRIDGE_FILE}"></script>`;

/** The bridge tag before the first script of index.html (a classic script runs before deferred module scripts). */
function injectBridgeTag(html) {
  if (html.includes(BRIDGE_TAG)) return html;
  const at = html.search(/<script\b/i);
  if (at === -1) throw new Error('index.html enthält kein <script> – ist das ein App-Build (vite build --mode app)?');
  return `${html.slice(0, at)}${BRIDGE_TAG}\n    ${html.slice(at)}`;
}

// the precompressed .br/.gz copies are for the server; the WebView reads the plain files
const shouldCopy = (name) => !/\.(br|gz)$/.test(name);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else if (entry.isFile() && shouldCopy(entry.name)) fs.copyFileSync(src, dest);
  }
}

function checkAppBuild(dir) {
  const index = path.join(dir, 'index.html');
  if (!fs.existsSync(index)) throw new Error(`${index} fehlt – erst \`npm run build:app\` im Ordner frontend ausführen`);
  const html = fs.readFileSync(index, 'utf-8');
  if (!html.includes('Content-Security-Policy')) {
    throw new Error(`${dir} ist kein App-Build (keine CSP im index.html): \`vite build --mode app\` verwenden`);
  }
}

async function bundleBridge(outFile) {
  const esbuild = require('esbuild');
  await esbuild.build({
    entryPoints: [path.join(MOBILE_DIR, 'src', 'native-bridge.mjs')],
    outfile: outFile,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020', 'safari14', 'chrome87'],
    minify: true,
    legalComments: 'none',
    logLevel: 'warning'
  });
}

function parseArgs(argv) {
  const args = { build: false, from: path.join(FRONTEND_DIR, 'dist-app') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--build') args.build = true;
    else if (argv[i] === '--from') args.from = path.resolve(argv[++i] || '');
    else throw new Error(`Unbekannte Option: ${argv[i]}`);
  }
  return args;
}

async function prepareWeb({ build = false, from = path.join(FRONTEND_DIR, 'dist-app'), wwwDir = WWW_DIR } = {}) {
  if (build) execFileSync('npm', ['run', 'build:app'], { cwd: FRONTEND_DIR, stdio: 'inherit' });
  checkAppBuild(from);
  fs.rmSync(wwwDir, { recursive: true, force: true });
  copyDir(from, wwwDir);
  await bundleBridge(path.join(wwwDir, BRIDGE_FILE));
  const index = path.join(wwwDir, 'index.html');
  fs.writeFileSync(index, injectBridgeTag(fs.readFileSync(index, 'utf-8')));
  return wwwDir;
}

module.exports = { injectBridgeTag, shouldCopy, parseArgs, prepareWeb, BRIDGE_TAG, WWW_DIR };

if (require.main === module) {
  prepareWeb(parseArgs(process.argv.slice(2)))
    .then((dir) => console.log(`[mobile] Web-Dateien bereit: ${path.relative(process.cwd(), dir) || dir}`))
    .catch((err) => {
      console.error(`[mobile] ${err.message}`);
      process.exit(1);
    });
}
