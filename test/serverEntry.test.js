// Server entry point (index.js): configuration, static serving and startup, one child process per case.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// index.js reads its configuration once at load, so every case runs the app in its own child process.
const ROOT = path.join(__dirname, '..');
const RESULT = '@@RESULT@@';
const tmpDirs = [];

const tmp = (prefix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
};

test.after(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const childEnv = (extra) => ({
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    LOG_LEVEL: 'info',
    TRUST_PROXY: 'true',
    ...extra
});

function run(args, { env, cwd, timeoutMs = 20000, onOutput } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const collect = (chunk) => {
            output += chunk;
            if (onOutput) onOutput(output, child);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        const started = Date.now();
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child timed out:\n' + output)); }, timeoutMs);
        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, output, ms: Date.now() - started });
        });
    });
}

/** Loads <appDir>/index.js without listening, requests each path and returns status, headers and body. */
async function probe(appDir, env, requests) {
    const script = `
        const app = require(${JSON.stringify(path.join(appDir, 'index.js'))});
        const s = app.listen(0, '127.0.0.1', async () => {
            const base = 'http://127.0.0.1:' + s.address().port;
            const out = [];
            for (const [p, headers] of ${JSON.stringify(requests)}) {
                const r = await fetch(base + p, { headers });
                out.push({ path: p, status: r.status, headers: Object.fromEntries(r.headers), body: (await r.text()).slice(0, 4000) });
            }
            process.stdout.write('\\n${RESULT}' + JSON.stringify(out) + '\\n');
            process.exit(0);
        });`;
    const res = await run(['-e', script], { cwd: appDir, env: { MANGA_SHELF_NO_LISTEN: '1', ...env } });
    const line = res.output.split('\n').find(l => l.startsWith(RESULT));
    assert.ok(line, 'no result from child:\n' + res.output);
    const results = Object.fromEntries(JSON.parse(line.slice(RESULT.length)).map(r => [r.path, r]));
    return { results, output: res.output };
}

test('index.html in the app root: neither the database nor the source is served', async () => {
    const appDir = tmp('manga-shelf-rootlayout-');
    for (const entry of ['index.js', 'db.js', 'mangaPassion.js', 'package.json', 'core', 'routes', 'middleware', 'services', 'utils']) {
        fs.cpSync(path.join(ROOT, entry), path.join(appDir, entry), { recursive: true });
    }
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(appDir, 'node_modules'), 'junction');
    fs.writeFileSync(path.join(appDir, 'index.html'), '<!doctype html><div id="root"></div>');

    const paths = ['/data/manga.db', '/db.js', '/package.json', '/middleware/auth.js', '/index.js', '/manga/1'];
    const { results, output } = await probe(appDir, {}, paths.map(p => [p, {}]));
    assert.ok(fs.existsSync(path.join(appDir, 'data', 'manga.db')), 'the default data dir lies inside the app dir');
    for (const p of paths.slice(0, -1)) {
        assert.notEqual(results[p].status, 200, p);
        assert.ok(!results[p].body.startsWith('SQLite format 3'), p);
        assert.doesNotMatch(results[p].body, /require\(/, p);
    }
    assert.equal(results['/manga/1'].status, 500);
    assert.match(results['/manga/1'].body, /Frontend nicht gefunden/);
    assert.ok(!results['/manga/1'].body.includes(appDir), 'the public error page shows no install path');
    assert.match(output, /index\.html liegt direkt im App-Verzeichnis/);
});

test('a FRONTEND_DIR that contains the data dir is not served', async () => {
    const dir = tmp('manga-shelf-frontend-data-');
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    const { results, output } = await probe(ROOT, { FRONTEND_DIR: dir, DATA_DIR: path.join(dir, 'data') }, [['/data/manga.db', {}], ['/manga/1', {}]]);
    assert.notEqual(results['/data/manga.db'].status, 200);
    assert.ok(!results['/data/manga.db'].body.startsWith('SQLite format 3'));
    assert.equal(results['/manga/1'].status, 500);
    assert.match(output, /wird nicht ausgeliefert/);
});

