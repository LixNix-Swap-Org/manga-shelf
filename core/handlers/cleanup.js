// "Sammlung aufräumen": GET /maintenance/quality (data-quality checks), POST /maintenance/fix (the safe fixes).
const { badRequest } = require('../errors');
const { isValidIsbn } = require('../lib/isbn');
const { normalizePublisher, isKnownPublisher } = require('../lib/publishers');
const { migrateLegacyReadStatus } = require('../lib/owners');
const { zonedToday } = require('../radar');

const ITEM_LIMIT = 50;

const SERIES_CHECKS = [
    { id: 'series_without_cover', where: "(m.cover_image IS NULL OR TRIM(m.cover_image) = '')" },
    { id: 'series_without_mp_link', where: 'm.manga_passion_id IS NULL' },
    { id: 'series_without_author', where: "(m.author IS NULL OR TRIM(m.author) = '')" },
    { id: 'series_without_total', where: 'm.total_volumes IS NULL' }
];

const OWNED = "v.status = 'Vorhanden'";
const VOLUME_CHECKS = [
    { id: 'volumes_without_price', where: `${OWNED} AND v.price IS NULL` },
    { id: 'volumes_without_purchase_date', where: `${OWNED} AND (v.purchase_date IS NULL OR TRIM(v.purchase_date) = '')` },
    { id: 'volumes_without_isbn', where: `${OWNED} AND (v.isbn IS NULL OR TRIM(v.isbn) = '')` },
    { id: 'legacy_read_status', where: "LOWER(TRIM(v.status)) = 'gelesen'", fix: 'legacy_read' }
];

const VOLUME_SELECT = `
    SELECT v.id, v.manga_id, m.title, v.volume_number, v.type, v.status, v.isbn, v.release_date
    FROM volumes v JOIN mangas m ON m.id = v.manga_id`;
const VOLUME_ORDER = 'ORDER BY m.title COLLATE NOCASE, v.number_sort, v.id';

function seriesCheck(ctx, { id, where }) {
    const count = ctx.db.prepare(`SELECT count(*) AS n FROM mangas m WHERE ${where}`).get().n;
    const items = count ? ctx.db.prepare(`SELECT m.id, m.title, m.publisher, m.cover_image FROM mangas m WHERE ${where} ORDER BY m.title COLLATE NOCASE LIMIT ${ITEM_LIMIT}`).all() : [];
    return { id, count, items };
}

function volumeCheck(ctx, { id, where, fix }, params = []) {
    const count = ctx.db.prepare(`SELECT count(*) AS n FROM volumes v JOIN mangas m ON m.id = v.manga_id WHERE ${where}`).get(...params).n;
    const items = count ? ctx.db.prepare(`${VOLUME_SELECT} WHERE ${where} ${VOLUME_ORDER} LIMIT ${ITEM_LIMIT}`).all(...params) : [];
    return fix ? { id, count, items, fix } : { id, count, items };
}

/** Series sharing a title (case and spaces ignored); same title with another publisher is often a second edition. */
function duplicateTitles(ctx) {
    const groups = ctx.db.prepare(`
        SELECT LOWER(TRIM(title)) AS key FROM mangas GROUP BY key HAVING count(*) > 1 ORDER BY key
    `).all();
    const members = ctx.db.prepare(`
        SELECT m.id, m.title, m.publisher, m.cover_image, (SELECT count(*) FROM volumes v WHERE v.manga_id = m.id) AS volume_count
        FROM mangas m WHERE LOWER(TRIM(m.title)) = ? ORDER BY m.id
    `);
    const items = groups.slice(0, ITEM_LIMIT).map(g => {
        const series = members.all(g.key);
        return { key: g.key, title: series[0]?.title || g.key, series };
    });
    return { id: 'duplicate_titles', count: groups.length, items };
}

function invalidIsbns(ctx) {
    const rows = ctx.db.prepare(`${VOLUME_SELECT} WHERE v.isbn IS NOT NULL AND TRIM(v.isbn) <> '' ${VOLUME_ORDER}`).all()
        .filter(v => !isValidIsbn(v.isbn));
    return { id: 'invalid_isbns', count: rows.length, items: rows.slice(0, ITEM_LIMIT) };
}

