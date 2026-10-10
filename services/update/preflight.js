const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const zip = require('./zip');
const { satisfiesRange, compareVersions } = require('./version');
const { updateError } = require('./errors');
const { MB } = require('./constants');
const { openRegular, copyOut, isHandle } = require('./verifiedFile');
const disk = require('../../utils/disk');
const log = require('../../utils/logger').child('update');

const MARGIN_BYTES = 100 * MB;
const RUN_TIMEOUT_MS = 20000;
const DB_CHECK_TIMEOUT_MS = 120000;
const DB_CHECK_MS_PER_MB = 1000;
const DB_CHECK_MAX_MS = 60 * 60 * 1000;
const DB_CHECK_FROM = '3.1.0';
const NODE_CHECK_FILES = ['index.js', 'db.js'];
const OUTPUT_LIMIT = 64 * 1024;

function requireSpace(dir, needed, volume, freeBytes) {
    const free = freeBytes(dir);
    if (free !== null && free !== undefined && free < needed) {
        throw updateError('NO_SPACE', { free: disk.formatMb(free), needed: disk.formatMb(needed) }, { volume, free_bytes: free, needed_bytes: needed });
    }
}

function sizeOf(target, depth = 0) {
    let st;
    try { st = fs.lstatSync(target); } catch (e) { return 0; }
    if (st.isSymbolicLink()) return 0;
    if (!st.isDirectory()) return st.size;
    if (depth > 20) return 0;
    let total = 0;
    for (const name of fs.readdirSync(target)) total += sizeOf(path.join(target, name), depth + 1);
    return total;
}

/** Bytes of the shipped tree in `codeDir` (package.json "files", the package files and frontend/dist). */
function currentTreeSize(codeDir) {
    let files;
    try { files = JSON.parse(fs.readFileSync(path.join(codeDir, 'package.json'), 'utf8')).files || []; } catch (e) { files = []; }
    const names = new Set(['package.json', 'package-lock.json', 'frontend/dist', ...files.map((f) => String(f).replace(/\/$/, ''))]);
    let total = 0;
    for (const name of names) total += sizeOf(path.join(codeDir, name));
    return total;
}

const sameVolume = (a, b) => {
    try { return fs.statSync(a).dev === fs.statSync(b).dev; } catch (e) { return false; }
};

/** Data volume: asset (twice for a binary: staged and its run copy) + 2 × database + backup estimate + 100 MB; code volume: asset + current code. */
function checkSpace({ mode, dataDir, codeDir, execPath, assetSize, freeBytes = disk.freeBytes }) {
    const db = disk.fileSize(path.join(dataDir, 'manga.db')) + disk.fileSize(path.join(dataDir, 'manga.db-wal'));
    const assetCopies = mode === 'sea-user' ? 2 : 1;
    const dataNeeded = assetCopies * assetSize + 2 * db + Math.ceil(1.2 * db) + MARGIN_BYTES;
    const codeBase = mode === 'pterodactyl' ? codeDir : path.dirname(execPath);
    const codeNeeded = assetSize + (mode === 'pterodactyl' ? currentTreeSize(codeDir) : disk.fileSize(execPath));
    const shared = sameVolume(dataDir, codeBase);
    requireSpace(dataDir, shared ? dataNeeded + codeNeeded : dataNeeded, 'data', freeBytes);
    if (!shared) requireSpace(codeBase, codeNeeded, 'code', freeBytes);
    if (mode === 'pterodactyl') {
        log.warn(`[Update] Für das Update werden etwa ${disk.formatMb(dataNeeded + codeNeeded)} Speicherplatz gebraucht – das Speicherlimit im Panel ist für den Server nicht sichtbar.`);
    }
    return { dataNeeded, codeNeeded };
}

function productionDeps(lock) {
    if (!lock || typeof lock !== 'object' || !lock.packages || typeof lock.packages !== 'object') return null;
    const list = [];
    for (const [key, info] of Object.entries(lock.packages)) {
        if (key === '' || !info || info.dev === true) continue;
        list.push(`${key}@${info.version || ''}#${info.integrity || info.resolved || ''}`);
    }
    return list.sort().join('\n');
}

