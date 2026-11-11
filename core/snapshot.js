// Series list, series detail and the offline snapshot: the read shapes of GET /mangas, /mangas/:id, /offline-snapshot.
const { regularNumberedSql, volumeOrderSql } = require('./lib/volumeNumber');
const access = require('./lib/access');
const catalogWrite = require('./lib/catalogWrite');
const { copiesByVolume, attachCopies } = require('./lib/copies');

// Series per block of the offline snapshot; between blocks other requests get the event loop. Tests lower it.
const options = { chunkSize: 200 };

const REGULAR = regularNumberedSql('v');
const VOLUME_SEARCH_NOTE_MAX = 200;
const VOLUME_SEARCH_MAX = 4000;

/**
 * Search text of series m: ISBNs, named volume numbers, then notes, one per line (plain numbers would match
 * nearly everything); notes are cut to 200 characters, the field to 4000. A subquery: the volume_reads join repeats values.
 */
const VOLUME_SEARCH_SQL = `(SELECT SUBSTR(GROUP_CONCAT(t, char(10)), 1, ${VOLUME_SEARCH_MAX}) FROM (
                       SELECT 0 AS part, id, isbn AS t FROM volumes WHERE manga_id = m.id AND isbn IS NOT NULL AND TRIM(isbn) <> ''
                       UNION ALL
                       SELECT 1, id, volume_number FROM volumes WHERE manga_id = m.id AND volume_number GLOB '*[^0-9.]*'
                       UNION ALL
                       SELECT 2, id, SUBSTR(notes, 1, ${VOLUME_SEARCH_NOTE_MAX}) FROM volumes WHERE manga_id = m.id AND notes IS NOT NULL AND TRIM(notes) <> ''
                       ORDER BY part, id
                   ))`;

/**
 * Series list with aggregates for the dashboard (also the snapshot's `mangas`), without detail-only columns.
 * wished (0|1): wish_priority set and no volume owned. { volumeSearch: true } adds volume_search (snapshot only).
 * One row per volume: the volume_reads join is on its primary key (catalog_volume_id, user_id) for one user, so plain
 * COUNTs and SUMs are exact; only regular_owned counts distinct numbers. The marks of `userId` need no member check:
 * the list only holds shelves `userId` belongs to (the caller's own).
 */
function listMangas(ctx, userId, { volumeSearch = false, shelfIds = access.accessibleShelfIds(ctx) } = {}) {
    const scope = access.inShelves('m.shelf_id', shelfIds);
    return ctx.db.prepare(`
            SELECT m.id, m.title, m.alt_title, m.author, m.publisher, m.language, m.status, m.tags, m.total_volumes,
                   COUNT(CASE WHEN v.status = 'Vorhanden' THEN v.id END) as owned_volumes,
                   m.cover_image, m.banner_image, m.manga_passion_id, m.created_at, m.updated_at, m.updated_by, m.wish_priority,
                   m.collecting, m.region, m.work_key, m.work_id, m.currency, m.shelf_id, m.format, m.total_chapters,
                   COALESCE((SELECT cp.chapters_read FROM chapter_progress cp WHERE cp.catalog_series_id = m.catalog_series_id AND cp.user_id = ?), 0) as chapters_read,
                   COUNT(CASE WHEN v.status = 'Fehlt' THEN v.id END) as missing_count,
                   COUNT(CASE WHEN v.status IN ('Vorbestellt', 'Bestellt') THEN v.id END) as preorder_count,
                   CASE WHEN m.wish_priority IS NOT NULL AND COUNT(CASE WHEN v.status = 'Vorhanden' THEN 1 END) = 0 THEN 1 ELSE 0 END as wished,
                   COALESCE(SUM(CASE WHEN v.status = 'Vorhanden' THEN v.price ELSE 0 END), 0) as total_value,
                   COALESCE(SUM(v.price), 0) as full_value,
                   COUNT(v.id) as volume_count,
                   COUNT(DISTINCT CASE WHEN v.status = 'Vorhanden' AND ${REGULAR} THEN v.number_sort END) as regular_owned, -- distinct numbers: a duplicate entry does not raise progress
                   MAX(CASE WHEN ${REGULAR} THEN v.number_sort END) as max_regular_number, -- highest existing regular number, any status: a missing volume 4 keeps 3 of 3 from being complete
                   COUNT(CASE WHEN v.status = 'Vorhanden' AND NOT ${REGULAR} THEN v.id END) as extras_owned,
                   (SELECT GROUP_CONCAT(o.person, char(10)) FROM (
                        SELECT DISTINCT vo.user_id || char(9) || u.username AS person
                        FROM volume_owners vo JOIN volumes ov ON ov.id = vo.volume_id JOIN users u ON u.id = vo.user_id
                        WHERE ov.manga_id = m.id ORDER BY vo.user_id) o) as owners, -- "id<TAB>name" per line: the person filter of the shelf
                   COUNT(CASE WHEN v.status = 'Vorhanden' THEN vr.catalog_volume_id END) as read_volume_count${volumeSearch ? `,
                   ${VOLUME_SEARCH_SQL} as volume_search` : ''}
            FROM mangas m
            LEFT JOIN volumes v ON m.id = v.manga_id
            LEFT JOIN volume_reads vr ON vr.catalog_volume_id = v.catalog_volume_id AND vr.user_id = ?
            WHERE ${scope.sql}
            GROUP BY m.id
            ORDER BY m.title ASC
        `).all(userId, userId, ...scope.params);
}

