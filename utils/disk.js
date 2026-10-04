const fs = require('fs');

const MB = 1024 * 1024;
const formatMb = (bytes) => (bytes < 10 * MB ? `${(Math.max(0, bytes) / MB).toFixed(1)} MB` : `${Math.round(bytes / MB)} MB`);

/** Bytes available to this (unprivileged) process on the file system holding `dir`; null when unknown. */
function freeBytes(dir) {
    try {
        const s = fs.statfsSync(dir);
        return Number(s.bavail) * Number(s.bsize);
    } catch (e) {
        return null;
    }
}

/**
 * Throws a 507 error (German message) when `dir` has less than `neededBytes` free. An unknown free space
 * (statfs unsupported) never blocks.
 */
function ensureFreeSpace(dir, neededBytes, what = 'diesen Vorgang') {
    const free = module.exports.freeBytes(dir);
    if (free === null || free >= neededBytes) return free;
    const err = new Error(`Nicht genug Speicherplatz auf dem Server für ${what} (frei: ${formatMb(free)}, benötigt: ${formatMb(neededBytes)}). Bitte Platz freigeben (z. B. alte Snapshots löschen) und erneut versuchen.`);
    err.status = 507;
    err.code = 'INSUFFICIENT_SPACE';
    err.freeBytes = free;
    err.neededBytes = neededBytes;
    throw err;
}

/** Size of a file in bytes, 0 when it does not exist. */
function fileSize(file) {
    try { return fs.statSync(file).size; } catch (e) { return 0; }
}

module.exports = { freeBytes, ensureFreeSpace, fileSize, formatMb };
