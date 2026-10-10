// Covers the desktop Crunchyroll sign-in window with stand-ins for BrowserWindow, session and dialog.
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { createWatchLogin, browserUserAgent, registerClientCertificateGuard } = require('../lib/watchLogin');
const { createWatchService } = require('../lib/watchService');
const { createWatchSecret } = require('../lib/watchSecret');
const { crunchyroll, createFlow, FlowError, tempDir, flush, fakeSafeStorage, fakeWindow, fakeTransport, fakeApiSession } = require('./watchFakes');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const LOGIN_COOKIE = 'etp-login-cookie-000001';
const DONE_URL = 'https://www.crunchyroll.com/de/';
const deferred = () => {
    const d = {};
    d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
    return d;
};

const mocked = new WeakSet();

function setup(t, { available = true } = {}) {
    if (!mocked.has(t)) {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        mocked.add(t);
    }
    const log = [];
    const h = { log, windows: [], sessions: [], dialogs: [], connects: 0 };
    const dir = tempDir(t);
    const safe = fakeSafeStorage({ available });
    h.store = createWatchSecret({ file: path.join(dir, 'watch-secret.json'), safeStorage: safe, platform: 'darwin' });
    const service = createWatchService({
        createFlow, FlowError, crunchyroll, secret: h.store, transport: fakeTransport().send, apiSession: fakeApiSession(),
        randomUUID: () => '99999999-8888-4777-8666-555555555555', now: () => 1, isForeground: () => true
    });
    h.service = {
        status: () => service.status(),
        connect: (args) => {
            h.connects += 1;
            h.lastConnect = args;
            return service.connect(args);
        }
    };
    h.cookies = [{ name: 'etp_rt', value: LOGIN_COOKIE, domain: '.crunchyroll.com' }];

    const session = {
        fromPartition(name, options) {
            const ses = new EventEmitter();
            ses.name = name;
            ses.options = options;
            ses.handlers = {};
            ses.setUserAgent = (ua) => { ses.userAgent = ua; log.push('ses:ua'); };
            ses.setPermissionRequestHandler = (fn) => { ses.handlers.request = fn; log.push('ses:request'); };
            ses.setPermissionCheckHandler = (fn) => { ses.handlers.check = fn; log.push('ses:check'); };
            ses.setDevicePermissionHandler = (fn) => { ses.handlers.device = fn; log.push('ses:device'); };
            ses.cookies = { get: (filter) => { ses.cookieFilter = filter; return h.cookieGate ? h.cookieGate.promise : Promise.resolve(h.cookies); } };
            for (const name of ['clearStorageData', 'clearCache', 'clearAuthCache']) {
                ses[name] = async () => {
                    await new Promise((resolve) => setImmediate(resolve));
                    log.push(name);
                };
            }
            h.sessions.push(ses);
            return ses;
        }
    };
    class BrowserWindow extends EventEmitter {
        constructor(options) {
            super();
            log.push('window');
            this.options = options;
            this.destroyed = false;
            this.destroyCalls = 0;
            this.loads = [];
            const contents = new EventEmitter();
            contents.url = '';
            contents.getURL = () => contents.url;
            contents.setWindowOpenHandler = (fn) => { contents.openHandler = fn; };
            contents.executeJavaScript = (code) => {
                contents.scripts = (contents.scripts || 0) + 1;
                if (h.scriptGate) return h.scriptGate.promise;
                return Promise.resolve('{"accountAuthClientId":"web_client_01","anonClientId":null}');
            };
            this.webContents = contents;
            h.windows.push(this);
        }
        isDestroyed() { return this.destroyed; }
        setMenu(menu) { this.menu = menu; }
        setTitle(title) { this.title = title; }
        loadURL(url, options) {
            this.loads.push({ url, options });
            this.webContents.url = url;
            return Promise.resolve();
        }
        close() {
            this.emit('close', { preventDefault() {} });
            this.destroy();
        }
        destroy() {
            this.destroyCalls += 1;
            log.push('destroy');
            if (this.destroyed) return;
            this.destroyed = true;
            this.emit('closed');
        }
    }
    const dialog = {
        showMessageBox(win, options) {
            const entry = { win, options, done: deferred() };
            options.signal.addEventListener('abort', () => entry.done.resolve({ response: 0 }));
            h.dialogs.push(entry);
            return entry.done.promise;
        }
    };
    h.mainWindow = fakeWindow({ visible: true, focused: true });
    h.login = createWatchLogin({ BrowserWindow, session, dialog, app: { isPackaged: true }, getMainWindow: () => h.mainWindow, service: h.service, crunchyroll, userAgent: UA });
    h.win = () => h.windows[h.windows.length - 1];
    h.navigate = (url) => {
        h.win().webContents.url = url;
        h.win().webContents.emit('did-navigate', {}, url);
    };
    h.saved = () => fs.existsSync(h.store.file);
    return h;
}

