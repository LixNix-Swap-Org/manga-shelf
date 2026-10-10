const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const zip = require('./zip');
const swap = require('./swap');
const stateFile = require('./state');
const { updateError, UPDATE_TEXTS } = require('./errors');
const { MB, RELEASE_MANIFEST } = require('./constants');
const { openRegular, sha256Of, NOFOLLOW } = require('./verifiedFile');

const MAX_ENTRY_BYTES = 128 * MB;
const MAX_UNPACKED_BYTES = 768 * MB;
const PACKAGE_FILES = Object.freeze(['package.json', 'package-lock.json', '.env.example', RELEASE_MANIFEST]);
const FRONTEND_DIST = 'frontend/dist';

const bad = (reason) => updateError('BAD_PACKAGE', null, { reason });

function sha256File(file) {
    return swap.sha256FileSync(file);
}

/** { dirs, files } a release may write: package.json "files" plus the package files and frontend/dist. */
function releaseEntries(pkg) {
    const dirs = new Set([FRONTEND_DIST]);
    const files = new Set(PACKAGE_FILES);
    for (const item of Array.isArray(pkg && pkg.files) ? pkg.files : []) {
        if (typeof item !== 'string') throw bad('files_list');
        const isDir = item.endsWith('/');
        const name = isDir ? item.slice(0, -1) : item;
        if (!swap.validEntryName(name)) throw bad('files_list');
        (isDir ? dirs : files).add(name);
    }
    if (!files.has('index.js')) throw bad('files_list');
    return { dirs, files };
}

function realDirOrNull(dir) {
    const st = swap.lstatOrNull(dir);
    if (!st) return null;
    if (!st.isDirectory() || st.isSymbolicLink()) throw bad('update_dir');
    return st;
}

function mkdirInside(base, rel) {
    let dir = base;
    for (const segment of rel.split('/')) {
        dir = path.join(dir, segment);
        const st = swap.lstatOrNull(dir);
        if (!st) fs.mkdirSync(dir, { mode: 0o755 });
        else if (!st.isDirectory() || st.isSymbolicLink()) throw bad('path');
    }
    return dir;
}

/** Unpacks the release ZIP (path or FileHandle) into <codeDir>/.update/next, regular files of the release only; resolves { entries, files, version }. */
async function unpackRelease({ zipFile, codeDir }) {
    const archive = await zip.openZip(zipFile, { maxEntries: 20000 });
    try {
        const seen = new Set();
        const files = [];
        const dirNames = [];
        let total = 0;
        for (const entry of archive.entries) {
            const name = zip.safeName(entry.name);
            if (!name) throw bad('path');
            const kind = zip.entryKind(entry);
            if (kind !== 'file' && kind !== 'dir') throw bad('entry_type');
            const folded = name.toLowerCase();
            if (seen.has(folded)) throw bad('duplicate');
            seen.add(folded);
            if (kind === 'dir') {
                dirNames.push(name);
                continue;
            }
            if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw bad('entry_too_large');
            total += entry.uncompressedSize;
            files.push({ entry, name });
        }
        if (total > MAX_UNPACKED_BYTES) throw bad('too_large');
        const pkgFile = files.find((f) => f.name === 'package.json');
        if (!pkgFile) throw bad('missing_package_json');
        let pkg;
        try {
            pkg = JSON.parse((await zip.readEntry(archive, pkgFile.entry, MB)).toString('utf8'));
        } catch (e) {
            if (e.expose) throw e;
            throw bad('package_json');
        }
        const allowed = releaseEntries(pkg);
        const owner = (name) => {
            if (allowed.files.has(name)) return { name, kind: 'file' };
            for (const dir of allowed.dirs) if (name === dir || name.startsWith(dir + '/')) return { name: dir, kind: 'dir' };
            return null;
        };
        const used = new Map();
        for (const f of files) {
            const entry = owner(f.name);
            if (!entry || (entry.name === f.name && entry.kind === 'dir')) throw bad('unexpected_entry');
            used.set(entry.name, entry);
        }
        const parents = new Set([...allowed.dirs, ...allowed.files].flatMap((n) => n.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))));
        for (const d of dirNames) {
            if (!owner(d) && !parents.has(d)) throw bad('unexpected_entry');
        }
        if (!used.has('index.js') || !used.has('package.json')) throw bad('missing_entry');

        const updateDir = path.join(codeDir, swap.UPDATE_DIR);
        if (realDirOrNull(updateDir)) fs.rmSync(updateDir, { recursive: true, force: true });
        fs.mkdirSync(updateDir, { mode: 0o700 });
        const nextDir = path.join(updateDir, 'next');
        fs.mkdirSync(nextDir, { mode: 0o700 });
        for (const f of files) {
            const segments = f.name.split('/');
            const parent = segments.length > 1 ? mkdirInside(nextDir, segments.slice(0, -1).join('/')) : nextDir;
            const target = path.join(parent, segments[segments.length - 1]);
            if (!target.startsWith(nextDir + path.sep)) throw bad('path');
            const unixMode = f.entry.versionMadeBy >> 8 === 3 ? (f.entry.externalAttrs >>> 16) & 0o777 : 0o644;
            await zip.extractEntry(archive, f.entry, target, MAX_ENTRY_BYTES, unixMode & 0o111 ? 0o755 : 0o644);
        }
        return { entries: swap.orderEntries([...used.values()]), files: new Set(files.map((f) => f.name)), version: pkg.version };
    } finally {
        await zip.closeZip(archive);
    }
}

