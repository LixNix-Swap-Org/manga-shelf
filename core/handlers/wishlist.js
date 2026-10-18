// Wished series: wish_priority set and no volume owned (the one rule for chip, shopping list and statistics).
const access = require('../lib/access');

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
const wishedSeries = (ctx, shelfIds = access.accessibleShelfIds(ctx)) => {
    const q = scoped(WISHED_SERIES_SQL, shelfIds);
    return ctx.db.prepare(q.sql).all(...q.params);
};
const wishedSummary = (ctx, shelfIds = access.accessibleShelfIds(ctx)) => {
    const q = scoped(WISHED_SQL, shelfIds);
    return ctx.db.prepare(q.sql).get(...q.params);
};

module.exports = { wishedSeries, wishedSummary };
