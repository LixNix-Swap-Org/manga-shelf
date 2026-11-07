// Catalog stage 3 (migration 46): the one place that writes edition data into the catalog. A handler writes its row as
// before and wraps the write in track(); afterwards the overlay fields that changed go
//   - into the catalog entry, when the caller may edit every row of it (all in shelves they edit) or the data comes from a
//     source (Manga Passion, AniList): the overlay triggers then carry it into every linked row where the field is not local,
//   - else into local_fields of this row only, so the catalog and the other shelves keep theirs.
// reset() puts catalog values back into a row. Nothing here ever changes a row of another shelf directly.
const access = require('./access');
const { SERIES_OVERLAY_FIELDS, VOLUME_OVERLAY_FIELDS } = require('./catalog');
const { badRequest, conflict } = require('../errors');

const KINDS = {
    series: { table: 'mangas', link: 'catalog_series_id', catalog: 'catalog_series', fields: SERIES_OVERLAY_FIELDS },
    volume: { table: 'volumes', link: 'catalog_volume_id', catalog: 'catalog_volumes', fields: VOLUME_OVERLAY_FIELDS }
};

const hasCatalog = (ctx) => Boolean(ctx.db.prepare("SELECT 1 AS hit FROM pragma_table_info('mangas') WHERE name = 'local_fields'").get());

/** local_fields as an array (never throws on a stored value that is not a JSON list). */
function parseLocal(text) {
    if (!text) return [];
    try {
        const list = JSON.parse(text);
        return Array.isArray(list) ? list.filter(f => typeof f === 'string') : [];
    } catch {
        return [];
    }
}

const storeLocal = (set) => (set.size ? JSON.stringify([...set].sort()) : null);
const same = (a, b) => a === b || ((a === null || a === undefined) && (b === null || b === undefined));

/** Shelves the caller edits, as SQL; an empty list matches nothing. */
function editableScope(ctx, column) {
    const editable = ctx.user ? access.accessibleShelfIds(ctx, 'editor') : [];
    if (!editable.length) return null;
    return { sql: `COALESCE(${column}, 1) NOT IN (${editable.map(() => '?').join(',')})`, params: editable };
}

/** Whether every row of the catalog entry lies in shelves the caller may edit. */
function ownsEntry(ctx, kind, catalogId) {
    const outside = editableScope(ctx, kind === 'series' ? 'shelf_id' : 'm.shelf_id');
    if (!outside) return false;
    const sql = kind === 'series'
        ? `SELECT 1 AS hit FROM mangas WHERE catalog_series_id = ? AND ${outside.sql} LIMIT 1`
        : `SELECT 1 AS hit FROM volumes v JOIN mangas m ON m.id = v.manga_id WHERE v.catalog_volume_id = ? AND ${outside.sql} LIMIT 1`;
    return !ctx.db.prepare(sql).get(catalogId, ...outside.params);
}

/** Catalog series ids with a row outside the shelves the caller has with `minRole` (null: the caller has none at all). */
function seriesOutside(ctx, minRole) {
    const shelves = ctx.user ? access.accessibleShelfIds(ctx, minRole) : [];
    if (!shelves.length) return null;
    return new Set(ctx.db.prepare(`SELECT DISTINCT catalog_series_id AS id FROM mangas
        WHERE catalog_series_id IS NOT NULL AND COALESCE(shelf_id, 1) NOT IN (${shelves.map(() => '?').join(',')})`).all(...shelves).map(r => r.id));
}

/**
 * id -> { editable, resettable } for the catalog series of the caller's rows, with two queries for any number of rows
 * (detail, offline copy). editable: a change goes to the catalog for every shelf (every row in shelves the caller edits).
 * resettable: the catalog values may be shown to the caller (no row in a shelf the caller does not belong to: a catalog
 * value may have come from such a row, even for an entry with a Manga Passion id), so "Auf Katalogstand zurücksetzen"
 * never shows a text of another shelf.
 */
function seriesFlags(ctx) {
    const notEditable = seriesOutside(ctx, 'editor');
    const notReadable = seriesOutside(ctx, 'viewer');
    return (id) => ({
        editable: notEditable !== null && !notEditable.has(id),
        resettable: notReadable !== null && !notReadable.has(id)
    });
}

/** Whether the catalog values of the entry of `kind` may be shown to the caller (see seriesFlags). */
function canSeeEntry(ctx, kind, catalogId) {
    const seriesId = kind === 'series' ? catalogId
        : ctx.db.prepare('SELECT series_id FROM catalog_volumes WHERE id = ?').get(catalogId)?.series_id;
    if (seriesId === undefined || seriesId === null) return false;
    const shelves = ctx.user ? access.accessibleShelfIds(ctx, 'viewer') : [];
    if (!shelves.length) return false;
    return !ctx.db.prepare(`SELECT 1 AS hit FROM mangas WHERE catalog_series_id = ? AND COALESCE(shelf_id, 1) NOT IN (${shelves.map(() => '?').join(',')}) LIMIT 1`)
        .get(seriesId, ...shelves);
}

