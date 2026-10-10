const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startTestServer } = require('./helpers');
const h = require('./fixtures/update/helpers');
const pkg = require('../package.json');

let ctx, admin, editor, boss, system, update, rateLimit;

const updaterRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-system-update-'));

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client(); editor = ctx.client(); boss = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'ed', password: 'password123', role: 'editor' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'boss', password: 'password123', role: 'admin', current_password: 'password123' })).status, 200);
    await editor('POST', '/auth/login', { username: 'ed', password: 'password123' });
    await boss('POST', '/auth/login', { username: 'boss', password: 'password123' });
    system = require('../routes/system');
    update = require('../services/update');
    rateLimit = require('../middleware/rateLimit');
    useUpdater({ releases: [] });
});
test.after(async () => {
    update.resetForTests();
    await ctx.close();
    fs.rmSync(updaterRoot, { recursive: true, force: true });
});

const NEXT = '9.1.0';
const ZIP_NAME = 'pterodactyl-manga-shelf.zip';
const DL = 'https://github.com/LixNix-Swap-Org/manga-shelf/releases/download/';
const SIGNER = 'https://github.com/LixNix-Swap-Org/manga-shelf/.github/workflows/release.yml@refs/heads/main';
const LOCK = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/express': { version: '5.2.1', integrity: 'sha512-a' } } });
const ZIP = h.makeZip([
    { name: 'package.json', data: JSON.stringify({ version: NEXT, engines: { node: '>=22.13.0' }, files: ['index.js', 'db.js'] }) },
    { name: 'package-lock.json', data: LOCK },
    { name: 'index.js', data: 'module.exports = "new";\n' },
    { name: 'db.js', data: 'module.exports = 1;\n' }
]);
const signedFiles = h.makeRelease(NEXT, { [ZIP_NAME]: ZIP });
const BUNDLE = Buffer.from(JSON.stringify(h.makeBundle(signedFiles.sumsBytes)));

const ghAsset = (v, name, size = 10) => ({ name, size, browser_download_url: `${DL}v${v}/${name}` });
const rawRelease = (v, { signed = true, body = '' } = {}) => ({
    tag_name: `v${v}`, draft: false, prerelease: false, published_at: '2026-10-01T00:00:00Z', body,
    assets: [
        ...(signed ? [ghAsset(v, 'SHA256SUMS.txt'), ghAsset(v, 'SHA256SUMS.txt.sigstore.json'), ghAsset(v, `manga-shelf-release-v${v}.json`)] : []),
        ghAsset(v, ZIP_NAME, ZIP.length)
    ]
});
const PUBLISHED = [rawRelease(NEXT, { body: '### Before updating\nRe-import the egg.\n' }), rawRelease('9.0.0', { signed: false }), rawRelease('0.0.1')];

const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
};

function fakeDownload({ releases, gate, listError, calls }) {
    const files = { 'SHA256SUMS.txt': signedFiles.sumsBytes, 'SHA256SUMS.txt.sigstore.json': BUNDLE, [signedFiles.markerName]: signedFiles.markerBytes };
    return {
        fetchJson: async (url) => {
            calls.push(url);
            if (listError) throw listError;
            if (url.includes('/releases/tags/')) return rawRelease(/v(\d+\.\d+\.\d+)$/.exec(url)[1], { body: '### Before updating\nRe-import the egg.\n' });
            return releases;
        },
        fetchBuffer: async (url) => files[path.basename(url)],
        fetchToFile: async (url, { dest, expectedSha256, onProgress, signal }) => {
            onProgress(Math.floor(ZIP.length / 2), ZIP.length);
            if (gate) await gate(signal);
            fs.writeFileSync(dest, ZIP);
            onProgress(ZIP.length, ZIP.length);
            const sha256 = h.sha256hex(ZIP);
            if (expectedSha256 !== sha256) throw Object.assign(new Error('damaged'), { code: 'CHECKSUM_MISMATCH' });
            return { sha256, size: ZIP.length };
        }
    };
}

let updaterRun = 0;

