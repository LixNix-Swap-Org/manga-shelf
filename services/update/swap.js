const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { fsyncDir } = require('./state');
const { RELEASE_MANIFEST } = require('./constants');

const UPDATE_DIR = '.update';
const FORBIDDEN_TOP = new Set(['data', 'node_modules', '.env', 'ssl', 'uploads', UPDATE_DIR, '.git']);
const TOP_DOT_FILES = new Set(['.env.example', RELEASE_MANIFEST]);
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const LAST_ENTRIES = ['index.js', 'package-lock.json', 'package.json'];

/** True when `text` holds a control character, a backslash or a colon (never part of a release path). */
function unsafeChars(text) {
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c < 0x20 || c === 0x7f || c === 0x5c || c === 0x3a) return true;
    }
    return false;
}

function lstatOrNull(file) {
    try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
}

const lexists = (file) => lstatOrNull(file) !== null;

function swapError(text, code = 'SWAP_FAILED') {
    const err = new Error(text);
    err.code = code;
    return err;
}

/** sha256 hex of a file, read in chunks. */
function sha256FileSync(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(1024 * 1024);
    try {
        let n;
        while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

/** A journaled entry name: a top-level file or folder of the release, or a nested file such as scripts/admin.js. */
function validEntryName(name) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 300) return false;
    const segments = name.split('/');
    if (segments.length > 6 || FORBIDDEN_TOP.has(segments[0])) return false;
    return segments.every((s) => s !== '.' && s !== '..' && (SEGMENT.test(s) || (segments.length === 1 && TOP_DOT_FILES.has(s))));
}

/** A relative path inside the code folder that may be moved aside (removals of the previous manifest). */
function validRelativePath(name) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 400) return false;
    const segments = name.split('/');
    if (segments.length > 12 || FORBIDDEN_TOP.has(segments[0]) || segments[0] === '.env') return false;
    return !unsafeChars(name) && segments.every((s) => s !== '.' && s !== '..' && s.length > 0 && s.length <= 255);
}

function realDir(dir) {
    const st = lstatOrNull(dir);
    return Boolean(st && st.isDirectory() && !st.isSymbolicLink());
}

function ensureParent(base, rel) {
    if (!realDir(base)) throw swapError('Ordner fehlt oder ist eine Verknüpfung: ' + base);
    const segments = rel.split('/').slice(0, -1);
    let dir = base;
    for (const s of segments) {
        dir = path.join(dir, s);
        const st = lstatOrNull(dir);
        if (!st) fs.mkdirSync(dir, { mode: 0o755 });
        else if (!st.isDirectory() || st.isSymbolicLink()) throw swapError('Pfad ist kein Ordner: ' + dir);
    }
}

function treePaths(codeDir, name) {
    const parts = name.split('/');
    return {
        rel: name,
        cur: path.join(codeDir, ...parts),
        next: path.join(codeDir, UPDATE_DIR, 'next', ...parts),
        prev: path.join(codeDir, UPDATE_DIR, 'previous', ...parts)
    };
}

/** Swap order: folders first, then single files, index.js, and package-lock.json with package.json last. */
function orderEntries(entries) {
    const rank = (name) => (LAST_ENTRIES.includes(name) ? 10 + LAST_ENTRIES.indexOf(name) : 0);
    return [...entries].sort((a, b) => rank(a.name) - rank(b.name) || (a.kind === b.kind ? 0 : a.kind === 'dir' ? -1 : 1) || (a.name < b.name ? -1 : 1));
}

function checkTree(state, codeDir) {
    if (!Array.isArray(state.entries) || !Array.isArray(state.removals)) throw swapError('Journal ohne Einträge');
    for (const e of state.entries) {
        if (!e || !validEntryName(e.name) || (e.kind !== 'dir' && e.kind !== 'file')) throw swapError('Ungültiger Eintrag im Journal');
    }
    for (const r of state.removals) if (!validRelativePath(r)) throw swapError('Ungültiger Pfad im Journal');
    const updateDir = path.join(codeDir, UPDATE_DIR);
    if (!realDir(updateDir)) throw swapError('.update fehlt oder ist eine Verknüpfung');
    for (const sub of ['next', 'previous']) {
        const dir = path.join(updateDir, sub);
        if (!lexists(dir)) fs.mkdirSync(dir, { mode: 0o700 });
        else if (!realDir(dir)) throw swapError('.update/' + sub + ' ist kein Ordner');
    }
}

