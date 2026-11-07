// Copying a series, or the volumes it lacks, from another shelf of the caller (catalog stage c2).
// Everything here reads only the caller's own shelves: a shelf the caller does not belong to is never searched, named
// or counted, so no answer tells whether another shelf holds an edition. The copy takes the values of the caller's own
// row, never the catalog's (a catalog value may be the text of a shelf the caller never saw); the link triggers then
// tie the copy to the same catalog entry and mark what differs from it as local.
const { badRequest, notFound, conflict, msg } = require('../errors');
const access = require('../lib/access');
const { qstr } = require('../lib/query');
const { canonicalVolumeNumber } = require('../lib/volumeNumber');
const { parseIdList } = require('../lib/validate');

const MAX_CANDIDATES = 5;
const MIN_QUERY = 2;
const MAX_QUERY = 100;
const MAX_VOLUME_IDS = 1000;

// the series fields a copy takes; the wish, the collecting state and everything per person stay behind
const SERIES_COLUMNS = ['title', 'alt_title', 'author', 'publisher', 'language', 'region', 'currency', 'work_key', 'status', 'tags',
    'total_volumes', 'description', 'cover_image', 'banner_image', 'manga_passion_id', 'format', 'total_chapters'];
// the edition data of a volume; price paid, condition, notes, photos, the wish and the owners stay with the person
const VOLUME_COLUMNS = ['volume_number', 'type', 'isbn', 'price', 'release_date', 'release_year', 'pages', 'publisher', 'language',
    'cover_image', 'manga_passion_volume_id', 'sort_after'];

/** Lower case, without accents, ß as ss, every run of other characters one space. */
const fold = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/ß/g, 'ss').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const volumeKey = (row) => `${row.type || 'volume'}\n${canonicalVolumeNumber(row.volume_number, row.type || 'volume').toLowerCase()}`;

const placeholders = (list) => list.map(() => '?').join(',');

/** Catalog entries that already have a row in the shelf. */
const entriesIn = (ctx, shelfId) => new Set(ctx.db.prepare('SELECT DISTINCT catalog_series_id AS id FROM mangas WHERE shelf_id = ? AND catalog_series_id IS NOT NULL')
    .all(shelfId).map(r => r.id));

/** 0: the whole title, 1: its start, 2: a word inside; null when the query is not in it. */
function rankOf(row, query) {
    let best = null;
    for (const title of [row.title, row.alt_title]) {
        const key = fold(title);
        if (!key) continue;
        const rank = key === query ? 0 : key.startsWith(query) ? 1 : key.includes(query) ? 2 : null;
        if (rank !== null && (best === null || rank < best)) best = rank;
    }
    return best;
}

/**
 * GET /mangas/copy-candidates?q=&shelf_id=: series of the caller's other shelves whose title contains `q` and whose
 * edition the target shelf (an editable one, default the one POST /mangas would pick) does not hold yet. One series
 * per edition (the one with the most volumes), at most five.
 */
