// Covers the staging script and the packaging configuration of the desktop app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { backendEntries, missingEntries, parseStageArgs, STAGE } = require('../scripts/stage');

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