function useUpdater({ releases = PUBLISHED, install, gate, backupGate, backupVerified = true, listError, freeBytes = 1e12 } = {}) {
    update.resetForTests();
    system.resetSystemState();
    rateLimit.resetRateLimits();
    const dir = path.join(updaterRoot, `u-${updaterRun++}`);
    const codeDir = path.join(dir, 'code');
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
    fs.mkdirSync(codeDir, { recursive: true });
    fs.writeFileSync(path.join(codeDir, 'package.json'), JSON.stringify({ version: pkg.version, files: ['index.js', 'db.js'] }));
    fs.writeFileSync(path.join(codeDir, 'package-lock.json'), LOCK);
    fs.writeFileSync(path.join(codeDir, 'index.js'), 'module.exports = "old";\n');
    fs.writeFileSync(path.join(codeDir, 'db.js'), 'module.exports = 0;\n');
    const calls = [];
    const exits = [];
    update.configureForTests({
        dataDir,
        installMode: install || { mode: 'pterodactyl', canInstall: true, reason: null, supervisor: 'wings', codeDir, execPath: process.execPath, assetName: ZIP_NAME, restart: 'pterodactyl' },
        download: fakeDownload({ releases, gate, listError, calls }),
        verifier: require('../services/update/verify').createVerifier({ verifyBundle: async () => h.goodSigner() }),
        freeBytes: () => freeBytes,
        apply: {
            backupsDir: path.join(dataDir, 'backups'),
            schemaVersion: () => 27,
            holdSnapshot: () => () => {},
            createBackupSnapshot: async (prefix) => {
                if (backupGate) await backupGate;
                const filename = `${prefix}-2026-10-10T10-00-00-000Z.zip`;
                fs.writeFileSync(path.join(dataDir, 'backups', filename), 'backup');
                return { filename, verified: backupVerified };
            }
        },
        exit: (code) => exits.push(code)
    });
    return { dataDir, codeDir, calls, exits };
}

async function until(fn) {
    for (let i = 0; i < 500; i++) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('timed out');
}

