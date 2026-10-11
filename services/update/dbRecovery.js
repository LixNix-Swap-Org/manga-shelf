const fs = require('fs');
const path = require('path');
const stateFile = require('./state');
const swap = require('./swap');

const EXIT_RECOVERY_PENDING = 74;
const UNTOUCHED_PHASES = new Set(['staged', 'ready-to-swap', 'started', 'confirmed']);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function newerThan(a, b) {
    const pa = VERSION.exec(String(a));
    const pb = VERSION.exec(String(b));
    if (!pa || !pb) return false;
    for (let i = 1; i <= 3; i++) {
        if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) > Number(pb[i]);
    }
    return false;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function exists(file) {
    try {
        fs.lstatSync(file);
        return true;
    } catch (e) {
        return false;
    }
}

function unlinkQuietly(file) {
    try { fs.unlinkSync(file); } catch (e) {}
}

function recoveryError(text) {
    const err = new Error(text);
    err.code = 'DB_RECOVERY_FAILED';
    return err;
}

/** fsync of a file where the platform allows it. */
function fsyncFile(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r+');
        fs.fsyncSync(fd);
    } catch (e) {}
    if (fd !== undefined) fs.closeSync(fd);
}

/** Copies `dbFile` and its -wal to `target` (never overwriting) and fsyncs both. */
function keepCopy(dbFile, target) {
    fs.copyFileSync(dbFile, target, fs.constants.COPYFILE_EXCL);
    fsyncFile(target);
    if (exists(dbFile + '-wal')) {
        fs.copyFileSync(dbFile + '-wal', target + '-wal', fs.constants.COPYFILE_EXCL);
        fsyncFile(target + '-wal');
    }
}

/** Extracts manga.db of `backupFile` into `staged` once its sha256 matches; returns the schema of the copy. */
function stageBackup(backupFile, sha256, staged) {
    let st = null;
    try { st = fs.lstatSync(backupFile); } catch (e) {}
    if (!st || !st.isFile()) throw recoveryError('Backup fehlt: ' + path.basename(backupFile));
    if (swap.sha256FileSync(backupFile) !== sha256) throw recoveryError('Backup wurde verändert: ' + path.basename(backupFile));
    for (const f of [staged, staged + '-wal', staged + '-shm', staged + '-journal']) unlinkQuietly(f);
    swap.extractDbSync(backupFile, staged);
    const schema = swap.readSchemaVersion(staged);
    if (schema === null) {
        unlinkQuietly(staged);
        throw recoveryError('Datenbank im Backup ist nicht lesbar');
    }
    return schema;
}

/** Ends every session of the database file, as a restore does. */
function endSessions(file, nowMs = Date.now()) {
    const { DatabaseSync } = require('node:sqlite');
    const conn = new DatabaseSync(file);
    try {
        conn.exec('PRAGMA journal_mode = DELETE;');
        const has = (table) => conn.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
        if (has('users')) conn.prepare('UPDATE users SET password_changed_at = max(?, coalesce(password_changed_at, 0) + 1)').run(nowMs);
        if (has('app_settings')) conn.prepare("DELETE FROM app_settings WHERE key = 'revoked_sessions'").run();
    } finally {
        conn.close();
    }
    for (const suffix of ['-wal', '-shm', '-journal']) unlinkQuietly(file + suffix);
    fsyncFile(file);
}

/** Puts `staged` in place of manga.db: the replaced file (with its -wal) waits as manga.db.bak until the new one reads back as `schema`; `onMove` runs once no manga.db.bak is in the way, before any file is touched. */
function installDatabase(dataDir, staged, schema, onMove = () => {}) {
    const dbFile = path.join(dataDir, 'manga.db');
    const bak = dbFile + '.bak';
    const bakTmp = bak + '.tmp';
    if (exists(bak)) throw recoveryError('manga.db.bak existiert bereits');
    let bakWritten = false;
    let swapped = false;
    try {
        onMove();
        unlinkQuietly(bakTmp);
        unlinkQuietly(bak + '-wal');
        if (exists(dbFile)) {
            if (exists(dbFile + '-wal')) fs.copyFileSync(dbFile + '-wal', bak + '-wal');
            fs.copyFileSync(dbFile, bakTmp);
            fsyncFile(bakTmp);
            fs.renameSync(bakTmp, bak);
            bakWritten = true;
            stateFile.fsyncDir(dataDir);
        }
        unlinkQuietly(dbFile + '-wal');
        unlinkQuietly(dbFile + '-shm');
        fs.renameSync(staged, dbFile);
        swapped = true;
        stateFile.fsyncDir(dataDir);
        if (swap.readSchemaVersion(dbFile) !== schema) throw recoveryError('Eingesetzte Datenbank ist nicht lesbar');
        if (bakWritten) {
            unlinkQuietly(bak);
            unlinkQuietly(bak + '-wal');
        }
        stateFile.fsyncDir(dataDir);
    } catch (err) {
        unlinkQuietly(bakTmp);
        unlinkQuietly(staged);
        if (swapped && bakWritten) {
            try {
                putBack(dbFile);
            } catch (e) {}
        } else if (bakWritten) {
            unlinkQuietly(bak);
            unlinkQuietly(bak + '-wal');
        }
        throw err;
    }
}

function putBack(dbFile) {
    const bak = dbFile + '.bak';
    unlinkQuietly(dbFile + '-wal');
    unlinkQuietly(dbFile + '-shm');
    if (exists(bak + '-wal')) fs.renameSync(bak + '-wal', dbFile + '-wal');
    fs.renameSync(bak, dbFile);
    stateFile.fsyncDir(path.dirname(dbFile));
}

