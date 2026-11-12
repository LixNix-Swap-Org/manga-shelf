// Wished series: wish_priority set and no volume owned (the one rule for chip, shopping list and statistics).
const access = require('../lib/access');
const { wishesBySeries, setWish } = require('../lib/wishes');
const { parseWishPriority } = require('../lib/validate');
const { badRequest, notFound } = require('../errors');

// The wished series with what is already known to be missing (shopping list)
const WISHED_SERIES_SQL = `
    SELECT m.id, m.title, m.cover_image, m.publisher, m.wish_priority, m.total_volumes, m.manga_passion_id, m.language, m.currency,
           COALESCE(SUM(CASE WHEN v.status = 'Fehlt' THEN 1 ELSE 0 END), 0) AS known_missing_count,
           COALESCE(SUM(CASE WHEN v.status = 'Fehlt' THEN COALESCE(v.price, 0) ELSE 0 END), 0) AS known_missing_cost
    FROM mangas m
    LEFT JOIN volumes v ON v.manga_id = m.id
    WHERE m.wish_priority IS NOT NULL AND {SHELVES}
    GROUP BY m.id
    HAVING COALESCE(SUM(CASE WHEN v.status = 'Vorhanden' THEN 1 ELSE 0 END), 0) = 0
    ORDER BY m.wish_priority DESC, m.title COLLATE NOCASE ASC, m.id ASC`;

// Count and known missing cost (euro series only, like every statistics total) of the wished series
const WISHED_SQL = `
    SELECT count(*) AS count, COALESCE(SUM(known_cost), 0) AS known_cost FROM (
        SELECT SUM(CASE WHEN v.status = 'Fehlt' AND m.currency = 'EUR' THEN COALESCE(v.price, 0) ELSE 0 END) AS known_cost
        FROM mangas m LEFT JOIN volumes v ON v.manga_id = m.id
        WHERE m.wish_priority IS NOT NULL AND {SHELVES}
        GROUP BY m.id
        HAVING COALESCE(SUM(CASE WHEN v.status = 'Vorhanden' THEN 1 ELSE 0 END), 0) = 0
    )
`;

const scoped = (sql, shelfIds) => {
    const scope = access.inShelves('m.shelf_id', shelfIds);
    return { sql: sql.replace('{SHELVES}', scope.sql), params: scope.params };
};
// each with who wishes it (migration 57: wishes per person, visible to the shelf) and the caller's own wish
const wishedSeries = (ctx, shelfIds = access.accessibleShelfIds(ctx)) => {
    const q = scoped(WISHED_SERIES_SQL, shelfIds);
    const rows = ctx.db.prepare(q.sql).all(...q.params);
    const wishes = wishesBySeries(ctx.db, rows.map(r => r.id));
    for (const r of rows) {
        r.wishes = (wishes.get(r.id) || []).map(w => ({ ...w, mine: w.user_id === ctx.user?.id }));
        r.my_wish = r.wishes.find(w => w.user_id === ctx.user?.id)?.priority ?? null;
    }
    return rows;
};
const wishedSummary = (ctx, shelfIds = access.accessibleShelfIds(ctx)) => {
    const q = scoped(WISHED_SQL, shelfIds);
    return ctx.db.prepare(q.sql).get(...q.params);
};

// PUT /mangas/:id/wish { priority, household? }: the caller's own wish on the series (0 to 3; null or '' removes it). Any
// member of the shelf may keep a wishlist, a viewer too. `household: true` changes the household wish of migration 57
// instead (editors of the shelf).
function setOwnWish(ctx, { params, body }) {
    const mangaId = access.parseId(params.id);
    if (!mangaId) throw notFound('Manga');
    const household = body?.household === true;
    access.mangaAccess(ctx, mangaId, household ? 'editor' : 'viewer');
    if (!Object.prototype.hasOwnProperty.call(body || {}, 'priority')) throw badRequest('Priorität fehlt');
    const r = parseWishPriority(body.priority);
    if (r.error) throw badRequest('Ungültige Wunsch-Priorität (leer oder 0 bis 3)');
    let highest = null;
    ctx.db.transaction(() => { highest = setWish(ctx.db, mangaId, household ? null : ctx.user.id, r.value); });
    const wishes = (wishesBySeries(ctx.db, mangaId).get(mangaId) || []).map(w => ({ ...w, mine: w.user_id === ctx.user.id }));
    return { body: { success: true, my_wish: wishes.find(w => w.mine)?.priority ?? null, wish_priority: highest, wishes } };
}

module.exports = { wishedSeries, wishedSummary, setOwnWish };
