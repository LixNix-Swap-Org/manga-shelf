// Reading marks and chapter progress on the catalog (migration 42): volume_reads is keyed by catalog_volume_id and
// chapter_progress by catalog_series_id, so a volume read in one shelf counts as read in every shelf that holds the same
// catalog volume. Leaving a shelf or moving a series deletes nothing; a mark only shows where its user is a member.
//
// Read shapes: the views shelf_volume_reads (volume_id, user_id, read_at) and shelf_chapter_progress (manga_id, user_id,
// chapters_read, updated_at) list the marks per shelf row, limited to members of the row's shelf. They are read-only:
// every write goes through the helpers below (or straight into the catalog tables).

/** The views (read shapes per shelf row, members of the row's shelf only). */
const MARK_VIEWS_SQL = `
    CREATE VIEW IF NOT EXISTS shelf_volume_reads AS
        SELECT v.id AS volume_id, r.user_id, r.read_at
        FROM volume_reads r
        JOIN volumes v ON v.catalog_volume_id = r.catalog_volume_id
        JOIN mangas m ON m.id = v.manga_id
        JOIN shelf_members sm ON sm.shelf_id = m.shelf_id AND sm.user_id = r.user_id;
    CREATE VIEW IF NOT EXISTS shelf_chapter_progress AS
        SELECT m.id AS manga_id, p.user_id, p.chapters_read, p.updated_at
        FROM chapter_progress p
        JOIN mangas m ON m.catalog_series_id = p.catalog_series_id
        JOIN shelf_members sm ON sm.shelf_id = m.shelf_id AND sm.user_id = p.user_id;`;

const MARK_VIEWS = ['shelf_volume_reads', 'shelf_chapter_progress'];

// Members of the shelf of series row `mangaId` (an SQL expression)
const membersOf = (mangaId) => `SELECT sm.user_id FROM shelf_members sm JOIN mangas g ON g.shelf_id = sm.shelf_id WHERE g.id = ${mangaId}`;

/**
 * A row that moves to another catalog entry (a volume number or series identity corrected, see core/lib/catalog.js) takes
 * the marks its shelf's members see there along; the old entry keeps a mark only while its user still sees it elsewhere.
 */
const MARK_FOLLOW_TRIGGERS_SQL = `
    CREATE TRIGGER trg_volumes_reads_follow AFTER UPDATE OF catalog_volume_id ON volumes
    WHEN OLD.catalog_volume_id IS NOT NULL AND NEW.catalog_volume_id IS NOT NULL AND NEW.catalog_volume_id <> OLD.catalog_volume_id BEGIN
        INSERT OR IGNORE INTO volume_reads (catalog_volume_id, user_id, read_at)
        SELECT NEW.catalog_volume_id, r.user_id, r.read_at FROM volume_reads r
         WHERE r.catalog_volume_id = OLD.catalog_volume_id AND r.user_id IN (${membersOf('NEW.manga_id')});
        DELETE FROM volume_reads
         WHERE catalog_volume_id = OLD.catalog_volume_id AND user_id IN (${membersOf('NEW.manga_id')})
           AND NOT EXISTS (SELECT 1 FROM volumes o JOIN mangas om ON om.id = o.manga_id
                           JOIN shelf_members osm ON osm.shelf_id = om.shelf_id AND osm.user_id = volume_reads.user_id
                           WHERE o.catalog_volume_id = OLD.catalog_volume_id);
    END;
    CREATE TRIGGER trg_mangas_chapters_follow AFTER UPDATE OF catalog_series_id ON mangas
    WHEN OLD.catalog_series_id IS NOT NULL AND NEW.catalog_series_id IS NOT NULL AND NEW.catalog_series_id <> OLD.catalog_series_id BEGIN
        INSERT OR IGNORE INTO chapter_progress (catalog_series_id, user_id, chapters_read, updated_at)
        SELECT NEW.catalog_series_id, p.user_id, p.chapters_read, p.updated_at FROM chapter_progress p
         WHERE p.catalog_series_id = OLD.catalog_series_id AND p.user_id IN (${membersOf('NEW.id')});
        DELETE FROM chapter_progress
         WHERE catalog_series_id = OLD.catalog_series_id AND user_id IN (${membersOf('NEW.id')})
           AND NOT EXISTS (SELECT 1 FROM mangas o JOIN shelf_members osm ON osm.shelf_id = o.shelf_id AND osm.user_id = chapter_progress.user_id
                           WHERE o.catalog_series_id = OLD.catalog_series_id);
    END;`;

const MARK_FOLLOW_TRIGGERS = ['trg_volumes_reads_follow', 'trg_mangas_chapters_follow'];

const hasColumn = (d, table, column) => d.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);

/** Whether volume_reads is keyed by the catalog already (migration 42 ran). */
const marksOnCatalog = (d) => hasColumn(d, 'volume_reads', 'catalog_volume_id');

/** Whether chapter_progress is keyed by the catalog already (migration 42 ran). */
const chaptersOnCatalog = (d) => hasColumn(d, 'chapter_progress', 'catalog_series_id');

/**
 * Before the catalog is rebuilt (migration 40 replayed after 42): the marks by the shelf rows that show them. Every row
 * holding a catalog entry gets the mark, so it survives whatever the rebuild merges or splits. Each table only once
 * it is keyed by the catalog.
 */
