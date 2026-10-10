// Fakes shared by the desktop watch tests: clock, safeStorage, windows, powerMonitor and a Crunchyroll answer table.
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = path.resolve(__dirname, '..', '..');
const crunchyroll = require(path.join(repo, 'core', 'watch', 'crunchyroll.js'));
const { createFlow, FlowError } = require(path.join(repo, 'core', 'watch', 'crunchyrollFlow.js'));
const fixture = (name) => fs.readFileSync(path.join(repo, 'test', 'fixtures', 'crunchyroll', name), 'utf8');

const COOKIE = 'etp-desktop-cookie-0001';
const NEW_LOGIN = 'etp-desktop-login-0002';
const SECRET = { etp_rt: COOKIE, client_id: 'test_client_01', device_id: '11111111-2222-4333-8444-555555555555', account_id: null, saved_at: 1 };

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-watch-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function fakeClock(start = 1_000_000) {
    let now = start;
    let nextId = 1;
    const timers = new Map();
    const add = (fn, ms, every) => {
        const id = nextId++;
        timers.set(id, { fn, at: now + Math.max(0, ms || 0), every });
        return id;
    };
    const clock = {
        now: () => now,
        setTimeout: (fn, ms) => add(fn, ms, null),
        setInterval: (fn, ms) => add(fn, ms, ms),
        clearTimeout: (id) => { timers.delete(id); },
        clearInterval: (id) => { timers.delete(id); },
        async advance(ms) {
            const end = now + ms;
            for (;;) {
                let due = null;
                for (const [id, timer] of timers) if (timer.at <= end && (!due || timer.at < due[1].at)) due = [id, timer];
                if (!due) break;
                const [id, timer] = due;
                now = timer.at;
                if (timer.every) timer.at += timer.every;
                else timers.delete(id);
                timer.fn();
                await flush();
            }
            now = end;
            await flush();
        }
    };
    clock.timers = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval };
    return clock;
}

const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

function fakeSafeStorage({ available = true, backend = 'gnome_libsecret' } = {}) {
    const store = {
        available,
        backend,
        decryptThrows: false,
        encryptThrows: false,
        isEncryptionAvailable: () => store.available,
        getSelectedStorageBackend: () => store.backend,
        encryptString(text) {
            if (store.encryptThrows) throw new Error('encrypt');
            return Buffer.from(`enc:${Buffer.from(text).toString('hex')}`);
        },
        decryptString(buffer) {
            const raw = buffer.toString();
            if (store.decryptThrows || !raw.startsWith('enc:')) throw new Error('decrypt');
            return Buffer.from(raw.slice(4), 'hex').toString();
        }
    };
    return store;
}

function fakeWindow({ visible = false, focused = false, minimized = false } = {}) {
    const win = new EventEmitter();
    let destroyed = false;
    const state = { visible, focused, minimized };
    win.state = state;
    win.webContents = new EventEmitter();
    win.webContents.sent = [];
    win.webContents.send = (channel, ...args) => {
        win.webContents.sent.push(channel);
        if (win.onSend) win.onSend(channel, ...args);
    };
    win.webContents.isDestroyed = () => destroyed;
    win.isDestroyed = () => destroyed;
    const live = () => {
        if (destroyed) throw new Error('Object has been destroyed');
    };
    win.isVisible = () => { live(); return state.visible; };
    win.isMinimized = () => { live(); return state.minimized; };
    win.isFocused = () => { live(); return state.focused; };
    win.show = () => { state.visible = true; state.minimized = false; win.emit('show'); };
    win.hide = () => { state.visible = false; state.focused = false; win.emit('hide'); };
    win.focus = () => { state.focused = true; win.emit('focus'); };
    win.blur = () => { state.focused = false; win.emit('blur'); };
    win.minimize = () => { state.minimized = true; state.focused = false; win.emit('minimize'); };
    win.restore = () => { state.minimized = false; win.emit('restore'); };
    win.destroy = () => {
        if (destroyed) return;
        destroyed = true;
        win.emit('closed');
    };
    return win;
}

function fakePowerMonitor(idle = 'active') {
    const monitor = new EventEmitter();
    monitor.idle = idle;
    monitor.getSystemIdleState = () => monitor.idle;
    return monitor;
}

const answer = (status, text, extra = {}) => ({ status, headers: {}, text, cookies: [], ...extra });

/** Transport stand-in: answers by endpoint, counts requests, can hold the token request until released. */
function fakeTransport() {
    const t = { requests: [], held: null };
    t.answers = {
        token: () => answer(200, fixture('token.json')),
        watch: () => answer(200, fixture('watch-history.json')),
        discover: () => answer(200, fixture('discover-history.json')),
        me: () => answer(200, fixture('me.json'))
    };
    const kindOf = (url) => (url.endsWith('/auth/v1/token') ? 'token' : url.endsWith('/accounts/v1/me') ? 'me' : url.includes('/watch-history') ? 'watch' : 'discover');
    t.hold = (kind) => {
        const gate = { kind };
        gate.reached = new Promise((resolve) => { gate.arrive = resolve; });
        t.held = gate;
        return gate;
    };
    t.send = async (request) => {
        const kind = kindOf(request.url);
        t.requests.push({ kind, request });
        if (t.held && t.held.kind === kind && !t.held.release) {
            const gate = t.held;
            const pending = new Promise((resolve) => { gate.release = (value) => resolve(value || t.answers[kind]()); });
            gate.arrive();
            return pending;
        }
        return t.answers[kind]();
    };
    t.tokenCalls = () => t.requests.filter((r) => r.kind === 'token').length;
    return t;
}

function fakeApiSession() {
    const ses = { closed: 0, cleared: 0 };
    ses.closeAllConnections = async () => { ses.closed += 1; };
    ses.clearStorageData = async () => { ses.cleared += 1; };
    return ses;
}

module.exports = {
    crunchyroll, createFlow, FlowError, COOKIE, NEW_LOGIN, SECRET, answer, fixture,
    tempDir, fakeClock, flush, fakeSafeStorage, fakeWindow, fakePowerMonitor, fakeTransport, fakeApiSession
};
