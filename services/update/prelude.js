const fs = require('fs');
const path = require('path');
const stateFile = require('./state');
const swap = require('./swap');
const { CONFIRM_AFTER_MS, EXIT_RESTART, EXIT_ROLLBACK_PENDING } = require('./constants');

const ROLLED_BACK_LINE = '[Update] vorherige Version wiederhergestellt – Server im Panel starten';
const COUNTED_PHASES = new Set(['swapped', 'started']);

const ctx = {
    ran: false,
    result: null,
    dataDir: null,
    codeDir: null,
    execPath: null,
    platform: process.platform,
    version: null,
    versionFromTree: false,
    server: true,
    armed: false,
    started: false,
    startedAt: 0,
    confirmAfterMs: CONFIRM_AFTER_MS,
    listenFailed: false,
    guard: false,
    confirmTimer: null,
    exit: (code) => process.exit(code),
    out: (line) => process.stderr.write(line + '\n')
};

const threshold = (state) => (state.mode === 'pterodactyl' ? 1 : 2);
const now = () => new Date().toISOString();

function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

function readVersion(codeDir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(codeDir, 'package.json'), 'utf8')).version || null;
    } catch (e) {
        return null;
    }
}

function write(state, patch) {
    return stateFile.writeState(ctx.dataDir, { ...state, ...patch });
}

const swapCtx = () => ({ codeDir: ctx.codeDir, execPath: ctx.execPath, platform: ctx.platform });

function foreignBinary(state) {
    return state.mode === 'sea-user' && (typeof state.exec_path !== 'string' || path.resolve(state.exec_path) !== path.resolve(ctx.execPath));
}

const keptDatabaseName = (state) => `manga.db.v${state.to}-${now().replace(/[:.]/g, '-')}`;

function rollback(state, reason) {
    let journal = state;
    if (journal.phase !== 'rolling_back') {
        swap.checkRollback(journal, ctx.dataDir, swapCtx());
        journal = write(journal, { phase: 'rolling_back', error: reason, pid: process.pid, rollback_at: now() });
    }
    const keepAs = journal.started_at ? keptDatabaseName(journal) : null;
    if (swap.restoreDatabase(journal, ctx.dataDir, { keepAs })) {
        journal = write(journal, { db_restored: true, ...(keepAs ? { db_kept: keepAs } : {}) });
        if (keepAs) ctx.out(`[Update] Datenbank von v${journal.to} aufbewahrt als ${keepAs}`);
    }
    swap.revertCode(journal, swapCtx());
    swap.cleanupCode(journal, swapCtx());
    write(journal, { phase: 'rolled_back', db_restored: journal.db_restored === true, finished_at: now() });
    ctx.out(journal.mode === 'pterodactyl' ? ROLLED_BACK_LINE : `[Update] vorherige Version v${journal.from} wiederhergestellt`);
}

function rollbackFailed(state, err) {
    const current = stateFile.readState(ctx.dataDir);
    if (current && current.phase === 'rolling_back') {
        ctx.out(`[Update] Zurücksetzen auf v${state.from} unterbrochen: ${err.message} – der nächste Start setzt es fort`);
        try {
            write(current, { rollback_error: String(err.message).slice(0, 500) });
        } catch (e) {}
        ctx.exit(EXIT_ROLLBACK_PENDING);
        return { action: 'rollback_pending', error: err.message };
    }
    ctx.out(`[Update] Zurücksetzen auf v${state.from} nicht möglich: ${err.message}`);
    write(state, { phase: 'failed', error: 'ROLLBACK_FAILED', finished_at: now() });
    return { action: 'rollback_failed', error: err.message };
}

function rollbackAndExit(state, reason) {
    try {
        rollback(state, reason);
    } catch (err) {
        return rollbackFailed(state, err);
    }
    ctx.exit(EXIT_RESTART);
    return { action: 'rolled_back', reason };
}

function cleanStop(code) {
    return ctx.started && (code === 0 || Date.now() - ctx.startedAt >= ctx.confirmAfterMs);
}

