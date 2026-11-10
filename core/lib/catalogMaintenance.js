// Upkeep of the global catalog (catalog stage c3): entries nobody shows any more go, and the console gets the figures.
//
// A catalog entry outlived its last series until now. That kept reading marks and chapters for an edition someone may
// add again, but it also kept texts of series long deleted and, through its existence, the fact that somebody on the
// server once had that edition. The purge deletes what nothing needs any more:
// - a catalog volume no volume row links to and nobody has a reading mark on;
// - a catalog series no series row links to, nobody has chapter progress on and whose catalog volumes all go.
// Marks keep their entry: they show again when the edition comes back (core/lib/marks.js). A series in the trash does
// not keep its entry; the restore relinks it like a new series (RELINKED_COLUMNS), and its copy of the marks comes
// back where the catalog lost them (core/handlers/trash.js).

/** Row columns a restore or an undo never writes back: the insert triggers relink the row and mark what differs. */
const RELINKED_COLUMNS = {
    mangas: ['catalog_series_id', 'local_fields'],
    volumes: ['catalog_volume_id', 'local_fields']
};

const ORPHAN_VOLUMES_SQL = `SELECT c.id FROM catalog_volumes c
    WHERE NOT EXISTS (SELECT 1 FROM volumes v WHERE v.catalog_volume_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM volume_reads r WHERE r.catalog_volume_id = c.id)`;

const ORPHAN_SERIES_SQL = `SELECT c.id FROM catalog_series c
    WHERE NOT EXISTS (SELECT 1 FROM mangas m WHERE m.catalog_series_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM chapter_progress p WHERE p.catalog_series_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM catalog_volumes v WHERE v.series_id = c.id AND v.id NOT IN (${ORPHAN_VOLUMES_SQL}))`;

// catalog_merge_log names a catalog series for every kind but volume_isbn, which names a catalog volume
const LOG_OF_VOLUMES = "kind = 'volume_isbn'";

const changesOf = (result) => Number(result && result.changes) || 0;

/** True once the catalog of migration 41 and the marks on it (migration 43) exist. */
const hasCatalog = (db) => Boolean(db.prepare("SELECT 1 AS hit FROM pragma_table_info('volume_reads') WHERE name = 'catalog_volume_id'").get());

/**
 * Deletes the catalog volumes and series nothing needs any more (see the header) in one transaction of `ctx.db`;
 * returns { volumes, series } (how many went).
 */
function purgeOrphans(ctx) {
    const db = ctx.db;
    if (!hasCatalog(db)) return { volumes: 0, series: 0 };
    let report = { volumes: 0, series: 0 };
    db.transaction(() => {
        db.prepare(`DELETE FROM catalog_merge_log WHERE ${LOG_OF_VOLUMES} AND catalog_id IN (${ORPHAN_VOLUMES_SQL})`).run();
        const volumes = changesOf(db.prepare(`DELETE FROM catalog_volumes WHERE id IN (${ORPHAN_VOLUMES_SQL})`).run());
        db.prepare(`DELETE FROM catalog_merge_log WHERE NOT (${LOG_OF_VOLUMES}) AND catalog_id IN (${ORPHAN_SERIES_SQL})`).run();
        const series = changesOf(db.prepare(`DELETE FROM catalog_series WHERE id IN (${ORPHAN_SERIES_SQL})`).run());
        report = { volumes, series };
    });
    return report;
}

/**
 * Figures for the server console (`katalog`): entries, how many editions sit in more than one shelf, rows with fields
 * of their own, what the purge would take, and the merge log by kind. Reads every shelf: the console is admin access.
 */
function stats(db) {
    if (!hasCatalog(db)) return null;
    const one = (sql) => db.prepare(sql).get().n;
    return {
        series: one('SELECT count(*) AS n FROM catalog_series'),
        volumes: one('SELECT count(*) AS n FROM catalog_volumes'),
        shared: one('SELECT count(*) AS n FROM (SELECT catalog_series_id FROM mangas WHERE catalog_series_id IS NOT NULL GROUP BY catalog_series_id HAVING count(DISTINCT shelf_id) > 1)'),
        localSeries: one('SELECT count(*) AS n FROM mangas WHERE local_fields IS NOT NULL'),
        localVolumes: one('SELECT count(*) AS n FROM volumes WHERE local_fields IS NOT NULL'),
        orphanSeries: one(`SELECT count(*) AS n FROM (${ORPHAN_SERIES_SQL})`),
        orphanVolumes: one(`SELECT count(*) AS n FROM (${ORPHAN_VOLUMES_SQL})`),
        log: db.prepare('SELECT kind, count(*) AS n FROM catalog_merge_log GROUP BY kind ORDER BY kind').all()
    };
}

/** The newest `limit` rows of the merge log (what the backfill of migration 41 papered over). */
const mergeLog = (db, limit = 20) => db.prepare('SELECT id, kind, catalog_id, old_ids, detail, created_at FROM catalog_merge_log ORDER BY id DESC LIMIT ?').all(limit);

module.exports = { RELINKED_COLUMNS, purgeOrphans, stats, mergeLog };