function forwardEntry(codeDir, name) {
    const p = treePaths(codeDir, name);
    if (!lexists(p.next)) return;
    if (lexists(p.cur)) {
        if (lexists(p.prev)) throw swapError('Eintrag liegt schon in .update/previous: ' + name);
        ensureParent(path.join(codeDir, UPDATE_DIR, 'previous'), name);
        fs.renameSync(p.cur, p.prev);
    }
    ensureParent(codeDir, name);
    fs.renameSync(p.next, p.cur);
}

function revertEntry(codeDir, name) {
    const p = treePaths(codeDir, name);
    if (!lexists(p.next) && lexists(p.cur)) {
        ensureParent(path.join(codeDir, UPDATE_DIR, 'next'), name);
        fs.renameSync(p.cur, p.next);
    }
    if (lexists(p.prev)) {
        if (lexists(p.cur)) throw swapError('Eintrag ist doppelt vorhanden: ' + name);
        ensureParent(codeDir, name);
        fs.renameSync(p.prev, p.cur);
    }
}

function forwardRemoval(codeDir, name) {
    const p = treePaths(codeDir, name);
    if (lexists(p.cur) && !lexists(p.prev)) {
        ensureParent(path.join(codeDir, UPDATE_DIR, 'previous'), name);
        fs.renameSync(p.cur, p.prev);
    }
}

function revertRemoval(codeDir, name) {
    const p = treePaths(codeDir, name);
    if (lexists(p.prev) && !lexists(p.cur)) {
        ensureParent(codeDir, name);
        fs.renameSync(p.prev, p.cur);
    }
}

function binaryPaths(execPath) {
    return { exec: execPath, next: execPath + '.new', prev: execPath + '.previous' };
}

function checkBinary(state, execPath) {
    if (typeof state.exec_path !== 'string' || path.resolve(state.exec_path) !== path.resolve(execPath)) {
        throw swapError('Journal gehört zu einer anderen Programmdatei');
    }
    if (!state.next || !/^[0-9a-f]{64}$/.test(String(state.next.sha256))) throw swapError('Journal ohne Prüfsumme der neuen Datei');
    if (!state.previous || !/^[0-9a-f]{64}$/.test(String(state.previous.sha256))) throw swapError('Journal ohne Prüfsumme der alten Datei');
}

function forwardBinary(state, execPath, platform) {
    checkBinary(state, execPath);
    const p = binaryPaths(execPath);
    if (!lexists(p.next)) {
        if (lexists(p.exec) && sha256FileSync(p.exec) === state.next.sha256) return;
        throw swapError('Neue Programmdatei fehlt');
    }
    if (sha256FileSync(p.next) !== state.next.sha256) throw swapError('Neue Programmdatei wurde verändert', 'NEXT_CHANGED');
    if (platform === 'win32') {
        if (lexists(p.prev)) {
            try { fs.unlinkSync(p.prev); } catch (e) { fs.renameSync(p.prev, `${p.prev}.old-${Date.now()}`); }
        }
        fs.renameSync(p.exec, p.prev);
        fs.renameSync(p.next, p.exec);
        return;
    }
    if (lexists(p.prev)) fs.unlinkSync(p.prev);
    try {
        fs.linkSync(p.exec, p.prev);
    } catch (e) {
        fs.copyFileSync(p.exec, p.prev, fs.constants.COPYFILE_EXCL);
    }
    fs.renameSync(p.next, p.exec);
    fsyncDir(path.dirname(p.exec));
}

/** Before the first rename: every new entry waits in .update/next (or <binary>.new) and nothing sits in .update/previous. */
function checkReady(state, { codeDir, execPath = process.execPath } = {}) {
    if (state.mode === 'sea-user') {
        checkBinary(state, execPath);
        if (!lexists(binaryPaths(execPath).next)) throw swapError('Neue Programmdatei fehlt');
        return;
    }
    checkTree(state, codeDir);
    for (const e of state.entries) {
        const p = treePaths(codeDir, e.name);
        if (!lexists(p.next)) throw swapError('Neue Datei fehlt: ' + e.name);
        if (lexists(p.prev)) throw swapError('Eintrag liegt schon in .update/previous: ' + e.name);
    }
}

