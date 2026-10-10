const fs = require('fs');
const path = require('path');
const { STATE_FORMAT, STATE_FILE } = require('./constants');

const PHASES = new Set(['staged', 'ready-to-swap', 'swapping', 'swapped', 'started', 'rolling_back', 'confirmed', 'rolled_back', 'failed']);
const MODES = new Set(['pterodactyl', 'sea-user']);
const HOLD_PHASES = new Set(['staged', 'ready-to-swap', 'swapping', 'swapped', 'started', 'rolling_back']);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BACKUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.zip$/;
const SHA256 = /^[0-9a-f]{64}$/;

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
    try {
        const file = statePath(dataDir);
        const st = fs.lstatSync(file);
        if (!st.isFile() || st.size > 1024 * 1024) return null;
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        return null;
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

const RESULTS = { started: 'ok', confirmed: 'ok', rolled_back: 'rolled_back', failed: 'failed' };

/** { from, to, at, result, error, backup } of the last update for the system page, or null. */
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
        backup: state.backup ? state.backup.file : null
    };
}

module.exports = { STATE_FORMAT, STATE_FILE, PHASES, HOLD_PHASES, statePath, readState, writeState, patchState, heldBackup, lastResult, fsyncDir };