/** True while the journal says a downgrade began replacing manga.db (db.kept set) and the newer code (`version`) runs again without having returned. */
function recoveryApplies(state, version) {
    const db = state && state.downgrade && state.downgrade.db;
    if (!db || typeof db !== 'object' || db.returned_at || typeof db.kept !== 'string' || !db.kept) return false;
    if (UNTOUCHED_PHASES.has(state.phase) || !newerThan(version, state.to)) return false;
    if (state.phase === 'swapping' && ownerAlive(state.pid)) return false;
    return !(state.phase === 'failed' && state.error === 'ROLLBACK_FAILED' && state.attempts > 0);
}

function ownerAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

function pendingError(state, cause) {
    const fresh = state.backup && state.backup.file ? state.backup.file : 'vor-update-…zip';
    const kept = state.downgrade.db.kept;
    const err = new Error(`[Update] Rückkehr zu v${state.from} nicht abgeschlossen: ${cause.message}. Die Datenbank wird nicht geöffnet. `
        + `Der Stand von vor dem Zurücksetzen liegt in backups/${fresh} und als ${kept}. Bei gestopptem Server ${kept} als manga.db einsetzen `
        + '(die jetzige manga.db samt manga.db-wal und manga.db-shm vorher umbenennen) und neu starten – update-state.json nicht löschen.', { cause });
    err.code = 'DOWNGRADE_RECOVERY_PENDING';
    err.exitCode = EXIT_RECOVERY_PENDING;
    return err;
}

const withDb = (state, patch) => ({ ...state, downgrade: { ...state.downgrade, db: { ...state.downgrade.db, ...patch } } });

function checkFresh(state, fresh) {
    if (!fresh) throw recoveryError('Kein Backup im Journal');
    if (!exists(fresh)) throw recoveryError('Backup fehlt: ' + state.backup.file);
    if (swap.sha256FileSync(fresh) !== state.backup.sha256) throw recoveryError('Backup wurde verändert: ' + state.backup.file);
}

function markReturned(dataDir, state, at, out) {
    try {
        stateFile.writeState(dataDir, withDb(state, { returned_at: at }));
    } catch (err) {
        out(`[Update] Rückkehr zu v${state.from} nicht im Journal vermerkt: ${err.message}`);
    }
}

/** Puts the fresh backup of a downgrade back when `version` runs again on the database it replaced; throws DOWNGRADE_RECOVERY_PENDING (exit 74) when it cannot finish. */
function recoverReplacedDatabase({ dataDir, version, out = (line) => process.stderr.write(line + '\n'), now = Date.now } = {}) {
    const state = stateFile.readState(dataDir);
    if (!recoveryApplies(state, version)) return { action: 'none' };
    const schemaBefore = state.schema_before;
    if (!Number.isInteger(schemaBefore)) return { action: 'none' };
    const plan = state.downgrade.db;
    const dbFile = path.join(dataDir, 'manga.db');
    const bak = dbFile + '.bak';
    const putsBack = exists(bak) && (!plan.replaced_at || Boolean(plan.returning_at));
    const ahead = swap.readSchemaVersion(putsBack ? bak : dbFile);
    if (!putsBack && ahead === null) return { action: 'none' };
    if (!putsBack && ahead >= schemaBefore) {
        markReturned(dataDir, state, new Date(now()).toISOString(), out);
        return { action: 'none' };
    }
    const fresh = state.backup && state.backup.file ? path.join(dataDir, 'backups', state.backup.file) : null;
    let journal = state;
    let kept = null;
    let moved = false;
    try {
        if (ahead === null) throw recoveryError('manga.db.bak ist nicht lesbar');
        if (ahead < schemaBefore) checkFresh(state, fresh);
        if (putsBack) {
            putBack(dbFile);
            out(`[Update] Rückkehr zu v${state.from}: manga.db.bak als manga.db zurückgelegt`);
        }
        const current = swap.readSchemaVersion(dbFile);
        if (current === null) throw recoveryError('manga.db ist nicht lesbar');
        if (current < schemaBefore) {
            if (!fresh) throw recoveryError('Kein Backup im Journal');
            if (exists(bak)) throw recoveryError('manga.db.bak existiert bereits');
            const name = `manga.db.v${state.to}-${stamp()}`;
            keepCopy(dbFile, path.join(dataDir, name));
            kept = name;
            stateFile.fsyncDir(dataDir);
            out(`[Update] Datenbank von v${state.to} aufbewahrt als ${kept}${exists(path.join(dataDir, kept + '-wal')) ? ` und ${kept}-wal` : ''}`);
            const staged = dbFile + '.restore-tmp';
            const schema = stageBackup(fresh, state.backup.sha256, staged);
            if (schema < schemaBefore) {
                unlinkQuietly(staged);
                throw recoveryError('Backup passt nicht zum Stand vor dem Zurücksetzen');
            }
            endSessions(staged, now());
            installDatabase(dataDir, staged, schema, () => {
                const next = withDb(journal, { returning_at: new Date(now()).toISOString() });
                stateFile.writeState(dataDir, next);
                journal = next;
                moved = true;
            });
            out(`[Update] Rückkehr zu v${state.from}: Datenbank aus backups/${state.backup.file} wiederhergestellt`);
        }
    } catch (err) {
        if (kept && !moved) {
            unlinkQuietly(path.join(dataDir, kept));
            unlinkQuietly(path.join(dataDir, kept + '-wal'));
        }
        throw pendingError(state, err);
    }
    markReturned(dataDir, journal, new Date(now()).toISOString(), out);
    return { action: 'recovered', kept };
}

module.exports = { recoverReplacedDatabase, recoveryApplies, stageBackup, endSessions, installDatabase, keepCopy, fsyncFile, EXIT_RECOVERY_PENDING };
