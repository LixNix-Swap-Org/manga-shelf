// Trash: GET /trash, POST /trash/:id/restore, DELETE /trash/:id, DELETE /trash; purgeTrash for the scheduler.
const { badRequest, notFound, conflict } = require('../errors');
const { parsePositiveInt } = require('../lib/validate');
const { TRASH_RETENTION_DAYS, sqlTimestamp } = require('../lib/trash');
const { findDuplicate, duplicateError } = require('./volumes');
const { OWNED_STATUS, addOwner, syncStatusWithOwners } = require('../lib/owners');

const DAY_MS = 24 * 60 * 60 * 1000;

function parsePayload(row) {
    try {
        const payload = JSON.parse(row.payload);
        return payload && typeof payload === 'object' ? payload : {};
    } catch (e) {
        return {};
    }
}

const purgeDate = (deletedAt) => {
    const time = Date.parse(String(deletedAt).replace(' ', 'T') + 'Z');
    return Number.isNaN(time) ? null : new Date(time + TRASH_RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
};

function entryId(params) {
    const id = parsePositiveInt(params.id);
    if (!id) throw badRequest('Ungültige Papierkorb-ID');
    return id;
}

/** Entries newest first with what the dialog shows; the payload itself stays on the server. */
function list(ctx) {
    const rows = ctx.db.prepare(`
        SELECT t.*, u.username AS deleted_by_name FROM trash t LEFT JOIN users u ON u.id = t.deleted_by
        ORDER BY t.deleted_at DESC, t.id DESC
    `).all();
    const seriesExists = ctx.db.prepare('SELECT 1 AS ok FROM mangas WHERE id = ?');
    const trashedSeries = new Set(rows.filter(r => r.kind === 'manga').map(r => r.ref_id));
    const items = rows.map((row) => {
        const payload = parsePayload(row);
        const base = {
            id: row.id,
            kind: row.kind,
            ref_id: row.ref_id,
            manga_id: row.manga_id,
            title: row.title,
            deleted_at: row.deleted_at,
            deleted_by: row.deleted_by,
            deleted_by_name: row.deleted_by_name || null,
            purge_at: purgeDate(row.deleted_at)
        };
        if (row.kind === 'manga') {
            const volumes = Array.isArray(payload.volumes) ? payload.volumes : [];
            return {
                ...base,
                cover_image: payload.manga?.cover_image || null,
                publisher: payload.manga?.publisher || null,
                volume_count: volumes.length,
                owned_count: volumes.filter(v => v.status === 'Vorhanden').length,
                restorable: true
            };
        }
        const volume = payload.volume || {};
        const seriesLive = Boolean(seriesExists.get(row.manga_id));
        return {
            ...base,
            volume_number: volume.volume_number ?? null,
            type: volume.type || 'volume',
            status: volume.status || null,
            cover_image: volume.cover_image || null,
            restorable: seriesLive,
            series_in_trash: !seriesLive && trashedSeries.has(row.manga_id)
        };
    });
    return { body: { items, retention_days: TRASH_RETENTION_DAYS } };
}

const columnsOf = (ctx, table) => new Set(ctx.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));

