const fs = require('fs');
const crypto = require('crypto');
const { updateError } = require('./errors');

const CHUNK = 1024 * 1024;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const SHA256 = /^[0-9a-f]{64}$/;

const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

/** Opens `file` read-only without following a symlink; refuses anything but a regular file of this user. */
async function openRegular(file, { uid = processUid() } = {}) {
    let handle;
    try {
        handle = await fs.promises.open(file, fs.constants.O_RDONLY | NOFOLLOW);
    } catch (err) {
        if (err.code === 'ELOOP' || err.code === 'EMLINK') throw updateError('BAD_PACKAGE', null, { reason: 'staged_file' });
        throw err;
    }
    try {
        const st = await handle.stat();
        if (!st.isFile() || (uid !== null && st.uid !== uid)) throw updateError('BAD_PACKAGE', null, { reason: 'staged_file' });
    } catch (err) {
        await handle.close().catch(() => {});
        throw err;
    }
    return handle;
}

async function eachChunk(handle, fn) {
    const buf = Buffer.allocUnsafe(CHUNK);
    let position = 0;
    for (;;) {
        const { bytesRead } = await handle.read(buf, 0, buf.length, position);
        if (bytesRead === 0) return position;
        await fn(buf.subarray(0, bytesRead));
        position += bytesRead;
    }
}

/** sha256 hex of the whole content behind `handle`. */
async function sha256Of(handle) {
    const hash = crypto.createHash('sha256');
    await eachChunk(handle, (chunk) => hash.update(chunk));
    return hash.digest('hex');
}

/** Copies the content behind `handle` into the new file `target` ('wx', `mode`); removes it and throws CHECKSUM_MISMATCH unless it hashes to `sha256`. */
async function copyOut(handle, target, { sha256, mode = 0o600 } = {}) {
    if (!SHA256.test(String(sha256))) throw updateError('CHECKSUM_MISSING');
    const out = await fs.promises.open(target, 'wx', mode);
    const hash = crypto.createHash('sha256');
    let ok = false;
    try {
        await eachChunk(handle, async (chunk) => {
            hash.update(chunk);
            await out.write(chunk, 0, chunk.length);
        });
        await out.sync();
        ok = hash.digest('hex') === sha256;
    } finally {
        await out.close().catch(() => {});
        if (!ok) await fs.promises.unlink(target).catch(() => {});
    }
    if (!ok) throw updateError('CHECKSUM_MISMATCH');
    return target;
}

/** True for a FileHandle (as opposed to a path). */
const isHandle = (value) => Boolean(value) && typeof value === 'object' && typeof value.read === 'function' && typeof value.fd === 'number';

module.exports = { openRegular, sha256Of, copyOut, isHandle, processUid, NOFOLLOW };
