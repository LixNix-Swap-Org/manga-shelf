// Covers the embedded server controller, serial queue, run switching, permissions and server environment.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { createServerController, createSerialQueue, createRunSwitcher, createLockedWarning, needsRestart, permissionAllowed, generateSetupToken, serverEnv, BUSY_MESSAGE } = require('../lib/server');

const repo = path.resolve(__dirname, '..', '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-desktop-server-'));
const setupToken = generateSetupToken();
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
delete process.env.SETUP_TOKEN;
const ctl = createServerController({ serverDir: repo, dataDir, setupToken, env: process.env });

test.after(async () => {
    await ctl.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('generateSetupToken uses the server format and is long enough for SETUP_TOKEN', () => {
    const { normalizeSetupToken, MIN_SETUP_TOKEN_LENGTH } = require('../../utils/config');
    const token = generateSetupToken();
    assert.match(token, /^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/);
    assert.ok(normalizeSetupToken(token).length >= MIN_SETUP_TOKEN_LENGTH);
    assert.notEqual(generateSetupToken(), token);
});

test('serverEnv sets DATA_DIR, keeps index.js from listening and drops FRONTEND_DIR', () => {
    const env = serverEnv({ PATH: '/bin', FRONTEND_DIR: '/x' }, { dataDir: '/d', setupToken: 'ABCD-EFGH-JKLM-NPQR' });
    assert.deepEqual(env, { PATH: '/bin', DATA_DIR: '/d', MANGA_SHELF_NO_LISTEN: '1', SETUP_TOKEN: 'ABCD-EFGH-JKLM-NPQR' });
    assert.equal('SETUP_TOKEN' in serverEnv({}, { dataDir: '/d' }), false);
});

test('the controller runs the server in-process: setup with the app-set code, health, backup', async () => {
    const started = await ctl.start({ host: '127.0.0.1', port: 0 });
    assert.equal(started.url, `http://127.0.0.1:${started.port}`);
    assert.equal(ctl.loaded(), true);
    assert.equal(process.env.DATA_DIR, dataDir);
    assert.equal(await ctl.needsSetup(), true);
    const health = await ctl.health();
    assert.equal(health.name, 'Manga Shelf');
    assert.ok(health.instance_id);

    const wrong = await fetch(`${started.url}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'Sehr-geheim-123', setup_token: 'FALSCH-FALSCH-FALSCH' }) });
    assert.equal(wrong.status, 403);
    const res = await fetch(`${started.url}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'Sehr-geheim-123', setup_token: setupToken.toLowerCase() }) });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(await ctl.needsSetup(), false);

    const backup = await ctl.backupNow();
    assert.equal(backup.ok, true, backup.lines.join('\n'));
    assert.ok(fs.readdirSync(path.join(dataDir, 'backups')).some((f) => f.startsWith('manual-') && f.endsWith('.zip')));
});

test('a mode switch restarts on another host with the same data; a taken port falls back only when asked', async () => {
    const first = await ctl.start({ host: '127.0.0.1', port: 0 });
    const second = await ctl.start({ host: '0.0.0.0', port: 0 });
    assert.equal(second.host, '0.0.0.0');
    assert.equal(second.url, `http://127.0.0.1:${second.port}`);
    await assert.rejects(fetch(`${first.url}/api/health`));
    assert.equal(await ctl.needsSetup(), false);

    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    try {
        const taken = blocker.address().port;
        await assert.rejects(ctl.start({ host: '127.0.0.1', port: taken }), { code: 'EADDRINUSE' });
        assert.equal(ctl.current(), null);
        const fallback = await ctl.start({ host: '127.0.0.1', port: taken, fallbackPort: true });
        assert.notEqual(fallback.port, taken);
        assert.equal((await fetch(`${fallback.url}/api/health`)).status, 200);
    } finally {
        blocker.close();
    }
    await ctl.stop();
    assert.equal(ctl.current(), null);
    assert.equal(await ctl.health(), null);
    await assert.rejects(ctl.backupNow(), /läuft nicht/);
});

test('overlapping starts run one after another instead of failing with "Server läuft bereits"', async () => {
    await ctl.start({ host: '127.0.0.1', port: 0 });
    const [a, b, c] = await Promise.all([
        ctl.start({ host: '0.0.0.0', port: 0 }),
        ctl.start({ host: '127.0.0.1', port: 0 }),
        ctl.stop().then(() => ctl.start({ host: '127.0.0.1', port: 0 }))
    ]);
    assert.equal(a.host, '0.0.0.0');
    assert.equal(b.host, '127.0.0.1');
    assert.equal(ctl.current().port, c.port);
    assert.equal((await fetch(`${c.url}/api/health`)).status, 200);
});

