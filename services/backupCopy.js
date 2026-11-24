// Second backup location: every verified snapshot of data/backups is copied into a folder on another disk (USB drive,
// NAS share) with the same retention per kind. The folder comes from BACKUP_COPY_DIR (Docker, Pterodactyl; the field
// in the Backups dialog is locked then) or from app_settings backup_copy_dir. A failed copy never touches the
// snapshots on the server; its reason is kept in app_settings backup_copy_status and shown in the dialog.
const fs = require('fs');
const path = require('path');
const { db, dataDir } = require('../db');
const log = require('../utils/logger').child('backup-copy');
const { config } = require('../utils/config');
const { HttpError, msg, msgData } = require('../core/errors');
const disk = require('../utils/disk');

const DIR_KEY = 'backup_copy_dir';
const STATUS_KEY = 'backup_copy_status';
const DOWNLOAD_KEY = 'backup_downloaded_at';
const MAX_DIR_LENGTH = 1024;
// the hint "all backups on the same disk" stays away this long after a ZIP was downloaded
const DOWNLOAD_FRESH_MS = 30 * 24 * 60 * 60 * 1000;
const SPACE_FACTOR = 1.05;

// i18n: server texts of the copy status (collected for the client catalogs)
const COPY_TEXTS = {
    unreachable: 'Ordner {dir} ist nicht erreichbar. Nächster Versuch beim nächsten Backup.',
    notDir: '{dir} ist kein Ordner.',
    readOnly: 'In den Ordner {dir} darf der Server nicht schreiben.',
    full: 'Im Ordner {dir} ist nicht genug Platz für {file} (frei: {free}, benötigt: {needed}).',
    failed: 'Kopie nach {dir} fehlgeschlagen: {reason}',
    relative: 'Bitte einen vollständigen Pfad angeben (z. B. E:\\Manga-Backups oder /mnt/nas/manga).',
    insideData: 'Der Ordner liegt im Datenordner des Servers. Bitte einen Ordner auf einer anderen Platte wählen.',
    tooLong: 'Der Pfad ist zu lang.',
    locked: 'Der Ordner ist über BACKUP_COPY_DIR festgelegt und kann hier nicht geändert werden.'
};

function readSetting(key) {
    try {
        const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
        return row ? row.value : null;
    } catch (e) {
        return null;
    }
}

function writeSetting(key, value) {
    if (value === null) db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
    else db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
}

/** The folder for copies and where it is set: { dir, fromEnv }; dir null when none is set. */
function copyTarget() {
    const fromEnv = config.backupCopyDir;
    if (fromEnv) return { dir: fromEnv, fromEnv: true };
    const stored = readSetting(DIR_KEY);
    return { dir: stored || null, fromEnv: false };
}