/** INSERT of the stored row with the columns the table still has (a later migration may add or drop some). */
function insertRow(ctx, table, columns, row, overrides = {}) {
    const values = { ...row, ...overrides };
    const names = Object.keys(values).filter(k => columns.has(k));
    ctx.db.prepare(`INSERT INTO ${table} (${names.map(n => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
        .run(...names.map(n => (values[n] === undefined ? null : values[n])));
}

// Re-inserts volumes with their owners and reads, keeping only columns the current schema still has.
function restoreVolumeRows(ctx, volumes, owners, reads) {
    const volumeCols = columnsOf(ctx, 'volumes');
    volumeCols.delete('number_sort');
    const ownerCols = columnsOf(ctx, 'volume_owners');
    const readCols = columnsOf(ctx, 'volume_reads');
    const userExists = ctx.db.prepare('SELECT 1 AS ok FROM users WHERE id = ?');
    const restoredIds = new Set();
    for (const v of volumes) {
        insertRow(ctx, 'volumes', volumeCols, v);
        restoredIds.add(v.id);
    }
    // a user deleted meanwhile takes their ownership and reads along
    const vanished = new Map();
    for (const o of owners) {
        if (!restoredIds.has(o.volume_id)) continue;
        if (userExists.get(o.user_id)) insertRow(ctx, 'volume_owners', ownerCols, o);
        else if (!vanished.has(o.volume_id)) vanished.set(o.volume_id, o);
    }
    for (const r of reads) if (restoredIds.has(r.volume_id) && userExists.get(r.user_id)) insertRow(ctx, 'volume_reads', readCols, r);
    // an owned volume left without owners goes to the restoring admin (as on a user delete), otherwise it is missing
    const hasOwner = ctx.db.prepare('SELECT 1 AS ok FROM volume_owners WHERE volume_id = ? LIMIT 1');
    for (const v of volumes) {
        if (v.status !== OWNED_STATUS || hasOwner.get(v.id)) continue;
        if (ctx.user?.role === 'admin') addOwner(ctx.db, v.id, ctx.user.id, vanished.get(v.id) || v);
        else syncStatusWithOwners(ctx.db, v.id);
    }
}

const sequenceOf = (ctx, table) => Number(ctx.db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table)?.seq ?? 0);

function restoreManga(ctx, entry, payload) {
    const manga = payload.manga;
    if (!manga || !manga.id) throw conflict('Der Eintrag ist beschädigt und lässt sich nicht wiederherstellen', 'TRASH_INVALID');
    if (ctx.db.prepare('SELECT 1 AS ok FROM mangas WHERE id = ?').get(manga.id)) {
        throw conflict('Die Reihe existiert bereits', 'TRASH_ID_TAKEN');
    }
    // only ids the table really handed out (an entry from another database state never claims new ids)
    if (manga.id > sequenceOf(ctx, 'mangas')) throw conflict('Der Eintrag passt nicht zu dieser Datenbank und lässt sich nicht wiederherstellen', 'TRASH_INVALID');
    const volumes = (Array.isArray(payload.volumes) ? payload.volumes : []);
    const taken = ctx.db.prepare('SELECT 1 AS ok FROM volumes WHERE id = ?');
    const volumeSequence = sequenceOf(ctx, 'volumes');
    const free = volumes.filter(v => v.id <= volumeSequence && !taken.get(v.id));
    const updatedBy = manga.updated_by && ctx.db.prepare('SELECT 1 AS ok FROM users WHERE id = ?').get(manga.updated_by) ? manga.updated_by : null;
    // owned_volumes is counted up again by the volume triggers
    insertRow(ctx, 'mangas', columnsOf(ctx, 'mangas'), manga, { owned_volumes: 0, updated_by: updatedBy });
    restoreVolumeRows(ctx, free, payload.owners || [], payload.reads || []);
    const animeIds = Array.isArray(payload.anime_ids) ? payload.anime_ids : [];
    const relink = ctx.db.prepare('UPDATE animes SET manga_id = ? WHERE id = ? AND manga_id IS NULL');
    for (const animeId of animeIds) relink.run(manga.id, animeId);
}

function restoreVolume(ctx, entry, payload) {
    const volume = payload.volume;
    if (!volume || !volume.id) throw conflict('Der Eintrag ist beschädigt und lässt sich nicht wiederherstellen', 'TRASH_INVALID');
    if (!ctx.db.prepare('SELECT 1 AS ok FROM mangas WHERE id = ?').get(volume.manga_id)) {
        const seriesTrashed = ctx.db.prepare("SELECT 1 AS ok FROM trash WHERE kind = 'manga' AND ref_id = ?").get(volume.manga_id);
        throw conflict(seriesTrashed
            ? `Die Reihe „${entry.title}“ liegt im Papierkorb – bitte zuerst die Reihe wiederherstellen.`
            : `Die Reihe „${entry.title}“ gibt es nicht mehr; der Band lässt sich nicht wiederherstellen.`,
        'TRASH_SERIES_MISSING', { series_in_trash: Boolean(seriesTrashed) });
    }
    if (ctx.db.prepare('SELECT 1 AS ok FROM volumes WHERE id = ?').get(volume.id)) throw conflict('Der Band existiert bereits', 'TRASH_ID_TAKEN');
    if (volume.id > sequenceOf(ctx, 'volumes')) throw conflict('Der Eintrag passt nicht zu dieser Datenbank und lässt sich nicht wiederherstellen', 'TRASH_INVALID');
    const type = volume.type || 'volume';
    const duplicate = findDuplicate(ctx, volume.manga_id, volume.volume_number, type);
    if (duplicate) throw duplicateError(type, volume.volume_number, duplicate);
    restoreVolumeRows(ctx, [volume], payload.owners || [], payload.reads || []);
}

/** Puts a series or volume back with its original ids, owners and reads (users deleted meanwhile are left out). */
function restore(ctx, { params }) {
    const id = entryId(params);
    const entry = ctx.db.prepare('SELECT * FROM trash WHERE id = ?').get(id);
    if (!entry) throw notFound('Papierkorb-Eintrag');
    const payload = parsePayload(entry);
    ctx.db.transaction(() => {
        if (entry.kind === 'manga') restoreManga(ctx, entry, payload);
        else restoreVolume(ctx, entry, payload);
        ctx.db.prepare('DELETE FROM trash WHERE id = ?').run(id);
    });
    return { body: { success: true, kind: entry.kind, id: entry.ref_id, manga_id: entry.manga_id, title: entry.title } };
}

function remove(ctx, { params }) {
    const id = entryId(params);
    if (ctx.db.prepare('DELETE FROM trash WHERE id = ?').run(id).changes === 0) throw notFound('Papierkorb-Eintrag');
    return { body: { success: true } };
}

function empty(ctx) {
    const removed = ctx.db.prepare('DELETE FROM trash').run().changes;
    return { body: { success: true, removed } };
}

/** Deletes entries older than `days` for good; returns how many. */
function purgeTrash(ctx, { days = TRASH_RETENTION_DAYS } = {}) {
    const cutoff = sqlTimestamp(new Date(ctx.now().getTime() - days * DAY_MS));
    return ctx.db.prepare('DELETE FROM trash WHERE deleted_at < ?').run(cutoff).changes;
}

module.exports = { list, restore, remove, empty, purgeTrash };
