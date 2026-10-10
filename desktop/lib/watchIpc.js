const REFUSED = Object.freeze({
    status: Object.freeze({ ok: true, available: false, reason: 'unreadable', connected: false }),
    login: Object.freeze({ ok: false, code: 'failed' }),
    sync: Object.freeze({ ok: false, code: 'network' }),
    logout: Object.freeze({ ok: true }),
    prefs: Object.freeze({ ok: false, code: 'not_allowed' })
});

/** The desktop:watch-* channels; every one answers only the main window's own page. */
function registerWatchIpc({ ipcMain, isWatchSender, service, login, prefs, foreground }) {
    const allowed = (event) => {
        try {
            return isWatchSender(event) === true;
        } catch (_) {
            return false;
        }
    };
    const handle = (channel, refused, fn) => {
        ipcMain.handle(channel, async (event, ...args) => {
            if (!allowed(event)) return refused;
            try {
                return await fn(...args);
            } catch (_) {
                return refused;
            }
        });
    };

    ipcMain.on('desktop:watch-allowed', (event) => {
        event.returnValue = allowed(event);
    });
    handle('desktop:watch-status', REFUSED.status, () => service.status());
    handle('desktop:watch-login', REFUSED.login, () => login.login());
    handle('desktop:watch-sync', REFUSED.sync, (options) => service.sync({ force: Boolean(options && options.force) }));
    handle('desktop:watch-logout', REFUSED.logout, () => service.logout());
    handle('desktop:watch-prefs-get', REFUSED.prefs, (key) => prefs.get(key));
    handle('desktop:watch-prefs-set', REFUSED.prefs, (key, value) => prefs.set(key, value));
    handle('desktop:watch-prefs-remove', REFUSED.prefs, (key) => prefs.remove(key));
    handle('desktop:watch-foreground-now', false, () => foreground.foregroundNow() === true);
}

module.exports = { registerWatchIpc, REFUSED };
