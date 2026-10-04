// Series list, series detail and the offline snapshot: the read shapes of GET /mangas, /mangas/:id, /offline-snapshot.
const { regularNumberedSql, volumeOrderSql } = require('./lib/volumeNumber');

// Series per block of the offline snapshot; between blocks other requests get the event loop. Tests lower it.
const options = { chunkSize: 200 };

const REGULAR = regularNumberedSql('v');
// volume_search travels with every list answer: notes are cut, the whole field is capped per series
const VOLUME_SEARCH_NOTE_MAX = 200;
const VOLUME_SEARCH_MAX = 4000;

/**
 * Series list with aggregates for the dashboard (also the snapshot's `mangas`). description and
 * manga_passion_edition_data are left out (only the detail view needs them); owned_volumes is counted live.
 * wished (0|1): wish_priority is set and no volume is owned (the one rule for chip, shopping list and statistics).
 * missing_count counts 'Fehlt' volumes, preorder_count 'Vorbestellt' and 'Bestellt' ones (shelf filters next to collecting).
 * volume_search feeds the dashboard search: ISBNs, then named volume numbers, then notes, one per line (plain numbers
 * would match nearly every series), each note cut to 200 characters and the field to 4000; the short entries come first
 * so the cap only ever cuts notes. A subquery, because the join with volume_reads would repeat values.
 */
function listMangas(ctx, userId) {
    return ctx.db.prepare(`
            SELECT m.id, m.title, m.alt_title, m.author, m.publisher, m.language, m.status, m.tags, m.total_volumes,
                   COUNT(DISTINCT CASE WHEN v.status = 'Vorhanden' THEN v.id END) as owned_volumes,
                   m.cover_image, m.banner_image, m.manga_passion_id, m.created_at, m.updated_at, m.updated_by, m.wish_priority,
                   m.collecting,
                   COUNT(DISTINCT CASE WHEN v.status = 'Fehlt' THEN v.id END) as missing_count,
                   COUNT(DISTINCT CASE WHEN v.status IN ('Vorbestellt', 'Bestellt') THEN v.id END) as preorder_count,
                   CASE WHEN m.wish_priority IS NOT NULL AND COUNT(CASE WHEN v.status = 'Vorhanden' THEN 1 END) = 0 THEN 1 ELSE 0 END as wished,
                   COALESCE(SUM(CASE WHEN v.status = 'Vorhanden' THEN v.price ELSE 0 END), 0) as total_value,
                   COALESCE(SUM(v.price), 0) as full_value,
                   COUNT(DISTINCT v.id) as volume_count,
                   COUNT(DISTINCT CASE WHEN v.status = 'Vorhanden' AND ${REGULAR} THEN v.number_sort END) as regular_owned, -- distinct numbers: a duplicate entry does not raise progress
                   MAX(CASE WHEN v.status = 'Vorhanden' AND ${REGULAR} THEN v.number_sort END) as max_regular_number,
                   COUNT(DISTINCT CASE WHEN v.status = 'Vorhanden' AND NOT ${REGULAR} THEN v.id END) as extras_owned,
                   COUNT(DISTINCT CASE WHEN v.status = 'Vorhanden' THEN vr.volume_id END) as read_volume_count,
                   (SELECT SUBSTR(GROUP_CONCAT(t, char(10)), 1, ${VOLUME_SEARCH_MAX}) FROM (
                       SELECT 0 AS part, id, isbn AS t FROM volumes WHERE manga_id = m.id AND isbn IS NOT NULL AND TRIM(isbn) <> ''
                       UNION ALL
                       SELECT 1, id, volume_number FROM volumes WHERE manga_id = m.id AND volume_number GLOB '*[^0-9.]*'
                       UNION ALL
                       SELECT 2, id, SUBSTR(notes, 1, ${VOLUME_SEARCH_NOTE_MAX}) FROM volumes WHERE manga_id = m.id AND notes IS NOT NULL AND TRIM(notes) <> ''
                       ORDER BY part, id
                   )) as volume_search
            FROM mangas m
            LEFT JOIN volumes v ON m.id = v.manga_id
            LEFT JOIN volume_reads vr ON v.id = vr.volume_id AND vr.user_id = ?
            GROUP BY m.id
            ORDER BY m.title ASC
        `).all(userId);
}

/** volumes.* without the internal number_sort, in table order (the API shape of a volume). */
function volumeColumns(ctx) {
    return ctx.db.prepare('PRAGMA table_info(volumes)').all()
        .filter(c => c.name !== 'number_sort')
        .map(c => `v."${c.name.replace(/"/g, '""')}"`)
        .join(', ');
}

const READS_SELECT = `
        SELECT vr.volume_id, vr.user_id, u.username
        FROM volume_reads vr
        JOIN users u ON vr.user_id = u.id`;

const OWNERS_SELECT = `
        SELECT vo.volume_id, vo.user_id, u.username, vo.price, vo.purchase_date
        FROM volume_owners vo
        JOIN users u ON vo.user_id = u.id`;