test('a restart is refused while a restore or snapshot runs; its files survive and the server keeps running', async () => {
    const lifecycle = require(path.join(repo, 'services', 'lifecycle.js'));
    const running = await ctl.start({ host: '127.0.0.1', port: 0 });
    const tmp = path.join(dataDir, 'manga.db.restore-tmp');
    fs.writeFileSync(tmp, 'x');
    let finish;
    lifecycle.trackJob('Wiederherstellung', new Promise((resolve) => { finish = resolve; }));
    try {
        assert.deepEqual(ctl.busy(), ['Wiederherstellung']);
        await assert.rejects(ctl.start({ host: '0.0.0.0', port: 0 }), (err) => err.code === 'SERVER_BUSY' && err.message === BUSY_MESSAGE && err.jobs.includes('Wiederherstellung'));
        await assert.rejects(ctl.stop(), (err) => err.code === 'SERVER_BUSY', 'switching to client mode stops the server: refused as well');
        assert.equal(ctl.current().url, running.url);
        assert.equal((await fetch(`${running.url}/api/health`)).status, 200);
        assert.ok(fs.existsSync(tmp), 'the restart did not sweep the running job');
    } finally {
        finish();
        await new Promise((resolve) => setImmediate(resolve));
        fs.rmSync(tmp, { force: true });
    }
    assert.deepEqual(ctl.busy(), []);
    assert.equal((await ctl.start({ host: '0.0.0.0', port: 0 })).host, '0.0.0.0');
});

test('quitting stops the server even while a job runs (stop with force)', async () => {
    const lifecycle = require(path.join(repo, 'services', 'lifecycle.js'));
    await ctl.start({ host: '127.0.0.1', port: 0 });
    let finish;
    lifecycle.trackJob('Snapshot', new Promise((resolve) => { finish = resolve; }));
    const stopping = ctl.stop({ force: true });
    setTimeout(finish, 50);
    await stopping;
    assert.equal(ctl.current(), null);
    assert.deepEqual(ctl.busy(), []);
});

test('the desktop "Backup jetzt" snapshot counts as a running job for the restart guard', async () => {
    await ctl.start({ host: '127.0.0.1', port: 0 });
    const backup = ctl.backupNow();
    const seen = ctl.busy();
    const result = await backup;
    assert.equal(result.ok, true, result.lines.join('\n'));
    assert.deepEqual(seen, ['Snapshot']);
    assert.deepEqual(ctl.busy(), []);
});

/** switchRun with stubs: settings, overrides and the server controller as plain values. */
function switcher({ current = { host: '127.0.0.1', port: 37210 }, busy = [], apply = async () => true } = {}) {
    const state = { settings: { mode: 'local', serverPort: 3000 }, overrides: { port: null }, refreshed: 0, busyShown: [], applied: 0 };
    const switchRun = createRunSwitcher({
        queue: createSerialQueue(),
        settings: { get: () => state.settings, update: (patch) => { state.settings = { ...state.settings, ...patch }; } },
        getOverrides: () => state.overrides,
        setOverrides: (next) => { state.overrides = next; },
        resolveRun: (settings) => ({ server: settings.mode === 'client' ? null : { host: settings.mode === 'server' ? '0.0.0.0' : '127.0.0.1', port: settings.mode === 'server' ? settings.serverPort : 37210 } }),
        controller: { current: () => current, busy: () => busy },
        apply: async (options) => { state.applied++; return apply(options); },
        showBusy: async (jobs) => { state.busyShown.push(jobs); },
        refresh: () => { state.refreshed++; }
    });
    return { state, switchRun };
}

test('switchRun: a change that is refused while jobs run is undone and the menu rebuilt', async () => {
    const { state, switchRun } = switcher({ busy: ['Snapshot'] });
    const result = await switchRun(() => {
        state.settings = { ...state.settings, mode: 'server' };
        state.overrides = { port: 4000 };
    });
    assert.equal(result, false);
    assert.equal(state.applied, 0);
    assert.deepEqual(state.settings, { mode: 'local', serverPort: 3000 });
    assert.deepEqual(state.overrides, { port: null });
    assert.deepEqual(state.busyShown, [['Snapshot']]);
    assert.equal(state.refreshed, 1, 'menu and tray show the running mode again');
});

test('switchRun: a skipped change rebuilds the menu, a change that keeps the server ignores busy jobs', async () => {
    const skipped = switcher();
    assert.equal(await skipped.switchRun(() => false), false);
    assert.equal(skipped.state.refreshed, 1);
    assert.equal(skipped.state.applied, 0);
    const tray = switcher({ busy: ['Wiederherstellung'] });
    assert.equal(await tray.switchRun(() => { tray.state.settings = { ...tray.state.settings, tray: true }; }), true);
    assert.equal(tray.state.settings.tray, true);
    assert.equal(tray.state.refreshed, 0);
    assert.deepEqual(tray.state.busyShown, []);
});

