const crypto = require('crypto');

const TOKEN_URL = 'https://www.crunchyroll.com/auth/v1/token';
const SCRIPT_TIMEOUT_MS = 3000;
const CHECK_INTERVAL_MS = 1000;
const TOKEN_COOKIE_DOMAINS = ['www.crunchyroll.com', '.www.crunchyroll.com', 'crunchyroll.com', '.crunchyroll.com'];

/** A plain Chrome user agent built from Electron's fallback (its platform and Chrome major), without app or Electron tokens. */
function browserUserAgent(fallback) {
    const text = String(fallback || '');
    const platform = /\(([^)]+)\)/.exec(text);
    const chrome = /\bChrome\/(\d+)/.exec(text);
    if (!platform || !chrome) return text;
    return `Mozilla/5.0 (${platform[1]}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome[1]}.0.0.0 Safari/537.36`;
}

/** Client certificate requests without a page or from the login window are answered with no certificate. */
function registerClientCertificateGuard(app, isLoginContents) {
    app.on('select-client-certificate', (event, webContents, _url, _list, callback) => {
        if (webContents !== null && !isLoginContents(webContents)) return;
        event.preventDefault();
        callback();
    });
}

const parseUrl = (raw) => {
    try {
        return new URL(String(raw));
    } catch (_) {
        return null;
    }
};
const crunchyrollHost = (host) => host === 'crunchyroll.com' || host.endsWith('.crunchyroll.com');
const allowedUrl = (raw) => {
    const url = parseUrl(raw);
    return Boolean(url) && url.protocol === 'https:' && crunchyrollHost(url.hostname);
};

