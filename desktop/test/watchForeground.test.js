// Covers when the desktop page is told to sync: focus and show of the main window, the 15-minute tick and the wake from sleep.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createForeground } = require('../lib/watchForeground');
const { createWatchService } = require('../lib/watchService');
const { createWatchSecret } = require('../lib/watchSecret');
const { crunchyroll, createFlow, FlowError, SECRET, NEW_LOGIN, tempDir, fakeClock, flush, fakeSafeStorage, fakeWindow, fakePowerMonitor, fakeTransport, fakeApiSession } = require('./watchFakes');

const CHANNEL = 'desktop:watch-foreground';
const MINUTE = 60 * 1000;

function setup(t, { platform = 'darwin', signedIn = true } = {}) {
    const clock = fakeClock();
    const powerMonitor = fakePowerMonitor();
    const net = { online: true, isOnline: () => net.online };
    const foreground = createForeground({ powerMonitor, net, platform, timers: clock.timers });
    const dir = tempDir(t);
    const store = createWatchSecret({ file: path.join(dir, 'watch-secret.json'), safeStorage: fakeSafeStorage(), platform });
    if (signedIn) store.write(SECRET);
    const transport = fakeTransport();
    const service = createWatchService({
        createFlow, FlowError, crunchyroll, secret: store, transport: transport.send, apiSession: fakeApiSession(),
        randomUUID: () => '99999999-8888-4777-8666-555555555555', now: clock.now, isForeground: foreground.isForeground
    });
    const h = { clock, powerMonitor, net, foreground, service, transport, answers: [] };
    h.window = (state) => {
        const win = fakeWindow(state);
        win.onSend = (channel) => {
            if (channel === CHANNEL) h.answers.push(service.sync({ force: false }));
        };
        foreground.attach(win);
        return win;
    };
    h.settle = async () => {
        await flush();
        await Promise.all(h.answers);
    };
    h.tokens = () => transport.tokenCalls();
    return h;
}

test('hidden start (autostart + tray): no signal, no token request', async (t) => {
    const h = setup(t);
    const win = h.window({ visible: false });
    await h.clock.advance(31 * MINUTE);
    await h.settle();
    assert.equal(h.tokens(), 0);
    assert.deepEqual(win.webContents.sent, []);
    assert.equal(h.foreground.foregroundNow(), false);
    assert.equal(h.foreground.isForeground(), false);
});

test('tray-hidden window and a resume: none', async (t) => {
    const h = setup(t);
    h.window({ visible: false });
    h.powerMonitor.emit('resume');
    await h.clock.advance(11 * MINUTE);
    await h.settle();
    assert.equal(h.tokens(), 0);
});

test('show then focus: one signal (debounced 2 s), one token request', async (t) => {
    const h = setup(t);
    const win = h.window({ visible: false });
    win.show();
    await h.clock.advance(1000);
    win.focus();
    await h.clock.advance(1999);
    assert.deepEqual(win.webContents.sent, []);
    await h.clock.advance(1);
    await h.settle();
    assert.deepEqual(win.webContents.sent, [CHANNEL]);
    assert.equal(h.tokens(), 1);
});

test('a minimized window: focus sends nothing and sync answers background', async (t) => {
    const h = setup(t);
    const win = h.window({ visible: true, focused: true });
    win.minimize();
    win.emit('focus');
    await h.clock.advance(3000);
    assert.deepEqual(win.webContents.sent, []);
    assert.deepEqual(await h.service.sync({}), { ok: false, code: 'background' });
    assert.equal(h.tokens(), 0);
});

test('a tick while locked or idle: none; two ticks while focused and active: two', async (t) => {
    const h = setup(t);
    const win = h.window({ visible: true, focused: true });
    h.powerMonitor.idle = 'locked';
    await h.clock.advance(15 * MINUTE);
    h.powerMonitor.idle = 'idle';
    await h.clock.advance(15 * MINUTE);
    await h.settle();
    assert.equal(h.tokens(), 0);
    assert.deepEqual(win.webContents.sent, []);
    h.powerMonitor.idle = 'unknown';
    await h.clock.advance(15 * MINUTE);
    h.powerMonitor.idle = 'active';
    await h.clock.advance(15 * MINUTE);
    await h.settle();
    assert.equal(h.tokens(), 2);
    assert.deepEqual(win.webContents.sent, [CHANNEL, CHANNEL]);
});

test('resume while locked waits for unlock-screen, then sends one signal', async (t) => {
    const h = setup(t);
    const win = h.window({ visible: true, focused: true });
    h.powerMonitor.idle = 'locked';
    h.powerMonitor.emit('resume');
    await h.clock.advance(MINUTE);
    assert.deepEqual(win.webContents.sent, []);
    h.powerMonitor.idle = 'active';
    h.powerMonitor.emit('unlock-screen');
    await h.settle();
    assert.deepEqual(win.webContents.sent, [CHANNEL]);
    assert.equal(h.tokens(), 1);
});