function onExit(code) {
    if (!ctx.armed || ctx.listenFailed) return;
    const state = stateFile.readState(ctx.dataDir);
    if (!state || !COUNTED_PHASES.has(state.phase) || state.to !== ctx.version) return;
    try {
        if (cleanStop(code)) {
            if (state.attempts > 0) write(state, { attempts: state.attempts - 1 });
            return;
        }
        if (state.attempts < threshold(state)) {
            ctx.out(`[Update] Start von v${state.to} fehlgeschlagen (Versuch ${state.attempts})`);
            return;
        }
        rollback(state, 'START_FAILED');
    } catch (err) {
        ctx.out(`[Update] Zurücksetzen beim nächsten Start: ${err.message}`);
    }
}

function arm() {
    ctx.armed = true;
    if (!ctx.guard) {
        ctx.guard = true;
        process.on('exit', onExit);
    }
}

function count(state) {
    if (state.attempts >= threshold(state)) return rollbackAndExit(state, 'START_FAILED');
    const next = write(state, { attempts: state.attempts + 1, pending_start: false, last_attempt_at: now() });
    arm();
    return { action: 'counted', attempts: next.attempts };
}

function handleSwapped(state) {
    if (foreignBinary(state)) return { action: 'none', phase: state.phase };
    if (ctx.version !== state.to) {
        if (ctx.version === state.from && !swap.hasJournaledPrevious(state, swapCtx())) {
            swap.cleanupCode(state, swapCtx());
            write(state, { phase: 'failed', error: 'VERSION_MISMATCH', finished_at: now() });
            return { action: 'version_mismatch' };
        }
        return rollbackAndExit(state, 'VERSION_MISMATCH');
    }
    return count(state);
}

function handleStarted(state) {
    if (foreignBinary(state) || ctx.version !== state.to) return { action: 'none', phase: state.phase };
    return { ...count(state), phase: state.phase };
}

function recover(state) {
    const how = swap.recoverJournal(state, swapCtx());
    if (how === 'reverted') {
        swap.cleanupCode(state, swapCtx());
        write(state, { phase: 'failed', error: 'UPDATE_INTERRUPTED', finished_at: now() });
        return { action: 'reverted' };
    }
    return { action: 'completed', state: write(state, { phase: 'swapped' }) };
}

function inspect() {
    const state = stateFile.readState(ctx.dataDir);
    if (!state) return { action: 'none' };
    if (foreignBinary(state)) return { action: 'none', phase: state.phase };
    const owned = pidAlive(state.pid);
    if (!ctx.server) {
        if (state.phase !== 'swapping' || owned) return { action: 'none', phase: state.phase };
        const { action } = recover(state);
        return { action };
    }
    if (state.phase === 'rolling_back') {
        if (owned) return { action: 'none', phase: state.phase };
        return { ...rollbackAndExit(state, state.error || 'START_FAILED'), resumed: true };
    }
    if (state.phase === 'staged' || state.phase === 'ready-to-swap') {
        if (owned) return { action: 'none', phase: state.phase };
        swap.cleanupCode(state, swapCtx());
        write(state, { phase: 'failed', error: 'UPDATE_INTERRUPTED', finished_at: now() });
        return { action: 'interrupted' };
    }
    if (state.phase === 'swapping') {
        const recovered = recover(state);
        if (recovered.action === 'reverted') return recovered;
        if (ctx.codeDir && state.mode === 'pterodactyl' && ctx.versionFromTree) ctx.version = readVersion(ctx.codeDir);
        return { ...handleSwapped(recovered.state), recovered: true };
    }
    if (state.phase === 'swapped') return handleSwapped(state);
    if (state.phase === 'started') return handleStarted(state);
    return { action: 'none', phase: state.phase };
}