/** Files of the previous release's manifest the new one no longer ships and no swapped folder covers. */
function computeRemovals({ codeDir, entries, files }) {
    const file = path.join(codeDir, RELEASE_MANIFEST);
    const st = swap.lstatOrNull(file);
    if (!st || !st.isFile() || st.size > 2 * MB) return [];
    let listed;
    try {
        listed = JSON.parse(fs.readFileSync(file, 'utf8')).files;
    } catch (e) {
        return [];
    }
    if (!Array.isArray(listed)) return [];
    const dirs = entries.filter((e) => e.kind === 'dir').map((e) => e.name);
    const names = new Set(entries.map((e) => e.name));
    const out = [];
    for (const name of listed) {
        if (!swap.validRelativePath(name) || files.has(name) || names.has(name)) continue;
        if (dirs.some((d) => name === d || name.startsWith(d + '/'))) continue;
        const cur = swap.lstatOrNull(path.join(codeDir, ...name.split('/')));
        if (cur && cur.isFile()) out.push(name);
    }
    return out;
}

/** Copies the staged binary (`fd` of the verified file, or `stagedFile`) to <execPath>.new, created exclusively with the old mode and owner, hashed on the way. */
function writeNewBinary({ execPath, stagedFile, fd, sha256, platform = process.platform }) {
    const next = `${execPath}.new`;
    const st = fs.statSync(execPath);
    const existing = swap.lstatOrNull(next);
    if (existing) {
        if (existing.isDirectory() && !existing.isSymbolicLink()) throw bad('new_exists');
        fs.unlinkSync(next);
    }
    const out = fs.openSync(next, 'wx', st.mode & 0o777);
    const hash = crypto.createHash('sha256');
    let ok = false;
    try {
        const src = fd !== undefined ? fd : fs.openSync(stagedFile, fs.constants.O_RDONLY | NOFOLLOW);
        try {
            const buf = Buffer.allocUnsafe(MB);
            let position = 0;
            let n;
            while ((n = fs.readSync(src, buf, 0, buf.length, position)) > 0) {
                hash.update(buf.subarray(0, n));
                fs.writeSync(out, buf, 0, n);
                position += n;
            }
        } finally {
            if (fd === undefined) fs.closeSync(src);
        }
        if (platform !== 'win32') {
            fs.fchmodSync(out, st.mode & 0o7777);
            try { fs.fchownSync(out, st.uid, st.gid); } catch (e) {}
        }
        fs.fsyncSync(out);
        ok = hash.digest('hex') === sha256;
    } finally {
        fs.closeSync(out);
        if (!ok) {
            try { fs.unlinkSync(next); } catch (e) {}
        }
    }
    if (!ok) throw updateError('CHECKSUM_MISMATCH');
    stateFile.fsyncDir(path.dirname(execPath));
    if (platform === 'darwin') spawnSync('/usr/bin/xattr', ['-d', 'com.apple.quarantine', next], { stdio: 'ignore' });
    return next;
}

