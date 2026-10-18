// Trash: GET /trash, POST /trash/:id/restore, DELETE /trash/:id, DELETE /trash; purgeTrash for the scheduler.
const { msg, badRequest, notFound, conflict } = require('../errors');
const { parsePositiveInt } = require('../lib/validate');
const { TRASH_RETENTION_DAYS, sqlTimestamp } = require('../lib/trash');
const { findDuplicate, duplicateError } = require('./volumes');
const { OWNED_STATUS, addOwner, syncStatusWithOwners } = require('../lib/owners');
const access = require('../lib/access');
const { qstr } = require('../lib/query');
const { parseLanguage, DEFAULT_LANGUAGE } = require('../lib/language');

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

/** The entry, 404 unless the caller belongs to its shelf with at least `minRole`. */
function loadEntry(ctx, params, minRole) {
    const id = entryId(params);
    const entry = ctx.db.prepare('SELECT * FROM trash WHERE id = ?').get(id);
    if (!entry) throw notFound('Papierkorb-Eintrag');
    try {
        access.requireShelf(ctx, entry.shelf_id, minRole);
    } catch (err) {
        if (err.status === 404) throw notFound('Papierkorb-Eintrag');
        throw err;
    }
    return entry;
}

function entryId(params) {
    const id = parsePositiveInt(params.id);
    if (!id) throw badRequest('Ungültige Papierkorb-ID');
    return id;
}

/** Entries newest first with what the dialog shows; the payload itself stays on the server. */
function list(ctx, { query } = {}) {
    const scope = access.inShelves('t.shelf_id', access.requestedShelfIds(ctx, qstr(query && query.shelf_id)));
    const rows = ctx.db.prepare(`
        SELECT t.*, u.username AS deleted_by_name FROM trash t LEFT JOIN users u ON u.id = t.deleted_by
        WHERE ${scope.sql}
        ORDER BY t.deleted_at DESC, t.id DESC
    `).all(...scope.params);
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

// Re-inserts volumes with their owners and reads, keeping only columns the current schema still has. Marks come back
// for members of `shelfId` only: a user deleted meanwhile or no longer in the shelf takes their ownership and reads along.
function restoreVolumeRows(ctx, volumes, owners, reads, shelfId) {
    const volumeCols = columnsOf(ctx, 'volumes');
    volumeCols.delete('number_sort');
    const ownerCols = columnsOf(ctx, 'volume_owners');
    const readCols = columnsOf(ctx, 'volume_reads');
    const member = ctx.db.prepare('SELECT 1 AS ok FROM shelf_members WHERE shelf_id = ? AND user_id = ?');
    const isMember = (userId) => Boolean(member.get(shelfId, userId));
    const restoredIds = new Set();
    for (const v of volumes) {
        insertRow(ctx, 'volumes', volumeCols, v);
        restoredIds.add(v.id);
    }
    const vanished = new Map();
    for (const o of owners) {
        if (!restoredIds.has(o.volume_id)) continue;
        if (isMember(o.user_id)) insertRow(ctx, 'volume_owners', ownerCols, o);
        else if (!vanished.has(o.volume_id)) vanished.set(o.volume_id, o);
    }
    for (const r of reads) if (restoredIds.has(r.volume_id) && isMember(r.user_id)) insertRow(ctx, 'volume_reads', readCols, r);
    // an owned volume left without owners goes to the restoring admin (a member: restoring needs editor rights there),
    // otherwise it is missing
    const hasOwner = ctx.db.prepare('SELECT 1 AS ok FROM volume_owners WHERE volume_id = ? LIMIT 1');
    for (const v of volumes) {
        if (v.status !== OWNED_STATUS || hasOwner.get(v.id)) continue;
        if (ctx.user?.role === 'admin') addOwner(ctx.db, v.id, ctx.user.id, vanished.get(v.id) || v);
        else syncStatusWithOwners(ctx.db, v.id);
    }
}

const sequenceOf = (ctx, table) => Number(ctx.db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table)?.seq ?? 0);

/**
 * The shelf a restored series goes back to: the one it was in when it was deleted, else the shelf of its trash entry
 * (an entry written before migration 32 has no shelf in its payload), each only while it exists and the caller may
 * edit there. Never the caller's own shelf by default: 409 SHELF_UNAVAILABLE instead.
 */
