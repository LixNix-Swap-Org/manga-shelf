// Guard against buying a volume twice: the same edition volume (catalog_volume_id) owned or ordered in another row the
// caller can see. Only the caller's own shelves count (accessibleShelfIds), so the answer never names a foreign shelf.
const { accessibleShelfIds, inShelves } = require('./access');

const OWNED = 'Vorhanden';
const ORDERED = ['Vorbestellt', 'Bestellt'];
const CHUNK = 400;

/**
 * volume id -> [{ shelf_id, shelf_name, status: 'owned' | 'ordered', owners: [usernames] }] for every given volume whose
 * edition volume is owned or ordered in another row of the caller's shelves (owned first, then by shelf name). Volumes
 * without such a row are left out of the map. `owners` names the personal copies; a household copy names nobody.
 */
function ownedElsewhere(ctx, volumeIds) {
    const ids = [...new Set(volumeIds.map(Number).filter(Number.isSafeInteger))];
    const shelfIds = accessibleShelfIds(ctx);
    const result = new Map();
    if (!ids.length || !shelfIds.length) return result;
    const shelves = inShelves('m.shelf_id', shelfIds);
    const rows = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
        const part = ids.slice(i, i + CHUNK);
        rows.push(...ctx.db.prepare(`
            SELECT x.id AS volume_id, o.id AS other_id, o.status, m.shelf_id, s.name AS shelf_name
            FROM volumes x
            JOIN volumes o ON o.catalog_volume_id = x.catalog_volume_id AND o.id <> x.id
            JOIN mangas m ON m.id = o.manga_id
            JOIN shelves s ON s.id = m.shelf_id
            WHERE x.id IN (${part.map(() => '?').join(',')}) AND x.catalog_volume_id IS NOT NULL
              AND o.status IN ('${OWNED}', ${ORDERED.map(s => `'${s}'`).join(', ')}) AND ${shelves.sql}
            ORDER BY o.id
        `).all(...part, ...shelves.params));
    }
    if (!rows.length) return result;

    const owners = new Map();
    const others = [...new Set(rows.filter(r => r.status === OWNED).map(r => r.other_id))];
    for (let i = 0; i < others.length; i += CHUNK) {
        const part = others.slice(i, i + CHUNK);
        for (const r of ctx.db.prepare(`
            SELECT c.volume_id, u.username FROM volume_copies c JOIN users u ON u.id = c.owner_user_id
            WHERE c.volume_id IN (${part.map(() => '?').join(',')}) ORDER BY c.created_at, c.id
        `).all(...part)) {
            if (!owners.has(r.volume_id)) owners.set(r.volume_id, []);
            owners.get(r.volume_id).push(r.username);
        }
    }

    for (const r of rows) {
        const status = r.status === OWNED ? 'owned' : 'ordered';
        if (!result.has(r.volume_id)) result.set(r.volume_id, []);
        const list = result.get(r.volume_id);
        let entry = list.find(e => e.shelf_id === r.shelf_id && e.status === status);
        if (!entry) {
            entry = { shelf_id: r.shelf_id, shelf_name: r.shelf_name, status, owners: [] };
            list.push(entry);
        }
        for (const name of owners.get(r.other_id) || []) if (!entry.owners.includes(name)) entry.owners.push(name);
    }
    for (const list of result.values()) {
        list.sort((a, b) => (a.status === b.status ? 0 : a.status === 'owned' ? -1 : 1)
            || String(a.shelf_name).localeCompare(String(b.shelf_name)) || a.shelf_id - b.shelf_id);
    }
    return result;
}

module.exports = { ownedElsewhere };