/** GET /mangas/volume-search: [{ id, volume_search }] by series id, only series with something to search. */
function listVolumeSearch(ctx, shelfIds = access.accessibleShelfIds(ctx)) {
    const scope = access.inShelves('m.shelf_id', shelfIds);
    return ctx.db.prepare(`
            SELECT id, volume_search FROM (SELECT m.id, ${VOLUME_SEARCH_SQL} AS volume_search FROM mangas m WHERE ${scope.sql})
            WHERE volume_search IS NOT NULL
            ORDER BY id
        `).all(...scope.params);
}

/** Columns the triggers keep and no answer shows: number_sort (migration 15) and the catalog link (migration 41). */
const INTERNAL_VOLUME_COLUMNS = new Set(['number_sort', 'catalog_volume_id']);

/** volumes.* without the internal columns, in table order (the API shape of a volume). */
function volumeColumns(ctx) {
    const info = ctx.db.prepare('PRAGMA table_info(volumes)').all();
    const columns = new Set(info.map(c => c.name));
    // "Zuletzt geändert von" (migration 55): the name of the account, null once it is deleted
    return info
        .filter(c => !INTERNAL_VOLUME_COLUMNS.has(c.name))
        .map(c => `v."${c.name.replace(/"/g, '""')}"`)
        .concat(columns.has('updated_by') ? ['(SELECT u.username FROM users u WHERE u.id = v.updated_by) AS updated_by_name'] : [])
        .join(', ');
}

const READS_SELECT = `
        SELECT vr.volume_id, vr.user_id, u.username, vr.read_at
        FROM shelf_volume_reads vr
        JOIN users u ON vr.user_id = u.id`;

const OWNERS_SELECT = `
        SELECT vo.volume_id, vo.user_id, u.username, vo.price, vo.purchase_date, vo.condition, vo.created_at
        FROM volume_owners vo
        JOIN users u ON vo.user_id = u.id`;

const CHAPTERS_SELECT = `
        SELECT cp.manga_id, cp.user_id, u.username, cp.chapters_read, cp.updated_at
        FROM shelf_chapter_progress cp
        JOIN users u ON cp.user_id = u.id`;

const USERS_SQL = 'SELECT id, username, role FROM users ORDER BY id ASC';
const MEMBERS_SQL = 'SELECT shelf_id, user_id FROM shelf_members';

/** shelf id -> Set of member user ids */
function loadMembers(ctx) {
    const byShelf = new Map();
    for (const r of ctx.db.prepare(MEMBERS_SQL).all()) {
        if (!byShelf.has(r.shelf_id)) byShelf.set(r.shelf_id, new Set());
        byShelf.get(r.shelf_id).add(r.user_id);
    }
    return byShelf;
}

/**
 * Readers and owners of a series are the members of its shelf, the caller, and anyone who already read or owns one of
 * its volumes (a removed member's history stays visible). Other accounts of the server never show up.
 */