const until = async (fn) => {
    for (let i = 0; i < 50 && !fn(); i++) await flush();
    assert.ok(fn(), 'condition not reached');
};

test('the session is configured before the window; every handler is installed', async (t) => {
    const h = setup(t);
    const pending = h.login.login();
    await until(() => h.windows.length === 1);
    const win = h.win();
    const ses = h.sessions[0];
    assert.match(ses.name, /^crunchyroll-login-[0-9a-f]{24}$/);
    assert.deepEqual(ses.options, { cache: false });
    assert.equal(ses.userAgent, UA);
    assert.deepEqual(h.log.slice(0, 5), ['ses:ua', 'ses:request', 'ses:check', 'ses:device', 'window']);
    assert.deepEqual(win.options, {
        parent: h.mainWindow,
        webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, devTools: false, safeDialogs: true }
    });
    assert.equal(ses.listenerCount('will-download'), 1);
    let prevented = false;
    ses.emit('will-download', { preventDefault: () => { prevented = true; } });
    assert.ok(prevented);
    let granted = null;
    ses.handlers.request(win.webContents, 'media', (value) => { granted = value; });
    assert.equal(granted, false);
    assert.equal(ses.handlers.check(), false);
    assert.equal(ses.handlers.device(), false);
    for (const event of ['select-bluetooth-device', 'will-prevent-unload', 'before-input-event', 'render-process-gone', 'will-navigate', 'will-redirect', 'did-navigate', 'did-navigate-in-page']) {
        assert.equal(win.webContents.listenerCount(event), 1, event);
    }
    for (const event of ['close', 'closed', 'page-title-updated']) assert.equal(win.listenerCount(event), 1, event);
    for (const event of ['hide', 'minimize', 'closed']) assert.equal(h.mainWindow.listenerCount(event), 1, event);
    assert.equal(typeof win.webContents.openHandler, 'function');
    assert.equal(win.menu, null);
    assert.deepEqual(win.loads, [{ url: crunchyroll.LOGIN_OPTIONS.url, options: { userAgent: UA } }]);
    assert.equal(win.title, 'Bei Crunchyroll anmelden – www.crunchyroll.com');
    let device = null;
    const bluetooth = { prevented: false, preventDefault() { this.prevented = true; } };
    win.webContents.emit('select-bluetooth-device', bluetooth, [{ deviceId: 'x' }], (id) => { device = id; });
    assert.ok(bluetooth.prevented);
    assert.equal(device, '');
    const unload = { prevented: false, preventDefault() { this.prevented = true; } };
    win.webContents.emit('will-prevent-unload', unload);
    assert.ok(unload.prevented);
    const title = { prevented: false, preventDefault() { this.prevented = true; } };
    win.emit('page-title-updated', title, 'Fremder Titel');
    assert.ok(title.prevented);
    win.close();
    assert.deepEqual(await pending, { ok: false, code: 'cancelled' });
    for (const event of ['hide', 'minimize', 'closed']) assert.equal(h.mainWindow.listenerCount(event), 0, event);
});

test('navigation: only https crunchyroll.com and its subdomains; popups load in the same window', async (t) => {
    const h = setup(t);
    const pending = h.login.login();
    await until(() => h.windows.length === 1);
    const contents = h.win().webContents;
    const navigate = (url) => {
        const event = { url, prevented: false, preventDefault() { this.prevented = true; } };
        contents.emit('will-navigate', event, url);
        return event.prevented;
    };
    assert.equal(navigate('https://sso.crunchyroll.com/authorize'), false);
    assert.equal(navigate('https://crunchyroll.com/'), false);
    assert.equal(navigate('http://www.crunchyroll.com/'), true);
    assert.equal(navigate('https://evilcrunchyroll.com/'), true);
    assert.equal(navigate('https://crunchyroll.com.evil.example/'), true);
    const redirect = (url, isMainFrame) => {
        const details = { url, isMainFrame, prevented: false, preventDefault() { this.prevented = true; } };
        contents.emit('will-redirect', details);
        return details.prevented;
    };
    assert.equal(redirect('https://accounts.google.com/', true), true);
    assert.equal(redirect('https://accounts.google.com/', false), false);
    assert.equal(redirect('https://static.crunchyroll.com/x', true), false);
    assert.deepEqual(contents.openHandler({ url: 'https://www.crunchyroll.com/de/help' }), { action: 'deny' });
    assert.deepEqual(h.win().loads.at(-1), { url: 'https://www.crunchyroll.com/de/help', options: { userAgent: UA } });
    assert.deepEqual(contents.openHandler({ url: 'https://evil.example/' }), { action: 'deny' });
    assert.equal(h.win().loads.length, 2);
    h.win().close();
    await pending;
});

