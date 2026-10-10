const CHANNEL = 'desktop:watch-foreground';
const DEBOUNCE_MS = 2000;
const TICK_MS = 15 * 60 * 1000;
const RESUME_LIMIT_MS = 10 * 60 * 1000;
const ONLINE_WAIT_MS = 10000;
const ONLINE_POLL_MS = 500;
const IDLE_SECONDS = 300;

/** When the page may sync: focus and show of the main window, a 15-minute tick and the wake from sleep, never while idle or locked. */
function createForeground({ powerMonitor, net, platform, timers }) {
    let win = null;
    let unbind = null;
    let debounce = null;
    let pendingResume = null;
    let screenLocked = false;

    const alive = () => Boolean(win) && !win.isDestroyed();
    const visible = () => alive() && win.isVisible() && !win.isMinimized();
    const focused = () => visible() && win.isFocused();
    const idleState = () => {
        try {
            return powerMonitor.getSystemIdleState(IDLE_SECONDS);
        } catch (_) {
            return 'unknown';
        }
    };
    const active = () => !['idle', 'locked'].includes(idleState());

    const signal = () => {
        if (!alive() || !active()) return;
        const contents = win.webContents;
        if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) return;
        contents.send(CHANNEL);
    };

    const cancelDebounce = () => {
        if (debounce) timers.clearTimeout(debounce);
        debounce = null;
    };
    const schedule = () => {
        if (!visible()) return;
        cancelDebounce();
        debounce = timers.setTimeout(() => {
            debounce = null;
            if (visible()) signal();
        }, DEBOUNCE_MS);
    };

    const dropResume = () => {
        if (!pendingResume) return;
        for (const timer of pendingResume.timers) timers.clearTimeout(timer);
        pendingResume = null;
    };
    const advanceResume = () => {
        const pending = pendingResume;
        if (!pending || pending.stage !== 'window' || !focused()) return;
        pending.stage = 'online';
        let polls = 0;
        const poll = () => {
            if (pendingResume !== pending) return;
            let online;
            try { online = net.isOnline(); } catch (_) { online = true; }
            if (online || polls >= ONLINE_WAIT_MS / ONLINE_POLL_MS) {
                dropResume();
                cancelDebounce();
                signal();
                return;
            }
            polls += 1;
            pending.timers.push(timers.setTimeout(poll, ONLINE_POLL_MS));
        };
        poll();
    };
    const onResume = () => {
        dropResume();
        if (platform === 'linux') return;
        const pending = { stage: screenLocked || idleState() === 'locked' ? 'unlock' : 'window', timers: [] };
        pendingResume = pending;
        pending.timers.push(timers.setTimeout(() => { if (pendingResume === pending) dropResume(); }, RESUME_LIMIT_MS));
        advanceResume();
    };

    powerMonitor.on('resume', onResume);
    powerMonitor.on('suspend', dropResume);
    powerMonitor.on('lock-screen', () => { screenLocked = true; });
    powerMonitor.on('unlock-screen', () => {
        screenLocked = false;
        if (pendingResume && pendingResume.stage === 'unlock') {
            pendingResume.stage = 'window';
            advanceResume();
        }
    });
    timers.setInterval(() => {
        if (focused()) signal();
    }, TICK_MS);

    const onShown = () => {
        schedule();
        advanceResume();
    };

    function attach(next) {
        if (unbind) unbind();
        cancelDebounce();
        win = next || null;
        unbind = null;
        if (!win) return;
        const target = win;
        const onGone = () => {
            if (win === target) cancelDebounce();
        };
        const onClosed = () => {
            if (win !== target) return;
            cancelDebounce();
            win = null;
            unbind = null;
        };
        const events = [['focus', onShown], ['show', onShown], ['restore', onShown], ['hide', onGone], ['minimize', onGone], ['closed', onClosed]];
        for (const [name, fn] of events) target.on(name, fn);
        unbind = () => {
            if (target.isDestroyed()) return;
            for (const [name, fn] of events) target.removeListener(name, fn);
        };
    }

    return {
        attach,
        isForeground: visible,
        foregroundNow: () => focused() && active()
    };
}

module.exports = { createForeground, FOREGROUND_CHANNEL: CHANNEL };
