// Covers the staging script and the packaging configuration of the desktop app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { backendEntries, missingEntries, parseStageArgs, requireWatchBuild, WATCH_MANIFEST_KEY, STAGE } = require('../scripts/stage');

const desktop = path.resolve(__dirname, '..');
const repo = path.resolve(desktop, '..');
const read = (file) => fs.readFileSync(path.join(desktop, file), 'utf8');
const rootPkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const desktopPkg = JSON.parse(read('package.json'));
const builder = read('electron-builder.yml');

test('the stage takes the backend from the root package.json "files" (incl. core/) and every entry exists', () => {
    const entries = backendEntries(rootPkg);
    for (const entry of ['index.js', 'db.js', 'core', 'routes', 'services', 'utils', 'middleware', 'package.json', 'package-lock.json']) {
        assert.ok(entries.includes(entry), entry);
    }
    assert.deepEqual(missingEntries(repo, entries), []);
    assert.deepEqual(missingEntries(repo, ['gibt-es-nicht.js']), ['gibt-es-nicht.js']);
    assert.throws(() => backendEntries({}), /files/);
});

test('every local module the main process loads is inside the packaged "files"', () => {
    const patterns = [...builder.matchAll(/^ {2}- ([\w./*-]+)$/gm)].map((m) => m[1]).filter((p) => !p.includes('stage'));
    const covered = (rel) => patterns.some((p) => (p.endsWith('/**') ? rel.startsWith(p.slice(0, -2)) : rel === p));
    const seen = new Set();
    const visit = (rel) => {
        if (seen.has(rel)) return;
        seen.add(rel);
        assert.ok(covered(rel), `${rel} fehlt in electron-builder.yml files`);
        const source = fs.readFileSync(path.join(desktop, rel), 'utf8');
        for (const [, dep] of source.matchAll(/require\('(\.{1,2}\/[^']+)'\)/g)) {
            const target = path.relative(desktop, path.resolve(path.dirname(path.join(desktop, rel)), dep));
            visit(target.endsWith('.js') ? target : `${target}.js`);
        }
    };
    visit(desktopPkg.main);
    visit('preload.js');
    visit('ui/dialogPreload.js');
    assert.ok(seen.has('lib/secureStore.js'));
    assert.ok(covered('assets/tray.png'));
});

test('electron-builder targets per OS, extra resources from the stage, the deep link scheme', () => {
    for (const target of ['target: dmg', 'target: zip', 'arch: universal', 'target: nsis', 'target: portable', 'allowToChangeInstallationDirectory: true', '- AppImage', '- deb', '- rpm']) {
        assert.ok(builder.includes(target), target);
    }
    for (const from of ['dist/stage/server', 'dist/stage/app-frontend', 'dist/stage/qr.mjs']) assert.ok(builder.includes(`from: ${from}`), from);
    assert.ok(STAGE.endsWith(path.join('desktop', 'dist', 'stage')));
    assert.match(builder, /schemes:\n\s+- manga-shelf/);
    assert.match(builder, /NSCameraUsageDescription/);
    assert.ok(fs.existsSync(path.join(desktop, 'build', 'entitlements.mac.plist')));
    for (const size of [16, 32, 48, 64, 128, 256, 512]) assert.ok(fs.existsSync(path.join(desktop, 'build', 'icons', `${size}x${size}.png`)), size);
    assert.ok(fs.existsSync(path.join(desktop, 'flatpak', 'de.mangashelf.desktop.yml')));
});

test('desktop/package.json: same version as the app, the build scripts the CI calls, Electron with node:sqlite', () => {
    assert.equal(desktopPkg.version, rootPkg.version);
    assert.equal(desktopPkg.main, 'main.js');
    assert.match(desktopPkg.scripts['build:desktop'], /^node scripts\/stage\.js --build-frontend && node scripts\/builder\.js --publish never$/);
    assert.match(desktopPkg.scripts['build:dir'], /^node scripts\/stage\.js --build-frontend && node scripts\/builder\.js --dir --publish never$/);
    assert.deepEqual(desktopPkg.dependencies ?? {}, {}, 'runtime modules come from the stage, not from desktop/node_modules');
    const electronMajor = Number(/(\d+)/.exec(desktopPkg.devDependencies.electron)[1]);
    assert.ok(electronMajor >= 44, 'Electron 44+ bundles Node 24 (node:sqlite)');
});

test('local builds stay unsigned without signing variables; CI certificates or an explicit choice keep signing', () => {
    const { builderEnv } = require('../scripts/builder');
    const plain = builderEnv({ PATH: '/bin', CSC_LINK: ' ' });
    assert.equal(plain.unsigned, true);
    assert.equal(plain.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
    assert.equal(plain.env.PATH, '/bin');
    for (const name of ['CSC_LINK', 'CSC_NAME', 'WIN_CSC_LINK', 'APPLE_ID', 'APPLE_API_KEY', 'APPLE_KEYCHAIN_PROFILE']) {
        const signed = builderEnv({ [name]: 'x' });
        assert.equal(signed.unsigned, false, name);
        assert.equal(signed.env.CSC_IDENTITY_AUTO_DISCOVERY, undefined, name);
    }
    assert.deepEqual(builderEnv({ CSC_IDENTITY_AUTO_DISCOVERY: 'true' }), { env: { CSC_IDENTITY_AUTO_DISCOVERY: 'true' }, unsigned: false });
});

test('the build wrapper passes its arguments to electron-builder and says the build is unsigned', () => {
    const { spawnSync } = require('child_process');
    const env = { ...process.env };
    for (const name of ['CSC_LINK', 'CSC_NAME', 'WIN_CSC_LINK', 'APPLE_ID', 'APPLE_API_KEY', 'APPLE_KEYCHAIN_PROFILE', 'CSC_IDENTITY_AUTO_DISCOVERY']) delete env[name];
    const run = spawnSync(process.execPath, [path.join(desktop, 'scripts', 'builder.js'), '--version'], { encoding: 'utf8', env });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /unsignierter Build/);
    assert.match(run.stdout, /\d+\.\d+\.\d+/);
});

test('stage arguments', () => {
    const opts = parseStageArgs(['--build-frontend', '--web', 'w', '--app', 'a']);
    assert.equal(opts.buildFrontend, true);
    assert.equal(opts.web, path.resolve('w'));
    assert.equal(opts.app, path.resolve('a'));
    assert.equal(parseStageArgs([]).web, path.join(repo, 'frontend', 'dist'));
});

test('smoke helpers find the unpacked app per OS and run Linux under xvfb without a display', (t) => {
    const os = require('os');
    const { findUnpackedBinary, smokeCommand } = require('../scripts/smoke');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-out-'));
    t.after(() => fs.rmSync(out, { recursive: true, force: true }));
    const touch = (rel) => { fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true }); fs.writeFileSync(path.join(out, rel), ''); };
    assert.equal(findUnpackedBinary(out, 'linux'), null);
    touch('linux-unpacked/manga-shelf');
    touch('win-unpacked/Manga Shelf.exe');
    touch('mac-arm64/Manga Shelf.app/Contents/MacOS/Manga Shelf');
    assert.equal(findUnpackedBinary(out, 'linux'), path.join(out, 'linux-unpacked', 'manga-shelf'));
    assert.equal(findUnpackedBinary(out, 'win32'), path.join(out, 'win-unpacked', 'Manga Shelf.exe'));
    assert.equal(findUnpackedBinary(out, 'darwin'), path.join(out, 'mac-arm64', 'Manga Shelf.app', 'Contents', 'MacOS', 'Manga Shelf'));
    assert.equal(findUnpackedBinary(path.join(out, 'nope'), 'linux'), null);

    const opts = { port: 3999, dataDir: '/d', userDataDir: '/u' };
    const linux = smokeCommand('/bin/app', { ...opts, platform: 'linux', env: {} });
    assert.equal(linux.command, 'xvfb-run');
    assert.deepEqual(linux.args.slice(0, 3), ['-a', '/bin/app', '--server-only']);
    assert.ok(linux.args.includes('--no-sandbox'));
    assert.equal(smokeCommand('/bin/app', { ...opts, platform: 'linux', env: { DISPLAY: ':0' } }).command, '/bin/app');
    const mac = smokeCommand('/bin/app', { ...opts, platform: 'darwin', env: {} });
    assert.deepEqual(mac.args, ['--server-only', '--port', '3999', '--data-dir', '/d', '--user-data-dir=/u']);
});

test('electronCommand: --no-sandbox on Linux and xvfb-run -a without a display, shared by smoke and the Electron gate test', () => {
    const { electronCommand, smokeCommand } = require('../scripts/smoke');
    assert.deepEqual(electronCommand('/e', ['run.js', '--user-data-dir=/u'], { platform: 'linux', env: {} }), { command: 'xvfb-run', args: ['-a', '/e', 'run.js', '--user-data-dir=/u', '--no-sandbox'] });
    assert.deepEqual(electronCommand('/e', ['run.js'], { platform: 'linux', env: { DISPLAY: ':0' } }), { command: '/e', args: ['run.js', '--no-sandbox'] });
    assert.deepEqual(electronCommand('/e', ['run.js'], { platform: 'darwin', env: {} }), { command: '/e', args: ['run.js'] });
    assert.deepEqual(electronCommand('/e', ['run.js'], { platform: 'win32', env: {} }), { command: '/e', args: ['run.js'] });
    const opts = { port: 1, dataDir: '/d', userDataDir: '/u' };
    for (const env of [{}, { DISPLAY: ':1' }]) {
        assert.deepEqual(smokeCommand('/bin/app', { ...opts, platform: 'linux', env }), electronCommand('/bin/app', ['--server-only', '--port', '1', '--data-dir', '/d', '--user-data-dir=/u'], { platform: 'linux', env }));
    }
    const launcher = read('scripts/electronTest.js');
    assert.match(launcher, /require\('\.\/smoke'\)/);
    assert.match(launcher, /electronCommand\(binary, \[path\.join\(DESKTOP, 'test', 'electron', 'run\.js'\), `--user-data-dir=\$\{userData\}`\]\)/);
    assert.equal(desktopPkg.scripts['test:electron'], 'node scripts/electronTest.js');
    assert.equal(desktopPkg.scripts.test, 'node --test test/*.test.js');
});

test('the Electron gate launcher fails on a kill, a signal and a null or non-zero code', () => {
    const { exitCodeOf, LIMIT_MS } = require('../scripts/electronTest');
    assert.equal(LIMIT_MS, 120000);
    assert.equal(exitCodeOf({ code: 0, signal: null, killed: false }), 0);
    assert.equal(exitCodeOf({ code: 1, signal: null, killed: false }), 1);
    assert.equal(exitCodeOf({ code: null, signal: 'SIGKILL', killed: true }), 1);
    assert.equal(exitCodeOf({ code: null, signal: 'SIGSEGV', killed: false }), 1);
    assert.equal(exitCodeOf({ code: null, signal: null, killed: false }), 1);
    assert.equal(exitCodeOf({ code: 0, signal: null, killed: true }), 1);
    const run = read('test/electron/run.js');
    const handlers = run.indexOf("process.on('uncaughtException', fail);\nprocess.on('unhandledRejection', fail);");
    assert.ok(handlers > 0);
    assert.ok(handlers < run.indexOf("const { app } = require('electron');"));
    assert.ok(handlers < run.indexOf("require('./transport')"));
    assert.match(run, /const fail = \(err\) => \{\n[^\n]*\n\s*require\('electron'\)\.app\.exit\(1\);/);
    assert.match(run, /app\.exit\(failed \? 1 : 0\)/);
});

test('the Electron gate test is complete in a checkout: every file it loads exists, none is git-ignored, the TLS fixture holds', (t) => {
    const { spawnSync } = require('child_process');
    const crypto = require('crypto');
    const gateDir = path.join(desktop, 'test', 'electron');
    const seen = new Set();
    const visit = (abs) => {
        if (seen.has(abs)) return;
        seen.add(abs);
        assert.ok(fs.existsSync(abs), `${path.relative(repo, abs)} fehlt`);
        for (const [, dep] of fs.readFileSync(abs, 'utf8').matchAll(/require\('(\.{1,2}\/[^']+)'\)/g)) {
            const target = path.resolve(path.dirname(abs), dep);
            visit(target.endsWith('.js') ? target : `${target}.js`);
        }
    };
    visit(path.join(desktop, 'scripts', 'electronTest.js'));
    visit(path.join(gateDir, 'run.js'));
    assert.ok(seen.has(path.join(gateDir, 'fixtureTls.js')));
    assert.doesNotMatch(read('test/electron/transport.js'), /readFileSync/);

    const { CERT, KEY } = require('./electron/fixtureTls');
    const cert = new crypto.X509Certificate(CERT);
    assert.ok(cert.checkPrivateKey(crypto.createPrivateKey(KEY)));
    assert.equal(cert.checkIP('127.0.0.1'), '127.0.0.1');
    assert.ok(Date.parse(cert.validTo) > Date.now(), `fixture certificate expired ${cert.validTo}`);

    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' });
    if (top.status !== 0 || fs.realpathSync(top.stdout.trim()) !== fs.realpathSync(repo)) {
        t.skip('kein Git-Checkout');
        return;
    }
    const files = [...new Set([...seen, ...fs.readdirSync(gateDir).map((name) => path.join(gateDir, name))])].map((abs) => path.relative(repo, abs));
    const ignored = spawnSync('git', ['check-ignore', '--no-index', '--verbose', '--', ...files], { cwd: repo, encoding: 'utf8' });
    assert.equal(ignored.status, 1, ignored.stdout || ignored.stderr);
});

test('the stage builds the desktop web build and refuses one without the Crunchyroll card unless it is switched off', (t) => {
    const os = require('os');
    const stage = read('scripts/stage.js');
    assert.match(stage, /run\('npx', \['vite', 'build', '--mode', 'desktop', '--outDir', webOut, '--emptyOutDir'\], frontend\);\n\s*requireWatchBuild\(webOut\);/);
    assert.match(stage, /requireWatchBuild\(opts\.web\);\n\s*copyEntry\(opts\.web, webOut\);/);
    assert.equal(WATCH_MANIFEST_KEY, 'src/app/watch/CrunchyrollCard.jsx');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-web-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    assert.throws(() => requireWatchBuild(dir, {}), /src\/app\/watch\/CrunchyrollCard\.jsx.*--mode desktop/);
    fs.mkdirSync(path.join(dir, '.vite'));
    fs.writeFileSync(path.join(dir, '.vite', 'manifest.json'), JSON.stringify({ 'index.html': {} }));
    assert.throws(() => requireWatchBuild(dir, {}), /VITE_WATCH_CRUNCHYROLL=off/);
    assert.doesNotThrow(() => requireWatchBuild(dir, { VITE_WATCH_CRUNCHYROLL: 'off' }));
    fs.writeFileSync(path.join(dir, '.vite', 'manifest.json'), JSON.stringify({ 'index.html': {}, [WATCH_MANIFEST_KEY]: {} }));
    assert.doesNotThrow(() => requireWatchBuild(dir, {}));
});