const npmInstallsOnStart = (env) => /\bnpm\s+(install|ci)\b/.test(String(env.STARTUP || ''));

/** Runs `file args` without blocking the event loop; resolves { status, signal, stdout, error }. */
function runChild(file, args, { timeout, env, signal } = {}) {
    return new Promise((resolve) => {
        let stdout = '';
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            resolve({ stdout, ...result });
        };
        let child;
        try {
            child = spawn(file, args, { env, signal, timeout, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        } catch (error) {
            finish({ status: null, signal: null, error });
            return;
        }
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
        });
        child.on('error', (error) => finish({ status: null, signal: null, error }));
        child.on('close', (status, sig) => finish({ status, signal: sig, error: null }));
    });
}

function throwIfAborted(signal) {
    if (signal && signal.aborted) throw updateError('DOWNLOAD_ABORTED');
}

/** ZIP checks: package.json version and engines, `node --check` of the entry files, production dependency set. */
async function zipPreflight({ file, version, codeDir, workDir, env = process.env, nodePath = process.execPath, run = runChild, signal }) {
    const archive = await zip.openZip(file);
    try {
        const find = (name) => archive.entries.find((e) => e.name === name);
        const read = async (name, max) => {
            const entry = find(name);
            if (!entry) throw updateError('BAD_PACKAGE', null, { reason: 'missing_' + name.replace(/[^a-z]/gi, '_') });
            return zip.readEntry(archive, entry, max);
        };
        let pkg;
        try {
            pkg = JSON.parse((await read('package.json', MB)).toString('utf8'));
        } catch (e) {
            if (e.expose) throw e;
            throw updateError('BAD_PACKAGE', null, { reason: 'package_json' });
        }
        if (!pkg || pkg.version !== version) throw updateError('PREFLIGHT_FAILED', null, { reason: 'version' });
        const range = pkg.engines && pkg.engines.node;
        if (range !== undefined && satisfiesRange(range, process.version) !== true) {
            throw updateError('NOT_INSTALLABLE', null, { reason: 'engines', node: typeof range === 'string' ? range : null });
        }
        const checkDir = path.join(workDir, 'check');
        fs.rmSync(checkDir, { recursive: true, force: true });
        fs.mkdirSync(checkDir, { mode: 0o700 });
        try {
            for (const name of NODE_CHECK_FILES) {
                const entry = find(name);
                if (!entry) throw updateError('BAD_PACKAGE', null, { reason: 'missing_' + name.replace('.', '_') });
                const target = path.join(checkDir, name);
                await zip.extractEntry(archive, entry, target, 16 * MB);
                const result = await run(nodePath, ['--check', target], { timeout: RUN_TIMEOUT_MS, signal });
                throwIfAborted(signal);
                if (result.error || result.status !== 0) throw updateError('PREFLIGHT_FAILED', null, { reason: 'syntax' });
            }
        } finally {
            fs.rmSync(checkDir, { recursive: true, force: true });
        }
        let newLock = null;
        let oldLock = null;
        try { newLock = JSON.parse((await read('package-lock.json', 16 * MB)).toString('utf8')); } catch (e) { newLock = null; }
        try { oldLock = JSON.parse(fs.readFileSync(path.join(codeDir, 'package-lock.json'), 'utf8')); } catch (e) { oldLock = null; }
        const before = productionDeps(oldLock);
        const after = productionDeps(newLock);
        const changed = before === null || after === null || before !== after;
        if (changed && !npmInstallsOnStart(env)) throw updateError('NOT_INSTALLABLE', null, { reason: 'deps_changed' });
        return { packageJson: pkg, depsChanged: changed };
    } finally {
        await zip.closeZip(archive);
    }
}