function defaultDeps() {
    const scheduler = require('../scheduler');
    return {
        createBackupSnapshot: scheduler.createBackupSnapshot,
        holdSnapshot: scheduler.holdSnapshot,
        backupsDir: scheduler.backupsDir,
        schemaVersion: () => {
            const { db } = require('../../db');
            return require('../../core/schema').appliedSchemaVersion(db);
        }
    };
}

/** Verified backup, update state and new code next to the old, all read through one handle of the staged file; resolves { state, releaseHold }. */
async function prepareSwitch({ staged, install, from, dataDir, userId, deps = {}, onStep = () => {} }) {
    const d = { ...defaultDeps(), ...deps };
    const to = staged.version;
    let state = null;
    let release = null;
    const handle = staged.handle || await openRegular(staged.file);
    try {
        onStep('verifying');
        if (await sha256Of(handle) !== staged.sha256) throw updateError('CHECKSUM_MISMATCH');
        const previousState = stateFile.readState(dataDir);
        if (previousState && previousState.phase === 'started') swap.cleanupCode(previousState, { codeDir: install.codeDir, execPath: install.execPath });

        onStep('backup');
        const snapshot = await d.createBackupSnapshot(`vor-update-v${from}-auf-v${to}`, { includeUploads: false });
        if (!snapshot || snapshot.verified !== true) throw updateError('BACKUP_FAILED');
        release = d.holdSnapshot(snapshot.filename);
        if (await sha256Of(handle) !== staged.sha256) throw updateError('CHECKSUM_MISMATCH');
        const backupSha = sha256File(path.join(d.backupsDir, snapshot.filename));
        const previousSha = install.mode === 'sea-user'
            ? sha256File(install.execPath)
            : sha256File(path.join(install.codeDir, 'package.json'));

        state = stateFile.writeState(dataDir, {
            phase: 'staged',
            mode: install.mode,
            restart: install.restart,
            from,
            to,
            at: new Date().toISOString(),
            user: userId,
            pid: process.pid,
            schema_before: d.schemaVersion(),
            backup: { file: snapshot.filename, sha256: backupSha },
            previous: { sha256: previousSha },
            next: { sha256: staged.sha256 },
            attempts: 0,
            ...(install.mode === 'sea-user' ? { exec_path: install.execPath } : { code_dir: install.codeDir })
        });

        onStep('copying');
        let extra = {};
        if (install.mode === 'pterodactyl') {
            const unpacked = await unpackRelease({ zipFile: handle, codeDir: install.codeDir });
            if (unpacked.version !== to) throw updateError('PREFLIGHT_FAILED', null, { reason: 'version' });
            extra = { entries: unpacked.entries, removals: computeRemovals({ codeDir: install.codeDir, entries: unpacked.entries, files: unpacked.files }) };
        } else if (install.mode === 'sea-user') {
            writeNewBinary({ execPath: install.execPath, fd: handle.fd, sha256: staged.sha256 });
        } else {
            throw updateError('NOT_INSTALLABLE', null, { reason: install.mode });
        }
        state = stateFile.writeState(dataDir, { ...state, ...extra, phase: 'ready-to-swap' });
        return { state, releaseHold: release };
    } catch (err) {
        if (release) release();
        if (state) {
            swap.cleanupCode(state, { codeDir: install.codeDir, execPath: install.execPath });
            try {
                stateFile.writeState(dataDir, { ...state, phase: 'failed', error: err.code && UPDATE_TEXTS[err.code] ? err.code : 'UPDATE_FAILED', finished_at: new Date().toISOString() });
            } catch (e) {}
        }
        throw err;
    } finally {
        if (handle !== staged.handle) await handle.close().catch(() => {});
    }
}

module.exports = { prepareSwitch, unpackRelease, computeRemovals, writeNewBinary, releaseEntries, PACKAGE_FILES };