function candidates(ctx, { query }) {
    const target = access.targetShelfId(ctx, qstr(query.shelf_id));
    const text = fold(qstr(query.q)).slice(0, MAX_QUERY);
    if (text.length < MIN_QUERY) return { body: { shelf_id: target, results: [] } };
    const shelves = access.accessibleShelfIds(ctx, 'viewer').filter(id => id !== target);
    if (!shelves.length) return { body: { shelf_id: target, results: [] } };
    const present = entriesIn(ctx, target);
    const rows = ctx.db.prepare(`
        SELECT m.id, m.title, m.alt_title, m.author, m.publisher, m.language, m.format, m.cover_image, m.shelf_id,
               m.catalog_series_id, s.name AS shelf_name
        FROM mangas m JOIN shelves s ON s.id = m.shelf_id
        WHERE m.shelf_id IN (${placeholders(shelves)})
    `).all(...shelves);
    const hits = [];
    for (const row of rows) {
        if (row.catalog_series_id !== null && present.has(row.catalog_series_id)) continue;
        const rank = rankOf(row, text);
        if (rank !== null) hits.push({ ...row, rank });
    }
    if (!hits.length) return { body: { shelf_id: target, results: [] } };
    const counts = new Map(ctx.db.prepare(`SELECT manga_id, COUNT(*) AS n FROM volumes WHERE manga_id IN (${placeholders(hits)}) GROUP BY manga_id`)
        .all(...hits.map(h => h.id)).map(r => [r.manga_id, r.n]));
    // one series per edition: the one with the most volumes, then the oldest
    const byEntry = new Map();
    for (const hit of hits) {
        hit.volume_count = counts.get(hit.id) || 0;
        const key = hit.catalog_series_id ?? `row:${hit.id}`;
        const kept = byEntry.get(key);
        if (!kept || hit.volume_count > kept.volume_count || (hit.volume_count === kept.volume_count && hit.id < kept.id)) byEntry.set(key, hit);
    }
    const results = [...byEntry.values()]
        .sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title, 'de') || a.id - b.id)
        .slice(0, MAX_CANDIDATES)
        .map((hit) => {
            const out = { ...hit };
            delete out.rank;
            delete out.catalog_series_id;
            return out;
        });
    return { body: { shelf_id: target, results } };
}

/** The series `raw` names, after checking that the caller may read it (404 otherwise). */
function readableSeries(ctx, raw) {
    const id = access.parseId(raw);
    if (!id) throw badRequest('from muss die ID einer Reihe sein');
    access.mangaAccess(ctx, id, 'viewer');
    return ctx.db.prepare('SELECT * FROM mangas WHERE id = ?').get(id);
}

/** The new status of a copied volume: an announced one stays announced, everything else is missing. */
const copiedStatus = (status) => (status === 'Erscheint bald' ? 'Erscheint bald' : 'Fehlt');

/** Inserts copies of `volumes` into the series `mangaId`, skipping a type and number it already has; returns the new ids. */
function insertVolumes(ctx, mangaId, volumes) {
    const taken = new Set(ctx.db.prepare('SELECT volume_number, type FROM volumes WHERE manga_id = ?').all(mangaId).map(volumeKey));
    const insert = ctx.db.prepare(`INSERT INTO volumes (manga_id, status, ${VOLUME_COLUMNS.join(', ')}) VALUES (?, ?, ${placeholders(VOLUME_COLUMNS)})`);
    const created = [];
    for (const volume of volumes) {
        const key = volumeKey(volume);
        if (taken.has(key)) continue;
        taken.add(key);
        created.push(Number(insert.run(mangaId, copiedStatus(volume.status), ...VOLUME_COLUMNS.map(c => volume[c] ?? null)).lastInsertRowid));
    }
    return created;
}

const volumesOf = (ctx, mangaId) => ctx.db.prepare('SELECT * FROM volumes WHERE manga_id = ? ORDER BY id').all(mangaId);

/**
 * POST /mangas/copy { from, shelf_id?, volumes? }: the series `from` (any shelf the caller reads) as a new series in
 * the target shelf, with its volumes as missing ones when `volumes` is true. 409 COPY_EXISTS when the target shelf
 * already holds the edition (a shelf of the caller, so the answer tells nothing new).
 */
function copySeries(ctx, { body }) {
    const source = readableSeries(ctx, body.from);
    const target = access.targetShelfId(ctx, body.shelf_id);
    if (body.volumes !== undefined && typeof body.volumes !== 'boolean') throw badRequest('volumes muss true oder false sein');
    let existing = null;
    if (source.shelf_id === target) existing = source;
    else if (source.catalog_series_id !== null) {
        existing = ctx.db.prepare('SELECT id FROM mangas WHERE shelf_id = ? AND catalog_series_id = ? ORDER BY id LIMIT 1').get(target, source.catalog_series_id) || null;
    }
    if (existing) throw conflict(msg('Diese Ausgabe steht schon in diesem Regal'), 'COPY_EXISTS', { existing_id: existing.id });
    let id = null;
    let created = [];
    ctx.db.transaction(() => {
        id = Number(ctx.db.prepare(`INSERT INTO mangas (${SERIES_COLUMNS.join(', ')}, collecting, updated_by, shelf_id) VALUES (${placeholders(SERIES_COLUMNS)}, 'aktiv', ?, ?)`)
            .run(...SERIES_COLUMNS.map(c => source[c] ?? null), ctx.user.id, target).lastInsertRowid);
        if (body.volumes === true) created = insertVolumes(ctx, id, volumesOf(ctx, source.id));
    });
    return { status: 201, body: { success: true, id, shelf_id: target, volumes_created: created.length } };
}

