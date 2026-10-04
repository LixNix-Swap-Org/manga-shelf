// Shopping list (GET /shopping-list): missing volumes, wished series and, on request, what other users own.
const { qstr } = require('../lib/query');
const { volumeOrderSql } = require('../lib/volumeNumber');
const { buildShoppingList } = require('../radar');
const { wishedSeries } = require('./wishlist');

// paused and dropped series (mangas.collecting) keep their missing volumes off the list
const SHOPPING_SERIES = "COALESCE(m.collecting, 'aktiv') NOT IN ('pausiert', 'abgebrochen')";

function shoppingList(ctx, { query }) {
    const missingVols = ctx.db.prepare(`
        SELECT 
            v.id, v.manga_id, v.volume_number, v.isbn, v.price, 
            v.release_year, v.condition, v.publisher as vol_publisher, 
            v.notes, v.status, v.type, v.priority, v.target_price,
            m.title as manga_title, 
            m.cover_image as manga_cover,
            COALESCE(v.language, m.language) as language, m.currency as currency,
            COALESCE(NULLIF(TRIM(v.publisher), ''), NULLIF(TRIM(m.publisher), ''), 'Unbekannt') as effective_publisher
        FROM volumes v
        JOIN mangas m ON v.manga_id = m.id
        WHERE v.status = 'Fehlt' AND ${SHOPPING_SERIES}
        ORDER BY 
            effective_publisher ASC,
            m.title ASC,
            ${volumeOrderSql('v')}
    `).all();

    // ?include_others=1: volumes others own and the caller does not yet, in series the caller already collects
    if (qstr(query.include_others) === '1') {
        const others = ctx.db.prepare(`
            SELECT
                v.id, v.manga_id, v.volume_number, v.isbn, v.price,
                v.release_year, v.condition, v.publisher as vol_publisher,
                v.notes, v.status, v.type,
                m.title as manga_title,
                m.cover_image as manga_cover,
                COALESCE(v.language, m.language) as language, m.currency as currency,
                COALESCE(NULLIF(TRIM(v.publisher), ''), NULLIF(TRIM(m.publisher), ''), 'Unbekannt') as effective_publisher,
                (SELECT GROUP_CONCAT(username, ', ') FROM (SELECT u.username FROM volume_owners vo JOIN users u ON u.id = vo.user_id WHERE vo.volume_id = v.id ORDER BY vo.created_at, vo.rowid)) as owned_by_others
            FROM volumes v
            JOIN mangas m ON v.manga_id = m.id
            WHERE v.status = 'Vorhanden'
              AND NOT EXISTS (SELECT 1 FROM volume_owners vo WHERE vo.volume_id = v.id AND vo.user_id = ?)
              AND EXISTS (SELECT 1 FROM volume_owners vo WHERE vo.volume_id = v.id)
              AND m.id IN (
                  SELECT v2.manga_id FROM volumes v2
                  JOIN volume_owners vo2 ON vo2.volume_id = v2.id AND vo2.user_id = ?
              )
            ORDER BY m.title ASC, COALESCE(v.number_sort, 0) ASC, v.volume_number ASC
        `).all(ctx.user.id, ctx.user.id);
        const result = buildShoppingList(missingVols, wishedSeries(ctx));
        return { body: { ...result, others: others.map(o => ({ ...o, owned_by_others: o.owned_by_others || '' })) } };
    }

    return { body: buildShoppingList(missingVols, wishedSeries(ctx)) };
}

module.exports = { shoppingList, SHOPPING_SERIES };
