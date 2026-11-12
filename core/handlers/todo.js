// "Zu erledigen": GET /todo, the open points of the collection in one list, each pointing at its series.
//   gap       a collected series (not dropped, at least one volume owned) with volumes marked missing
//   overdue   a pre-ordered or ordered volume whose release date has passed (probably out: mark it owned)
//   elsewhere a missing volume whose edition volume is owned or ordered in another of the caller's shelves
//   lent      a copy of the caller (or of the household) lent out for LENT_DAYS days or more, per series and borrower
const access = require('../lib/access');
const { qstr } = require('../lib/query');
const { zonedToday } = require('../radar');
const { ownedElsewhere } = require('../lib/ownedElsewhere');
const { volumeOrderSql } = require('../lib/volumeNumber');

const LIMIT = 100;
// a lending this old is worth a reminder ("seit 3 Monaten an Mia verliehen")
const LENT_DAYS = 90;

function todayString(ctx) {
    const d = zonedToday(ctx.now(), ctx.config?.appTimeZone);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todo(ctx, { query }) {
    const shelfIds = access.requestedShelfIds(ctx, qstr(query.shelf_id));
    const scope = access.inShelves('m.shelf_id', shelfIds);
    const items = [];

    const missing = ctx.db.prepare(`
        SELECT v.id, v.manga_id, v.volume_number, m.title, m.cover_image
        FROM volumes v JOIN mangas m ON m.id = v.manga_id
        WHERE v.status = 'Fehlt' AND COALESCE(m.collecting, 'aktiv') <> 'abgebrochen' AND ${scope.sql}
          AND EXISTS (SELECT 1 FROM volumes o WHERE o.manga_id = m.id AND o.status = 'Vorhanden')
        ORDER BY m.title COLLATE NOCASE, m.id, ${volumeOrderSql('v')}
    `).all(...scope.params);
    const elsewhere = ownedElsewhere(ctx, missing.map((v) => v.id));
    const bySeries = new Map();
    for (const v of missing) {
        const entry = bySeries.get(v.manga_id) || { manga_id: v.manga_id, title: v.title, cover_image: v.cover_image, gap: [], elsewhere: [] };
        const other = elsewhere.get(v.id);
        if (other && other.length) entry.elsewhere.push({ volume_id: v.id, volume_number: v.volume_number, shelf_name: other[0].shelf_name, status: other[0].status });
        else entry.gap.push(v.volume_number);
        bySeries.set(v.manga_id, entry);
    }
    for (const e of bySeries.values()) {
        if (e.elsewhere.length) {
            items.push({ kind: 'elsewhere', manga_id: e.manga_id, title: e.title, cover_image: e.cover_image, count: e.elsewhere.length, volumes: e.elsewhere.map((x) => x.volume_number), shelf_name: e.elsewhere[0].shelf_name });
        }
        if (e.gap.length) {
            items.push({ kind: 'gap', manga_id: e.manga_id, title: e.title, cover_image: e.cover_image, count: e.gap.length, volumes: e.gap });
        }
    }

    const overdue = ctx.db.prepare(`
        SELECT v.manga_id, m.title, m.cover_image, v.volume_number, SUBSTR(v.release_date, 1, 10) AS release_date
        FROM volumes v JOIN mangas m ON m.id = v.manga_id
        WHERE v.status IN ('Vorbestellt', 'Bestellt') AND v.release_date IS NOT NULL AND SUBSTR(v.release_date, 1, 10) < ? AND ${scope.sql}
        ORDER BY m.title COLLATE NOCASE, m.id, ${volumeOrderSql('v')}
    `).all(todayString(ctx), ...scope.params);
    const overdueBySeries = new Map();
    for (const v of overdue) {
        const entry = overdueBySeries.get(v.manga_id) || { kind: 'overdue', manga_id: v.manga_id, title: v.title, cover_image: v.cover_image, count: 0, volumes: [] };
        entry.count += 1;
        entry.volumes.push(v.volume_number);
        overdueBySeries.set(v.manga_id, entry);
    }
    items.push(...overdueBySeries.values());

    const lent = ctx.db.prepare(`
        SELECT v.manga_id, m.title, m.cover_image, v.volume_number, COALESCE(b.username, c.lent_to_name) AS lent_to,
               SUBSTR(c.lent_at, 1, 10) AS lent_at, CAST(julianday(?) - julianday(SUBSTR(c.lent_at, 1, 10)) AS INTEGER) AS days
        FROM volume_copies c
        JOIN volumes v ON v.id = c.volume_id
        JOIN mangas m ON m.id = v.manga_id
        LEFT JOIN users b ON b.id = c.lent_to_user_id
        WHERE (c.owner_user_id = ? OR c.owner_user_id IS NULL) AND (c.lent_to_user_id IS NOT NULL OR c.lent_to_name IS NOT NULL)
          AND c.lent_at IS NOT NULL AND julianday(?) - julianday(SUBSTR(c.lent_at, 1, 10)) >= ${LENT_DAYS} AND ${scope.sql}
        ORDER BY m.title COLLATE NOCASE, m.id, ${volumeOrderSql('v')}
    `).all(todayString(ctx), ctx.user.id, todayString(ctx), ...scope.params);
    const lentBySeries = new Map();
    for (const v of lent) {
        const key = `${v.manga_id}\u0000${v.lent_to}`;
        const entry = lentBySeries.get(key) || { kind: 'lent', manga_id: v.manga_id, title: v.title, cover_image: v.cover_image, count: 0, volumes: [], lent_to: v.lent_to, lent_at: v.lent_at, days: v.days };
        entry.count += 1;
        entry.volumes.push(v.volume_number);
        // the oldest lending of the group names how long it has been
        if (v.days > entry.days) Object.assign(entry, { lent_at: v.lent_at, days: v.days });
        lentBySeries.set(key, entry);
    }
    items.push(...lentBySeries.values());

    // what to act on first: owned elsewhere (avoid a double purchase), then overdue orders, long lendings, then gaps
    const rank = { elsewhere: 0, overdue: 1, lent: 2, gap: 3 };
    items.sort((a, b) => rank[a.kind] - rank[b.kind] || String(a.title).localeCompare(String(b.title), 'de', { sensitivity: 'base' }));
    return { body: { total: items.length, items: items.slice(0, LIMIT) } };
}

module.exports = { todo, LENT_DAYS };