async function raw(client, method, url, body, headers = {}) {
    const res = await fetch(ctx.base + url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(client.cookie ? { Cookie: client.cookie } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* no body */ }
    return { status: res.status, body: json, headers: res.headers };
}

const systemUpdate = async () => {
    await admin('GET', '/system');
    await system.updateRun();
    return (await admin('GET', '/system')).body.update;
};

function fakeGithub(impl) {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = (url, opts) => {
        if (String(url).startsWith(ctx.base)) return realFetch(url, opts);
        calls.push(String(url));
        return impl(String(url), opts);
    };
    return { calls, restore: () => { global.fetch = realFetch; } };
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('GET /system: admins only, with version, storage, backups, orphans, sources and update state', async () => {
    const gh = fakeGithub(() => Promise.reject(new Error('offline')));
    try {
        system.resetSystemState();
        assert.equal((await ctx.client()('GET', '/system')).status, 401);
        assert.equal((await editor('GET', '/system')).status, 403);
        const res = await admin('GET', '/system');
        assert.equal(res.status, 200);
        const b = res.body;
        assert.equal(b.version, require('../package.json').version);
        assert.equal(b.node, process.version);
        assert.ok(Number.isInteger(b.uptime));
        assert.equal(b.data_dir, ctx.dataDir);
        assert.ok(['ok', 'degraded', 'error'].includes(b.health.status));
        assert.ok(b.database.bytes > 0);
        assert.equal(b.database.schema_version, b.database.latest_schema_version);
        assert.equal(b.database.counts.users, 3);
        assert.ok(b.storage.free_bytes === null || b.storage.free_bytes > 0);
        assert.deepEqual(b.storage.uploads, { count: 0, bytes: 0 });
        assert.equal(b.orphans.count, 0);
        assert.equal(b.backups.count, 0);
        assert.equal(b.backups.last_verified, null);
        assert.equal(typeof b.backups.schedule.hour, 'number');
        assert.deepEqual(b.jobs, { running: [], restore_running: false });
        assert.deepEqual(b.sources, { users_with_keys: 0 });
        assert.equal(b.update.current, b.version);
        assert.equal(b.update.available, false);
        await system.updateRun();
    } finally {
        gh.restore();
    }
});

test('update check: a newer GitHub release is reported after the background check; failures stay quiet', async () => {
    const gh = fakeGithub(() => Promise.resolve(jsonResponse({ tag_name: 'v99.1.0', html_url: 'https://github.com/LixNix-Swap-Org/manga-shelf/releases/tag/v99.1.0' })));
    try {
        system.resetSystemState();
        const first = await admin('GET', '/system');
        assert.equal(first.body.update.latest, null, 'the page never waits for GitHub');
        await system.updateRun();
        const second = (await admin('GET', '/system')).body.update;
        assert.equal(second.latest, '99.1.0');
        assert.equal(second.available, true);
        assert.match(second.url, /^https:\/\/github\.com\//);
        assert.ok(second.checked_at);
        assert.equal(gh.calls.length, 1, 'checked once a day');
        assert.equal(gh.calls[0], 'https://api.github.com/repos/LixNix-Swap-Org/manga-shelf/releases/latest');
    } finally {
        gh.restore();
    }

    const failing = fakeGithub(() => Promise.resolve(jsonResponse({ message: 'Not Found' }, 404)));
    try {
        system.resetSystemState();
        await admin('GET', '/system');
        await system.updateRun();
        const state = (await admin('GET', '/system')).body.update;
        assert.equal(state.latest, null);
        assert.equal(state.available, false);
        assert.equal(failing.calls.length, 1, 'retried at most hourly');
    } finally {
        failing.restore();
    }

    assert.ok(system.compareVersions('2.20.0', '2.19.1') > 0);
    assert.equal(system.compareVersions('v2.19.1', '2.19.1'), 0);
    assert.ok(system.compareVersions('2.9.0', '2.10.0') < 0);
});

test('update check: UPDATE_CHECK=false sends nothing and hides the update endpoints', async () => {
    const gh = fakeGithub(() => assert.fail('no request expected'));
    const u = useUpdater({ releases: PUBLISHED });
    process.env.UPDATE_CHECK = 'false';
    try {
        system.resetSystemState();
        const state = (await admin('GET', '/system')).body.update;
        assert.equal(state.enabled, false);
        assert.equal(state.install, undefined);
        assert.equal(system.updateRun(), null);
        assert.equal(gh.calls.length, 0);
        for (const [method, url, body] of [
            ['GET', '/system/update/status'],
            ['POST', '/system/update/check', {}],
            ['POST', '/system/update/prepare', { version: NEXT }],
            ['POST', '/system/update/apply/x', { current_password: 'password123' }],
            ['DELETE', '/system/update/staging/x']
        ]) {
            const res = await admin(method, url, body);
            assert.equal(res.status, 404, url);
            assert.deepEqual(res.body, {
                error: 'Updates über die Systemseite sind abgeschaltet (UPDATE_CHECK=false).', code: 'NOT_AVAILABLE',
                msg: 'Updates über die Systemseite sind abgeschaltet ({variable}=false).', params: { variable: 'UPDATE_CHECK' }
            });
        }
        assert.deepEqual(u.calls, []);
    } finally {
        delete process.env.UPDATE_CHECK;
        gh.restore();
    }
});

test('update endpoints are for admins only', async () => {
    useUpdater({ releases: PUBLISHED });
    const anonymous = ctx.client();
    for (const [method, url] of [['GET', '/system/update/status'], ['POST', '/system/update/check'], ['POST', '/system/update/prepare'], ['POST', '/system/update/apply/x'], ['DELETE', '/system/update/staging/x']]) {
        const body = method === 'GET' ? undefined : {};
        assert.equal((await anonymous(method, url, body)).status, 401, url);
        assert.equal((await editor(method, url, body)).status, 403, url);
    }
    assert.equal(update.getStatus().phase, 'idle');
});

test('GET /system: the update card gets install mode, releases with reasons, progress and the last result', async (t) => {
    const gh = fakeGithub(() => Promise.reject(new Error('no request expected')));
    t.after(() => gh.restore());
    const u = useUpdater({ releases: PUBLISHED });
    const first = (await admin('GET', '/system')).body.update;
    assert.equal(first.releases, null, 'the page never waits for GitHub');
    await system.updateRun();
    const b = (await admin('GET', '/system')).body.update;
    assert.equal(b.enabled, true);
    assert.equal(b.current, pkg.version);
    assert.equal(b.latest, NEXT);
    assert.equal(b.available, true);
    assert.equal(b.url, `https://github.com/LixNix-Swap-Org/manga-shelf/releases/tag/v${NEXT}`);
    assert.ok(b.checked_at);
    assert.deepEqual(b.releases, [
        { version: NEXT, tag: `v${NEXT}`, published_at: '2026-10-01T00:00:00Z', url: `https://github.com/LixNix-Swap-Org/manga-shelf/releases/tag/v${NEXT}`, signed: true, installable: true, reason: null, has_admin_notes: true },
        { version: '9.0.0', tag: 'v9.0.0', published_at: '2026-10-01T00:00:00Z', url: 'https://github.com/LixNix-Swap-Org/manga-shelf/releases/tag/v9.0.0', signed: false, installable: false, reason: 'unsigned', has_admin_notes: false },
        { version: '0.0.1', tag: 'v0.0.1', published_at: '2026-10-01T00:00:00Z', url: 'https://github.com/LixNix-Swap-Org/manga-shelf/releases/tag/v0.0.1', signed: true, installable: false, reason: 'older', has_admin_notes: false }
    ]);
    assert.equal(b.releases_error, null);
    assert.equal(b.next_try_at, null);
    assert.deepEqual(b.install, {
        mode: 'pterodactyl', can_install: false, reason: 'no_restart', supervisor: 'wings', restart: 'pterodactyl', asset: ZIP_NAME,
        instructions: { kind: 'pterodactyl', command: null, url: 'https://github.com/LixNix-Swap-Org/manga-shelf#updating', argv: null },
        image: null
    });
    assert.equal(b.staging, null);
    assert.equal(b.status.phase, 'idle');
    assert.equal(b.last, null);
    assert.equal(u.calls.filter((url) => url.includes('/releases?')).length, 1, 'the list is cached');
    assert.deepEqual(gh.calls, [], 'the latest version comes from the list');

    const stop = update.registerRestart(async () => {});
    try {
        assert.equal((await admin('GET', '/system')).body.update.install.can_install, true);
        process.env.UPDATE_INSTALL = 'false';
        const off = (await admin('GET', '/system')).body.update.install;
        assert.deepEqual([off.can_install, off.reason], [false, 'install_off']);
    } finally {
        delete process.env.UPDATE_INSTALL;
        stop();
    }

    fs.writeFileSync(path.join(u.dataDir, 'update-state.json'), JSON.stringify({
        format: 1, phase: 'rolled_back', mode: 'pterodactyl', from: pkg.version, to: NEXT, at: '2026-10-10T10:00:00.000Z',
        finished_at: '2026-10-10T10:05:00.000Z', attempts: 1, error: 'START_FAILED',
        backup: { file: 'vor-update-v3.0.0-auf-v9.1.0-2026-10-10T10-00-00-000Z.zip', sha256: 'a'.repeat(64) }
    }));
    assert.deepEqual((await admin('GET', '/system')).body.update.last, {
        from: pkg.version, to: NEXT, at: '2026-10-10T10:05:00.000Z', result: 'rolled_back', error: 'START_FAILED',
        backup: 'vor-update-v3.0.0-auf-v9.1.0-2026-10-10T10-00-00-000Z.zip'
    });
});

test('GET /system: installs that cannot replace themselves get structured instructions', async () => {
    const no = (mode, reason, extra = {}) => ({ mode, canInstall: false, reason, supervisor: null, codeDir: '/srv/app', execPath: '/srv/bin/manga-shelf-server', assetName: null, restart: null, ...extra });
    const cases = [
        [no('docker', 'docker'), { kind: 'docker', image: 'ghcr.io/lixnix-swap-org/manga-shelf', argv: null }],
        [no('desktop', 'desktop'), { kind: 'desktop', url: 'https://github.com/LixNix-Swap-Org/manga-shelf/releases', argv: null }],
        [no('source', 'source', { assetName: ZIP_NAME }), { kind: 'source', argv: null }],
        [no('sea-system', 'system_path', { assetName: 'manga-shelf-server-linux-x64', execPath: '/usr/local/bin/manga-shelf-server' }), { kind: 'service', argv: ['/usr/local/bin/manga-shelf-server'] }],
        [no('sea-system', 'system_path', { assetName: 'manga-shelf-server-windows-x64.exe', execPath: 'C:\\Program Files\\Manga Shelf\\manga-shelf-server.exe' }), { kind: 'windows' }],
        [no('sea-system', 'foreign_owner', { assetName: 'manga-shelf-server-macos-universal' }), { kind: 'binary' }],
        [no('sea-user', 'no_asset'), { kind: 'sea-user', argv: ['/srv/bin/manga-shelf-server'] }]
    ];
    for (const [install, expected] of cases) {
        useUpdater({ install });
        const info = (await admin('GET', '/system')).body.update.install;
        assert.equal(info.mode, install.mode);
        assert.equal(info.can_install, false);
        assert.equal(info.reason, install.reason);
        if (expected.image) assert.equal(info.image, expected.image);
        else assert.equal(info.image, null);
        for (const key of ['kind', 'url', 'argv']) {
            if (key in expected) assert.deepEqual(info.instructions[key], expected[key], `${install.mode} ${key}`);
        }
    }
    useUpdater({ install: no('sea-system', 'system_path', { assetName: 'manga-shelf-server-linux-x64', execPath: '/usr/bin/manga-shelf-server' }) });
    assert.ok(['deb', 'rpm', 'package'].includes((await admin('GET', '/system')).body.update.install.instructions.kind));

    assert.deepEqual(system.startOptions(['start', '--port', '8080', '--host=0.0.0.0', '--data-dir', 'rel/data', '--no-console', '--log-file', '--port']), ['--port', '8080', '--host', '0.0.0.0', '--data-dir', path.resolve('rel/data'), '--no-console', '--log-file']);
    assert.deepEqual(system.startOptions(['--no-console', '--data-dir=/srv/d', '--log-file'], { forService: true }), ['--data-dir', '/srv/d']);
    assert.deepEqual(system.startOptions(['--port', '--host', 'h']), ['--host', 'h']);
});

test('POST /system/update/check refreshes the list (rate limit and outage reported, 6 per 10 minutes per admin)', async () => {
    const u = useUpdater({ releases: PUBLISHED });
    await systemUpdate();
    const checked = await admin('POST', '/system/update/check', {});
    assert.equal(checked.status, 200);
    assert.deepEqual(checked.body.releases.map((r) => r.version), [NEXT, '9.0.0', '0.0.1']);
    assert.equal(checked.body.releases_error, null);
    assert.ok(checked.body.fetched_at);
    assert.equal(u.calls.filter((url) => url.includes('/releases?')).length, 2, 'a manual check skips the cache');

    const reset = Math.floor(Date.now() / 1000) + 600;
    const limited = useUpdater({ listError: Object.assign(new Error('rate limited'), { httpStatus: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }) });
    const view = (await admin('POST', '/system/update/check', {})).body;
    assert.deepEqual(view.releases, []);
    assert.equal(view.releases_error, 'RATE_LIMITED');
    assert.equal(view.next_try_at, new Date(reset * 1000).toISOString());
    const card = (await admin('GET', '/system')).body.update;
    assert.equal(card.releases_error, 'RATE_LIMITED');
    assert.equal(card.next_try_at, view.next_try_at);
    await system.updateRun();
    assert.equal(limited.calls.length, 1, 'no request before the reset');

    useUpdater({ listError: new Error('offline') });
    assert.equal((await admin('POST', '/system/update/check', {})).body.releases_error, 'GITHUB_UNAVAILABLE');
    for (let i = 0; i < 5; i++) assert.equal((await admin('POST', '/system/update/check', {})).status, 200);
    const tooMany = await raw(admin, 'POST', '/system/update/check', {});
    assert.equal(tooMany.status, 429);
    assert.equal(tooMany.body.code, 'TOO_MANY_REQUESTS');
    assert.ok(Number(tooMany.headers.get('retry-after')) > 0);
    assert.equal((await boss('POST', '/system/update/check', {})).status, 200, 'the limit is per admin');
});

test('POST /system/update/prepare refuses with the documented codes before any download', async () => {
    const u = useUpdater({ releases: PUBLISHED });
    process.env.UPDATE_INSTALL = 'false';
    try {
        const off = await admin('POST', '/system/update/prepare', { version: NEXT });
        assert.equal(off.status, 403);
        assert.deepEqual(off.body, {
            error: 'Installieren über die Systemseite ist abgeschaltet (UPDATE_INSTALL=false).', code: 'UPDATE_INSTALL_OFF',
            msg: 'Installieren über die Systemseite ist abgeschaltet ({variable}=false).', params: { variable: 'UPDATE_INSTALL' }
        });
    } finally {
        delete process.env.UPDATE_INSTALL;
    }
    const expect = async (body, status, code) => {
        const res = await admin('POST', '/system/update/prepare', body);
        assert.deepEqual([res.status, res.body.code], [status, code], JSON.stringify(body));
        return res.body;
    };
    await expect({ version: 'v9.1.0' }, 404, 'VERSION_UNKNOWN');
    await expect({}, 404, 'VERSION_UNKNOWN');
    await expect({ version: '0.0.1' }, 409, 'VERSION_NOT_NEWER');
    await expect({ version: '9.0.0' }, 409, 'RELEASE_UNSIGNED');
    await expect({ version: '9.9.9' }, 404, 'VERSION_UNKNOWN');
    await expect({ version: 42 }, 404, 'VERSION_UNKNOWN');
    const limit = await raw(admin, 'POST', '/system/update/prepare', { version: NEXT });
    assert.deepEqual([limit.status, limit.body.code], [429, 'TOO_MANY_REQUESTS']);
    assert.ok(Number(limit.headers.get('retry-after')) > 0);
    assert.equal(u.calls.some((url) => url.includes('/releases/tags/')), false);

    useUpdater({ releases: PUBLISHED, freeBytes: 1024 });
    const space = await expect({ version: NEXT }, 507, 'NO_SPACE');
    assert.match(space.error, /Nicht genug Speicherplatz/);

    useUpdater({ releases: PUBLISHED, install: { mode: 'docker', canInstall: false, reason: 'docker', supervisor: null, codeDir: '/app', execPath: process.execPath, assetName: null, restart: null } });
    const docker = await expect({ version: NEXT }, 409, 'NOT_INSTALLABLE');
    assert.equal(docker.reason, 'docker');
    assert.equal(update.getStatus().phase, 'idle');
});

test('prepare → download progress → ready; apply re-checks the password, answers 202 before the backup, then restarts', async () => {
    const download = deferred();
    const backup = deferred();
    const u = useUpdater({ releases: PUBLISHED, gate: () => download.promise, backupGate: backup.promise });
    await systemUpdate();

    const started = await admin('POST', '/system/update/prepare', { version: NEXT });
    assert.equal(started.status, 202);
    assert.match(started.body.staging_id, /^[0-9a-f-]{36}$/);
    assert.ok(Date.parse(started.body.expires_at) > Date.now());
    const id = started.body.staging_id;
    assert.equal((await boss('POST', '/system/update/prepare', { version: NEXT })).body.code, 'UPDATE_BUSY');

    await until(async () => (await admin('GET', '/system/update/status')).body.bytes > 0);
    const progress = (await admin('GET', '/system/update/status')).body;
    assert.deepEqual([progress.phase, progress.version, progress.bytes, progress.total, progress.staging_id], ['downloading', NEXT, Math.floor(ZIP.length / 2), ZIP.length, id]);
    assert.equal(progress.verified, null);
    const card = (await admin('GET', '/system')).body.update;
    assert.deepEqual(card.staging, { staging_id: id, version: NEXT, asset: ZIP_NAME, size: ZIP.length, expires_at: progress.expires_at, verified: false });
    assert.equal(card.status.phase, 'downloading');

    download.resolve();
    await until(async () => (await admin('GET', '/system/update/status')).body.phase === 'ready');
    const ready = (await admin('GET', '/system/update/status')).body;
    assert.deepEqual(ready.verified, { identity: SIGNER, log_index: '123456' });
    assert.deepEqual(ready.admin_notes.map((n) => [n.version, n.text]), [[NEXT, 'Re-import the egg.']]);
    assert.equal(ready.error, null);
    assert.equal((await admin('GET', '/system')).body.update.staging.verified, true);

    const apply = (client, body, headers) => raw(client, 'POST', `/system/update/apply/${id}`, body, headers);
    const noRestart = await apply(admin, { current_password: 'password123' });
    assert.deepEqual([noRestart.status, noRestart.body.code, noRestart.body.reason], [409, 'NOT_INSTALLABLE', 'no_restart']);
    rateLimit.resetRateLimits();
    let shutdowns = 0;
    update.registerRestart(async () => { shutdowns++; });

    assert.deepEqual([(await apply(admin, {})).status, (await apply(admin, {})).body.error], [400, 'Bitte das aktuelle Passwort eingeben']);
    const wrong = await apply(admin, { current_password: 'falsch-falsch' });
    assert.deepEqual([wrong.status, wrong.body], [403, { error: 'Das aktuelle Passwort stimmt nicht', code: 'WRONG_PASSWORD' }]);
    const limited = await apply(admin, { current_password: 'password123' });
    assert.deepEqual([limited.status, limited.body.code], [429, 'TOO_MANY_REQUESTS'], '3 attempts per 10 minutes');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    rateLimit.resetRateLimits();

    const guard = rateLimit.loginGuard;
    for (let i = 0; i < 10; i++) guard.attempt(rateLimit.accountKey('admin'), '10.88.0.1');
    const locked = await apply(admin, { current_password: 'password123' }, { 'X-Forwarded-For': '10.88.0.1' });
    assert.deepEqual([locked.status, locked.body], [429, { error: 'Zu viele fehlgeschlagene Anmeldeversuche für diesen Benutzer. Bitte in einigen Minuten erneut versuchen.', code: 'TOO_MANY_ATTEMPTS' }]);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    rateLimit.resetRateLimits();

    const foreign = await apply(boss, { current_password: 'password123' });
    assert.deepEqual([foreign.status, foreign.body.code], [404, 'STAGING_NOT_FOUND']);
    const unknown = await raw(admin, 'POST', '/system/update/apply/00000000-0000-0000-0000-000000000000', { current_password: 'password123' });
    assert.deepEqual([unknown.status, unknown.body.code], [404, 'STAGING_NOT_FOUND']);

    const lifecycle = require('../services/lifecycle');
    const snapshot = deferred();
    const job = lifecycle.trackJob('Snapshot', snapshot.promise);
    const busy = await apply(admin, { current_password: 'password123' });
    assert.deepEqual([busy.status, busy.body.code], [409, 'JOB_RUNNING']);
    snapshot.resolve();
    await job;
    rateLimit.resetRateLimits();

    const accepted = await apply(admin, { current_password: 'password123' });
    assert.equal(accepted.status, 202);
    assert.deepEqual(accepted.body, { accepted: true, version: NEXT, restart: 'pterodactyl' });
    assert.equal((await admin('GET', '/system/update/status')).body.phase, 'applying', 'the backup runs after the answer');
    assert.equal((await apply(admin, { current_password: 'password123' })).body.code, 'UPDATE_RUNNING');
    assert.equal((await admin('DELETE', `/system/update/staging/${id}`)).body.code, 'UPDATE_RUNNING');
    assert.equal((await admin('POST', '/system/update/prepare', { version: NEXT })).body.code, 'UPDATE_RUNNING');

    backup.resolve();
    await until(() => u.exits.length === 1);
    assert.deepEqual(u.exits, [75]);
    assert.equal(shutdowns, 1);
    assert.equal(fs.readFileSync(path.join(u.codeDir, 'index.js'), 'utf8'), 'module.exports = "new";\n');
    assert.equal(update.heldBackup(), `vor-update-v${pkg.version}-auf-v${NEXT}-2026-10-10T10-00-00-000Z.zip`);
    useUpdater();
});

test('after a failed background install, writes such as POST /mangas are accepted again', async () => {
    const backup = deferred();
    const u = useUpdater({ backupGate: backup.promise, backupVerified: false });
    update.registerRestart(async () => { throw new Error('no restart after a failure'); });
    const id = (await admin('POST', '/system/update/prepare', { version: NEXT })).body.staging_id;
    await until(async () => (await admin('GET', '/system/update/status')).body.phase === 'ready');
    assert.equal((await raw(admin, 'POST', `/system/update/apply/${id}`, { current_password: 'password123' })).status, 202);
    const during = await admin('POST', '/mangas', { title: 'Während des Updates' });
    assert.deepEqual([during.status, during.body.code], [503, 'MAINTENANCE']);

    backup.resolve();
    await until(async () => (await admin('GET', '/system/update/status')).body.phase === 'failed');
    assert.equal((await admin('GET', '/system/update/status')).body.error.code, 'BACKUP_FAILED');
    const after = await admin('POST', '/mangas', { title: 'Nach dem Update' });
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.deepEqual(u.exits, []);
    assert.equal(fs.readFileSync(path.join(u.codeDir, 'index.js'), 'utf8'), 'module.exports = "old";\n');
    useUpdater();
});

test('DELETE /system/update/staging/:id cancels a running download; failures show up in the status', async () => {
    const u = useUpdater({ releases: PUBLISHED, gate: (signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'DOWNLOAD_ABORTED' })))) });
    const started = (await admin('POST', '/system/update/prepare', { version: NEXT })).body;
    await until(async () => (await admin('GET', '/system/update/status')).body.bytes > 0);
    const missing = await admin('DELETE', '/system/update/staging/other');
    assert.deepEqual([missing.status, missing.body.code], [404, 'STAGING_NOT_FOUND']);
    const removed = await boss('DELETE', `/system/update/staging/${started.staging_id}`);
    assert.deepEqual([removed.status, removed.body], [200, { success: true, discarded: true }]);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await admin('GET', '/system/update/status')).body.phase, 'idle');
    assert.deepEqual(fs.readdirSync(path.join(u.dataDir, 'temp', 'update')), []);

    update.configureForTests({ verifier: require('../services/update/verify').createVerifier({ verifyBundle: async () => h.goodSigner(`${SIGNER}-x`) }) });
    const again = await admin('POST', '/system/update/prepare', { version: NEXT });
    assert.equal(again.status, 202);
    await until(async () => (await admin('GET', '/system/update/status')).body.phase === 'failed');
    const failed = (await admin('GET', '/system/update/status')).body;
    assert.equal(failed.error.code, 'SIGNATURE_IDENTITY');
    assert.equal(failed.error.message, 'Die Signatur stammt nicht aus dem Release-Workflow von manga-shelf.');
    assert.equal((await admin('GET', '/system')).body.update.staging, null);
    useUpdater();
});