const USERS_SQL = 'SELECT id, username, role FROM users ORDER BY id ASC';

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
 * owners, read info, parsed images, values and reader_stats. Shared by the detail route and the offline snapshot.
 */
function buildMangaDetail(manga, volumes, readsByVolume, ownersByVolume, users, userId) {
    delete manga.manga_passion_edition_data;
    manga.volumes = volumes;

    let total_value = 0;
    let full_value = 0;
    let ownedCount = 0;
    const readCounts = new Map();
    for (const v of volumes) {
        const p = typeof v.price === 'number' ? v.price : (parseFloat(v.price) || 0);
        const owned = v.status === 'Vorhanden';
        if (owned) {
            total_value += p;
            ownedCount++;
        }
        full_value += p;

        v.owners = (ownersByVolume.get(v.id) || []).map(o => ({ user_id: o.user_id, username: o.username, price: o.price, purchase_date: o.purchase_date }));
        v.owned_by_me = v.owners.some(o => o.user_id === userId);

        // both keys: POST /volumes/:id/read answers with user_id, older clients read id
        v.read_users = (readsByVolume.get(v.id) || []).map(r => ({ id: r.user_id, user_id: r.user_id, username: r.username }));
        v.read_by = v.read_users.map(u => u.id);
        v.is_read = v.read_by.includes(userId);
        // reads stay when a volume is sold or lent out, but progress only counts owned volumes
        if (owned) for (const id of v.read_by) readCounts.set(id, (readCounts.get(id) || 0) + 1);

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
            percentage: ownedCount > 0 ? Math.min(100, Math.round((count / ownedCount) * 100)) : 0
        };
    });
    return manga;
}

/** Full series detail (volumes with read info, values, reader stats) as served by GET /mangas/:id; null if missing. */
function loadMangaDetail(ctx, mangaId, userId) {
    const manga = ctx.db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
    if (!manga) return null;
    const volumes = ctx.db.prepare(`SELECT ${volumeColumns(ctx)} FROM volumes v WHERE v.manga_id = ? ORDER BY ${volumeOrderSql('v')}, v.id ASC`).all(mangaId);
    const reads = ctx.db.prepare(`${READS_SELECT} JOIN volumes v ON vr.volume_id = v.id WHERE v.manga_id = ? ORDER BY vr.read_at, vr.user_id`).all(mangaId);
    const owners = ctx.db.prepare(`${OWNERS_SELECT} JOIN volumes v ON vo.volume_id = v.id WHERE v.manga_id = ? ORDER BY vo.created_at, vo.rowid`).all(mangaId);
    const users = ctx.db.prepare(USERS_SQL).all();
    return buildMangaDetail(manga, volumes, groupBy(reads, 'volume_id'), groupBy(owners, 'volume_id'), users, userId);
}

function assertSameConnection(ctx, generation) {
    if (ctx.db.generation() === generation) return;
    const err = new Error('Die Datenbank wurde während der Offline-Kopie neu geöffnet');
    err.status = 503;
    throw err;
}

/**
 * The whole collection for the client's read-only offline copy: { generated_at, user, mangas, details } with
 * mangas = GET /mangas and details[id] = GET /mangas/:id of the same user. Built in blocks of series with a fixed
 * set of statements; other requests run between blocks, so blocks may see slightly different states (fine for an
 * offline copy). A database reopened meanwhile (restore) fails the build instead of mixing two databases.
 */
async function buildOfflineSnapshot(ctx, user) {
    const generation = ctx.db.generation();
    const mangas = listMangas(ctx, user.id);
    await ctx.yield();
    assertSameConnection(ctx, generation);

    const series = ctx.db.prepare('SELECT * FROM mangas ORDER BY id').all();
    const users = ctx.db.prepare(USERS_SQL).all();
    const volumesStmt = ctx.db.prepare(`SELECT ${volumeColumns(ctx)} FROM volumes v WHERE v.manga_id BETWEEN ? AND ? ORDER BY v.manga_id, ${volumeOrderSql('v')}, v.id ASC`);
    const readsStmt = ctx.db.prepare(`${READS_SELECT} JOIN volumes v ON vr.volume_id = v.id WHERE v.manga_id BETWEEN ? AND ? ORDER BY vr.volume_id, vr.read_at, vr.user_id`);
    const ownersStmt = ctx.db.prepare(`${OWNERS_SELECT} JOIN volumes v ON vo.volume_id = v.id WHERE v.manga_id BETWEEN ? AND ? ORDER BY vo.volume_id, vo.created_at, vo.rowid`);

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
        for (const m of block) {
            details[m.id] = buildMangaDetail(m, volumesByManga.get(m.id) || [], readsByVolume, ownersByVolume, users, user.id);
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

module.exports = { options, listMangas, loadMangaDetail, buildMangaDetail, buildOfflineSnapshot };