test('a FRONTEND_DIR inside the app or the data directory is not served', async () => {
    const data = tmp('manga-shelf-data-');
    fs.mkdirSync(path.join(data, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(data, 'backups', 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(data, 'backups', 'snapshot.zip'), 'PK secret');
    for (const [dir, file, secret] of [[path.join(ROOT, 'routes'), '/auth.js', /require\(/], [path.join(data, 'backups'), '/snapshot.zip', /secret/]]) {
        const { results, output } = await probe(ROOT, { FRONTEND_DIR: dir, DATA_DIR: data }, [[file, {}]]);
        assert.notEqual(results[file].status, 200, dir);
        assert.doesNotMatch(results[file].body, secret, dir);
        assert.match(output, /wird nicht ausgeliefert/);
    }
});

test('a FRONTEND_DIR without index.html serves none of its files', async () => {
    const dir = tmp('manga-shelf-noindex-');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'private');
    const { results } = await probe(ROOT, { FRONTEND_DIR: dir, DATA_DIR: tmp('manga-shelf-data-') }, [['/notes.txt', {}]]);
    assert.equal(results['/notes.txt'].status, 404);
    assert.notEqual(results['/notes.txt'].body, 'private');
});

test('the CSP no longer allows Google Fonts (the font is self-hosted)', async () => {
    const { results } = await probe(ROOT, { DATA_DIR: tmp('manga-shelf-data-') }, [['/', {}], ['/api/health', {}]]);
    for (const r of Object.values(results)) {
        const csp = r.headers['content-security-policy'];
        assert.ok(csp, r.path);
        assert.doesNotMatch(csp, /googleapis|gstatic/, r.path);
        assert.match(csp, /font-src 'self' data:/);
    }
});

test('missing frontend build: 500 page without the searched path, path only in the log', async () => {
    const empty = tmp('manga-shelf-nofrontend-');
    const data = tmp('manga-shelf-data-');
    const { results, output } = await probe(ROOT, { FRONTEND_DIR: empty, DATA_DIR: data }, [['/manga/1', {}]]);
    const page = results['/manga/1'];
    assert.equal(page.status, 500);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.body, /Frontend nicht gefunden/);
    assert.ok(!page.body.includes(empty) && !page.body.includes(ROOT), 'no filesystem path on the public page');
    assert.ok(output.includes(path.join(empty, 'index.html')), 'the searched path is logged');
});

test('CORS_ORIGIN: listed origins get credentials, others nothing', async () => {
    const data = tmp('manga-shelf-data-');
    const { results } = await probe(ROOT, { DATA_DIR: data, CORS_ORIGIN: 'https://client.example, https://other.example' }, [
        ['/api/health', { Origin: 'https://client.example' }],
        ['/api/version', { Origin: 'https://evil.example' }],
        ['/api/setup/status', { Origin: 'capacitor://localhost' }]
    ]);
    const allowed = results['/api/health'];
    assert.equal(allowed.headers['access-control-allow-origin'], 'https://client.example');
    assert.equal(allowed.headers['access-control-allow-credentials'], 'true');
    assert.equal(results['/api/version'].headers['access-control-allow-origin'], undefined);
    const app = results['/api/setup/status'];
    assert.equal(app.headers['access-control-allow-origin'], 'capacitor://localhost', 'the app origins are merged with CORS_ORIGIN');
    assert.equal(app.headers['access-control-allow-credentials'], undefined);
});

test('a port that is already in use ends the process with exit code 1', async () => {
    const blocker = net.createServer();
    await new Promise(resolve => blocker.listen(0, '0.0.0.0', resolve));
    const port = blocker.address().port;
    try {
        const res = await run([path.join(ROOT, 'index.js')], { cwd: tmp('manga-shelf-cwd-'), env: { PORT: String(port), DATA_DIR: tmp('manga-shelf-data-') } });
        assert.equal(res.code, 1, res.output);
        assert.ok(res.ms < 5000, `took ${res.ms} ms`);
        assert.match(res.output, /EADDRINUSE/);
    } finally {
        blocker.close();
    }
});

test('SIGTERM shuts a running server down with exit code 0', { skip: process.platform === 'win32' }, async () => {
    let signalled = false;
    const res = await run([path.join(ROOT, 'index.js')], {
        cwd: tmp('manga-shelf-cwd-'),
        env: { PORT: '0', DATA_DIR: tmp('manga-shelf-data-') },
        onOutput: (output, child) => {
            if (!signalled && output.includes('Server is online and ready.')) {
                signalled = true;
                child.kill('SIGTERM');
            }
        }
    });
    assert.ok(signalled, res.output);
    assert.equal(res.code, 0, res.output);
});

function copyApp(prefix) {
    const appDir = tmp(prefix);
    for (const entry of ['index.js', 'db.js', 'mangaPassion.js', 'package.json', 'core', 'routes', 'middleware', 'services', 'utils']) {
        fs.cpSync(path.join(ROOT, entry), path.join(appDir, entry), { recursive: true });
    }
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(appDir, 'node_modules'), 'junction');
    fs.writeFileSync(path.join(appDir, 'index.html'), '<!doctype html><div id="root"></div>');
    return appDir;
}

