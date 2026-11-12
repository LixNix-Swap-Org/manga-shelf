// Trash: a deleted series or volume leaves its tables (so no list, statistic or export can see it) and is kept as JSON
// in `trash` for TRASH_RETENTION_DAYS; core/handlers/trash.js lists, restores and purges it. Reading marks and chapter
// progress sit on the catalog (migration 43) and stay: other shelves holding the edition still show them, and the same
// edition added again (or restored) shows them again. The payload keeps a copy as the shelf showed it.
const { extraCopies } = require('./copies');
const { wishRows } = require('./wishes');

const TRASH_RETENTION_DAYS = 30;

/** 'YYYY-MM-DD HH:MM:SS' in UTC, the form of SQLite's CURRENT_TIMESTAMP. */
const sqlTimestamp = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

const OWNERS_SQL = 'SELECT vo.* FROM volume_owners vo WHERE vo.volume_id = ? ORDER BY vo.created_at, vo.rowid';
const READS_SQL = 'SELECT vr.* FROM shelf_volume_reads vr WHERE vr.volume_id = ? ORDER BY vr.read_at, vr.user_id';

// further copies of a person (migration 56) are not in volume_owners: the payload keeps them as extra_copies
function volumeParts(ctx, volumeIds) {
    const owners = [];
    const reads = [];
    const ownersStmt = ctx.db.prepare(OWNERS_SQL);
    const readsStmt = ctx.db.prepare(READS_SQL);
    for (const id of volumeIds) {
        owners.push(...ownersStmt.all(id));
        reads.push(...readsStmt.all(id));
    }
    return { owners, reads, extra_copies: extraCopies(ctx.db, volumeIds) };
}

// without shelfId, trg_trash_shelf_default (migration 32) gives the entry the shelf of its series
function insertTrash(ctx, { kind, refId, mangaId, title, payload, shelfId }) {
    const result = ctx.db.prepare(`
        INSERT INTO trash (kind, ref_id, manga_id, title, payload, deleted_by, deleted_at, shelf_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(kind, refId, mangaId, title, JSON.stringify(payload), ctx.user?.id ?? null, sqlTimestamp(ctx.now()), shelfId ?? null);
    return Number(result.lastInsertRowid);
}

function deleteVolumeRows(ctx, volumeId) {
    ctx.db.prepare('DELETE FROM volume_copies WHERE volume_id = ?').run(volumeId);
    ctx.db.prepare('DELETE FROM volumes WHERE id = ?').run(volumeId);
}

/**
 * Moves a series with its volumes and owners into the trash (a copy of its reads and chapter progress goes into the
 * payload); call it inside a transaction.
 * Returns the trash id, or null when the series does not exist.
 */
function moveMangaToTrash(ctx, mangaId) {
    const manga = ctx.db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
    if (!manga) return null;
    const volumes = ctx.db.prepare('SELECT * FROM volumes WHERE manga_id = ? ORDER BY id').all(manga.id);
    const { owners, reads, extra_copies } = volumeParts(ctx, volumes.map(v => v.id));
    // the anime linked to its work (core/lib/animeLinks.js): the link stays on the work, the list is for older restores
    const animeIds = manga.work_id ? ctx.db.prepare('SELECT id FROM animes WHERE work_id = ? ORDER BY id').all(manga.work_id).map(r => r.id) : [];
    const chapters = ctx.db.prepare('SELECT * FROM shelf_chapter_progress WHERE manga_id = ? ORDER BY user_id').all(manga.id);
    const trashId = insertTrash(ctx, {
        kind: 'manga', refId: manga.id, mangaId: manga.id, title: manga.title,
        payload: { manga, volumes, owners, reads, extra_copies, anime_ids: animeIds, chapters, wishes: wishRows(ctx.db, manga.id) }, shelfId: manga.shelf_id
    });
    for (const v of volumes) deleteVolumeRows(ctx, v.id);
    ctx.db.prepare('DELETE FROM mangas WHERE id = ?').run(manga.id);
    return trashId;
}

/** Moves one volume (row, owners; a copy of its reads) into the trash; inside a transaction. Returns the trash id or null. */
function moveVolumeToTrash(ctx, volumeId) {
    const volume = ctx.db.prepare('SELECT * FROM volumes WHERE id = ?').get(volumeId);
    if (!volume) return null;
    const series = ctx.db.prepare('SELECT title, shelf_id FROM mangas WHERE id = ?').get(volume.manga_id);
    const { owners, reads, extra_copies } = volumeParts(ctx, [volume.id]);
    const trashId = insertTrash(ctx, {
        kind: 'volume', refId: volume.id, mangaId: volume.manga_id, title: series?.title || '',
        payload: { volume, owners, reads, extra_copies }, shelfId: series?.shelf_id
    });
    deleteVolumeRows(ctx, volume.id);
    return trashId;
}

/** Drops the trash entry of a volume that came back another way (bulk undo). */
function forgetTrashedVolume(ctx, volumeId) {
    ctx.db.prepare("DELETE FROM trash WHERE kind = 'volume' AND ref_id = ?").run(volumeId);
}

module.exports = { TRASH_RETENTION_DAYS, sqlTimestamp, moveMangaToTrash, moveVolumeToTrash, forgetTrashedVolume };
