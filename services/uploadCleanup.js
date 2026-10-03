const fs = require('fs');
const path = require('path');
const { db, uploadsDir } = require('../db');
const log = require('../utils/logger').child('uploads');

const MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** One big string of every column that can name an upload, so a file name is "used" if it appears anywhere in it. */
function buildReferenceText() {
    const parts = [];
    for (const r of db.prepare('SELECT cover_image, banner_image, description, manga_passion_edition_data FROM mangas').all()) {
        parts.push(r.cover_image, r.banner_image, r.description, r.manga_passion_edition_data);
    }
    for (const r of db.prepare('SELECT cover_image, images, notes FROM volumes').all()) {
        parts.push(r.cover_image, r.images, r.notes);
    }
    return parts.filter(Boolean).join('\n');
}

/**
 * Deletes files in uploads/ that no series or volume references any more (left behind by deleted entries and
 * replaced covers). Files younger than 7 days stay: an upload happens before the form is saved.
 * With dryRun the files are only counted. Returns { removed, bytes, files }.
 */
function cleanOrphanUploads({ dryRun = false, minAgeMs = MIN_AGE_MS } = {}) {
    const result = { removed: 0, bytes: 0, files: [] };
    if (!fs.existsSync(uploadsDir)) return result;
    const text = buildReferenceText();
    const now = Date.now();
    for (const entry of fs.readdirSync(uploadsDir, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue;
        const full = path.join(uploadsDir, entry.name);
        let stat;
        try { stat = fs.statSync(full); } catch (e) { continue; }
        if (now - stat.mtimeMs < minAgeMs) continue;
        if (text.includes(entry.name)) continue;
        if (!dryRun) {
            try { fs.unlinkSync(full); } catch (e) { log.warn('Could not delete orphaned upload', entry.name, e); continue; }
        }
        result.removed++;
        result.bytes += stat.size;
        result.files.push(entry.name);
    }
    if (result.removed && !dryRun) log.info(`Removed ${result.removed} orphaned uploads (${Math.round(result.bytes / 1024)} KB)`);
    return result;
}

module.exports = { cleanOrphanUploads };