test('orphan cleanup refuses while an update is applied', async () => {
    useUpdater();
    update.lock.setPhase('applying');
    try {
        const res = await admin('POST', '/system/orphans/clean');
        assert.equal(res.status, 409);
        assert.equal(res.body.code, 'UPDATE_RUNNING');
    } finally {
        update.lock.release();
    }
    assert.equal((await admin('POST', '/system/orphans/clean')).status, 200);
});

test('orphans: counted by a dry run, removed by POST /system/orphans/clean (editors refused)', async () => {
    const gh = fakeGithub(() => Promise.reject(new Error('offline')));
    try {
        const uploads = path.join(ctx.dataDir, 'uploads');
        fs.mkdirSync(uploads, { recursive: true });
        const orphan = path.join(uploads, 'verwaist.jpg');
        const fresh = path.join(uploads, 'frisch.jpg');
        const trashed = path.join(uploads, 'papierkorb-cover.jpg');
        fs.writeFileSync(orphan, Buffer.alloc(2048));
        fs.writeFileSync(fresh, Buffer.alloc(10));
        fs.writeFileSync(trashed, Buffer.alloc(100));
        const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        fs.utimesSync(orphan, old, old);
        fs.utimesSync(trashed, old, old);
        // a series in the trash still needs its cover for a restore
        const { db } = require('../db');
        db.exec('CREATE TABLE IF NOT EXISTS trash (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref_id INTEGER NOT NULL, title TEXT NOT NULL, payload TEXT NOT NULL)');
        db.prepare('INSERT INTO trash (kind, ref_id, title, payload) VALUES (?, ?, ?, ?)')
            .run('manga', 999, 'Gelöscht', JSON.stringify({ manga: { cover_image: '/uploads/papierkorb-cover.jpg' } }));

        const before = (await admin('GET', '/system?refresh=1')).body;
        assert.deepEqual(before.storage.uploads, { count: 3, bytes: 2158 });
        assert.equal(before.orphans.count, 1);
        assert.equal(before.orphans.bytes, 2048);

        assert.equal((await editor('POST', '/system/orphans/clean')).status, 403);
        const cleaned = await admin('POST', '/system/orphans/clean');
        assert.equal(cleaned.status, 200);
        assert.deepEqual(cleaned.body, { success: true, removed: 1, bytes: 2048, skipped: false });
        assert.ok(!fs.existsSync(orphan));
        assert.ok(fs.existsSync(fresh), 'uploads younger than 7 days stay');
        assert.ok(fs.existsSync(trashed), 'covers of trashed entries stay');
        assert.equal((await admin('GET', '/system')).body.orphans.count, 0);
        await system.updateRun();
    } finally {
        gh.restore();
    }
});