function usersOfSeries(users, members, manga, userId, volumes, readsByVolume, ownersByVolume) {
    const keep = new Set(members.get(manga.shelf_id) || []);
    keep.add(userId);
    for (const v of volumes) {
        for (const r of readsByVolume.get(v.id) || []) keep.add(r.user_id);
        for (const o of ownersByVolume.get(v.id) || []) keep.add(o.user_id);
    }
    return users.filter(u => keep.has(u.id));
}

// other editions of a work (same work_key): what the edition switcher shows
const EDITIONS_SELECT = `
        SELECT m.id, m.title, m.language, m.region, m.currency, m.publisher, m.cover_image, m.owned_volumes,
               (SELECT count(*) FROM volumes v WHERE v.manga_id = m.id) AS volume_count, m.work_key, m.shelf_id, m.catalog_series_id
        FROM mangas m`;
const EDITIONS_ORDER = 'ORDER BY m.language, m.id';

/**
 * The other editions of `manga` from rows of its work (any order), in the detail shape. A row of the same catalog entry
 * (the same edition in another shelf, e.g. a copy from POST /mangas/copy) is no other edition and stays out.
 */
function editionsOf(manga, rows) {
    if (!manga.work_key) return [];
    const entry = manga.catalog_series_id ?? null;
    return rows.filter(r => r.work_key === manga.work_key && r.id !== manga.id && (entry === null || r.catalog_series_id !== entry))
        .sort((a, b) => (a.language < b.language ? -1 : a.language > b.language ? 1 : a.id - b.id))
        .map(({ work_key, shelf_id, catalog_series_id, ...edition }) => edition);
}

/** GET /mangas/:id `editions`: the other series sharing the work key of `manga`. */
function loadEditions(ctx, manga) {
    if (!manga.work_key) return [];
    const scope = access.inShelves('m.shelf_id', access.accessibleShelfIds(ctx));
    return editionsOf(manga, ctx.db.prepare(`${EDITIONS_SELECT} WHERE m.work_key = ? AND ${scope.sql} ${EDITIONS_ORDER}`).all(manga.work_key, ...scope.params));
}

function groupBy(rows, key) {
    const map = new Map();
    for (const row of rows) {
        const list = map.get(row[key]);
        if (list) list.push(row);
        else map.set(row[key], [row]);
    }
    return map;
}

/**
 * Turns a mangas row plus its volumes (already in display order) into the detail shape of GET /mangas/:id:
 * owners, read info, parsed images, values, reader_stats and the chapter progress (`chapters`: its chapter_progress
 * rows). Shared by the detail route and the offline snapshot.
 */