function stashMarks(d) {
    const stash = { reads: [], chapters: [] };
    if (marksOnCatalog(d)) {
        stash.reads = d.prepare(`SELECT v.id AS volume_id, r.user_id, r.read_at FROM volume_reads r
            JOIN volumes v ON v.catalog_volume_id = r.catalog_volume_id ORDER BY v.id, r.user_id`).all();
        d.exec('DELETE FROM volume_reads;');
    }
    if (chaptersOnCatalog(d)) {
        stash.chapters = d.prepare(`SELECT m.id AS manga_id, p.user_id, p.chapters_read, p.updated_at FROM chapter_progress p
            JOIN mangas m ON m.catalog_series_id = p.catalog_series_id ORDER BY m.id, p.user_id`).all();
        d.exec('DELETE FROM chapter_progress;');
    }
    return stash;
}

/** Puts stashed marks back on the rebuilt catalog (the earliest read, the highest chapter win). */
function restoreMarks(d, stash) {
    if (stash.reads.length) restoreReads(d, stash.reads);
    if (stash.chapters.length) restoreChapters(d, stash.chapters);
}

function restoreReads(d, reads) {
    const read = d.prepare(`INSERT INTO volume_reads (catalog_volume_id, user_id, read_at)
        SELECT catalog_volume_id, ?, ? FROM volumes WHERE id = ? AND catalog_volume_id IS NOT NULL
        ON CONFLICT (catalog_volume_id, user_id) DO UPDATE SET read_at = CASE
            WHEN volume_reads.read_at IS NULL THEN excluded.read_at
            WHEN excluded.read_at IS NULL THEN volume_reads.read_at
            ELSE min(volume_reads.read_at, excluded.read_at) END`);
    for (const r of reads) read.run(r.user_id, r.read_at, r.volume_id);
}

function restoreChapters(d, chapters) {
    const chapter = d.prepare(`INSERT INTO chapter_progress (catalog_series_id, user_id, chapters_read, updated_at)
        SELECT catalog_series_id, ?, ?, ? FROM mangas WHERE id = ? AND catalog_series_id IS NOT NULL
        ON CONFLICT (catalog_series_id, user_id) DO UPDATE SET chapters_read = max(chapter_progress.chapters_read, excluded.chapters_read),
            updated_at = max(chapter_progress.updated_at, excluded.updated_at)`);
    for (const c of chapters) chapter.run(c.user_id, c.chapters_read, c.updated_at, c.manga_id);
}

/**
 * Marks volume `volumeId` read for `userId`. `readAt` undefined: now; null: read, date unknown; else the stored text.
 * `replace`: an existing mark takes the new date. Returns true when a row was written.
 */
function addRead(db, volumeId, userId, readAt, { replace = false } = {}) {
    const at = readAt === undefined ? 'CURRENT_TIMESTAMP' : '?';
    const params = readAt === undefined ? [userId, volumeId] : [userId, readAt, volumeId];
    return db.prepare(`INSERT OR ${replace ? 'REPLACE' : 'IGNORE'} INTO volume_reads (catalog_volume_id, user_id, read_at)
        SELECT catalog_volume_id, ?, ${at} FROM volumes WHERE id = ? AND catalog_volume_id IS NOT NULL`).run(...params).changes > 0;
}

/** Removes the read mark of `userId` on volume `volumeId` (in every shelf holding it); the removed row ({ read_at }) or null. */
function removeRead(db, volumeId, userId) {
    return db.prepare(`DELETE FROM volume_reads WHERE catalog_volume_id = (SELECT catalog_volume_id FROM volumes WHERE id = ?) AND user_id = ?
        RETURNING read_at`).get(volumeId, userId) || null;
}

/** The read mark { read_at } of `userId` on volume `volumeId` as its shelf shows it, or null. */
function readOf(db, volumeId, userId) {
    return db.prepare('SELECT read_at FROM shelf_volume_reads WHERE volume_id = ? AND user_id = ?').get(volumeId, userId) || null;
}

/**
 * Sets the chapter of `userId` in series `mangaId`: replaces the stored one (`ifMissing`: only when there is none);
 * updated_at now unless given.
 */
function setChapterProgress(db, mangaId, userId, chapters, { updatedAt = null, ifMissing = false } = {}) {
    const at = updatedAt === null || updatedAt === undefined ? 'CURRENT_TIMESTAMP' : '?';
    const params = at === '?' ? [userId, chapters, updatedAt, mangaId] : [userId, chapters, mangaId];
    db.prepare(`INSERT OR ${ifMissing ? 'IGNORE' : 'REPLACE'} INTO chapter_progress (catalog_series_id, user_id, chapters_read, updated_at)
        SELECT catalog_series_id, ?, ?, ${at} FROM mangas WHERE id = ? AND catalog_series_id IS NOT NULL`).run(...params);
}

/** Removes the chapter of `userId` in series `mangaId` (in every shelf holding the edition). */
function clearChapterProgress(db, mangaId, userId) {
    db.prepare('DELETE FROM chapter_progress WHERE catalog_series_id = (SELECT catalog_series_id FROM mangas WHERE id = ?) AND user_id = ?')
        .run(mangaId, userId);
}

module.exports = {
    MARK_VIEWS_SQL,
    MARK_VIEWS,
    MARK_FOLLOW_TRIGGERS_SQL,
    MARK_FOLLOW_TRIGGERS,
    marksOnCatalog,
    chaptersOnCatalog,
    stashMarks,
    restoreMarks,
    addRead,
    removeRead,
    readOf,
    setChapterProgress,
    clearChapterProgress
};