test('orphan cleanup waits only for jobs that touch uploads and names the running one', async () => {
    const lifecycle = require('../services/lifecycle');
    let finishAnime;
    lifecycle.trackJob('Anime-Tageslauf', new Promise((resolve) => { finishAnime = resolve; }));
    try {
        const during = await admin('POST', '/system/orphans/clean');
        assert.equal(during.status, 200, JSON.stringify(during.body));
        let finishSnapshot;
        const snapshot = lifecycle.trackJob('Täglicher Snapshot', new Promise((resolve) => { finishSnapshot = resolve; }));
        const blocked = await admin('POST', '/system/orphans/clean');
        assert.equal(blocked.status, 409);
        assert.equal(blocked.body.code, 'JOB_RUNNING');
        assert.match(blocked.body.error, /„Täglicher Snapshot“/);
        finishSnapshot();
        await snapshot;
        await new Promise((r) => setImmediate(r));
        assert.equal((await admin('POST', '/system/orphans/clean')).status, 200);

        // a job without its own text: the German job name is a nested message, not a plain param
        let finishOther;
        const other = lifecycle.trackJob('Snapshot-Prüfung', new Promise((resolve) => { finishOther = resolve; }));
        const named = await admin('POST', '/system/orphans/clean');
        assert.deepEqual(named.body, {
            error: 'Gerade läuft „Snapshot-Prüfung“ – bitte gleich noch einmal versuchen',
            code: 'JOB_RUNNING',
            msg: 'Gerade läuft „{job}“ – bitte gleich noch einmal versuchen',
            params: { job: { msg: 'Snapshot-Prüfung', params: {} } }
        });
        finishOther();
        await other;
    } finally {
        finishAnime();
    }
});

