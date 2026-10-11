const fs = require('fs');
const path = require('path');
const { STATE_FORMAT, STATE_FILE } = require('./constants');
const { compareVersions } = require('./version');

const PHASES = new Set(['staged', 'ready-to-swap', 'swapping', 'swapped', 'started', 'rolling_back', 'confirmed', 'rolled_back', 'failed']);
const MODES = new Set(['pterodactyl', 'sea-user']);
const HOLD_PHASES = new Set(['staged', 'ready-to-swap', 'swapping', 'swapped', 'started', 'rolling_back']);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BACKUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.zip$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ROLLBACK_FROM = '3.1.0';
const ANCHOR_PHASES = new Set(['started', 'confirmed']);
const PRE_UPDATE_NAME = /^vor-update-v(\d+(?:\.\d+\.\d+)?)-auf-v(\d+(?:\.\d+\.\d+)?)-/;

const statePath = (dataDir) => path.join(dataDir, STATE_FILE);

function validState(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.format !== STATE_FORMAT || !PHASES.has(data.phase) || !MODES.has(data.mode)) return null;
    if (!VERSION.test(String(data.from)) || !VERSION.test(String(data.to))) return null;
    if (!Number.isInteger(data.attempts) || data.attempts < 0) return null;
    if (data.backup !== null && data.backup !== undefined) {
        if (typeof data.backup !== 'object' || !BACKUP_NAME.test(String(data.backup.file)) || !SHA256.test(String(data.backup.sha256))) return null;
    }
    return data;
}

