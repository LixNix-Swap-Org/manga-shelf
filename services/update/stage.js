const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { STAGING_TTL_MS } = require('./constants');
const { updateError } = require('./errors');
const { openRegular, sha256Of, processUid } = require('./verifiedFile');
const log = require('../../utils/logger').child('update');

let current = null;

const stagingRoot = (dataDir) => path.join(dataDir, 'temp', 'update');

function writeInfo(rec) {
    const info = {
        format: 1,
        version: rec.version,
        asset: rec.assetName,
        sha256: rec.sha256,
        size: rec.size,
        user_id: rec.userId,
        created_at: new Date(rec.createdAt).toISOString(),
        expires_at: new Date(rec.expiresAt).toISOString(),
        verified: rec.verified,
        signer: rec.signer
    };
    try {
        fs.writeFileSync(path.join(rec.dir, 'state.json'), JSON.stringify(info, null, 2), { mode: 0o600 });
    } catch (e) {}
}

function removeDir(dir) {
    try {
        const st = fs.lstatSync(dir);
        if (st.isDirectory() && !st.isSymbolicLink()) fs.rmSync(dir, { recursive: true, force: true });
        else fs.unlinkSync(dir);
    } catch (e) {}
}

function closeHandle(rec) {
    if (!rec.handle) return;
    rec.handle.close().catch(() => {});
    rec.handle = null;
}

function folderProblem(dir, uid) {
    let st;
    try {
        st = fs.lstatSync(dir);
    } catch (e) {
        return { problem: 'missing' };
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return { problem: 'symlink', st };
    if (uid === null) return { problem: null, st };
    if (st.uid !== uid) return { problem: 'foreign_owner', st };
    return { problem: st.mode & 0o022 ? 'shared_writable' : null, st };
}

function privateFolder(dir, { create, tighten, uid }) {
    if (create) {
        try {
            fs.mkdirSync(dir, { mode: 0o700 });
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
        }
    }
    let { problem, st } = folderProblem(dir, uid);
    if (problem === 'shared_writable' && tighten) {
        fs.chmodSync(dir, st.mode & 0o7777 & ~0o022);
        ({ problem } = folderProblem(dir, uid));
    }
    if (problem) {
        log.warn(`[Update] ${dir} ist kein privater Ordner (${problem}) – Update abgelehnt`);
        throw updateError('NOT_INSTALLABLE', null, { reason: 'data_dir_' + problem });
    }
}

/** DATA_DIR, DATA_DIR/temp and temp/update must be real folders of this user nobody else can write to; the last two are created or tightened. */
function assertPrivateRoot(dataDir, { uid = processUid() } = {}) {
    privateFolder(dataDir, { create: false, tighten: false, uid });
    privateFolder(path.join(dataDir, 'temp'), { create: true, tighten: true, uid });
    privateFolder(stagingRoot(dataDir), { create: true, tighten: true, uid });
}

/** Discards the staging (aborting its download) when `id` is it or omitted. Returns true when one was removed. */
function discard(id) {
    if (!current || (id !== undefined && current.id !== id)) return false;
    const rec = current;
    current = null;
    try { rec.abort.abort(); } catch (e) {}
    closeHandle(rec);
    removeDir(rec.dir);
    return true;
}

/** A fresh staging for `version`; any previous one is discarded first. */
function create({ dataDir, version, assetName, userId, now = Date.now(), uid }) {
    discard();
    assertPrivateRoot(dataDir, uid === undefined ? {} : { uid });
    const id = crypto.randomUUID();
    const dir = path.join(stagingRoot(dataDir), id);
    fs.mkdirSync(dir, { mode: 0o700 });
    current = {
        id,
        dir,
        version,
        assetName,
        userId,
        createdAt: now,
        expiresAt: now + STAGING_TTL_MS,
        verified: false,
        sha256: null,
        size: null,
        signer: null,
        logIndex: null,
        handle: null,
        abort: new AbortController()
    };
    writeInfo(current);
    return current;
}

/** The current staging, or null. */
const get = () => current;

/** The staging `id` when it belongs to `userId`, else null (foreign or unknown). */
function forUser(id, userId) {
    return current && current.id === id && current.userId === userId ? current : null;
}

/** Records the verified file; the time to apply it starts now. */
function markVerified(rec, { sha256, size, signer, logIndex, now = Date.now() }) {
    rec.verified = true;
    rec.sha256 = sha256;
    rec.size = size;
    rec.signer = signer;
    rec.logIndex = logIndex;
    rec.expiresAt = now + STAGING_TTL_MS;
    writeInfo(rec);
    return rec;
}

const isExpired = (rec, now = Date.now()) => now >= rec.expiresAt;

const assetPath = (rec) => path.join(rec.dir, rec.assetName);

/** Opens the downloaded asset once and keeps the handle when its content hashes to `sha256`; every later read goes through it. */
async function openVerified(rec, sha256) {
    const handle = await openRegular(assetPath(rec));
    try {
        if (await sha256Of(handle) !== sha256) throw updateError('CHECKSUM_MISMATCH');
        if (current !== rec) throw updateError('DOWNLOAD_ABORTED');
    } catch (err) {
        await handle.close().catch(() => {});
        throw err;
    }
    closeHandle(rec);
    rec.handle = handle;
    return handle;
}

/** Removes every staging folder except the current one (start-up sweep). Returns the number removed. */
function sweep(dataDir) {
    let names;
    try { names = fs.readdirSync(stagingRoot(dataDir)); } catch (e) { return 0; }
    let removed = 0;
    for (const name of names) {
        if (current && current.id === name) continue;
        removeDir(path.join(stagingRoot(dataDir), name));
        removed++;
    }
    return removed;
}

/** For tests: forget the staging without touching its files. */
function reset() {
    if (current) closeHandle(current);
    current = null;
}

module.exports = { stagingRoot, assertPrivateRoot, create, get, forUser, discard, markVerified, isExpired, assetPath, openVerified, sweep, reset };