test('POST /system/sessions/end-all ends every session; the admin keeps working with a new one', async () => {
    const other = ctx.client();
    await other('POST', '/auth/login', { username: 'ed', password: 'password123' });
    assert.equal((await other('GET', '/auth/me')).status, 200);
    const app = await fetch(`${ctx.base}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client': 'app' },
        body: JSON.stringify({ username: 'admin', password: 'password123' })
    }).then(r => r.json());
    assert.ok(app.token);

    assert.equal((await editor('POST', '/system/sessions/end-all')).status, 403);
    const oldCookie = admin.cookie;
    const res = await admin('POST', '/system/sessions/end-all');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.users, 3);
    assert.equal(res.body.token, undefined, 'browser clients get the cookie only');
    assert.notEqual(admin.cookie, oldCookie);
    assert.equal((await admin('GET', '/auth/me')).status, 200);
    assert.equal((await other('GET', '/auth/me')).status, 401);
    assert.equal((await ctx.client(oldCookie)('GET', '/auth/me')).status, 401);
    const bearerMe = await fetch(`${ctx.base}/auth/me`, { headers: { Authorization: `Bearer ${app.token}` } });
    assert.equal(bearerMe.status, 401);

    const fresh = await fetch(`${ctx.base}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client': 'app' },
        body: JSON.stringify({ username: 'admin', password: 'password123' })
    }).then(r => r.json());
    const viaBearer = await fetch(`${ctx.base}/system/sessions/end-all`, { method: 'POST', headers: { Authorization: `Bearer ${fresh.token}` } }).then(r => r.json());
    assert.ok(viaBearer.token, 'app clients get the new token in the body');
    assert.equal((await fetch(`${ctx.base}/auth/me`, { headers: { Authorization: `Bearer ${viaBearer.token}` } })).status, 200);
    await editor('POST', '/auth/login', { username: 'ed', password: 'password123' });
    await admin('POST', '/auth/login', { username: 'admin', password: 'password123' });
});

test('the calendar feed is rate-limited per address', async () => {
    const hit = () => fetch(`${ctx.base}/radar/feed.ics?token=${'x'.repeat(43)}`, { headers: { 'X-Forwarded-For': '10.77.0.1' } });
    let last;
    for (let i = 0; i < 121; i++) last = await hit();
    assert.equal(last.status, 429);
    const elsewhere = await fetch(`${ctx.base}/radar/feed.ics?token=${'x'.repeat(43)}`, { headers: { 'X-Forwarded-For': '10.77.0.2' } });
    assert.equal(elsewhere.status, 404);
});
