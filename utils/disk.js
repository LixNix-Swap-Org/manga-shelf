// Free-space checks run before large writes (restore, backup) so a full disk fails early with a clear message.
const fs = require('fs');
const { msg } = require('../core/errors');

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

// one whole sentence per purpose (the client looks the template up as it is); {free}/{needed} are formatMb values
const SPACE_TEXTS = {
    backup: 'Nicht genug Speicherplatz auf dem Server für das Backup (frei: {free}, benötigt: {needed}). Bitte Platz freigeben (z. B. alte Snapshots löschen) und erneut versuchen.',
    restore: 'Nicht genug Speicherplatz auf dem Server für die Wiederherstellung (frei: {free}, benötigt: {needed}). Bitte Platz freigeben (z. B. alte Snapshots löschen) und erneut versuchen.',
    inspect: 'Nicht genug Speicherplatz auf dem Server für die Prüfung des Backups (frei: {free}, benötigt: {needed}). Bitte Platz freigeben (z. B. alte Snapshots löschen) und erneut versuchen.',
    snapshot: 'Nicht genug Speicherplatz auf dem Server für den Snapshot (frei: {free}, benötigt: {needed}). Bitte Platz freigeben (z. B. alte Snapshots löschen) und erneut versuchen.',
    other: 'Nicht genug Speicherplatz auf dem Server für diesen Vorgang (frei: {free}, benötigt: {needed}). Bitte Platz freigeben (z. B. alte Snapshots löschen) und erneut versuchen.'
};

/**
 * Throws a 507 error when `dir` has less than `neededBytes` free: German `message`, `extra` = { msg, params } for the
 * error body (sendError(res, 507, err.message, err.code, err.extra)). `purpose` picks the sentence (SPACE_TEXTS).
 * An unknown free space (statfs unsupported) never blocks.
 */
function ensureFreeSpace(dir, neededBytes, purpose = 'other') {
    const free = module.exports.freeBytes(dir);
    if (free === null || free >= neededBytes) return free;
    const text = msg(Object.prototype.hasOwnProperty.call(SPACE_TEXTS, purpose) ? SPACE_TEXTS[purpose] : SPACE_TEXTS.other, {
        free: formatMb(free),
        needed: formatMb(neededBytes)
    });
    const err = new Error(text.text);
    err.status = 507;
    err.code = 'INSUFFICIENT_SPACE';
    err.extra = { msg: text.template, params: text.params };
    err.freeBytes = free;
    err.neededBytes = neededBytes;
    throw err;
}

/** Size of a file in bytes, 0 when it does not exist. */
function fileSize(file) {
    try { return fs.statSync(file).size; } catch (e) { return 0; }
}

module.exports = { freeBytes, ensureFreeSpace, fileSize, formatMb, SPACE_TEXTS };