/** Parsed and checked state of `dataDir`, or null. */
function readState(dataDir) {
    let text;
    let fd;
    try {
        fd = fs.openSync(statePath(dataDir), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.size > 1024 * 1024) return null;
        text = fs.readFileSync(fd, 'utf8');
    } catch (e) {
        return null;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
    try {
        return validState(JSON.parse(text));
    } catch (e) {
        return null;
    }
}

/** fsync of a folder where the platform allows it (not on Windows). */
function fsyncDir(dir) {
    let fd;
    try {
        fd = fs.openSync(dir, 'r');
        fs.fsyncSync(fd);
    } catch (e) {}
    if (fd !== undefined) fs.closeSync(fd);
}

/** Writes the state atomically: temp file, fsync, rename, fsync of the folder. */
function writeState(dataDir, state) {
    const target = statePath(dataDir);
    const tmp = `${target}.tmp-${process.pid}`;
    const data = Buffer.from(JSON.stringify({ ...state, format: STATE_FORMAT }, null, 2) + '\n');
    try { fs.unlinkSync(tmp); } catch (e) {}
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
        fs.writeSync(fd, data);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    try {
        fs.renameSync(tmp, target);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch (e) {}
        throw err;
    }
    fsyncDir(dataDir);
    return readState(dataDir);
}

/** Merges `patch` into the current state and writes it; null when there is no valid state. */
function patchState(dataDir, patch) {
    const current = readState(dataDir);
    if (!current) return null;
    return writeState(dataDir, { ...current, ...patch });
}

/** Backup file name the update still needs (exclude it from pruning and deletion), or null. */
function heldBackup(dataDir) {
    const state = readState(dataDir);
    return state && HOLD_PHASES.has(state.phase) && state.backup ? state.backup.file : null;
}

const backupFile = (backup) => (backup && typeof backup === 'object' && BACKUP_NAME.test(String(backup.file)) ? backup.file : null);
const rollbackTarget = (from, to) => compareVersions(from, ROLLBACK_FROM) >= 0 && compareVersions(from, to) < 0;

/** The update a journal can still be undone to on `version`: { target, undoes } of a plain update or of a downgrade that failed before its switch, else null. */
function journalRollback(state, version) {
    if (!state || typeof state !== 'object') return null;
    if (!state.downgrade) {
        if (!ANCHOR_PHASES.has(state.phase) || state.to !== version || compareVersions(state.from, state.to) >= 0) return null;
        return { target: state.from, undoes: { from: state.from, to: state.to, at: state.at || null, backup: state.backup || null, schema_before: state.schema_before } };
    }
    const undoes = state.downgrade.undoes;
    if (state.phase !== 'failed' || state.swapped_at || !undoes || typeof undoes !== 'object' || undoes.to !== version) return null;
    if (compareVersions(undoes.from, undoes.to) >= 0) return null;
    return { target: undoes.from, undoes };
}

/** { current, previous } of the app_settings values app_version / app_version_previous; `read(key)` returns the stored text or undefined. */
function versionRecord(read) {
    const parse = (key) => {
        try {
            const value = JSON.parse(read(key));
            return value && typeof value === 'object' && VERSION.test(String(value.version)) ? value : null;
        } catch (e) {
            return null;
        }
    };
    return { current: parse('app_version'), previous: parse('app_version_previous') };
}

/** { target, schema_before, backup, since } when the version record offers going back from `version`, else null. */
function recordRollback(record, version) {
    const current = record && record.current;
    const previous = record && record.previous;
    if (!current || !previous || current.version !== version || compareVersions(previous.version, version) >= 0) return null;
    const backup = current.backup && typeof current.backup === 'object' && BACKUP_NAME.test(String(current.backup.file)) ? current.backup : null;
    return { target: previous.version, schema_before: previous.schema, backup, since: current.since || null };
}

/** True for a vor-update-v<a>-auf-v<b> backup with a newer than b (written by a downgrade). */
function isDowngradeBackup(name) {
    const m = PRE_UPDATE_NAME.exec(String(name));
    if (!m) return false;
    const [a, b] = [m[1], m[2]];
    if (a.includes('.') !== b.includes('.')) return false;
    return a.includes('.') ? compareVersions(a, b) > 0 : Number(a) > Number(b);
}

/** { hold, anchor }: backups the running update needs (never pruned or deleted) and the one going back would restore (never pruned). */
function heldBackups(dataDir, { version, record = null } = {}) {
    const state = readState(dataDir);
    const hold = [];
    if (state && HOLD_PHASES.has(state.phase)) {
        const own = backupFile(state.backup);
        const source = state.downgrade && state.downgrade.db && backupFile(state.downgrade.db.source);
        for (const name of [own, source]) if (name && !hold.includes(name)) hold.push(name);
    }
    const fromJournal = journalRollback(state, version);
    let anchor = fromJournal && rollbackTarget(fromJournal.target, version) ? backupFile(fromJournal.undoes.backup) : null;
    if (!anchor && !fromJournal) {
        const fromRecord = recordRollback(record, version);
        if (fromRecord && compareVersions(fromRecord.target, ROLLBACK_FROM) >= 0) anchor = backupFile(fromRecord.backup);
    }
    return { hold, anchor };
}

const RESULTS = { started: 'ok', confirmed: 'ok', rolled_back: 'rolled_back', failed: 'failed' };

/** { from, to, at, result, error, backup, direction } of the last update for the system page, or null. */
function lastResult(dataDir) {
    const state = readState(dataDir);
    if (!state) return null;
    let result = RESULTS[state.phase] || null;
    if (state.phase === 'swapped' && state.pending_start) result = 'pending_start';
    if (!result) return null;
    return {
        from: state.from,
        to: state.to,
        at: state.finished_at || state.at || null,
        result,
        error: state.error || null,
        backup: state.backup ? state.backup.file : null,
        direction: state.downgrade ? 'downgrade' : 'upgrade'
    };
}

module.exports = {
    STATE_FORMAT, STATE_FILE, PHASES, HOLD_PHASES, ROLLBACK_FROM, statePath, readState, writeState, patchState, heldBackup, lastResult, fsyncDir,
    heldBackups, journalRollback, versionRecord, recordRollback, isDowngradeBackup
};
