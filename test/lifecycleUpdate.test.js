const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');
const posix = { skip: process.platform === 'win32' && 'POSIX signals and hard links' };
const tmpDirs = [];
const tmp = (prefix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
};
test.after(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readState = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'update-state.json'), 'utf8'));
const writeState = (dataDir, state) => fs.writeFileSync(path.join(dataDir, 'update-state.json'), JSON.stringify({ format: 1, ...state }));

function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

const childEnv = (extra) => ({ PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, LOG_LEVEL: 'info', TRUST_PROXY: 'true', ADMIN_CONSOLE: 'false', ...extra });

function run(args, { env, cwd, onOutput, timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd: cwd || tmp('manga-shelf-cwd-'), env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const collect = (chunk) => {
            output += chunk;
            if (onOutput) onOutput(output, child);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child timed out:\n' + output)); }, timeoutMs);
        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, output });
        });
    });
}

function fakeBinary(dir, content = 'alte Programmdatei') {
    const file = path.join(dir, 'manga-shelf-server');
    fs.writeFileSync(file, content, { mode: 0o755 });
    return file;
}

const DRIVER_HEAD = `
const fs = require('fs');
process.execPath = process.env.FAKE_EXEC;
const waitForHealth = async (port) => {
    for (;;) {
        try {
            const res = await fetch('http://127.0.0.1:' + port + '/api/health');
            if (res.ok) return;
        } catch (e) { /* not yet */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};
`;

function driver(dir, { entry, argv = [], after }) {
    const file = path.join(dir, 'driver.js');
    fs.writeFileSync(file, `${DRIVER_HEAD}
process.argv = [process.argv[0], ${JSON.stringify(entry)}, ...${JSON.stringify(argv)}];
require(${JSON.stringify(entry)});
waitForHealth(process.env.TEST_PORT).then(async () => {
${after}
});
`);
    return file;
}

function readyToSwap(fake, { restart }) {
    const next = `${fake}.new`;
    fs.writeFileSync(next, 'neue Programmdatei', { mode: 0o755 });
    return JSON.stringify({
        format: 1, phase: 'ready-to-swap', mode: 'sea-user', restart, from: '3.0.0', to: '3.0.1', at: new Date().toISOString(), user: 1, pid: 0,
        schema_before: 0, backup: null, previous: { sha256: sha256(fake) }, next: { sha256: sha256(next) }, attempts: 0, exec_path: fake
    });
}

const RESTART_NOW = `
    fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ ...JSON.parse(process.env.STATE_JSON), pid: process.pid }));
    const update = require(${JSON.stringify(path.join(ROOT, 'services', 'update'))});
    update.requestRestart({ dataDir: process.env.STATE_DIR, codeDir: null, execPath: process.env.FAKE_EXEC });
    process.emit('SIGTERM');`;

const swappedState = (fake, extra = {}) => ({
    phase: 'swapped', mode: 'sea-user', restart: 'supervised', from: '3.0.0', to: pkg.version, at: new Date().toISOString(), user: 1,
    pid: 1, schema_before: 0, backup: null, previous: { sha256: '0'.repeat(64) }, next: { sha256: sha256(fake) }, attempts: 0, exec_path: fake, ...extra
});

function firstStatement(rel) {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    return lines.find((line) => line.trim() && !line.startsWith('//') && !line.startsWith('#!'));
}

test('the update prelude is the first statement of index.js, the binary entry and scripts/admin.js', () => {
    assert.match(firstStatement('index.js'), /^const updatePrelude = /);
    assert.match(firstStatement('scripts/server-bin/entry.js'), /^const updatePrelude = require\('\.\.\/\.\.\/services\/update\/prelude'\);$/);
    assert.match(firstStatement('scripts/admin.js'), /^const updatePrelude = /);
    for (const rel of ['index.js', 'scripts/admin.js']) {
        const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        const block = source.slice(source.indexOf('const updatePrelude'), source.indexOf('})();'));
        assert.match(block, /\.update\/previous\/services\/update\/prelude/, `${rel}: falls back to the previous code during a switch`);
        assert.match(block, /\.update\/next\/services\/update\/prelude/, `${rel}: and to the new code`);
    }
});

test('index.js: a switched version counts its start and is marked started once it listens', posix, async () => {
    const dir = tmp('manga-shelf-lc-started-');
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir);
    const fake = fakeBinary(dir);
    writeState(dataDir, swappedState(fake));
    const port = await freePort();
    const file = driver(dir, { entry: path.join(ROOT, 'index.js'), after: 'process.kill(process.pid, "SIGTERM");' });
    const res = await run([file], { env: { DATA_DIR: dataDir, PORT: String(port), TEST_PORT: String(port), FAKE_EXEC: fake } });
    assert.equal(res.code, 0, res.output);
    const state = readState(dataDir);
    assert.equal(state.phase, 'started', res.output);
    assert.equal(state.attempts, 0);
    assert.ok(state.started_at && state.last_attempt_at, 'counted on entry, then marked started');
});