test('one refused-host dialog at a time, with the host as detail, aborted on cancel', async (t) => {
    const h = setup(t);
    const pending = h.login.login();
    await until(() => h.windows.length === 1);
    const contents = h.win().webContents;
    const refuse = (url) => contents.emit('will-navigate', { url, preventDefault() {} }, url);
    refuse('https://evil.example/a');
    refuse('https://other.example/b');
    await flush();
    assert.equal(h.dialogs.length, 1);
    assert.equal(h.dialogs[0].win, h.win());
    assert.equal(h.dialogs[0].options.type, 'info');
    assert.equal(h.dialogs[0].options.message, 'Hier werden nur Crunchyroll-Seiten geöffnet');
    assert.equal(h.dialogs[0].options.detail, 'evil.example');
    contents.emit('before-input-event', { prevented: false, preventDefault() { this.prevented = true; } }, { type: 'keyDown', meta: true, key: 'w' });
    assert.equal(h.dialogs[0].options.signal.aborted, true);
    assert.deepEqual(await pending, { ok: false, code: 'cancelled' });
});

test('timer and navigation check at once finish once and store the login', async (t) => {
    const h = setup(t);
    const pending = h.login.login();
    await until(() => h.windows.length === 1);
    h.win().webContents.url = DONE_URL;
    h.win().webContents.emit('did-navigate', {}, DONE_URL);
    t.mock.timers.tick(1000);
    h.win().webContents.emit('did-navigate-in-page', {}, DONE_URL, true);
    assert.deepEqual(await pending, { ok: true });
    assert.equal(h.connects, 1);
    assert.equal(h.sessions[0].cookieFilter.url, 'https://www.crunchyroll.com/auth/v1/token');
    assert.equal(h.sessions[0].cookieFilter.name, 'etp_rt');
    const secret = h.store.read();
    assert.equal(secret.etp_rt, LOGIN_COOKIE);
    assert.equal(secret.client_id, 'web_client_01');
    assert.deepEqual(h.log.slice(-4), ['clearStorageData', 'clearCache', 'clearAuthCache', 'destroy']);
});

test('the login page itself and a foreign host are not done', async (t) => {
    const h = setup(t);
    const pending = h.login.login();
    await until(() => h.windows.length === 1);
    h.navigate('https://www.crunchyroll.com/de/LOGIN?x=1');
    h.navigate('https://sso.crunchyroll.com/login');
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(h.connects, 0);
    h.win().close();
    assert.deepEqual(await pending, { ok: false, code: 'cancelled' });
    assert.equal(h.saved(), false);
});

test('cookie choice: www and .crunchyroll.com count, an sso host-only cookie or a bad value does not; the first in order wins', async (t) => {
    const choose = async (cookies) => {
        const h = setup(t);
        h.cookies = cookies;
        const pending = h.login.login();
        await until(() => h.windows.length === 1);
        h.navigate(DONE_URL);
        const result = await pending;
        return result.ok ? h.store.read().etp_rt : result;
    };
    const sso = { name: 'etp_rt', value: 'etp-sso-host-only-01', domain: 'sso.crunchyroll.com' };
    const www = { name: 'etp_rt', value: 'etp-www-cookie-0002', domain: 'www.crunchyroll.com' };
    const dot = { name: 'etp_rt', value: 'etp-dot-cookie-0003', domain: '.crunchyroll.com' };
    const bad = { name: 'etp_rt', value: 'a b', domain: '.crunchyroll.com' };
    assert.equal(await choose([sso, www, dot]), www.value);
    assert.equal(await choose([sso, bad, dot, www]), dot.value);
});

test('close during a pending check: cancelled, nothing stored', async (t) => {
    const h = setup(t);
    h.cookieGate = deferred();
    const pending = h.login.login();
    await until(() => h.windows.length === 1);
    h.navigate(DONE_URL);
    await flush();
    h.win().close();
    assert.deepEqual(await pending, { ok: false, code: 'cancelled' });
    h.cookieGate.resolve(h.cookies);
    await flush();
    assert.equal(h.connects, 0);
    assert.equal(h.saved(), false);
    assert.equal(h.win().destroyCalls, 1);
});