/** Fields of a volume write the catalog cannot take: an invalid ISBN-13, or an ISBN / Manga Passion id another entry has. */
function volumeConflicts(ctx, row, fields) {
    const out = new Set();
    if (fields.includes('isbn') && row.isbn !== null && row.isbn !== undefined) {
        const valid = /^\d{13}$/.test(String(row.isbn));
        if (!valid || ctx.db.prepare('SELECT 1 AS hit FROM catalog_volumes WHERE isbn = ? AND id <> ?').get(String(row.isbn), row.catalog_volume_id)) out.add('isbn');
    }
    if (fields.includes('manga_passion_volume_id') && row.manga_passion_volume_id !== null && row.manga_passion_volume_id !== undefined
        && ctx.db.prepare('SELECT 1 AS hit FROM catalog_volumes WHERE mp_volume_id = ? AND id <> ?').get(row.manga_passion_volume_id, row.catalog_volume_id)) {
        out.add('manga_passion_volume_id');
    }
    return out;
}

/**
 * After the row of `kind` (series | volume) changed from `before`: sends the changed overlay fields to the catalog or marks
 * them local (see above). Only fields present in `before` count. Returns { catalog: [...], local: [...] } or null.
 * Call it in the transaction of the write.
 */
function commit(ctx, kind, before, { source = false } = {}) {
    const spec = KINDS[kind];
    if (!before || !hasCatalog(ctx)) return null;
    const after = ctx.db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(before.id);
    // no entry, or the identity triggers moved the row to another one (they marked what differs there)
    if (!after || after[spec.link] === null || after[spec.link] === undefined || (spec.link in before && after[spec.link] !== before[spec.link])) return null;
    const changed = Object.keys(spec.fields).filter(f => f in before && !same(before[f], after[f]));
    if (!changed.length) return null;

    const local = new Set(parseLocal(after.local_fields));
    let toCatalog = [];
    if (source || ownsEntry(ctx, kind, after[spec.link])) {
        const conflicts = kind === 'volume' ? volumeConflicts(ctx, after, changed) : new Set();
        toCatalog = changed.filter(f => !conflicts.has(f));
        for (const f of toCatalog) local.delete(f);
        for (const f of conflicts) local.add(f);
    } else {
        for (const f of changed) local.add(f);
    }
    const stored = storeLocal(local);
    if (stored !== (after.local_fields ?? null)) ctx.db.prepare(`UPDATE ${spec.table} SET local_fields = ? WHERE id = ?`).run(stored, after.id);
    if (toCatalog.length) {
        ctx.db.prepare(`UPDATE ${spec.catalog} SET ${toCatalog.map(f => `${spec.fields[f]} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(...toCatalog.map(f => after[f] ?? null), after[spec.link]);
    }
    return { catalog: toCatalog, local: changed.filter(f => !toCatalog.includes(f)) };
}

/** Runs write() (a row write of `kind` id `id`) and commits its overlay changes; returns what write() returned. */
function track(ctx, kind, id, write, options = {}) {
    const before = hasCatalog(ctx) ? ctx.db.prepare(`SELECT * FROM ${KINDS[kind].table} WHERE id = ?`).get(id) : null;
    const result = write();
    if (before) commit(ctx, kind, before, options);
    return result;
}

/**
 * Puts the catalog values of `fields` (default: every local field) back into the row and drops them from local_fields.
 * Returns the remaining local fields, or null when the row has no catalog entry; 409 CATALOG_PRIVATE when the caller may
 * not see the entry's values (canSeeEntry).
 */
function reset(ctx, kind, id, fields = null) {
    const spec = KINDS[kind];
    const row = ctx.db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(id);
    if (!row || row[spec.link] === null || row[spec.link] === undefined) return null;
    if (!canSeeEntry(ctx, kind, row[spec.link])) {
        throw conflict('Diese Ausgabe steht auch in einem Regal, das du nicht siehst. Ihre Katalogwerte lassen sich hier nicht übernehmen.', 'CATALOG_PRIVATE');
    }
    const local = new Set(parseLocal(row.local_fields));
    const wanted = (fields || [...local]).filter(f => f in spec.fields);
    const entry = ctx.db.prepare(`SELECT * FROM ${spec.catalog} WHERE id = ?`).get(row[spec.link]);
    if (!entry) return [...local].sort();
    // the title of a series is never empty
    const take = wanted.filter(f => !(f === 'title' && !entry.title));
    for (const f of take) local.delete(f);
    const sets = take.map(f => `${f} = ?`);
    ctx.db.prepare(`UPDATE ${spec.table} SET ${[...sets, 'local_fields = ?'].join(', ')} WHERE id = ?`)
        .run(...take.map(f => entry[spec.fields[f]] ?? null), storeLocal(local), id);
    return [...local].sort();
}

/** `fields` of a reset body: null (every local field) or a list of overlay fields of `kind`; anything else is a 400. */
function readResetFields(body, kind) {
    const raw = body && body.fields;
    if (raw === undefined || raw === null) return null;
    if (!Array.isArray(raw) || raw.length > 50 || raw.some(f => typeof f !== 'string' || !(f in KINDS[kind].fields))) {
        throw badRequest('Ungültige Parameter');
    }
    return [...new Set(raw)];
}

module.exports = { KINDS, parseLocal, ownsEntry, seriesFlags, canSeeEntry, commit, track, reset, readResetFields };