const isInside = (child, parent) => {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const dirError = (message, status = 400) => new HttpError(status, message, 'BACKUP_COPY_DIR');

/** Checks a folder typed in the dialog: absolute, outside the data folder. Returns the resolved path. */
function normalizeCopyDir(input) {
    const value = String(input ?? '').trim();
    if (value.length > MAX_DIR_LENGTH) throw dirError(msg(COPY_TEXTS.tooLong));
    if (!path.isAbsolute(value)) throw dirError(msg(COPY_TEXTS.relative));
    const dir = path.resolve(value);
    if (isInside(dir, dataDir) || isInside(dataDir, dir)) throw dirError(msg(COPY_TEXTS.insideData));
    return dir;
}

/** Throws a msg() error when `dir` is not an existing folder the server may write to. Never creates it. */
function assertUsable(dir) {
    let stat;
    try {
        stat = fs.statSync(dir);
    } catch (e) {
        // a missing drive or an unmounted share: creating the folder would put the copies on the server's own disk
        throw Object.assign(new Error('unreachable'), { message_: msg(COPY_TEXTS.unreachable, { dir }) });
    }
    if (!stat.isDirectory()) throw Object.assign(new Error('not a dir'), { message_: msg(COPY_TEXTS.notDir, { dir }) });
    try {
        fs.accessSync(dir, fs.constants.W_OK);
    } catch (e) {
        throw Object.assign(new Error('read only'), { message_: msg(COPY_TEXTS.readOnly, { dir }) });
    }
}

function readStatus() {
    try {
        const data = JSON.parse(readSetting(STATUS_KEY) || 'null');
        return data && typeof data === 'object' ? data : {};
    } catch (e) {
        return {};
    }
}

function saveStatus(status) {
    try {
        writeSetting(STATUS_KEY, JSON.stringify(status));
    } catch (e) {
        log.warn('Could not store the copy status:', e);
    }
}

/** Names of the snapshot ZIPs in the copy folder; null when it cannot be read. */
function copiedNames(dir) {
    try {
        return new Set(fs.readdirSync(dir).filter((name) => name.endsWith('.zip')));
    } catch (e) {
        return null;
    }
}

function copyFileAtomic(source, target) {
    const part = `${target}.part`;
    try {
        fs.copyFileSync(source, part);
        fs.renameSync(part, target);
    } catch (err) {
        try { fs.unlinkSync(part); } catch (e) { /* never written */ }
        throw err;
    }
}

/** The same retention as in data/backups, applied to the copies (only verified snapshots are ever copied). */
function pruneCopies(dir, scheduler) {
    const names = copiedNames(dir);
    if (!names) return;
    const byCategory = new Map();
    for (const filename of names) {
        const parsed = scheduler.parseSnapshotName(filename);
        const category = scheduler.categoryOf(filename);
        if (!parsed || category === 'other') continue;
        if (!byCategory.has(category)) byCategory.set(category, { prefix: parsed.prefix, entries: [] });
        byCategory.get(category).entries.push({ filename, time: parsed.time, verified: true });
    }
    for (const { prefix, entries } of byCategory.values()) {
        const keep = scheduler.retentionFor(prefix);
        if (!keep || keep === Infinity) continue;
        for (const name of scheduler.selectForPruning(entries, keep)) {
            try {
                fs.unlinkSync(path.join(dir, name));
                try { fs.unlinkSync(path.join(dir, name.replace(/\.zip$/, '.json'))); } catch (e) { /* none */ }
            } catch (e) {
                log.warn('Could not delete old copy', name, e.message);
            }
        }
    }
}

let running = null;

/**
 * Copies every verified snapshot the copy folder lacks (with its sidecar), then prunes the copies. Resolves with the
 * status (see copyStatus); without a folder with null. Concurrent calls share one run.
 */
function syncCopies({ now = new Date() } = {}) {
    if (running) return running;
    running = (async () => {
        const { dir } = copyTarget();
        if (!dir) return null;
        const scheduler = require('./scheduler');
        const previous = readStatus();
        try {
            assertUsable(dir);
            const have = copiedNames(dir) || new Set();
            let copied = 0;
            for (const snapshot of scheduler.listSnapshots()) {
                if (snapshot.verified !== true || snapshot.category === 'other' || have.has(snapshot.filename)) continue;
                const free = disk.freeBytes(dir);
                const needed = Math.ceil(snapshot.size * SPACE_FACTOR);
                if (free !== null && free < needed) {
                    throw Object.assign(new Error('full'), {
                        message_: msg(COPY_TEXTS.full, { dir, file: snapshot.filename, free: disk.formatMb(free), needed: disk.formatMb(needed) })
                    });
                }
                const source = path.join(scheduler.backupsDir, snapshot.filename);
                // the sidecar first: a ZIP in the folder always has its check result next to it
                const sidecar = source.replace(/\.zip$/, '.json');
                if (fs.existsSync(sidecar)) copyFileAtomic(sidecar, path.join(dir, snapshot.filename.replace(/\.zip$/, '.json')));
                copyFileAtomic(source, path.join(dir, snapshot.filename));
                copied++;
            }
            pruneCopies(dir, scheduler);
            const status = { dir, ok_at: now.toISOString(), error: null, error_at: null };
            saveStatus(status);
            if (copied) log.info(`[Backup] ${copied} Snapshot${copied === 1 ? '' : 's'} nach ${dir} kopiert`);
            return status;
        } catch (err) {
            const message = err.message_ || msg(COPY_TEXTS.failed, { dir, reason: err.code || err.message });
            log.warn(`[Backup] ${message.text}`);
            const status = { dir, ok_at: previous.dir === dir ? previous.ok_at || null : null, error: message.text, error_msg: msgData(message), error_at: now.toISOString() };
            saveStatus(status);
            return status;
        }
    })().finally(() => { running = null; });
    return running;
}

/** True when a ZIP of everything left the server in the last 30 days (Direkt-ZIP or a snapshot download). */
function recentDownload(now = Date.now()) {
    const at = Date.parse(readSetting(DOWNLOAD_KEY) || '');
    return Number.isFinite(at) && now - at < DOWNLOAD_FRESH_MS;
}

function noteDownload(now = new Date()) {
    try {
        writeSetting(DOWNLOAD_KEY, now.toISOString());
    } catch (e) {
        log.warn('Could not note the backup download:', e);
    }
}

/**
 * What the Backups dialog and the system page show: { dir, from_env, ok_at, error, error_msg, error_at, copies, bytes,
 * free_bytes, same_disk_hint }. `same_disk_hint`: no second location and no ZIP downloaded in the last 30 days.
 */
function copyStatus(now = Date.now()) {
    const { dir, fromEnv } = copyTarget();
    const status = readStatus();
    const current = dir && status.dir === dir ? status : {};
    let copies = 0;
    let bytes = 0;
    const names = dir ? copiedNames(dir) : null;
    if (names) {
        for (const name of names) {
            copies++;
            bytes += disk.fileSize(path.join(dir, name));
        }
    }
    return {
        dir,
        from_env: fromEnv,
        ok_at: current.ok_at || null,
        error: current.error || null,
        error_msg: current.error_msg || null,
        error_at: current.error_at || null,
        copies: names ? copies : null,
        bytes: names ? bytes : null,
        free_bytes: dir && names ? disk.freeBytes(dir) : null,
        same_disk_hint: !dir && !recentDownload(now)
    };
}

/** The snapshot names present in the copy folder; null without a folder (the list then shows no "kopiert"). */
function copiedSet() {
    const { dir } = copyTarget();
    return dir ? copiedNames(dir) || new Set() : null;
}

/** Sets the folder from the dialog (null or '' removes it). Throws a 400 HttpError, 409 while BACKUP_COPY_DIR is set. */
function setCopyDir(input) {
    if (copyTarget().fromEnv) {
        throw dirError(msg(COPY_TEXTS.locked), 409);
    }
    const value = String(input ?? '').trim();
    if (!value) {
        writeSetting(DIR_KEY, null);
        writeSetting(STATUS_KEY, null);
        return null;
    }
    const dir = normalizeCopyDir(value);
    writeSetting(DIR_KEY, dir);
    return dir;
}

module.exports = {
    COPY_TEXTS,
    copyTarget,
    normalizeCopyDir,
    setCopyDir,
    syncCopies,
    copyStatus,
    copiedSet,
    noteDownload,
    recentDownload,
    DOWNLOAD_FRESH_MS
};
