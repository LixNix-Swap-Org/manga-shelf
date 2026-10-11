const fs = require('fs');
const path = require('path');
const stateFile = require('./state');
const swap = require('./swap');
const dbRecovery = require('./dbRecovery');
const pkg = require('../../package.json');
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

const defaultIsDbOpen = () => require('../../db').isDbOpen();

const replacesDatabase = (state) => Boolean(state && state.downgrade && state.downgrade.db && !state.downgrade.db.replaced_at);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function failWithoutSwitch(dataDir, state, ctx, text) {
    log.error(text);
    swap.cleanupCode(state, ctx);
    stateFile.writeState(dataDir, { ...state, phase: 'failed', error: 'UPDATE_FAILED', finished_at: new Date().toISOString() });
    return state.restart === 'manual' ? 1 : EXIT_RESTART;
}

function syncFresh(dataDir, state) {
    const backups = path.join(dataDir, 'backups');
    if (state.backup) {
        dbRecovery.fsyncFile(path.join(backups, state.backup.file));
        dbRecovery.fsyncFile(path.join(backups, state.backup.file.replace(/\.zip$/, '.json')));
    }
    stateFile.fsyncDir(backups);
    stateFile.fsyncDir(dataDir);
}

function replaceDatabase(dataDir, journal, progress) {
    const plan = journal.downgrade.db;
    const dbFile = path.join(dataDir, 'manga.db');
    const staged = dbFile + '.restore-tmp';
    const schema = dbRecovery.stageBackup(path.join(dataDir, 'backups', plan.source.file), plan.source.sha256, staged);
    if (schema !== plan.schema) {
        try { fs.unlinkSync(staged); } catch (e) {}
        throw new Error(`Backup hat Schema v${schema}, erwartet v${plan.schema}`);
    }
    dbRecovery.endSessions(staged);
    const kept = `manga.db.v${journal.from}-${stamp()}`;
    dbRecovery.keepCopy(dbFile, path.join(dataDir, kept));
    progress.kept = kept;
    syncFresh(dataDir, journal);
    let state = journal;
    dbRecovery.installDatabase(dataDir, staged, schema, () => {
        state = stateFile.writeState(dataDir, { ...journal, downgrade: { ...journal.downgrade, db: { ...plan, kept } } });
        progress.moved = true;
    });
    state = stateFile.writeState(dataDir, { ...state, downgrade: { ...state.downgrade, db: { ...state.downgrade.db, replaced_at: new Date().toISOString() } } });
    log.warn(`[Update] Datenbank für v${journal.to} eingesetzt; die bisherige liegt als ${kept} im Datenordner`);
    return state;
}

function dropUnusedCopies(dataDir, progress) {
    const files = [path.join(dataDir, 'manga.db.restore-tmp')];
    if (progress.kept) files.push(path.join(dataDir, progress.kept), path.join(dataDir, progress.kept + '-wal'));
    for (const file of files) {
        try { fs.unlinkSync(file); } catch (e) {}
    }
}

/** Journal 'swapping', for a downgrade the database, the renames, journal 'swapped'. Returns the exit code; a failed switch is undone. */
function performSwap({ dataDir, codeDir, execPath = process.execPath, platform = process.platform, timedOut = false, isDbOpen = defaultIsDbOpen }) {
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
    const withDatabase = replacesDatabase(state);
    if (withDatabase && timedOut) return failWithoutSwitch(dataDir, state, ctx, '[Update] Herunterfahren nicht rechtzeitig beendet – die Datenbank wird nicht ersetzt, kein Wechsel');
    if (withDatabase && isDbOpen()) return failWithoutSwitch(dataDir, state, ctx, '[Update] Die Datenbank ist noch geöffnet – sie wird nicht ersetzt, kein Wechsel');
    if (withDatabase && swap.lexists(path.join(dataDir, 'manga.db.bak'))) {
        return failWithoutSwitch(dataDir, state, ctx, '[Update] manga.db.bak liegt im Datenordner (abgebrochene Wiederherstellung) – die Datenbank wird nicht ersetzt, kein Wechsel');
    }
    let swapping;
    const progress = { kept: null, moved: false };
    try {
        swapping = stateFile.writeState(dataDir, { ...state, phase: 'swapping', pid: process.pid });
        if (withDatabase) swapping = replaceDatabase(dataDir, swapping, progress);
        swap.swapForward(swapping, ctx);
    } catch (err) {
        log.error('[Update] Wechsel fehlgeschlagen, die bisherige Version bleibt:', err);
        try {
            const current = stateFile.readState(dataDir) || swapping || state;
            swap.revertCode(current, ctx);
            swap.cleanupCode(current, ctx);
            stateFile.writeState(dataDir, { ...current, phase: 'failed', error: 'UPDATE_FAILED', finished_at: new Date().toISOString() });
        } catch (e) {
            log.error('[Update] Zurücknehmen fehlgeschlagen; der nächste Start räumt auf:', e);
        }
        if (withDatabase && progress.moved) {
            try {
                dbRecovery.recoverReplacedDatabase({ dataDir, version: pkg.version, out: (line) => log.warn(line) });
            } catch (e) {
                log.error(e.message);
            }
        } else if (withDatabase) {
            dropUnusedCopies(dataDir, progress);
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
function requestRestart({ dataDir, codeDir, execPath = process.execPath, platform = process.platform, exit = (code) => process.exit(code), deadlineMs = SHUTDOWN_DEADLINE_MS, isDbOpen = defaultIsDbOpen } = {}) {
    if (!handler) throw updateError('NOT_INSTALLABLE', null, { reason: 'no_restart' });
    if (restarting) return restarting;
    lock.setPhase('restarting');
    download.abortAll();
    const shutdown = handler;
    let done = false;
    let timer = null;
    const finish = ({ timedOut = false } = {}) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        let code;
        try {
            code = performSwap({ dataDir, codeDir, execPath, platform, timedOut, isDbOpen });
        } catch (err) {
            log.error('[Update] Wechsel abgebrochen:', err);
            code = 1;
        }
        exit(code);
    };
    timer = setTimeout(() => {
        log.warn('[Update] Herunterfahren dauert zu lange – Wechsel jetzt');
        finish({ timedOut: true });
    }, deadlineMs);
    restarting = Promise.resolve()
        .then(() => shutdown())
        .catch((err) => log.error('[Update] Herunterfahren fehlgeschlagen:', err))
        .then(() => finish());
    return restarting;
}

/** For tests. */
function reset() {
    handler = null;
    restarting = null;
}

module.exports = { registerRestart, hasRestartHandler, requestRestart, performSwap, reset, SHUTDOWN_DEADLINE_MS };
