#!/usr/bin/env node
// Stages electron-builder's extraResources into dist/stage: server (backend + node_modules + web build), app-frontend, qr.mjs.
// Usage: node scripts/stage.js [--build-frontend] [--web <dir>] [--app <dir>]; without --build-frontend the
// builds (default ../frontend/dist, ../frontend/dist-app) must already exist.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DESKTOP = path.resolve(__dirname, '..');
const ROOT = path.resolve(DESKTOP, '..');
const STAGE = path.join(DESKTOP, 'dist', 'stage');

/** Backend entries to copy: the root package.json "files" plus package.json and the lockfile. */
function backendEntries(rootPkg) {
    const files = Array.isArray(rootPkg.files) ? rootPkg.files : [];
    if (!files.length) throw new Error('package.json der Wurzel hat keine "files"-Liste');
    return [...new Set([...files.map((f) => f.replace(/\/+$/, '')), 'package.json', 'package-lock.json'])];
}

/** Entries of `entries` that do not exist below `root`. */
const missingEntries = (root, entries) => entries.filter((entry) => !fs.existsSync(path.join(root, entry)));

const SKIP = new Set(['node_modules', '.DS_Store']);
const copyEntry = (from, to) => fs.cpSync(from, to, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });

function parseStageArgs(argv) {
    const out = { buildFrontend: false, web: path.join(ROOT, 'frontend', 'dist'), app: path.join(ROOT, 'frontend', 'dist-app') };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--build-frontend') out.buildFrontend = true;
        else if (argv[i] === '--web') out.web = path.resolve(argv[++i]);
        else if (argv[i] === '--app') out.app = path.resolve(argv[++i]);
    }
    return out;
}

function run(cmd, args, cwd) {
    const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} fehlgeschlagen (Code ${res.status})`);
}

function requireBuild(dir, what) {
    if (!fs.existsSync(path.join(dir, 'index.html'))) {
        throw new Error(`${what} fehlt in ${dir}: erst bauen oder --build-frontend verwenden`);
    }
}

const WATCH_MANIFEST_KEY = 'src/app/watch/CrunchyrollCard.jsx';

/** The desktop web build must carry the Crunchyroll card unless VITE_WATCH_CRUNCHYROLL is 'off'. */
function requireWatchBuild(dir, env = process.env) {
    if (env.VITE_WATCH_CRUNCHYROLL === 'off') return;
    const file = path.join(dir, '.vite', 'manifest.json');
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { manifest = null; }
    if (!manifest || !Object.prototype.hasOwnProperty.call(manifest, WATCH_MANIFEST_KEY)) {
        throw new Error(`Web-Build ohne ${WATCH_MANIFEST_KEY} (${file}): mit "vite build --mode desktop" bauen oder VITE_WATCH_CRUNCHYROLL=off setzen`);
    }
}

function main() {
    const opts = parseStageArgs(process.argv.slice(2));
    const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const entries = backendEntries(rootPkg);
    const missing = missingEntries(ROOT, entries);
    if (missing.length) throw new Error(`Fehlende Backend-Dateien: ${missing.join(', ')}`);

    fs.rmSync(STAGE, { recursive: true, force: true });
    const serverDir = path.join(STAGE, 'server');
    fs.mkdirSync(serverDir, { recursive: true });
    for (const entry of entries) copyEntry(path.join(ROOT, entry), path.join(serverDir, entry));
    run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], serverDir);

    const webOut = path.join(serverDir, 'frontend', 'dist');
    const appOut = path.join(STAGE, 'app-frontend');
    const frontend = path.join(ROOT, 'frontend');
    if (opts.buildFrontend) {
        if (!fs.existsSync(path.join(frontend, 'node_modules'))) run('npm', ['ci', '--no-audit', '--no-fund'], frontend);
        run('npx', ['vite', 'build', '--mode', 'desktop', '--outDir', webOut, '--emptyOutDir'], frontend);
        requireWatchBuild(webOut);
        run('npx', ['vite', 'build', '--mode', 'app', '--outDir', appOut, '--emptyOutDir'], frontend);
    } else {
        requireBuild(opts.web, 'Web-Build');
        requireBuild(opts.app, 'App-Build (vite build --mode app)');
        requireWatchBuild(opts.web);
        copyEntry(opts.web, webOut);
        copyEntry(opts.app, appOut);
    }
    fs.copyFileSync(path.join(frontend, 'src', 'app', 'qr.js'), path.join(STAGE, 'qr.mjs'));
    console.log(`Stage bereit: ${STAGE}`);
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        console.error(`[stage] ${err.message}`);
        process.exit(1);
    }
}

module.exports = { backendEntries, missingEntries, parseStageArgs, requireWatchBuild, WATCH_MANIFEST_KEY, STAGE };