test('index.js: a port in use is not counted against the new version', posix, async () => {
    const dir = tmp('manga-shelf-lc-port-');
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir);
    const fake = fakeBinary(dir);
    writeState(dataDir, swappedState(fake));
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, '0.0.0.0', resolve));
    try {
        const file = path.join(dir, 'start.js');
        fs.writeFileSync(file, `process.execPath = process.env.FAKE_EXEC;\nrequire(${JSON.stringify(path.join(ROOT, 'index.js'))});\n`);
        const res = await run([file], { env: { DATA_DIR: dataDir, PORT: String(blocker.address().port), FAKE_EXEC: fake } });
        assert.equal(res.code, 1, res.output);
        assert.match(res.output, /EADDRINUSE/);
        const state = readState(dataDir);
        assert.equal(state.phase, 'swapped');
        assert.equal(state.attempts, 0, 'EADDRINUSE is not the new version\'s fault');
    } finally {
        blocker.close();
    }
});

test('index.js: an update restart stops the server, switches as the last step and exits 75; SIGTERM meanwhile changes nothing', posix, async () => {
    const dir = tmp('manga-shelf-lc-restart-');
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir);
    const fake = fakeBinary(dir);
    const port = await freePort();
    const file = driver(dir, { entry: path.join(ROOT, 'index.js'), after: RESTART_NOW });
    const res = await run([file], {
        env: {
            DATA_DIR: dataDir, PORT: String(port), TEST_PORT: String(port), FAKE_EXEC: fake, STATE_DIR: dataDir,
            STATE_FILE: path.join(dataDir, 'update-state.json'), STATE_JSON: readyToSwap(fake, { restart: 'supervised' })
        }
    });
    assert.equal(res.code, 75, res.output);
    assert.match(res.output, /\[Update\] Neustart für Update auf v3\.0\.1 \(Exit 75 beabsichtigt\)/);
    assert.equal(fs.readFileSync(fake, 'utf8'), 'neue Programmdatei');
    assert.equal(fs.readFileSync(`${fake}.previous`, 'utf8'), 'alte Programmdatei');
    assert.equal(fs.existsSync(`${fake}.new`), false);
    const after = readState(dataDir);
    assert.equal(after.phase, 'swapped');
    assert.equal(after.pending_start, false);
});

test('the binary (entry.js → main.js): counted and started, and a manual restart switches and exits 0 with pending_start', posix, async () => {
    const dir = tmp('manga-shelf-lc-sea-');
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { mode: 0o700 });
    const fake = fakeBinary(dir);
    writeState(dataDir, swappedState(fake, { to: pkg.version }));
    const port = await freePort();
    const entry = path.join(ROOT, 'scripts', 'server-bin', 'entry.js');
    const argv = ['--port', String(port), '--host', '127.0.0.1', '--data-dir', dataDir, '--no-console'];
    const env = { PORT: '', TEST_PORT: String(port), FAKE_EXEC: fake, HOME: dir, MANGA_SHELF_CACHE_DIR: path.join(dir, 'cache'), STATE_FILE: path.join(dataDir, 'update-state.json') };

    const started = await run([driver(dir, { entry, argv, after: `
    process.stdout.write('STATE ' + fs.readFileSync(process.env.STATE_FILE, 'utf8').replace(/\\n/g, ' ') + '\\n');
    process.kill(process.pid, 'SIGTERM');` })], { env });
    assert.equal(started.code, 0, started.output);
    assert.match(started.output, /läuft auf http:\/\/127\.0\.0\.1:/);
    assert.equal(readState(dataDir).phase, 'started', started.output);

    const restarted = await run([driver(dir, { entry, argv, after: RESTART_NOW })], {
        env: { ...env, STATE_DIR: dataDir, STATE_JSON: readyToSwap(fake, { restart: 'manual' }) }
    });
    assert.equal(restarted.code, 0, restarted.output);
    assert.match(restarted.output, /\[Update\] v3\.0\.1 installiert – Server bitte neu starten/);
    assert.equal(fs.readFileSync(fake, 'utf8'), 'neue Programmdatei');
    const after = readState(dataDir);
    assert.equal(after.phase, 'swapped');
    assert.equal(after.pending_start, true);
});

