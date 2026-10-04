// Trash: a deleted series or volume leaves its tables (so no list, statistic or export can see it) and is kept as JSON
// in `trash` for TRASH_RETENTION_DAYS; core/handlers/trash.js lists, restores and purges it.
const TRASH_RETENTION_DAYS = 30;

/** 'YYYY-MM-DD HH:MM:SS' in UTC, the form of SQLite's CURRENT_TIMESTAMP. */
const sqlTimestamp = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

const OWNERS_SQL = 'SELECT vo.* FROM volume_owners vo WHERE vo.volume_id = ? ORDER BY vo.created_at, vo.rowid';
const READS_SQL = 'SELECT vr.* FROM volume_reads vr WHERE vr.volume_id = ? ORDER BY vr.read_at, vr.user_id';

function volumeParts(ctx, volumeIds) {
    const owners = [];
    const reads = [];
    const ownersStmt = ctx.db.prepare(OWNERS_SQL);
    const readsStmt = ctx.db.prepare(READS_SQL);
    for (const id of volumeIds) {
        owners.push(...ownersStmt.all(id));
        reads.push(...readsStmt.all(id));
    }
    return { owners, reads };
}

function insertTrash(ctx, { kind, refId, mangaId, title, payload }) {
    const result = ctx.db.prepare(`
        INSERT INTO trash (kind, ref_id, manga_id, title, payload, deleted_by, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(kind, refId, mangaId, title, JSON.stringify(payload), ctx.user?.id ?? null, sqlTimestamp(ctx.now()));
    return Number(result.lastInsertRowid);
}

function deleteVolumeRows(ctx, volumeId) {
    ctx.db.prepare('DELETE FROM volume_reads WHERE volume_id = ?').run(volumeId);
    ctx.db.prepare('DELETE FROM volume_owners WHERE volume_id = ?').run(volumeId);
    ctx.db.prepare('DELETE FROM volumes WHERE id = ?').run(volumeId);
}

/**
 * Moves a series with its volumes, owners and reads into the trash; call it inside a transaction.
 * Returns the trash id, or null when the series does not exist.
 */
function moveMangaToTrash(ctx, mangaId) {
    const manga = ctx.db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
    if (!manga) return null;
    const volumes = ctx.db.prepare('SELECT * FROM volumes WHERE manga_id = ? ORDER BY id').all(manga.id);
    const { owners, reads } = volumeParts(ctx, volumes.map(v => v.id));
    const animeIds = ctx.db.prepare('SELECT id FROM animes WHERE manga_id = ? ORDER BY id').all(manga.id).map(r => r.id);
    const trashId = insertTrash(ctx, {
        kind: 'manga', refId: manga.id, mangaId: manga.id, title: manga.title,
        payload: { manga, volumes, owners, reads, anime_ids: animeIds }
    });
    for (const v of volumes) deleteVolumeRows(ctx, v.id);
    ctx.db.prepare('DELETE FROM mangas WHERE id = ?').run(manga.id);
    return trashId;
}

/** Moves one volume (row, owners, reads) into the trash; inside a transaction. Returns the trash id or null. */
function moveVolumeToTrash(ctx, volumeId) {
    const volume = ctx.db.prepare('SELECT * FROM volumes WHERE id = ?').get(volumeId);
    if (!volume) return null;
    const series = ctx.db.prepare('SELECT title FROM mangas WHERE id = ?').get(volume.manga_id);
    const { owners, reads } = volumeParts(ctx, [volume.id]);
    const trashId = insertTrash(ctx, {
        kind: 'volume', refId: volume.id, mangaId: volume.manga_id, title: series?.title || '',
        payload: { volume, owners, reads }
    });
    deleteVolumeRows(ctx, volume.id);
    return trashId;
}

/** Drops the trash entry of a volume that came back another way (bulk undo). */
function forgetTrashedVolume(ctx, volumeId) {
    ctx.db.prepare("DELETE FROM trash WHERE kind = 'volume' AND ref_id = ?").run(volumeId);
}

module.exports = { TRASH_RETENTION_DAYS, sqlTimestamp, moveMangaToTrash, moveVolumeToTrash, forgetTrashedVolume };