test('a FRONTEND_DIR that reaches the app directory through a symlink or another letter case is not served', { skip: process.platform === 'win32' }, async () => {
    const appDir = copyApp('manga-shelf-alias-');
    const link = path.join(tmp('manga-shelf-link-'), 'frontend');
    fs.symlinkSync(appDir, link, 'dir');
    const variants = [link];
    const upper = appDir.replace(/manga-shelf-alias-/, 'MANGA-SHELF-ALIAS-');
    if (fs.existsSync(upper)) variants.push(upper); // case-insensitive file system (macOS, Windows)
    const paths = ['/data/manga.db', '/db.js', '/package.json'];
    for (const frontendDir of variants) {
        const { results, output } = await probe(appDir, { FRONTEND_DIR: frontendDir }, paths.map(p => [p, {}]));
        for (const p of paths) {
            assert.notEqual(results[p].status, 200, `${frontendDir} ${p}`);
            assert.ok(!results[p].body.startsWith('SQLite format 3'), `${frontendDir} ${p}`);
        }
        assert.match(output, /wird nicht ausgeliefert/, frontendDir);
    }
});

test('a symlinked default build folder is still served', { skip: process.platform === 'win32' }, async () => {
    const appDir = copyApp('manga-shelf-linkdist-');
    fs.rmSync(path.join(appDir, 'index.html'));
    const build = tmp('manga-shelf-build-');
    fs.writeFileSync(path.join(build, 'index.html'), '<!doctype html><div id="root">build</div>');
    fs.mkdirSync(path.join(appDir, 'frontend'));
    fs.symlinkSync(build, path.join(appDir, 'frontend', 'dist'), 'dir');
    const { results } = await probe(appDir, { DATA_DIR: tmp('manga-shelf-data-') }, [['/manga/1', {}]]);
    assert.equal(results['/manga/1'].status, 200);
    assert.match(results['/manga/1'].body, /build/);
});

