// Covers the desktop:watch-* channels: every one answers only the main window's own page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { registerWatchIpc } = require('../lib/watchIpc');
const { originOf, APP_ORIGIN } = require('../lib/appProtocol');

function setup() {
    const handlers = new Map();
    const listeners = new Map();
    const ipcMain = {
        handle: (channel, fn) => handlers.set(channel, fn),
        on: (channel, fn) => listeners.set(channel, fn)
    };
    const calls = [];
    const mainContents = { id: 1 };
    const isWatchSender = (event) => originOf(event.senderFrame?.url || '') === APP_ORIGIN && event.sender === mainContents;
    const service = {
        status: () => { calls.push('status'); return { ok: true, available: true, connected: true }; },
        sync: (options) => { calls.push(['sync', options]); return Promise.resolve({ ok: true, items: [] }); },
        logout: async () => { calls.push('logout'); return { ok: true }; }
    };
    const login = { login: async () => { calls.push('login'); return { ok: true }; } };
    const prefs = {
        get: (key) => { calls.push(['get', key]); return { ok: true, value: 'v' }; },
        set: (key, value) => { calls.push(['set', key, value]); return { ok: true }; },
        remove: (key) => { calls.push(['remove', key]); return { ok: true }; }
    };
    const foreground = { foregroundNow: () => true };
    registerWatchIpc({ ipcMain, isWatchSender, service, login, prefs, foreground });
    return { handlers, listeners, calls, mainContents, service };
}

const CHANNELS = ['desktop:watch-status', 'desktop:watch-login', 'desktop:watch-sync', 'desktop:watch-logout', 'desktop:watch-prefs-get', 'desktop:watch-prefs-set', 'desktop:watch-prefs-remove', 'desktop:watch-foreground-now'];

test('every desktop:watch-* channel is registered', () => {
    const h = setup();
    assert.deepEqual([...h.handlers.keys()].sort(), [...CHANNELS].sort());
    assert.deepEqual([...h.listeners.keys()], ['desktop:watch-allowed']);
});

test('the main window page gets answers; arguments are passed on', async () => {
    const h = setup();
    const event = { sender: h.mainContents, senderFrame: { url: 'app://manga-shelf/anime' } };
    const allowed = {};
    h.listeners.get('desktop:watch-allowed')({ ...event, set returnValue(v) { allowed.value = v; } });
    assert.equal(allowed.value, true);
    assert.deepEqual(await h.handlers.get('desktop:watch-status')(event), { ok: true, available: true, connected: true });
    assert.deepEqual(await h.handlers.get('desktop:watch-login')(event), { ok: true });
    assert.deepEqual(await h.handlers.get('desktop:watch-sync')(event, { force: 1, extra: 'x' }), { ok: true, items: [] });
    assert.deepEqual(await h.handlers.get('desktop:watch-logout')(event), { ok: true });
    assert.deepEqual(await h.handlers.get('desktop:watch-prefs-get')(event, 'k'), { ok: true, value: 'v' });
    await h.handlers.get('desktop:watch-prefs-set')(event, 'k', 'v');
    await h.handlers.get('desktop:watch-prefs-remove')(event, 'k');
    assert.equal(await h.handlers.get('desktop:watch-foreground-now')(event), true);
    assert.deepEqual(h.calls, ['status', 'login', ['sync', { force: true }], 'logout', ['get', 'k'], ['set', 'k', 'v'], ['remove', 'k']]);
});

test('handlers refuse a foreign or data: sender and another window of the app', async () => {
    const h = setup();
    const senders = [
        { sender: h.mainContents, senderFrame: { url: 'https://evil.example/' } },
        { sender: h.mainContents, senderFrame: { url: 'data:text/html,x' } },
        { sender: { id: 2 }, senderFrame: { url: 'app://manga-shelf/' } },
        { sender: h.mainContents, senderFrame: null }
    ];
    for (const event of senders) {
        const allowed = {};
        h.listeners.get('desktop:watch-allowed')({ ...event, set returnValue(v) { allowed.value = v; } });
        assert.equal(allowed.value, false);
        assert.deepEqual(await h.handlers.get('desktop:watch-status')(event), { ok: true, available: false, reason: 'unreadable', connected: false });
        assert.deepEqual(await h.handlers.get('desktop:watch-login')(event), { ok: false, code: 'failed' });
        assert.deepEqual(await h.handlers.get('desktop:watch-sync')(event, {}), { ok: false, code: 'network' });
        assert.deepEqual(await h.handlers.get('desktop:watch-logout')(event), { ok: true });
        for (const channel of ['desktop:watch-prefs-get', 'desktop:watch-prefs-set', 'desktop:watch-prefs-remove']) {
            assert.deepEqual(await h.handlers.get(channel)(event, 'watch-sync:crunchyroll:state', 'x'), { ok: false, code: 'not_allowed' });
        }
        assert.equal(await h.handlers.get('desktop:watch-foreground-now')(event), false);
    }
    assert.deepEqual(h.calls, []);
});

test('a throwing service never reaches the page as an error', async () => {
    const h = setup();
    h.service.sync = () => { throw new Error('kaputt'); };
    const event = { sender: h.mainContents, senderFrame: { url: 'app://manga-shelf/' } };
    assert.deepEqual(await h.handlers.get('desktop:watch-sync')(event, {}), { ok: false, code: 'network' });
});