/** Rows of the caller's shelves (other than `manga`) that show the same edition, with the volumes `manga` lacks. */
function missingFrom(ctx, manga) {
    if (manga.catalog_series_id === null || manga.catalog_series_id === undefined) return [];
    const shelves = access.accessibleShelfIds(ctx, 'viewer');
    if (!shelves.length) return [];
    const rows = ctx.db.prepare(`
        SELECT m.id, m.shelf_id, s.name AS shelf_name FROM mangas m JOIN shelves s ON s.id = m.shelf_id
        WHERE m.catalog_series_id = ? AND m.id <> ? AND m.shelf_id IN (${placeholders(shelves)}) ORDER BY m.id
    `).all(manga.catalog_series_id, manga.id, ...shelves);
    if (!rows.length) return [];
    const taken = new Set(ctx.db.prepare('SELECT volume_number, type FROM volumes WHERE manga_id = ?').all(manga.id).map(volumeKey));
    const out = [];
    for (const row of rows) {
        const volumes = volumesOf(ctx, row.id).filter(v => !taken.has(volumeKey(v)));
        if (volumes.length) out.push({ ...row, volumes });
    }
    return out;
}

const loadSeries = (ctx, id) => {
    const manga = ctx.db.prepare('SELECT id, shelf_id, catalog_series_id FROM mangas WHERE id = ?').get(id);
    if (!manga) throw notFound('Manga');
    return manga;
};

/** GET /mangas/:id/volume-sources: per other series of the same edition in the caller's shelves, the volumes this one lacks. */
function volumeSources(ctx, { params }) {
    access.mangaAccess(ctx, params.id, 'editor');
    const sources = missingFrom(ctx, loadSeries(ctx, Number(params.id))).map(row => ({
        manga_id: row.id,
        shelf_id: row.shelf_id,
        shelf_name: row.shelf_name,
        volumes: row.volumes.map(v => ({ id: v.id, volume_number: v.volume_number, type: v.type, release_date: v.release_date }))
    }));
    return { body: { sources } };
}

/** POST /mangas/:id/volumes/copy { from, volume_ids? }: copies the volumes of `from` this series lacks (all or the named ones) as missing ones. */
function copyVolumes(ctx, { params, body }) {
    const manga = loadSeries(ctx, Number(params.id));
    const fromId = access.parseId(body.from);
    if (!fromId) throw badRequest('from muss die ID einer Reihe sein');
    const source = missingFrom(ctx, manga).find(row => row.id === fromId);
    if (!source) {
        // a series the caller cannot read stays a 404; one they can read is just not the same edition
        readableSeries(ctx, fromId);
        throw badRequest('Diese Reihe ist nicht dieselbe Ausgabe oder hat keine fehlenden Bände');
    }
    let volumes = source.volumes;
    if (body.volume_ids !== undefined) {
        const ids = parseIdList(body.volume_ids, MAX_VOLUME_IDS);
        if (ids.error) throw badRequest(msg('volume_ids muss eine Liste von 1 bis {max} Band-IDs sein', { max: MAX_VOLUME_IDS }));
        const wanted = new Set(ids.value);
        volumes = volumes.filter(v => wanted.has(v.id));
    }
    let created = [];
    ctx.db.transaction(() => { created = insertVolumes(ctx, manga.id, volumes); });
    return { body: { success: true, created } };
}

module.exports = { candidates, copySeries, volumeSources, copyVolumes };