test('a lock-screen since the last unlock also makes the resume wait', async (t) => {
    const h = setup(t);
    const win = h.window({ visible: true, focused: true });
    h.powerMonitor.emit('lock-screen');
    h.powerMonitor.emit('resume');
    await h.clock.advance(MINUTE);
    assert.deepEqual(win.webContents.sent, []);
    h.powerMonitor.emit('unlock-screen');
    await h.settle();
    assert.deepEqual(win.webContents.sent, [CHANNEL]);
});

test('resume without a lock while focused: one signal, after waiting up to 10 s for the network', async (t) => {
    const h = setup(t);
    const win = h.window({ visible: true, focused: true });
    h.powerMonitor.emit('resume');
    await h.settle();
    assert.deepEqual(win.webContents.sent, [CHANNEL]);
    assert.equal(h.tokens(), 1);

    const offline = setup(t);
    const other = offline.window({ visible: true, focused: true });
    offline.net.online = false;
    offline.powerMonitor.emit('resume');
    await offline.clock.advance(9000);
    assert.deepEqual(other.webContents.sent, []);
    await offline.clock.advance(1000);
    assert.deepEqual(other.webContents.sent, [CHANNEL]);
});

test('resume while the window is in the background waits until it is visible and focused', async (t) => {
    const h = setup(t);
    const win = h.window({ visible: true, focused: false });
    h.powerMonitor.emit('resume');
    await h.clock.advance(MINUTE);
    assert.deepEqual(win.webContents.sent, []);
    win.focus();
    await h.clock.advance(3000);
    await h.settle();
    assert.deepEqual(win.webContents.sent, [CHANNEL]);
    assert.equal(h.tokens(), 1);
});

test('resume with no unlock for 10 minutes, or a suspend meanwhile: none', async (t) => {
    const h = setup(t);
    const win = h.window({ visible: true, focused: true });
    h.powerMonitor.idle = 'locked';
    h.powerMonitor.emit('resume');
    await h.clock.advance(10 * MINUTE);
    h.powerMonitor.idle = 'active';
    h.powerMonitor.emit('unlock-screen');
    await h.settle();
    assert.deepEqual(win.webContents.sent, []);

    h.powerMonitor.idle = 'locked';
    h.powerMonitor.emit('resume');
    h.powerMonitor.emit('suspend');
    h.powerMonitor.idle = 'active';
    h.powerMonitor.emit('unlock-screen');
    await h.settle();
    assert.deepEqual(win.webContents.sent, []);
    assert.equal(h.tokens(), 0);
});

test('Linux: resume sends nothing', async (t) => {
    const h = setup(t, { platform: 'linux' });
    const win = h.window({ visible: true, focused: true });
    h.powerMonitor.emit('resume');
    await h.clock.advance(MINUTE);
    await h.settle();
    assert.deepEqual(win.webContents.sent, []);
});

test('foreground-now: only visible, not minimized, focused and not idle or locked', async (t) => {
    const h = setup(t);
    assert.equal(h.foreground.foregroundNow(), false);
    const win = h.window({ visible: true, focused: true });
    assert.equal(h.foreground.foregroundNow(), true);
    h.powerMonitor.idle = 'locked';
    assert.equal(h.foreground.foregroundNow(), false);
    h.powerMonitor.idle = 'idle';
    assert.equal(h.foreground.foregroundNow(), false);
    h.powerMonitor.idle = 'unknown';
    assert.equal(h.foreground.foregroundNow(), true);
    win.blur();
    assert.equal(h.foreground.foregroundNow(), false);
    assert.equal(h.foreground.isForeground(), true);
});

test('visible start, the user signs in 5 s after show: one token request', async (t) => {
    const h = setup(t, { signedIn: false });
    const win = h.window({ visible: false });
    win.show();
    await h.clock.advance(5000);
    await h.settle();
    assert.equal(h.tokens(), 0);
    await h.service.connect({ etpRt: NEW_LOGIN, scriptResult: null, isCancelled: () => false });
    win.focus();
    await h.clock.advance(3000);
    await h.settle();
    assert.equal(h.tokens(), 1);
});

test('close, then a new window attached, then focus: one signal on the new webContents', async (t) => {
    const h = setup(t);
    const first = h.window({ visible: true, focused: false });
    first.destroy();
    const second = h.window({ visible: true, focused: false });
    second.focus();
    first.emit('focus');
    await h.clock.advance(3000);
    await h.settle();
    assert.deepEqual(second.webContents.sent, [CHANNEL]);
    assert.deepEqual(first.webContents.sent, []);
    assert.equal(h.tokens(), 1);
});

test('a tick after the window was destroyed: no throw, no signal', async (t) => {
    const h = setup(t);
    const win = h.window({ visible: true, focused: true });
    win.isDestroyed = () => true;
    await h.clock.advance(15 * MINUTE);
    assert.deepEqual(win.webContents.sent, []);
    assert.equal(h.foreground.isForeground(), false);
    assert.equal(h.foreground.foregroundNow(), false);
});