/** The Crunchyroll sign-in window of the desktop: own throwaway session, only crunchyroll.com, the cookie goes straight to the store. */
function createWatchLogin({ BrowserWindow, session, dialog, app, getMainWindow, service, crunchyroll, userAgent }) {
    let current = null;
    const loginUrl = crunchyroll.LOGIN_OPTIONS.url;
    const notLogin = crunchyroll.LOGIN_OPTIONS.doneWhen.pathNotContaining;

    const doneUrl = (raw) => {
        const url = parseUrl(raw);
        return Boolean(url) && url.protocol === 'https:' && crunchyrollHost(url.hostname) && !url.pathname.toLowerCase().includes(notLogin);
    };

    async function open(run) {
        const mainWindow = getMainWindow();
        const status = await service.status();
        if (!status.available) return status.reason;
        if (run.settled) return 'cancelled';

        const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
        const ses = session.fromPartition(`crunchyroll-login-${crypto.randomBytes(12).toString('hex')}`, { cache: false });
        ses.setUserAgent(userAgent);
        ses.on('will-download', (event) => event.preventDefault());
        ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        ses.setPermissionCheckHandler(() => false);
        ses.setDevicePermissionHandler(() => false);

        const win = new BrowserWindow({
            parent: parent || undefined,
            webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, devTools: !app.isPackaged, safeDialogs: true }
        });
        const contents = win.webContents;
        run.contents = contents;
        const { finish } = run;
        let interval = null;
        let checking = false;
        let dialogOpen = false;
        const mainListeners = [];
        const gone = () => run.settled || win.isDestroyed();

        const setTitle = () => {
            if (gone()) return;
            const url = parseUrl(contents.getURL() || loginUrl);
            win.setTitle(`Bei Crunchyroll anmelden – ${url ? url.hostname : ''}`);
        };
        const refuse = (raw) => {
            if (dialogOpen || gone()) return;
            const url = parseUrl(raw);
            dialogOpen = true;
            Promise.resolve()
                .then(() => dialog.showMessageBox(win, { type: 'info', message: 'Hier werden nur Crunchyroll-Seiten geöffnet', detail: url ? url.hostname : '', signal: run.dialogAbort.signal }))
                .catch(() => {})
                .finally(() => { dialogOpen = false; });
        };
        const readScript = () => {
            let timer = null;
            const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), SCRIPT_TIMEOUT_MS); });
            const script = Promise.resolve()
                .then(() => contents.executeJavaScript(crunchyroll.LOGIN_OPTIONS.readScript))
                .then((value) => (typeof value === 'string' ? value : null), () => null);
            return Promise.race([script, timeout]).finally(() => clearTimeout(timer));
        };
        const check = async () => {
            if (checking || gone()) return;
            checking = true;
            try {
                if (!doneUrl(contents.getURL())) return;
                const cookies = await ses.cookies.get({ url: TOKEN_URL, name: 'etp_rt' });
                if (gone()) return;
                const cookie = (Array.isArray(cookies) ? cookies : []).find((c) => c && c.name === 'etp_rt'
                    && TOKEN_COOKIE_DOMAINS.includes(String(c.domain || '').toLowerCase())
                    && typeof c.value === 'string' && crunchyroll.COOKIE_RE.test(c.value));
                if (!cookie) return;
                let scriptResult = await readScript();
                if (gone()) return;
                if (!doneUrl(contents.getURL())) scriptResult = null;
                try {
                    await service.connect({ etpRt: cookie.value, scriptResult, isCancelled: () => run.settled });
                } catch (err) {
                    finish(err && err.code === 'cancelled' ? 'cancelled' : 'failed');
                    return;
                }
                finish('ok');
            } catch (_) {
                finish('failed');
            } finally {
                checking = false;
            }
        };

        try {
            win.on('close', () => finish('cancelled'));
            win.on('closed', () => finish('cancelled'));
            win.on('page-title-updated', (event) => event.preventDefault());
            win.setMenu(null);
            contents.on('select-bluetooth-device', (event, _devices, callback) => {
                event.preventDefault();
                callback('');
            });
            contents.on('will-prevent-unload', (event) => event.preventDefault());
            contents.on('before-input-event', (event, input) => {
                if (input && input.type === 'keyDown' && (input.control || input.meta) && String(input.key).toLowerCase() === 'w') {
                    event.preventDefault();
                    finish('cancelled');
                }
            });
            contents.on('render-process-gone', () => finish('failed'));
            contents.on('will-navigate', (event, url) => {
                const target = (event && event.url) || url;
                if (allowedUrl(target)) return;
                event.preventDefault();
                refuse(target);
            });
            contents.on('will-redirect', (details) => {
                if (!details.isMainFrame || allowedUrl(details.url)) return;
                details.preventDefault();
                refuse(details.url);
            });
            contents.setWindowOpenHandler(({ url }) => {
                if (!allowedUrl(url)) refuse(url);
                else if (!gone()) win.loadURL(url, { userAgent }).catch(() => {});
                return { action: 'deny' };
            });
            const onNavigated = () => {
                setTitle();
                check();
            };
            contents.on('did-navigate', onNavigated);
            contents.on('did-navigate-in-page', onNavigated);
            if (parent) {
                for (const name of ['hide', 'minimize', 'closed']) {
                    const fn = () => finish('cancelled');
                    parent.on(name, fn);
                    mainListeners.push([name, fn]);
                }
            }
            interval = setInterval(check, CHECK_INTERVAL_MS);
            setTitle();
            win.loadURL(loginUrl, { userAgent }).catch(() => {});
            return await run.outcome;
        } finally {
            finish('cancelled');
            clearInterval(interval);
            if (parent && !parent.isDestroyed()) for (const [name, fn] of mainListeners) parent.removeListener(name, fn);
            for (const step of [() => ses.clearStorageData(), () => ses.clearCache(), () => ses.clearAuthCache()]) {
                await Promise.resolve().then(step).catch(() => {});
            }
            if (!win.isDestroyed()) win.destroy();
        }
    }

    async function login() {
        if (current) return { ok: false, code: 'busy' };
        let resolveOutcome = null;
        const run = { settled: false, contents: null, dialogAbort: new AbortController() };
        run.outcome = new Promise((resolve) => { resolveOutcome = resolve; });
        run.finish = (result) => {
            if (run.settled) return;
            run.settled = true;
            run.dialogAbort.abort();
            resolveOutcome(result);
        };
        current = run;
        try {
            const result = await open(run);
            return result === 'ok' ? { ok: true } : { ok: false, code: result };
        } catch (_) {
            return { ok: false, code: 'failed' };
        } finally {
            if (current === run) current = null;
        }
    }

    const isLoginContents = (contents) => Boolean(current && current.contents && contents === current.contents);

    function finishPending(outcome) {
        if (current) current.finish(outcome);
    }

    return { login, isLoginContents, finishPending };
}

module.exports = { createWatchLogin, browserUserAgent, registerClientCertificateGuard };