test('switchRun: settings and overrides roll back when applyRun fails (SERVER_BUSY in the start itself, or an error)', async () => {
    const refused = switcher({ apply: async () => false });
    assert.equal(await refused.switchRun(() => { refused.state.settings = { ...refused.state.settings, mode: 'server' }; }), false);
    assert.equal(refused.state.applied, 1);
    assert.equal(refused.state.settings.mode, 'local');
    assert.equal(refused.state.refreshed, 1);
    const failing = switcher({ apply: async () => { throw new Error('kaputt'); } });
    await assert.rejects(failing.switchRun(() => { failing.state.overrides = { port: 4000 }; }), /kaputt/);
    assert.deepEqual(failing.state.overrides, { port: null });
    const ok = switcher();
    assert.equal(await ok.switchRun(() => { ok.state.settings = { ...ok.state.settings, mode: 'client' }; }, { announceSetup: true }), true);
    assert.equal(ok.state.settings.mode, 'client');
    assert.equal(ok.state.refreshed, 0);
});

test('the locked-keychain warning comes once per session, whenever the window first shows the remote view', () => {
    let locked = true;
    let shown = 0;
    const warn = createLockedWarning({ isLocked: () => locked, show: () => { shown++; } });
    assert.equal(warn('local'), false);
    assert.equal(warn(null), false);
    assert.equal(warn('remote'), true);
    assert.equal(warn('remote'), false);
    assert.equal(shown, 1);
    locked = false;
    const unlocked = createLockedWarning({ isLocked: () => locked, show: () => { shown++; } });
    assert.equal(unlocked('remote'), false);
    assert.equal(shown, 1);
});

test('load() removes a FRONTEND_DIR of the environment for good', async (t) => {
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-desktop-stub-'));
    t.after(() => fs.rmSync(stubDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(stubDir, 'index.js'), 'module.exports = { start: async ({ port }) => ({ port: port || 1 }), stop: async () => {} };');
    const env = { FRONTEND_DIR: '/home/kim/alter/build', PATH: '/bin' };
    const stub = createServerController({ serverDir: stubDir, dataDir: '/tmp/d', setupToken: 'ABCD-EFGH-JKLM-NPQR', env });
    await stub.start({ host: '127.0.0.1', port: 1 });
    assert.equal('FRONTEND_DIR' in env, false);
    assert.equal(env.DATA_DIR, '/tmp/d');
    assert.equal(env.PATH, '/bin');
});

test('the serial queue keeps the order and goes on after a failure', async () => {
    const queue = createSerialQueue();
    const order = [];
    const slow = queue(async () => { await new Promise((r) => setTimeout(r, 20)); order.push('a'); });
    const failing = queue(async () => { order.push('b'); throw new Error('kaputt'); });
    const last = queue(async () => { order.push('c'); return 'ok'; });
    await slow;
    await assert.rejects(failing, /kaputt/);
    assert.equal(await last, 'ok');
    assert.deepEqual(order, ['a', 'b', 'c']);
});

test('needsRestart: stopping or moving the running server counts, the same host and port do not', () => {
    const current = { host: '127.0.0.1', port: 37210, url: 'http://127.0.0.1:37210' };
    assert.equal(needsRestart(null, { host: '0.0.0.0', port: 3000 }), false);
    assert.equal(needsRestart(current, { host: '127.0.0.1', port: 37210 }), false);
    assert.equal(needsRestart(current, { host: '0.0.0.0', port: 3000 }), true);
    assert.equal(needsRestart(current, null), true, 'client mode stops the server');
});

test('permissions only for the app origin or the running local server, never for null origins', () => {
    const base = { appOrigin: 'app://manga-shelf', localOrigin: null };
    assert.equal(permissionAllowed({ ...base, permission: 'media', origin: 'app://manga-shelf' }), true);
    assert.equal(permissionAllowed({ ...base, permission: 'media', origin: null }), false, 'data:, about:blank, file: without a local server');
    assert.equal(permissionAllowed({ ...base, permission: 'media', origin: 'null' }), false);
    assert.equal(permissionAllowed({ ...base, permission: 'geolocation', origin: 'app://manga-shelf' }), false);
    const local = { ...base, localOrigin: 'http://127.0.0.1:37210' };
    assert.equal(permissionAllowed({ ...local, permission: 'clipboard-sanitized-write', origin: 'http://127.0.0.1:37210' }), true);
    assert.equal(permissionAllowed({ ...local, permission: 'fullscreen', origin: 'http://127.0.0.1:37211' }), false);
    assert.equal(permissionAllowed({ ...local, permission: 'media', origin: 'https://example.com' }), false);
});

test('clipboard-read for the paste button: app and local server pages only', () => {
    const local = { appOrigin: 'app://manga-shelf', localOrigin: 'http://127.0.0.1:37210' };
    assert.equal(permissionAllowed({ ...local, permission: 'clipboard-read', origin: 'app://manga-shelf' }), true);
    assert.equal(permissionAllowed({ ...local, permission: 'clipboard-read', origin: 'http://127.0.0.1:37210' }), true);
    assert.equal(permissionAllowed({ ...local, permission: 'clipboard-read', origin: 'https://www.crunchyroll.com' }), false);
    assert.equal(permissionAllowed({ ...local, permission: 'clipboard-read', origin: 'null' }), false);
});