test('preload: the watch bridge after locale, only when main allows it, platform names mapped, fallbacks for a rejected invoke', () => {
    const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    assert.match(preload, /watchAllowed = ipcRenderer\.sendSync\('desktop:watch-allowed'\) === true;/);
    assert.match(preload, /exposeInMainWorld\('mangashelfDesktop', \{[^}]*\blocale,\n\s*\.\.\.\(watch \? \{ watch \} : \{\}\),/s);
    assert.match(preload, /const WATCH_PLATFORMS = \{ darwin: 'macos', win32: 'windows', linux: 'linux' \};/);
    assert.match(preload, /platform: WATCH_PLATFORMS\[process\.platform\],/);
    assert.match(preload, /status: \(\) => invokeOr\(\{ ok: true, available: false, reason: 'unreadable', connected: false \}, 'desktop:watch-status'\)/);
    assert.match(preload, /login: \(\) => invokeOr\(\{ ok: false, code: 'failed' \}, 'desktop:watch-login'\)/);
    assert.match(preload, /sync: \(options\) => invokeOr\(\{ ok: false, code: 'network' \}, 'desktop:watch-sync', \{ force: Boolean\(options && options\.force\) \}\)/);
    assert.match(preload, /logout: \(\) => invokeOr\(\{ ok: true \}, 'desktop:watch-logout'\)/);
    for (const name of ['get', 'set', 'remove']) assert.match(preload, new RegExp(`${name}: \\([^)]*\\) => invokeOr\\(PREFS_REFUSED, 'desktop:watch-prefs-${name}'`));
    assert.match(preload, /subscribe\('desktop:watch-foreground', \(\) => callback\(\)\)/);
    assert.match(preload, /invokeOr\(false, 'desktop:watch-foreground-now'\)\.then\(\(now\) => \{ if \(active && now === true\) callback\(\); \}\)/);
});

const plain = (value) => JSON.parse(JSON.stringify(value));

function loadPreload({ allowed, platform = 'darwin', invoke }) {
    const vm = require('vm');
    const source = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    const exposed = {};
    const listeners = new Map();
    const ipcRenderer = {
        sendSync: (channel) => (channel === 'desktop:watch-allowed' ? allowed : channel === 'desktop:locale' ? 'de-DE' : {}),
        invoke: (channel, ...args) => invoke(channel, ...args),
        send: () => {},
        on: (channel, fn) => listeners.set(channel, fn),
        removeListener: (channel, fn) => { if (listeners.get(channel) === fn) listeners.delete(channel); }
    };
    const electron = { contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } }, ipcRenderer };
    vm.runInNewContext(source, {
        require: (name) => (name === 'electron' ? electron : require(name)),
        window: { location: { origin: 'app://manga-shelf', href: 'app://manga-shelf/' }, dispatchEvent: () => true },
        process: { platform },
        CustomEvent: class {}
    });
    return { bridge: exposed.mangashelfDesktop, listeners };
}

test('preload at run time: no watch without permission; answers, fallbacks and the foreground callback', async () => {
    assert.equal('watch' in loadPreload({ allowed: false, invoke: async () => null }).bridge, false);
    assert.equal('watch' in loadPreload({ allowed: 'yes', invoke: async () => null }).bridge, false);
    for (const [platform, name] of [['darwin', 'macos'], ['win32', 'windows'], ['linux', 'linux']]) {
        assert.equal(loadPreload({ allowed: true, platform, invoke: async () => null }).bridge.watch.platform, name);
    }

    const sent = [];
    const ok = loadPreload({ allowed: true, invoke: async (channel, ...args) => { sent.push([channel, ...args]); return channel === 'desktop:watch-foreground-now' ? true : { ok: true }; } });
    const { watch } = ok.bridge;
    assert.deepEqual(await watch.sync({ force: 'ja' }), { ok: true });
    assert.deepEqual(await watch.prefs.set('k', 'v'), { ok: true });
    assert.deepEqual(plain(sent), [['desktop:watch-sync', { force: true }], ['desktop:watch-prefs-set', 'k', 'v']]);
    let calls = 0;
    const off = watch.onForeground(() => { calls += 1; });
    assert.equal(typeof off, 'function');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    ok.listeners.get('desktop:watch-foreground')({}, 'ignored');
    assert.equal(calls, 2);
    off();
    assert.equal(ok.listeners.has('desktop:watch-foreground'), false);

    const failing = loadPreload({ allowed: true, invoke: () => Promise.reject(new Error('No handler registered')) }).bridge.watch;
    assert.deepEqual(plain(await failing.status()), { ok: true, available: false, reason: 'unreadable', connected: false });
    assert.deepEqual(plain(await failing.login()), { ok: false, code: 'failed' });
    assert.deepEqual(plain(await failing.sync({})), { ok: false, code: 'network' });
    assert.deepEqual(plain(await failing.logout()), { ok: true });
    for (const name of ['get', 'set', 'remove']) assert.deepEqual(plain(await failing.prefs[name]('k', 'v')), { ok: false, code: 'not_allowed' });
    let foreground = 0;
    failing.onForeground(() => { foreground += 1; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(foreground, 0);
});