/** Runs the journaled switch to the new code (state phase 'swapping' must already be on disk). */
function swapForward(state, { codeDir, execPath = process.execPath, platform = process.platform } = {}) {
    if (state.mode === 'sea-user') return forwardBinary(state, execPath, platform);
    checkTree(state, codeDir);
    for (const r of state.removals) forwardRemoval(codeDir, r);
    for (const e of orderEntries(state.entries)) forwardEntry(codeDir, e.name);
    fsyncDir(codeDir);
}

/** Puts the previous code back (journal revert or rollback after a failed start). Throws when it cannot be proven. */
function revertCode(state, { codeDir, execPath = process.execPath, platform = process.platform } = {}) {
    if (state.mode === 'sea-user') {
        checkBinary(state, execPath);
        const p = binaryPaths(execPath);
        if (lexists(p.exec) && sha256FileSync(p.exec) === state.previous.sha256) {
            if (lexists(p.next)) fs.unlinkSync(p.next);
            if (lexists(p.prev) && sha256FileSync(p.prev) === state.previous.sha256) {
                try { fs.unlinkSync(p.prev); } catch (e) {}
            }
            return;
        }
        if (!lexists(p.prev)) throw swapError('Vorherige Programmdatei fehlt', 'PREVIOUS_MISSING');
        if (sha256FileSync(p.prev) !== state.previous.sha256) throw swapError('Vorherige Programmdatei wurde verändert', 'PREVIOUS_CHANGED');
        if (platform === 'win32' && lexists(p.exec)) fs.renameSync(p.exec, `${p.exec}.failed-${Date.now()}`);
        fs.renameSync(p.prev, p.exec);
        fsyncDir(path.dirname(p.exec));
        return;
    }
    checkTree(state, codeDir);
    checkPreviousTree(state, codeDir);
    for (const e of orderEntries(state.entries).reverse()) revertEntry(codeDir, e.name);
    for (const r of state.removals) revertRemoval(codeDir, r);
    fsyncDir(codeDir);
}

function checkPreviousTree(state, codeDir) {
    if (!state.previous || !state.previous.sha256) return;
    const p = treePaths(codeDir, 'package.json');
    if (lexists(p.prev) && sha256FileSync(p.prev) !== state.previous.sha256) throw swapError('Vorherige Dateien wurden verändert', 'PREVIOUS_CHANGED');
}

/** Throws, before anything changes, when a rollback could not be completed (backup or previous code missing or changed). */
function checkRollback(state, dataDir, { codeDir, execPath = process.execPath } = {}) {
    databaseRestorePlan(state, dataDir);
    if (state.mode === 'sea-user') {
        checkBinary(state, execPath);
        const p = binaryPaths(execPath);
        if (lexists(p.exec) && sha256FileSync(p.exec) === state.previous.sha256) return;
        if (!lexists(p.prev)) throw swapError('Vorherige Programmdatei fehlt', 'PREVIOUS_MISSING');
        if (sha256FileSync(p.prev) !== state.previous.sha256) throw swapError('Vorherige Programmdatei wurde verändert', 'PREVIOUS_CHANGED');
        return;
    }
    checkTree(state, codeDir);
    checkPreviousTree(state, codeDir);
}

/** True while .update/previous still holds an entry of the journal (a revert that has not finished), or the journal is unreadable. */
function hasJournaledPrevious(state, { codeDir } = {}) {
    if (state.mode === 'sea-user') return false;
    if (!codeDir || !Array.isArray(state.entries) || !Array.isArray(state.removals)) return true;
    const names = [...state.entries.map((e) => e && e.name), ...state.removals];
    return names.some((name) => !validRelativePath(name) || lexists(treePaths(codeDir, name).prev));
}