function restoreShelf(ctx, entry, manga) {
    const editable = new Set(access.accessibleShelfIds(ctx, 'editor'));
    for (const candidate of [manga.shelf_id, entry.shelf_id]) {
        const id = access.parseId(candidate);
        if (id && editable.has(id)) return id;
    }
    throw conflict('Das Regal dieser Reihe gibt es nicht mehr oder du darfst dort nichts ändern; die Reihe lässt sich nicht wiederherstellen.', 'SHELF_UNAVAILABLE');
}

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
    // an entry trashed before migration 27 still carries a language name ('Deutsch')
    const language = parseLanguage(manga.language);
    const edition = { language: (language && language.language) || DEFAULT_LANGUAGE, region: manga.region || (language && language.region) || null };
    // the group may have been re-keyed or dissolved meanwhile: rejoin only a key a live series still carries
    edition.work_key = manga.work_key && ctx.db.prepare('SELECT 1 AS ok FROM mangas WHERE work_key = ? LIMIT 1').get(manga.work_key) ? manga.work_key : null;
    edition.shelf_id = restoreShelf(ctx, entry, manga);
    insertRow(ctx, 'mangas', columnsOf(ctx, 'mangas'), manga, { owned_volumes: 0, updated_by: updatedBy, ...edition });
    restoreVolumeRows(ctx, free, payload.owners || [], payload.reads || [], edition.shelf_id);
    // volumes of this series deleted on their own follow it, as on a move
    ctx.db.prepare("UPDATE trash SET shelf_id = ? WHERE kind = 'volume' AND manga_id = ?").run(edition.shelf_id, manga.id);
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
            ? msg('Die Reihe „{title}“ liegt im Papierkorb – bitte zuerst die Reihe wiederherstellen.', { title: entry.title })
            : msg('Die Reihe „{title}“ gibt es nicht mehr; der Band lässt sich nicht wiederherstellen.', { title: entry.title }),
        'TRASH_SERIES_MISSING', { series_in_trash: Boolean(seriesTrashed) });
    }
    // the series may have moved since: the volume goes back where the series is now, so that shelf decides
    let shelfId;
    try {
        shelfId = access.mangaAccess(ctx, volume.manga_id, 'editor');
    } catch (err) {
        if (err.status !== 403 && err.status !== 404) throw err;
        throw conflict(msg('Die Reihe „{title}“ liegt in einem Regal, in dem du nichts ändern darfst; der Band lässt sich nicht wiederherstellen.', { title: entry.title }), 'SHELF_UNAVAILABLE');
    }
    if (ctx.db.prepare('SELECT 1 AS ok FROM volumes WHERE id = ?').get(volume.id)) throw conflict('Der Band existiert bereits', 'TRASH_ID_TAKEN');
    if (volume.id > sequenceOf(ctx, 'volumes')) throw conflict('Der Eintrag passt nicht zu dieser Datenbank und lässt sich nicht wiederherstellen', 'TRASH_INVALID');
    const type = volume.type || 'volume';
    const duplicate = findDuplicate(ctx, volume.manga_id, volume.volume_number, type);
    if (duplicate) throw duplicateError(type, volume.volume_number, duplicate);
    restoreVolumeRows(ctx, [volume], payload.owners || [], payload.reads || [], shelfId);
}

/** Puts a series or volume back with its original ids, owners and reads (only of users who are members of its shelf). */
function restore(ctx, { params }) {
    const entry = loadEntry(ctx, params, 'editor');
    const id = entry.id;
    const payload = parsePayload(entry);
    ctx.db.transaction(() => {
        if (entry.kind === 'manga') restoreManga(ctx, entry, payload);
        else restoreVolume(ctx, entry, payload);
        ctx.db.prepare('DELETE FROM trash WHERE id = ?').run(id);
    });
    return { body: { success: true, kind: entry.kind, id: entry.ref_id, manga_id: entry.manga_id, title: entry.title } };
}

function remove(ctx, { params }) {
    const entry = loadEntry(ctx, params, 'editor');
    ctx.db.prepare('DELETE FROM trash WHERE id = ?').run(entry.id);
    return { body: { success: true } };
}

/**
 * Empties the trash of the shelves the caller owns; an app admin also that of every shelf they are an editor of (a
 * second admin or local profile joins the household shelf as editor). A viewer, also a pending local profile, never.
 */
function empty(ctx, { query } = {}) {
    const minRole = ctx.user && ctx.user.role === 'admin' ? 'editor' : 'owner';
    const scope = access.inShelves('shelf_id', access.requestedShelfIds(ctx, qstr(query && query.shelf_id), minRole));
    const removed = ctx.db.prepare(`DELETE FROM trash WHERE ${scope.sql}`).run(...scope.params).changes;
    return { body: { success: true, removed } };
}

/** Deletes entries older than `days` for good; returns how many. */
function purgeTrash(ctx, { days = TRASH_RETENTION_DAYS } = {}) {
    const cutoff = sqlTimestamp(new Date(ctx.now().getTime() - days * DAY_MS));
    return ctx.db.prepare('DELETE FROM trash WHERE deleted_at < ?').run(cutoff).changes;
}

module.exports = { list, restore, remove, empty, purgeTrash };