/** Runs once per process before any other require; returns { action, ... }. */
function run({ dataDir, codeDir = null, version = null, server = true, execPath = process.execPath, exit, out, platform } = {}) {
    if (ctx.ran) return ctx.result;
    ctx.ran = true;
    ctx.dataDir = dataDir ? path.resolve(dataDir) : null;
    ctx.codeDir = codeDir ? path.resolve(codeDir) : null;
    ctx.execPath = execPath;
    ctx.server = server !== false;
    ctx.versionFromTree = !version;
    ctx.version = version || (ctx.codeDir ? readVersion(ctx.codeDir) : null);
    if (exit) ctx.exit = exit;
    if (out) ctx.out = out;
    if (platform) ctx.platform = platform;
    let result = { action: 'none' };
    if (ctx.dataDir) {
        try {
            result = inspect();
        } catch (err) {
            ctx.out(`[Update] Prüfung beim Start fehlgeschlagen: ${err.message}`);
            result = { action: 'error', error: err.message };
        }
    }
    ctx.result = result;
    return result;
}

/** After a refused listen: EADDRINUSE/EACCES are not the new version's fault, so the attempt does not count. */
function markListenFailed(err) {
    if (!err || (err.code !== 'EADDRINUSE' && err.code !== 'EACCES')) return false;
    ctx.listenFailed = true;
    const state = ctx.dataDir && stateFile.readState(ctx.dataDir);
    if (ctx.armed && state && COUNTED_PHASES.has(state.phase) && state.attempts > 0) write(state, { attempts: state.attempts - 1 });
    return true;
}

/** Removes the previous code, the update folders and the staging and ends the hold on the backup. */
function confirm() {
    if (ctx.confirmTimer) {
        clearTimeout(ctx.confirmTimer);
        ctx.confirmTimer = null;
    }
    const state = ctx.dataDir && stateFile.readState(ctx.dataDir);
    if (!state || state.phase !== 'started' || state.to !== ctx.version) return false;
    swap.cleanupCode(state, swapCtx());
    const staging = path.join(ctx.dataDir, 'temp', 'update');
    const startedAt = Date.now() - process.uptime() * 1000;
    try {
        const st = fs.lstatSync(staging);
        if (st.isDirectory() && !st.isSymbolicLink()) {
            for (const name of fs.readdirSync(staging)) {
                const dir = path.join(staging, name);
                if (fs.lstatSync(dir).mtimeMs < startedAt) fs.rmSync(dir, { recursive: true, force: true });
            }
        }
    } catch (e) {}
    write(state, { phase: 'confirmed', finished_at: now() });
    return true;
}

/** Called once the server listens; a crash before confirm() (after `confirmAfterMs`) still counts against the new version. */
function markStarted({ confirmAfterMs = CONFIRM_AFTER_MS } = {}) {
    ctx.started = true;
    ctx.startedAt = Date.now();
    ctx.confirmAfterMs = confirmAfterMs;
    let state = ctx.dataDir && stateFile.readState(ctx.dataDir);
    if (!state || foreignBinary(state) || state.to !== ctx.version) return false;
    if (state.phase === 'swapped') {
        state = write(state, { phase: 'started', started_at: now(), attempts: ctx.armed ? 1 : 0, pending_start: false });
    }
    if (state.phase !== 'started') return false;
    if (!ctx.confirmTimer) {
        ctx.confirmTimer = setTimeout(confirm, confirmAfterMs);
        ctx.confirmTimer.unref();
    }
    return true;
}

/** The data folder as utils/config.js resolves it: DATA_DIR from the environment or <cwd>/.env, else <codeDir>/data. */
function resolveDataDir({ codeDir, env = process.env, cwd = process.cwd() } = {}) {
    let raw = env.DATA_DIR;
    if (raw === undefined) {
        try {
            const text = fs.readFileSync(path.join(cwd, '.env'), 'utf8');
            const m = /^[ \t]*(?:export[ \t]+)?DATA_DIR[ \t]*=[ \t]*(.*)$/m.exec(text);
            if (m) raw = m[1].replace(/[ \t]+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
        } catch (e) {}
    }
    return raw && String(raw).trim() ? path.resolve(String(raw).trim()) : path.join(codeDir, 'data');
}

/** Backup file the running update still needs (keep it out of pruning and DELETE), or null. */
function heldBackup() {
    return ctx.dataDir ? stateFile.heldBackup(ctx.dataDir) : null;
}

/** The result of run() (null before it ran). */
const lastRun = () => ctx.result;

module.exports = { run, markStarted, markListenFailed, confirm, heldBackup, lastRun, resolveDataDir, ROLLED_BACK_LINE };