/** After a crash during the switch: 'completed' when the running code is the new one, else undone: 'reverted'. */
function recoverJournal(state, ctx) {
    if (state.mode === 'sea-user') {
        checkBinary(state, ctx.execPath);
        const p = binaryPaths(ctx.execPath);
        if (lexists(p.exec) && sha256FileSync(p.exec) === state.next.sha256) return 'completed';
        if (!lexists(p.exec) && lexists(p.prev)) {
            if (sha256FileSync(p.prev) !== state.previous.sha256) throw swapError('Vorherige Programmdatei wurde verändert', 'PREVIOUS_CHANGED');
            fs.renameSync(p.prev, p.exec);
        }
        revertCode(state, ctx);
        return 'reverted';
    }
    checkTree(state, ctx.codeDir);
    const indexMoved = state.entries.some((e) => e.name === 'index.js') && !lexists(treePaths(ctx.codeDir, 'index.js').next);
    if (indexMoved) {
        swapForward(state, ctx);
        return 'completed';
    }
    revertCode(state, ctx);
    return 'reverted';
}

/** Removes what the update left in the code folder (.update, .previous, .new). Never throws. */
function cleanupCode(state, { codeDir, execPath = process.execPath } = {}) {
    try {
        if (state.mode === 'sea-user') {
            const p = binaryPaths(execPath);
            for (const file of [p.next, p.prev]) {
                const st = lstatOrNull(file);
                if (st && (st.isFile() || st.isSymbolicLink())) {
                    try { fs.unlinkSync(file); } catch (e) {}
                }
            }
        } else if (codeDir && realDir(path.join(codeDir, UPDATE_DIR))) {
            fs.rmSync(path.join(codeDir, UPDATE_DIR), { recursive: true, force: true });
        }
    } catch (e) {}
}

/** Highest applied schema migration of a database file; null when it cannot be read. */
function readSchemaVersion(dbFile) {
    if (!lexists(dbFile)) return null;
    let conn;
    try {
        const { DatabaseSync } = require('node:sqlite');
        conn = new DatabaseSync(dbFile, { readOnly: true });
        const tracked = conn.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
        return tracked ? (conn.prepare('SELECT max(version) AS v FROM schema_migrations').get()?.v || 0) : 0;
    } catch (e) {
        return null;
    } finally {
        try { if (conn) conn.close(); } catch (e) {}
    }
}