/** Distinct publisher spellings that are not canonical: unknown names, and stored spellings the aliases would change. */
function publisherChecks(ctx) {
    const counts = new Map();
    for (const table of ['mangas', 'volumes']) {
        for (const r of ctx.db.prepare(`SELECT publisher AS name, count(*) AS n FROM ${table} WHERE publisher IS NOT NULL AND TRIM(publisher) <> '' GROUP BY publisher`).all()) {
            const entry = counts.get(r.name) || { name: r.name, series_count: 0, volume_count: 0 };
            entry[table === 'mangas' ? 'series_count' : 'volume_count'] += r.n;
            counts.set(r.name, entry);
        }
    }
    const all = [...counts.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
    const outdated = all.filter(p => normalizePublisher(p.name) !== p.name).map(p => ({ ...p, canonical: normalizePublisher(p.name) }));
    const unknown = all.filter(p => normalizePublisher(p.name) === p.name && !isKnownPublisher(p.name));
    return [
        { id: 'publishers_outdated', count: outdated.length, items: outdated.slice(0, ITEM_LIMIT), fix: 'normalize_publishers' },
        { id: 'publishers_unknown', count: unknown.length, items: unknown.slice(0, ITEM_LIMIT) }
    ];
}

function todayString(ctx) {
    const d = zonedToday(ctx.now(), ctx.config?.appTimeZone);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Counts plus up to 50 entries per check; `fix` names the POST /maintenance/fix action a check offers. */
function quality(ctx) {
    const today = todayString(ctx);
    const checks = [
        duplicateTitles(ctx),
        ...SERIES_CHECKS.map(c => seriesCheck(ctx, c)),
        volumeCheck(ctx, VOLUME_CHECKS[0]),
        volumeCheck(ctx, VOLUME_CHECKS[1]),
        volumeCheck(ctx, VOLUME_CHECKS[2]),
        invalidIsbns(ctx),
        // release date passed: "vermutlich erschienen"; the client marks them owned through POST /volumes/bulk
        volumeCheck(ctx, { id: 'overdue_preorders', where: "v.status IN ('Vorbestellt', 'Bestellt') AND v.release_date IS NOT NULL AND SUBSTR(v.release_date, 1, 10) < ?" }, [today]),
        volumeCheck(ctx, VOLUME_CHECKS[3]),
        ...publisherChecks(ctx)
    ];
    return { body: { generated_at: ctx.now().toISOString(), today, limit: ITEM_LIMIT, checks } };
}

function normalizeStoredPublishers(ctx) {
    let changed = 0;
    for (const table of ['mangas', 'volumes']) {
        const rows = ctx.db.prepare(`SELECT DISTINCT publisher FROM ${table} WHERE publisher IS NOT NULL AND TRIM(publisher) <> ''`).all();
        const update = ctx.db.prepare(`UPDATE ${table} SET publisher = ? WHERE publisher = ?`);
        for (const { publisher } of rows) {
            const canonical = normalizePublisher(publisher);
            if (canonical && canonical !== publisher) changed += update.run(canonical, publisher).changes;
        }
    }
    return changed;
}

const FIXES = {
    legacy_read: (ctx) => migrateLegacyReadStatus(ctx.db),
    normalize_publishers: normalizeStoredPublishers
};

/** { check: 'legacy_read' | 'normalize_publishers' } -> { success, changed }. */
function fix(ctx, { body }) {
    const run = Object.prototype.hasOwnProperty.call(FIXES, body.check) ? FIXES[body.check] : null;
    if (!run) throw badRequest('Unbekannte Korrektur', 'FIX_UNKNOWN');
    let changed = 0;
    ctx.db.transaction(() => { changed = run(ctx); });
    return { body: { success: true, check: body.check, changed } };
}

module.exports = { quality, fix, ITEM_LIMIT };