function buildMangaDetail(manga, volumes, readsByVolume, ownersByVolume, users, userId, editions = [], chapters = [], catalogFlags = null) {
    delete manga.manga_passion_edition_data;
    // the catalog entry (migration 41) and what this shelf set itself (migration 46): never anything about a shelf the
    // caller does not belong to (catalogWrite.seriesFlags), and no catalog id (a reused id would tell the entry existed)
    manga.catalog = catalogWrite.view(manga.catalog_series_id, manga.local_fields, manga.catalog_source_fields, catalogFlags);
    delete manga.catalog_series_id;
    delete manga.catalog_source_fields;
    delete manga.local_fields;
    manga.editions = editions;
    manga.volumes = volumes;
    manga.chapter_progress = chapters.map(r => ({ user_id: r.user_id, username: r.username, chapters_read: r.chapters_read, updated_at: r.updated_at }));
    manga.chapters_read = chapters.find(r => r.user_id === userId)?.chapters_read || 0;

    let total_value = 0;
    let full_value = 0;
    let ownedCount = 0;
    const readCounts = new Map();
    // per person: owned volumes with an own copy, and how many of those they read ("4 von deinen 8" on the chip)
    const ownCounts = new Map();
    const ownReadCounts = new Map();
    for (const v of volumes) {
        const p = typeof v.price === 'number' ? v.price : (parseFloat(v.price) || 0);
        const owned = v.status === 'Vorhanden';
        if (owned) {
            total_value += p;
            ownedCount++;
        }
        full_value += p;

        v.owners = (ownersByVolume.get(v.id) || []).map(o => ({
            user_id: o.user_id, username: o.username, price: o.price, purchase_date: o.purchase_date, condition: o.condition, created_at: o.created_at
        }));
        v.owned_by_me = v.owners.some(o => o.user_id === userId);
        delete v.local_fields;   // a volume reset exists (POST /volumes/:id/catalog-reset), the interface does not use it yet

        // both keys: POST /volumes/:id/read answers with user_id, older clients read id
        v.read_users = (readsByVolume.get(v.id) || []).map(r => ({ id: r.user_id, user_id: r.user_id, username: r.username, read_at: r.read_at }));
        v.read_by = v.read_users.map(u => u.id);
        v.is_read = v.read_by.includes(userId);
        // reads stay when a volume is sold or lent out, but progress only counts owned volumes
        if (owned) for (const id of v.read_by) readCounts.set(id, (readCounts.get(id) || 0) + 1);
        if (owned) {
            for (const id of new Set(v.owners.map(o => o.user_id))) {
                ownCounts.set(id, (ownCounts.get(id) || 0) + 1);
                if (v.read_by.includes(id)) ownReadCounts.set(id, (ownReadCounts.get(id) || 0) + 1);
            }
        }

        try {
            if (v.images) {
                v.images = Array.isArray(v.images) ? v.images : JSON.parse(v.images);
            } else if (v.cover_image) {
                v.images = [v.cover_image];
            } else {
                v.images = [];
            }
        } catch (e) {
            v.images = v.cover_image ? [v.cover_image] : [];
        }
        if (!v.cover_image && v.images.length > 0) {
            v.cover_image = v.images[0];
        }
    }
    manga.owned_volumes = ownedCount;
    manga.wished = manga.wish_priority !== null && manga.wish_priority !== undefined && ownedCount === 0 ? 1 : 0;
    manga.total_value = Math.round(total_value * 100) / 100;
    manga.full_value = Math.round(full_value * 100) / 100;

    manga.reader_stats = users.map(u => {
        const count = readCounts.get(u.id) || 0;
        return {
            user_id: u.id,
            username: u.username,
            role: u.role,
            read_count: count,
            total_owned: ownedCount,
            unread_count: ownedCount - count,
            percentage: ownedCount > 0 ? Math.min(100, Math.round((count / ownedCount) * 100)) : 0,
            own_owned: ownCounts.get(u.id) || 0,
            own_read: ownReadCounts.get(u.id) || 0
        };
    });
    return manga;
}

/** Full series detail (volumes with read info, values, reader stats) as served by GET /mangas/:id; null if missing. */
function loadMangaDetail(ctx, mangaId, userId) {
    const manga = ctx.db.prepare(`SELECT *, (SELECT c.source_fields FROM catalog_series c WHERE c.id = mangas.catalog_series_id) AS catalog_source_fields FROM mangas WHERE id = ?`).get(mangaId);
    if (!manga || !access.accessibleShelfIds(ctx).includes(manga.shelf_id)) return null;
    const volumes = ctx.db.prepare(`SELECT ${volumeColumns(ctx)} FROM volumes v WHERE v.manga_id = ? ORDER BY ${volumeOrderSql('v')}, v.id ASC`).all(mangaId);
    const reads = ctx.db.prepare(`${READS_SELECT} JOIN volumes v ON vr.volume_id = v.id WHERE v.manga_id = ? ORDER BY vr.read_at, vr.user_id`).all(mangaId);
    const owners = ctx.db.prepare(`${OWNERS_SELECT} JOIN volumes v ON vo.volume_id = v.id WHERE v.manga_id = ? ORDER BY vo.created_at, vo.rowid`).all(mangaId);
    const users = ctx.db.prepare(USERS_SQL).all();
    const readsByVolume = groupBy(reads, 'volume_id');
    const ownersByVolume = groupBy(owners, 'volume_id');
    const scoped = usersOfSeries(users, loadMembers(ctx), manga, userId, volumes, readsByVolume, ownersByVolume);
    const chapters = ctx.db.prepare(`${CHAPTERS_SELECT} WHERE cp.manga_id = ? ORDER BY cp.user_id`).all(mangaId);
    const flags = manga.catalog_series_id === null || manga.catalog_series_id === undefined ? null
        : catalogWrite.seriesFlags(ctx)(manga.catalog_series_id);
    // every copy of a volume: price, date and condition per copy, and who borrowed it (migration 47)
    return attachCopies(buildMangaDetail(manga, volumes, readsByVolume, ownersByVolume, scoped, userId, loadEditions(ctx, manga), chapters, flags),
        copiesByVolume(ctx.db, 'v.manga_id = ?', [mangaId]));
}