/** manga.db out of a backup ZIP (stored or deflated, no ZIP64) into `target`, CRC and size checked. */
function extractDbSync(zipFile, target) {
    const buf = fs.readFileSync(zipFile);
    const tailStart = Math.max(0, buf.length - 22 - 0xffff);
    let eocd = -1;
    for (let i = buf.length - 22; i >= tailStart; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw swapError('Backup ist keine ZIP-Datei');
    const count = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    let p = cdOffset;
    let entry = null;
    for (let i = 0; i < count; i++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw swapError('Backup ist beschädigt');
        const nameLength = buf.readUInt16LE(p + 28);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
        if (name === 'manga.db') {
            entry = {
                method: buf.readUInt16LE(p + 10),
                crc32: buf.readUInt32LE(p + 16),
                compressedSize: buf.readUInt32LE(p + 20),
                size: buf.readUInt32LE(p + 24),
                offset: buf.readUInt32LE(p + 42)
            };
            break;
        }
        p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
    if (!entry || entry.compressedSize === 0xffffffff || entry.offset === 0xffffffff) throw swapError('manga.db fehlt im Backup');
    if (buf.readUInt32LE(entry.offset) !== 0x04034b50) throw swapError('Backup ist beschädigt');
    const start = entry.offset + 30 + buf.readUInt16LE(entry.offset + 26) + buf.readUInt16LE(entry.offset + 28);
    const data = buf.subarray(start, start + entry.compressedSize);
    let out;
    if (entry.method === 8) out = zlib.inflateRawSync(data);
    else if (entry.method === 0) out = data;
    else throw swapError('Backup nutzt ein unbekanntes Kompressionsverfahren');
    if (out.length !== entry.size || zlib.crc32(out) !== entry.crc32) throw swapError('Prüfsumme der Datenbank im Backup stimmt nicht');
    const fd = fs.openSync(target, 'wx', 0o600);
    try {
        fs.writeSync(fd, out);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

function unlinkQuietly(file) {
    try { fs.unlinkSync(file); } catch (e) {}
}

function databaseRestorePlan(state, dataDir) {
    const dbFile = path.join(dataDir, 'manga.db');
    const applied = readSchemaVersion(dbFile);
    if (applied !== null && Number.isInteger(state.schema_before) && applied <= state.schema_before) return null;
    if (!state.backup) throw swapError('Kein Backup im Journal', 'BACKUP_MISSING');
    const backupFile = path.join(dataDir, 'backups', state.backup.file);
    const st = lstatOrNull(backupFile);
    if (!st || !st.isFile()) throw swapError('Backup fehlt: ' + state.backup.file, 'BACKUP_MISSING');
    if (sha256FileSync(backupFile) !== state.backup.sha256) throw swapError('Backup wurde verändert: ' + state.backup.file, 'BACKUP_CHANGED');
    if (lexists(dbFile + '.bak')) throw swapError('manga.db.bak existiert bereits', 'ROLLBACK_COPY_PENDING');
    return { dbFile, backupFile };
}

/** Restores manga.db from the held backup (.bak discipline) when the schema moved past `schema_before`; `keepAs` keeps a copy of the replaced one. True when restored. */
function restoreDatabase(state, dataDir, { keepAs = null } = {}) {
    const plan = databaseRestorePlan(state, dataDir);
    if (!plan) return false;
    const { dbFile, backupFile } = plan;
    const staged = dbFile + '.restore-tmp';
    const bak = dbFile + '.bak';
    const bakTmp = bak + '.tmp';
    const kept = keepAs ? path.join(dataDir, path.basename(keepAs)) : null;
    for (const f of [staged, staged + '-wal', staged + '-shm', staged + '-journal', bakTmp]) unlinkQuietly(f);
    extractDbSync(backupFile, staged);
    const restoredVersion = readSchemaVersion(staged);
    if (restoredVersion === null || (Number.isInteger(state.schema_before) && restoredVersion > state.schema_before)) {
        unlinkQuietly(staged);
        throw swapError('Backup passt nicht zum Stand vor dem Update', 'BACKUP_CHANGED');
    }
    let bakWritten = false;
    let swapped = false;
    let keptWritten = false;
    try {
        if (kept && lexists(dbFile)) {
            fs.copyFileSync(dbFile, kept, fs.constants.COPYFILE_EXCL);
            keptWritten = true;
            if (lexists(dbFile + '-wal')) fs.copyFileSync(dbFile + '-wal', kept + '-wal', fs.constants.COPYFILE_EXCL);
        }
        if (lexists(dbFile)) {
            fs.copyFileSync(dbFile, bakTmp);
            fs.renameSync(bakTmp, bak);
            bakWritten = true;
        }
        unlinkQuietly(dbFile + '-wal');
        unlinkQuietly(dbFile + '-shm');
        fs.renameSync(staged, dbFile);
        swapped = true;
        fsyncDir(dataDir);
        if (readSchemaVersion(dbFile) !== restoredVersion) throw swapError('Wiederhergestellte Datenbank ist nicht lesbar');
        if (bakWritten) unlinkQuietly(bak);
        return true;
    } catch (err) {
        unlinkQuietly(bakTmp);
        unlinkQuietly(staged);
        if (swapped && bakWritten) {
            try {
                unlinkQuietly(dbFile + '-wal');
                unlinkQuietly(dbFile + '-shm');
                fs.copyFileSync(bak, dbFile);
                unlinkQuietly(bak);
            } catch (e) {}
        } else if (bakWritten) {
            unlinkQuietly(bak);
        }
        if (keptWritten) {
            unlinkQuietly(kept);
            unlinkQuietly(kept + '-wal');
        }
        throw err;
    }
}

module.exports = {
    UPDATE_DIR, LAST_ENTRIES, unsafeChars, sha256FileSync, lexists, lstatOrNull, validEntryName, validRelativePath, orderEntries, treePaths,
    checkReady, swapForward, revertCode, recoverJournal, cleanupCode, checkRollback, hasJournaledPrevious, readSchemaVersion, extractDbSync, restoreDatabase
};
