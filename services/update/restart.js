const stateFile = require('./state');
const swap = require('./swap');
const lock = require('./lock');
const download = require('./download');
const { updateError } = require('./errors');
const { EXIT_RESTART } = require('./constants');
const log = require('../../utils/logger').child('update');

const SHUTDOWN_DEADLINE_MS = 20000;
let handler = null;
let restarting = null;

/** The entry registers its graceful shutdown (resolves once server and database are closed); returns an unregister function. */
function registerRestart(fn) {
    if (typeof fn !== 'function') throw new TypeError('restart handler must be a function');
    handler = fn;
    return () => {
        if (handler === fn) handler = null;
    };
}

const hasRestartHandler = () => handler !== null;
const exitCodeFor = (state) => (state && state.restart === 'manual' ? 0 : EXIT_RESTART);

/** Journal 'swapping', the renames, journal 'swapped'. Returns the exit code; a failed switch is undone. */
function performSwap({ dataDir, codeDir, execPath = process.execPath, platform = process.platform }) {
    const ctx = { codeDir, execPath, platform };
    const state = stateFile.readState(dataDir);
    if (!state || state.phase !== 'ready-to-swap') {
        log.error('[Update] Kein vorbereitetes Update gefunden – Neustart ohne Wechsel');
        return state && state.restart === 'manual' ? 1 : EXIT_RESTART;
    }
    try {
        swap.checkReady(state, ctx);
    } catch (err) {
        log.error('[Update] Neue Version nicht vollständig vorbereitet – kein Wechsel:', err);
        swap.cleanupCode(state, ctx);
        stateFile.writeState(dataDir, { ...state, phase: 'failed', error: 'UPDATE_FAILED', finished_at: new Date().toISOString() });
        return exitCodeFor(state) || 1;
    }
    let swapping;
    try {
        swapping = stateFile.writeState(dataDir, { ...state, phase: 'swapping', pid: process.pid });
        swap.swapForward(swapping, ctx);
    } catch (err) {
        log.error('[Update] Wechsel fehlgeschlagen, die bisherige Version bleibt:', err);
        try {
            const current = swapping || state;
            swap.revertCode(current, ctx);
            swap.cleanupCode(current, ctx);
            stateFile.writeState(dataDir, { ...current, phase: 'failed', error: 'UPDATE_FAILED', finished_at: new Date().toISOString() });
        } catch (e) {
            log.error('[Update] Zurücknehmen fehlgeschlagen; der nächste Start räumt auf:', e);
        }
        return state.restart === 'manual' ? 1 : EXIT_RESTART;
    }
    const manual = swapping.restart === 'manual';
    stateFile.writeState(dataDir, { ...swapping, phase: 'swapped', pending_start: manual, swapped_at: new Date().toISOString() });
    if (manual) log.warn(`[Update] v${swapping.to} installiert – Server bitte neu starten`);
    else log.warn(`[Update] Neustart für Update auf v${swapping.to} (Exit 75 beabsichtigt)`);
    return exitCodeFor(swapping);
}

/** Shutdown through the registered handler (with a deadline), then the switch, then exit. */
function requestRestart({ dataDir, codeDir, execPath = process.execPath, platform = process.platform, exit = (code) => process.exit(code), deadlineMs = SHUTDOWN_DEADLINE_MS } = {}) {
    if (!handler) throw updateError('NOT_INSTALLABLE', null, { reason: 'no_restart' });
    if (restarting) return restarting;
    lock.setPhase('restarting');
    download.abortAll();
    const shutdown = handler;
    let done = false;
    let timer = null;
    const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        let code;
        try {
            code = performSwap({ dataDir, codeDir, execPath, platform });
        } catch (err) {
            log.error('[Update] Wechsel abgebrochen:', err);
            code = 1;
        }
        exit(code);
    };
    timer = setTimeout(() => {
        log.warn('[Update] Herunterfahren dauert zu lange – Wechsel jetzt');
        finish();
    }, deadlineMs);
    restarting = Promise.resolve()
        .then(() => shutdown())
        .catch((err) => log.error('[Update] Herunterfahren fehlgeschlagen:', err))
        .then(finish);
    return restarting;
}

/** For tests. */
function reset() {
    handler = null;
    restarting = null;
}

module.exports = { registerRestart, hasRestartHandler, requestRestart, performSwap, reset, SHUTDOWN_DEADLINE_MS };