function childEnv(workDir, env = process.env) {
    const keep = ['PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'LANG'];
    const out = {};
    for (const key of keep) if (env[key] !== undefined) out[key] = env[key];
    return {
        ...out,
        NODE_ENV: 'production',
        LOG_LEVEL: 'warn',
        DATA_DIR: path.join(workDir, 'check-data'),
        MANGA_SHELF_CACHE_DIR: path.join(workDir, 'check-cache')
    };
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const reportsVersion = (output, version) => new RegExp(`(^|[^0-9A-Za-z.])v${escape(version)}(?![0-9A-Za-z]|\\.\\d)`).test(String(output || ''));

/** Time the staged binary gets to migrate a copy of `bytes`: 2 minutes plus 1 second per MB, at most an hour. */
const dbCheckTimeout = (bytes) => Math.min(DB_CHECK_MAX_MS, DB_CHECK_TIMEOUT_MS + Math.ceil((bytes || 0) / MB) * DB_CHECK_MS_PER_MB);

function loadSqlite() {
    try {
        return require('node:sqlite');
    } catch (e) {
        return null;
    }
}

/** A consistent copy of the live database in `workDir` through the SQLite backup API (steps between which requests run); resolves its path. */
async function copyLiveDatabase(workDir) {
    const conn = require('../../db').ensureDbOpen();
    const sqlite = loadSqlite();
    const target = path.join(workDir, `check-${crypto.randomUUID()}.db`);
    if (sqlite && typeof sqlite.backup === 'function' && conn instanceof sqlite.DatabaseSync) {
        await sqlite.backup(conn, target);
        return target;
    }
    if (typeof conn.backup === 'function') {
        await conn.backup(target);
        return target;
    }
    conn.prepare('VACUUM INTO ?').run(target);
    return target;
}

function removeCopy(copy) {
    if (!copy) return;
    for (const f of [copy, `${copy}-wal`, `${copy}-shm`, `${copy}-journal`]) {
        try { fs.unlinkSync(f); } catch (e) {}
    }
}

/** Binary checks on a private copy of the verified bytes: `version` must name the target; from 3.1.0 `db-check <copy>` must pass. */
async function seaPreflight({ file, sha256, assetName, version, workDir, env = process.env, run = runChild, copyDatabase = copyLiveDatabase, signal }) {
    const handle = isHandle(file) ? file : await openRegular(file);
    const runDir = fs.mkdtempSync(path.join(workDir, 'run-'));
    let copy = null;
    try {
        const binary = path.join(runDir, path.basename(assetName || 'manga-shelf-server'));
        await copyOut(handle, binary, { sha256, mode: 0o700 });
        throwIfAborted(signal);
        const options = { env: childEnv(workDir, env), signal };
        const result = await run(binary, ['version'], { ...options, timeout: RUN_TIMEOUT_MS });
        throwIfAborted(signal);
        if (result.error || result.status !== 0 || !reportsVersion(result.stdout, version)) {
            throw updateError('PREFLIGHT_FAILED', null, { reason: 'version' });
        }
        if (compareVersions(version, DB_CHECK_FROM) < 0) return { dbChecked: false };
        copy = await copyDatabase(workDir);
        throwIfAborted(signal);
        const check = await run(binary, ['db-check', copy], { ...options, timeout: dbCheckTimeout(disk.fileSize(copy)) });
        throwIfAborted(signal);
        if (check.error || check.status !== 0) throw updateError('PREFLIGHT_FAILED', null, { reason: 'db_check' });
        return { dbChecked: true };
    } finally {
        removeCopy(copy);
        fs.rmSync(runDir, { recursive: true, force: true });
        fs.rmSync(path.join(workDir, 'check-data'), { recursive: true, force: true });
        fs.rmSync(path.join(workDir, 'check-cache'), { recursive: true, force: true });
        if (handle !== file) await handle.close().catch(() => {});
    }
}

/** Space check plus the mode's checks; throws an updateError on the first problem. */
async function runPreflight(options) {
    checkSpace({ ...options, assetSize: options.assetSize || 0 });
    if (options.mode === 'pterodactyl') return zipPreflight(options);
    if (options.mode === 'sea-user') return seaPreflight(options);
    throw updateError('NOT_INSTALLABLE', null, { reason: options.mode || 'unknown' });
}

module.exports = { runPreflight, checkSpace, zipPreflight, seaPreflight, productionDeps, reportsVersion, currentTreeSize, childEnv, runChild, dbCheckTimeout, copyLiveDatabase };