test('CLI runs of the binary and scripts/admin.js only finish an interrupted switch, with the data folder of the command line', posix, async () => {
    const dir = tmp('manga-shelf-lc-cli-');
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir);
    const fake = fakeBinary(dir, 'neue Programmdatei');
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    const swapping = { ...swappedState(fake), phase: 'swapping', pid: dead, to: '3.0.1' };
    writeState(dataDir, swapping);
    const entry = path.join(dir, 'entry-version.js');
    fs.writeFileSync(entry, `process.execPath = process.env.FAKE_EXEC;\nprocess.argv = [process.argv[0], 'x', 'version', '--data-dir', process.env.CLI_DATA];\nrequire(${JSON.stringify(path.join(ROOT, 'scripts', 'server-bin', 'entry.js'))});\n`);
    const version = await run([entry], { env: { FAKE_EXEC: fake, CLI_DATA: dataDir } });
    assert.equal(version.code, 0, version.output);
    assert.match(version.output, new RegExp(`manga-shelf-server v${pkg.version.replace(/\./g, '\\.')}`));
    const finished = readState(dataDir);
    assert.equal(finished.phase, 'swapped', 'the journal was completed (the binary at the path is the new one)');
    assert.equal(finished.attempts, 0, 'a CLI run never counts a start');

    writeState(dataDir, swapping);
    const admin = path.join(dir, 'admin.js');
    fs.writeFileSync(admin, `process.execPath = process.env.FAKE_EXEC;\nrequire(${JSON.stringify(path.join(ROOT, 'scripts', 'admin.js'))});\n`);
    const res = await run([admin], { env: { FAKE_EXEC: fake, DATA_DIR: dataDir, MANGA_SHELF_NO_LISTEN: '1' } });
    assert.equal(res.code, 0, res.output);
    assert.equal(readState(dataDir).phase, 'swapped');

    writeState(dataDir, { ...swapping, phase: 'staged' });
    assert.equal((await run([entry], { env: { FAKE_EXEC: fake, CLI_DATA: dataDir } })).code, 0);
    assert.equal(readState(dataDir).phase, 'staged', 'a staged update of a dead process is left to the next server start');
});

function newerSchemaDataDir(prefix, { accepted = false } = {}) {
    const dataDir = tmp(prefix);
    spawnSync(process.execPath, ['-e', "require('./db.js').closeDb()"], { cwd: ROOT, env: { ...process.env, DATA_DIR: dataDir, LOG_LEVEL: 'silent' } });
    const { LATEST_SCHEMA_VERSION } = require('../core/schema');
    const db = new DatabaseSync(path.join(dataDir, 'manga.db'));
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, 'future')").run(LATEST_SCHEMA_VERSION + 1);
    if (accepted) db.prepare("INSERT INTO app_settings (key, value) VALUES ('schema_newer_accepted', ?)").run(String(LATEST_SCHEMA_VERSION + 1));
    db.close();
    return { dataDir, version: LATEST_SCHEMA_VERSION + 1 };
}

test('index.js refuses a database of a newer version with exit 78 and names the way back', async () => {
    const { dataDir, version } = newerSchemaDataDir('manga-shelf-lc-newer-');
    const res = await run([path.join(ROOT, 'index.js')], { env: { DATA_DIR: dataDir, PORT: '0' } });
    assert.equal(res.code, 78, res.output);
    assert.match(res.output, new RegExp(`Schema v${version} und stammt aus einer neueren Version`));
    assert.match(res.output, /manga-shelf-server restore <backup\.zip>/);
    assert.match(res.output, /node scripts\/admin\.js wiederherstellen <backup\.zip>/);
    assert.match(res.output, /ALLOW_NEWER_SCHEMA=1/);
    assert.doesNotMatch(res.output, /Server is online/);
});

test('ALLOW_NEWER_SCHEMA=1 or the consent of a restore starts on a newer schema with a warning', posix, async () => {
    const cases = [
        { ...newerSchemaDataDir('manga-shelf-lc-allow-'), env: { ALLOW_NEWER_SCHEMA: '1' }, warning: /ALLOW_NEWER_SCHEMA ist gesetzt/ },
        { ...newerSchemaDataDir('manga-shelf-lc-accepted-', { accepted: true }), env: {}, warning: /bei der Wiederherstellung bestätigt/ }
    ];
    for (const c of cases) {
        let signalled = false;
        const res = await run([path.join(ROOT, 'index.js')], {
            env: { DATA_DIR: c.dataDir, PORT: '0', ...c.env },
            onOutput: (output, child) => {
                if (!signalled && output.includes('Server is online and ready.')) {
                    signalled = true;
                    child.kill('SIGTERM');
                }
            }
        });
        assert.ok(signalled, res.output);
        assert.equal(res.code, 0, res.output);
        assert.match(res.output, c.warning);
    }
});

test('the binary refuses a newer schema with exit 78 as well', posix, async () => {
    const { dataDir } = newerSchemaDataDir('manga-shelf-lc-newer-sea-');
    fs.chmodSync(dataDir, 0o700);
    const res = await run([path.join(ROOT, 'scripts', 'server-bin', 'entry.js'), '--port', '0', '--data-dir', dataDir, '--no-console'], {
        env: { HOME: dataDir, MANGA_SHELF_CACHE_DIR: path.join(os.tmpdir(), `manga-shelf-lc-cache-${process.pid}`) }
    });
    assert.equal(res.code, 78, res.output);
    assert.match(res.output, /Fehler: Die Datenbank .* hat Schema v\d+ und stammt aus einer neueren Version/);
});

test('shutdown aborts running update downloads before it waits for jobs', async () => {
    const lifecycle = require('../services/lifecycle');
    lifecycle.resetLifecycle();
    const order = [];
    await lifecycle.shutdown({
        stopScheduler: () => order.push('scheduler'),
        abortDownloads: () => order.push('downloads'),
        closeDb: () => order.push('db')
    });
    assert.deepEqual(order, ['scheduler', 'downloads', 'db']);
    lifecycle.resetLifecycle();
});