test('a default build folder that is a symlink to the app directory or above it is not served', { skip: process.platform === 'win32' }, async () => {
    for (const target of ['.', '..']) {
        let appDir = copyApp('manga-shelf-dotdist-');
        if (target === '..') {
            const outer = tmp('manga-shelf-outer-');
            fs.renameSync(appDir, path.join(outer, 'app'));
            appDir = path.join(outer, 'app');
            fs.writeFileSync(path.join(outer, 'index.html'), '<!doctype html><div id="root"></div>');
        }
        fs.mkdirSync(path.join(appDir, 'ssl'));
        fs.writeFileSync(path.join(appDir, 'ssl', 'privkey.pem'), '-----BEGIN PRIVATE KEY-----');
        fs.symlinkSync(target, path.join(appDir, 'dist'), 'dir');
        const paths = ['/ssl/privkey.pem', '/package.json', '/db.js'];
        const { results, output } = await probe(appDir, { DATA_DIR: tmp('manga-shelf-data-') }, paths.map(p => [p, {}]));
        for (const p of paths) {
            assert.notEqual(results[p].status, 200, `dist -> ${target} ${p}`);
            assert.doesNotMatch(results[p].body, /PRIVATE KEY|"dependencies"|require\(/, `dist -> ${target} ${p}`);
        }
        assert.match(output, /wird nicht ausgeliefert/, target);
    }
});

test('an invalid PORT stops the start with a German line and exit code 1', async () => {
    const res = await run([path.join(ROOT, 'index.js')], { cwd: tmp('manga-shelf-cwd-'), env: { PORT: 'abc', DATA_DIR: tmp('manga-shelf-data-') } });
    assert.equal(res.code, 1, res.output);
    assert.match(res.output, /PORT="abc" ist kein gültiger Port/);
    assert.doesNotMatch(res.output, /Server is online and ready/);
});

test('start: German config warnings, the setup code in the banner, one status line, SIGTERM ends it', { skip: process.platform === 'win32' }, async () => {
    let signalled = false;
    const res = await run([path.join(ROOT, 'index.js')], {
        cwd: tmp('manga-shelf-cwd-'),
        env: { PORT: '0', DATA_DIR: tmp('manga-shelf-data-'), BACKUP_HOUR: '25', COOKIE_SECURE: 'vielleicht', ADMIN_CONSOLE: 'false' },
        onOutput: (output, child) => {
            if (!signalled && output.includes('Server is online and ready.')) {
                signalled = true;
                child.kill('SIGTERM');
            }
        }
    });
    assert.equal(res.code, 0, res.output);
    assert.match(res.output, /BACKUP_HOUR="25" ist zu groß \(erlaubt: 0 bis 23\), es gilt 23/);
    assert.match(res.output, /COOKIE_SECURE="vielleicht" ist unbekannt/);
    const banner = res.output.slice(res.output.indexOf('Server listening on port'), res.output.indexOf('change this text 1'));
    assert.match(banner, /Einrichtungscode für das erste Admin-Konto: [A-Z2-9]{4}-/);
    assert.match(res.output, /Datenordner: .* \| Datenbank: /);
});

test('the setup code reaches stdout with LOG_LEVEL=silent, in the banner and when started without it', { skip: process.platform === 'win32' }, async () => {
    let signalled = false;
    const cli = await run([path.join(ROOT, 'index.js')], {
        cwd: tmp('manga-shelf-cwd-'),
        env: { PORT: '0', DATA_DIR: tmp('manga-shelf-data-'), LOG_LEVEL: 'silent', ADMIN_CONSOLE: 'false' },
        onOutput: (output, child) => {
            if (!signalled && output.includes('Server is online and ready.')) {
                signalled = true;
                child.kill('SIGTERM');
            }
        }
    });
    assert.equal(cli.code, 0, cli.output);
    assert.equal(cli.output.match(/Einrichtungscode für das erste Admin-Konto: [A-Z2-9]{4}(-[A-Z2-9]{4}){3}/g).length, 1, cli.output);

    const script = `
        const app = require(${JSON.stringify(path.join(ROOT, 'index.js'))});
        app.start({ host: '127.0.0.1', port: 0, console: false }).then(() => app.stop()).then(() => process.exit(0));`;
    const programmatic = await run(['-e', script], {
        cwd: tmp('manga-shelf-cwd-'),
        env: { MANGA_SHELF_NO_LISTEN: '1', DATA_DIR: tmp('manga-shelf-data-'), LOG_LEVEL: 'silent', SETUP_TOKEN: 'kurz' }
    });
    assert.equal(programmatic.code, 0, programmatic.output);
    assert.match(programmatic.output, /Einrichtungscode für das erste Admin-Konto: [A-Z2-9]{4}-/, 'a too short SETUP_TOKEN falls back to the generated code');
    assert.doesNotMatch(programmatic.output, /Server is online/);
});

test('ADMIN_CONSOLE=nein or a padded false keeps the stdin console of the CLI off', { skip: process.platform === 'win32' }, async () => {
    const ask = (adminConsole) => new Promise((resolve, reject) => {
        const env = childEnv({ PORT: '0', DATA_DIR: tmp('manga-shelf-data-'), LOG_LEVEL: 'warn' });
        if (adminConsole !== undefined) env.ADMIN_CONSOLE = adminConsole;
        const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], { cwd: tmp('manga-shelf-cwd-'), env, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '';
        let asked = false;
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child timed out:\n' + output)); }, 20000);
        const collect = (chunk) => {
            output += chunk;
            if (!asked && output.includes('Server is online and ready.')) {
                asked = true;
                child.stdin.write('hilfe\n');
                setTimeout(() => child.kill('SIGTERM'), 700);
            }
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.on('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
    });
    for (const off of ['nein', ' false ']) {
        const res = await ask(off);
        assert.equal(res.code, 0, res.output);
        assert.doesNotMatch(res.output, /Befehle der Server-Konsole/, JSON.stringify(off));
        assert.doesNotMatch(res.output, /ADMIN_CONSOLE/, 'no warning: the value is valid');
    }
    const on = await ask(undefined);
    assert.match(on.output, /Befehle der Server-Konsole/, 'control: the console answers by default');
});

test('config: SETUP_TOKEN is normalised, too short values warn without showing the value', () => {
    const { readConfig } = require('../utils/config');
    assert.equal(readConfig({ SETUP_TOKEN: ' abcd-efgh ijkl ' }).values.setupToken, 'ABCDEFGHIJKL');
    for (const weak of ['--', 'geheim-123', 'a b c d e f g h i j k']) {
        const { values, warnings } = readConfig({ SETUP_TOKEN: weak });
        assert.equal(values.setupToken, null, weak);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /^SETUP_TOKEN ist zu kurz \(mindestens 12 Zeichen/);
        assert.ok(!warnings[0].includes(weak), 'the value is not logged');
    }
});

test('config: one table for every variable, German warnings, fatal port and TRUST_PROXY', () => {
    const { readConfig, ENTRIES } = require('../utils/config');
    const base = readConfig({});
    assert.deepEqual([base.warnings, base.errors], [[], []]);
    assert.equal(base.values.port, 3000);
    assert.equal(base.values.trustProxy, 'loopback');
    assert.equal(base.values.cookieSecure, false);
    assert.equal(readConfig({ SERVER_PORT: '25565', PORT: '3000' }).values.port, 25565, 'Pterodactyl SERVER_PORT wins');
    assert.equal(readConfig({ PORT: '0' }).values.port, 0);
    assert.deepEqual(readConfig({ PORT: '70000' }).errors, ['PORT="70000" ist kein gültiger Port (erlaubt: 0 bis 65535)']);
    assert.match(readConfig({ TRUST_PROXY: 'nonsense value!' }).errors[0], /TRUST_PROXY ungültig/);
    const odd = readConfig({ LOG_LEVEL: 'verbose', LOG_FORMAT: 'xml', BACKUP_TIMEZONE: 'Mars/Olympus', APP_TIMEZONE: 'Europe/Vienna', CORS_ORIGIN: ' https://a.example , ,https://b.example' });
    assert.equal(odd.values.logLevel, 'info');
    assert.equal(odd.values.backupTimeZone, 'UTC');
    assert.equal(odd.values.appTimeZone, 'Europe/Vienna');
    assert.deepEqual(odd.values.corsOrigins, ['https://a.example', 'https://b.example']);
    assert.equal(odd.warnings.length, 3);
    assert.ok(odd.warnings.every(w => /ist (unbekannt|keine bekannte Zeitzone)/.test(w)), odd.warnings.join('\n'));
    assert.equal(readConfig({ COOKIE_SECURE: 'TRUE' }).values.cookieSecure, true);
    assert.equal(new Set(ENTRIES.map(e => e.name)).size, ENTRIES.length);
});

test('config: every variable is described in .env.example', () => {
    const { ENTRIES } = require('../utils/config');
    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    const missing = ENTRIES.filter(e => e.doc !== false)
        .flatMap(e => [e.name, ...(e.aliases || [])])
        .filter(name => !new RegExp(`^#?\\s*${name}=`, 'm').test(example));
    assert.deepEqual(missing, [], `.env.example fehlt: ${missing.join(', ')}`);
});
