// Control of the embedded Express server of the desktop app (start/stop, serialised runs, setup token, environment).
const crypto = require('crypto');
const path = require('path');
const { serverOrigin, sameServer } = require('../modes');

const SETUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const BUSY_MESSAGE = 'Wiederherstellung/Backup läuft – Betriebsart danach wechseln';

/** Runs the given async tasks one after another, also after a failure. */
function createSerialQueue() {
    let tail = Promise.resolve();
    return (task) => {
        const run = tail.then(task, task);
        tail = run.catch(() => {});
        return run;
    };
}

/** Whether going from the running server to `next` ({ host, port } or null) stops or restarts it. */
const needsRestart = (current, next) => Boolean(current) && !sameServer(current, next);

/**
 * switchRun of main.js: applies a settings change (`change` returns false to skip) in `queue`. A change refused or
 * failing in `apply` is undone; `refresh` then rebuilds state, menu and tray (Electron already flipped the radio item).
 */
function createRunSwitcher({ queue, settings, getOverrides, setOverrides, resolveRun, controller, apply, showBusy, refresh }) {
    return (change, options = {}) => queue(async () => {
        const before = { settings: settings.get(), overrides: getOverrides() };
        const rollback = () => {
            settings.update(before.settings);
            setOverrides(before.overrides);
            refresh();
        };
        if (change() === false) {
            refresh();
            return false;
        }
        const next = resolveRun(settings.get(), getOverrides());
        const jobs = needsRestart(controller.current(), next.server) ? controller.busy() : [];
        if (jobs.length) {
            rollback();
            await showBusy(jobs);
            return false;
        }
        let applied = false;
        try {
            applied = await apply(options);
        } finally {
            if (applied !== true) rollback();
        }
        return applied;
    });
}

/** The "keychain locked" warning: once per session, when the window shows the remote view while the store is locked. */
function createLockedWarning({ isLocked, show }) {
    let shown = false;
    return (view) => {
        if (shown || view !== 'remote' || !isLocked()) return false;
        shown = true;
        show();
        return true;
    };
}

/**
 * Camera, clipboard and fullscreen only for a page of the app itself: app://manga-shelf or the running local server.
 * 'clipboard-read' serves the 'Link einfügen' button, which reads only on tap.
 */
function permissionAllowed({ permission, origin, appOrigin, localOrigin }) {
    if (!['media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(permission)) return false;
    if (!origin || origin === 'null') return false;
    return origin === appOrigin || (Boolean(localOrigin) && origin === localOrigin);
}

/** A setup code in the server's format (XXXX-XXXX-XXXX-XXXX, see routes/auth.js). */
function generateSetupToken(randomInt = crypto.randomInt) {
    const chars = Array.from({ length: 16 }, () => SETUP_ALPHABET[randomInt(SETUP_ALPHABET.length)]);
    return chars.join('').match(/.{4}/g).join('-');
}

/**
 * Environment of the in-process server. db.js reads DATA_DIR when index.js is first loaded, so this runs before;
 * MANGA_SHELF_NO_LISTEN keeps index.js from starting itself (start() below does it).
 */
function serverEnv(env, { dataDir, setupToken }) {
    const next = { ...env, DATA_DIR: dataDir, MANGA_SHELF_NO_LISTEN: '1' };
    if (setupToken) next.SETUP_TOKEN = setupToken;
    delete next.FRONTEND_DIR;
    return next;
}

/**
 * Express in the main process via index.js start()/stop(); a taken port in local mode falls back to a free one.
 * Restart/stop is refused (SERVER_BUSY) while a restore or job runs; stop({ force: true }) is for quitting.
 */
function createServerController({ serverDir, dataDir, setupToken, env = process.env, log = () => {} }) {
    let backend = null;
    let current = null;
    const serial = createSerialQueue();

    const load = () => {
        if (backend) return backend;
        const next = serverEnv(env, { dataDir, setupToken });
        delete env.FRONTEND_DIR;
        Object.assign(env, next);
        backend = require(path.join(serverDir, 'index.js'));
        return backend;
    };

    const serverModule = (...parts) => require(path.join(serverDir, ...parts));

    /** Names of the jobs a restart would break (empty when the server is not loaded). */
    function busy() {
        if (!backend) return [];
        const jobs = [...serverModule('services', 'lifecycle.js').runningJobs()];
        if (serverModule('routes', 'backups.js').isRestoreRunning?.()) jobs.push('Wiederherstellung');
        if (serverModule('services', 'update', 'lock.js').isUpdateRunning?.()) jobs.push('Aktualisierung');
        return [...new Set(jobs)];
    }

    function assertIdle() {
        const jobs = busy();
        if (jobs.length) throw Object.assign(new Error(BUSY_MESSAGE), { code: 'SERVER_BUSY', jobs });
    }

    async function doStart({ host, port, fallbackPort = false, console: withConsole = false }) {
        const api = load();
        if (current) {
            assertIdle();
            await doStop();
        }
        let started;
        try {
            started = await api.start({ host, port, console: withConsole });
        } catch (err) {
            if (!fallbackPort || err.code !== 'EADDRINUSE') throw err;
            log(`Port ${port} ist belegt, ein freier Port wird genutzt`);
            started = await api.start({ host, port: 0, console: withConsole });
        }
        current = { host, port: started.port, url: serverOrigin(started.port, host) };
        return current;
    }

    async function doStop({ force = false } = {}) {
        if (!backend || !current) return;
        if (!force) assertIdle();
        current = null;
        await backend.stop();
    }

    const start = (options) => serial(() => doStart(options));
    const stop = (options) => serial(() => doStop(options));
    const services = (name) => serverModule('services', name);

    /** Snapshot like the console command `backup`; resolves to the console's lines. */
    async function backupNow() {
        if (!current) throw new Error('Der Server läuft nicht');
        const lines = [];
        const result = await services('console.js').runCommand('backup', (line) => lines.push(line), { revealSecrets: false });
        return { ok: result.ok === true, lines };
    }

    async function getJson(pathname) {
        if (!current) return null;
        try {
            const res = await fetch(current.url + pathname, { signal: AbortSignal.timeout(3000) });
            return res.ok ? await res.json() : null;
        } catch (_) {
            return null;
        }
    }

    return {
        start,
        stop,
        busy,
        backupNow,
        current: () => current,
        loaded: () => Boolean(backend),
        needsSetup: async () => Boolean((await getJson('/api/setup/status'))?.needsSetup),
        health: () => getJson('/api/health')
    };
}

module.exports = { createServerController, createSerialQueue, createRunSwitcher, createLockedWarning, needsRestart, permissionAllowed, generateSetupToken, serverEnv, SETUP_ALPHABET, BUSY_MESSAGE };