function assertSameConnection(ctx, generation) {
    if (ctx.db.generation() === generation) return;
    const err = new Error('Die Datenbank wurde während der Offline-Kopie neu geöffnet');
    err.status = 503;
    throw err;
}

/**
 * The collection for the client's read-only offline copy: { generated_at, user, mangas, details[id] }.
 * Built in blocks, so blocks may see slightly different states; a database reopened meanwhile (restore) fails the build.
 */
async function buildOfflineSnapshot(ctx, user, shelfIds = access.accessibleShelfIds(ctx)) {
    const generation = ctx.db.generation();
    const mangas = listMangas(ctx, user.id, { volumeSearch: true, shelfIds });
    await ctx.yield();
    assertSameConnection(ctx, generation);

    const shelfScope = access.inShelves('shelf_id', shelfIds);
    const series = ctx.db.prepare(`SELECT *, (SELECT c.source_fields FROM catalog_series c WHERE c.id = mangas.catalog_series_id) AS catalog_source_fields FROM mangas WHERE ${shelfScope.sql} ORDER BY id`).all(...shelfScope.params);
    const users = ctx.db.prepare(USERS_SQL).all();
    const members = loadMembers(ctx);
    const editionScope = access.inShelves('m.shelf_id', shelfIds);
    const editionsByWork = groupBy(ctx.db.prepare(`${EDITIONS_SELECT} WHERE m.work_key IS NOT NULL AND ${editionScope.sql} ${EDITIONS_ORDER}`).all(...editionScope.params), 'work_key');
    const volumesStmt = ctx.db.prepare(`SELECT ${volumeColumns(ctx)} FROM volumes v WHERE v.manga_id BETWEEN ? AND ? ORDER BY v.manga_id, ${volumeOrderSql('v')}, v.id ASC`);
    const readsStmt = ctx.db.prepare(`${READS_SELECT} JOIN volumes v ON vr.volume_id = v.id WHERE v.manga_id BETWEEN ? AND ? ORDER BY vr.volume_id, vr.read_at, vr.user_id`);
    const ownersStmt = ctx.db.prepare(`${OWNERS_SELECT} JOIN volumes v ON vo.volume_id = v.id WHERE v.manga_id BETWEEN ? AND ? ORDER BY vo.volume_id, vo.created_at, vo.rowid`);
    const chaptersStmt = ctx.db.prepare(`${CHAPTERS_SELECT} WHERE cp.manga_id BETWEEN ? AND ? ORDER BY cp.manga_id, cp.user_id`);

    const flagsOf = catalogWrite.seriesFlags(ctx);
    const details = {};
    const size = Math.max(1, options.chunkSize);
    for (let i = 0; i < series.length; i += size) {
        if (i > 0) {
            await ctx.yield();
            assertSameConnection(ctx, generation);
        }
        const block = series.slice(i, i + size);
        const from = block[0].id;
        const to = block[block.length - 1].id;
        const volumesByManga = groupBy(volumesStmt.all(from, to), 'manga_id');
        const readsByVolume = groupBy(readsStmt.all(from, to), 'volume_id');
        const ownersByVolume = groupBy(ownersStmt.all(from, to), 'volume_id');
        const chaptersByManga = groupBy(chaptersStmt.all(from, to), 'manga_id');
        const copies = copiesByVolume(ctx.db, 'v.manga_id BETWEEN ? AND ?', [from, to]);
        for (const m of block) {
            const volumes = volumesByManga.get(m.id) || [];
            details[m.id] = attachCopies(buildMangaDetail(m, volumes, readsByVolume, ownersByVolume,
                usersOfSeries(users, members, m, user.id, volumes, readsByVolume, ownersByVolume), user.id,
                editionsOf(m, editionsByWork.get(m.work_key) || []), chaptersByManga.get(m.id) || [],
                m.catalog_series_id === null ? null : flagsOf(m.catalog_series_id)), copies);
        }
    }
    assertSameConnection(ctx, generation);
    return {
        generated_at: ctx.now().toISOString(),
        user: { id: user.id, username: user.username, role: user.role },
        mangas,
        details
    };
}

module.exports = { options, listMangas, listVolumeSearch, loadMangaDetail, loadEditions, buildMangaDetail, buildOfflineSnapshot };