for (const [name, cancel] of [
    ['CmdOrCtrl+W', (h) => h.win().webContents.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', control: true, key: 'W' })],
    ['main window hide', (h) => h.mainWindow.hide()],
    ['main window minimize', (h) => h.mainWindow.minimize()],
    ['before-quit', (h) => h.login.finishPending('cancelled')]
]) {
    test(`${name} during a pending readScript: cancelled, no watch-secret.json, cleanup before destroy`, async (t) => {
        const h = setup(t);
        h.scriptGate = deferred();
        const pending = h.login.login();
        await until(() => h.windows.length === 1);
        h.navigate(DONE_URL);
        await until(() => h.win().webContents.scripts === 1);
        cancel(h);
        assert.deepEqual(await pending, { ok: false, code: 'cancelled' });
        h.scriptGate.resolve('{"accountAuthClientId":"web_client_01"}');
        await flush();
        assert.equal(h.connects, 0);
        assert.equal(h.saved(), false);
        assert.deepEqual(h.log.slice(-4), ['clearStorageData', 'clearCache', 'clearAuthCache', 'destroy']);
    });
}

test('a never-settling executeJavaScript: after 3 s the fallback client id is used', async (t) => {
    const h = setup(t);
    h.scriptGate = deferred();
    const pending = h.login.login();
    await until(() => h.windows.length === 1);
    h.navigate(DONE_URL);
    await until(() => h.win().webContents.scripts === 1);
    t.mock.timers.tick(2999);
    await flush();
    assert.equal(h.connects, 0);
    t.mock.timers.tick(1);
    assert.deepEqual(await pending, { ok: true });
    assert.equal(h.lastConnect.scriptResult, null);
    assert.equal(h.store.read().client_id, crunchyroll.ENDPOINTS.clientIdFallback.id);
});

test('the host is checked again after the script; a page that left crunchyroll.com gives no script result', async (t) => {
    const h = setup(t);
    h.scriptGate = deferred();
    const pending = h.login.login();
    await until(() => h.windows.length === 1);
    h.navigate(DONE_URL);
    await until(() => h.win().webContents.scripts === 1);
    h.win().webContents.url = 'https://evil.example/';
    h.scriptGate.resolve('{"accountAuthClientId":"evil_client_1"}');
    assert.deepEqual(await pending, { ok: true });
    assert.equal(h.lastConnect.scriptResult, null);
    assert.equal(h.store.read().client_id, crunchyroll.ENDPOINTS.clientIdFallback.id);
});

test('closing the login window while no check runs: cancelled, and a second login() opens a new window', async (t) => {
    const h = setup(t);
    const first = h.login.login();
    await until(() => h.windows.length === 1);
    assert.deepEqual(await h.login.login(), { ok: false, code: 'busy' });
    h.win().close();
    assert.deepEqual(await first, { ok: false, code: 'cancelled' });
    assert.equal(h.windows[0].destroyCalls, 1);
    assert.deepEqual(h.log.slice(-4), ['destroy', 'clearStorageData', 'clearCache', 'clearAuthCache']);
    const second = h.login.login();
    await until(() => h.windows.length === 2);
    assert.equal(h.login.isLoginContents(h.windows[1].webContents), true);
    assert.equal(h.login.isLoginContents(h.windows[0].webContents), false);
    h.navigate(DONE_URL);
    assert.deepEqual(await second, { ok: true });
    assert.equal(h.login.isLoginContents(h.windows[1].webContents), false);
});

test('a crashed page answers failed; a login without a usable key store opens no window', async (t) => {
    const h = setup(t);
    const pending = h.login.login();
    await until(() => h.windows.length === 1);
    h.win().webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    assert.deepEqual(await pending, { ok: false, code: 'failed' });

    const none = setup(t, { available: false });
    assert.deepEqual(await none.login.login(), { ok: false, code: 'unavailable' });
    assert.equal(none.windows.length, 0);
});

test('a rejected connect answers failed', async (t) => {
    const h = setup(t);
    h.service.connect = async () => { throw new FlowError('stale'); };
    const pending = h.login.login();
    await until(() => h.windows.length === 1);
    h.navigate(DONE_URL);
    assert.deepEqual(await pending, { ok: false, code: 'failed' });
});

test('browserUserAgent rebuilds a plain Chrome string per OS', () => {
    const tail = 'AppleWebKit/537.36 (KHTML, like Gecko) manga-shelf-desktop/3.1.1 Chrome/140.0.7339.80 Electron/44.5.1 Safari/537.36';
    assert.equal(browserUserAgent(`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${tail}`), UA);
    assert.equal(browserUserAgent(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${tail}`),
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');
    assert.equal(browserUserAgent(`Mozilla/5.0 (X11; Linux x86_64) ${tail}`),
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');
});

test('client certificates: none for requests without a page and for the login window, others untouched', () => {
    const app = new EventEmitter();
    const login = { id: 'login' };
    registerClientCertificateGuard(app, (contents) => contents === login);
    const ask = (contents) => {
        const event = { prevented: false, preventDefault() { this.prevented = true; } };
        let answered = false;
        app.emit('select-client-certificate', event, contents, 'https://x/', [{}], () => { answered = true; });
        return { prevented: event.prevented, answered };
    };
    assert.deepEqual(ask(null), { prevented: true, answered: true });
    assert.deepEqual(ask(login), { prevented: true, answered: true });
    assert.deepEqual(ask({ id: 'main' }), { prevented: false, answered: false });
});
