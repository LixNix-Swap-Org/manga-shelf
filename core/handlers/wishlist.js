// Wished series: wish_priority set and no volume owned (the one rule for chip, shopping list and statistics).
const access = require('../lib/access');
const { wishesBySeries, setWish } = require('../lib/wishes');
const { parseWishPriority } = require('../lib/validate');
const { badRequest, notFound } = require('../errors');
const { qstr } = require('../lib/query');

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

// ----- shared wishlist: GET /wishlist/shared?token=… (no session; routes/system.js issues the token, scope 'wishlist' of
// calendar_feeds since migration 58). A read-only page for family and friends: the own wishes of the token's account
// (series with no owned volume, like every wishlist), with title, publisher, priority and the volumes known to be
// missing. No shelf names, no other people, no prices.

const OWN_WISHES_SQL = `
    SELECT m.id, m.title, m.cover_image, m.publisher, w.priority,
           COALESCE(SUM(CASE WHEN v.status = 'Fehlt' THEN 1 ELSE 0 END), 0) AS known_missing
    FROM series_wishes w
    JOIN mangas m ON m.id = w.manga_id
    LEFT JOIN volumes v ON v.manga_id = m.id
    WHERE w.user_id = ? AND {SHELVES}
    GROUP BY m.id
    HAVING COALESCE(SUM(CASE WHEN v.status = 'Vorhanden' THEN 1 ELSE 0 END), 0) = 0
    ORDER BY w.priority DESC, m.title COLLATE NOCASE ASC, m.id ASC`;

const PRIORITY_TEXT = { 1: '★ niedrig', 2: '★★ mittel', 3: '★★★ hoch' };
const html = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// covers from this server (/uploads) or another https address; anything else (data:, javascript:) is left out
const safeCover = (src) => (typeof src === 'string' && (/^\/uploads\/[A-Za-z0-9._/-]+$/.test(src) || /^https:\/\/[^\s"'<>]+$/.test(src)) ? src : null);

const PAGE_CSS = `
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #0b0f19; color: #f1f5f9; font-family: 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif; }
    main { max-width: 860px; margin: 0 auto; padding: 32px 16px 48px; }
    h1 { font-size: 1.4rem; margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }
    h1 svg { color: #fb7185; flex-shrink: 0; }
    .lead { color: #94a3b8; font-size: .875rem; margin: 0 0 24px; }
    ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
    li { display: flex; gap: 12px; padding: 12px; border-radius: 16px; background: rgba(15, 23, 42, .6); border: 1px solid rgba(244, 63, 94, .25); }
    .cover { width: 64px; height: 96px; border-radius: 12px; object-fit: cover; border: 1px solid #1e293b; background: #0f172a; flex-shrink: 0; }
    .title { font-weight: 700; font-size: .8rem; margin: 2px 0 4px; overflow-wrap: anywhere; }
    .meta { color: #94a3b8; font-size: .7rem; margin: 0 0 6px; }
    .prio { display: inline-block; font-size: .65rem; font-weight: 700; padding: 2px 6px; border-radius: 8px; border: 1px solid rgba(244, 63, 94, .4); background: rgba(244, 63, 94, .12); color: #fecdd3; }
    .known { color: #cbd5e1; font-size: .7rem; margin-left: 6px; }
    .empty { color: #94a3b8; padding: 24px; border: 1px dashed #334155; border-radius: 16px; text-align: center; }
    footer { color: #94a3b8; font-size: .7rem; margin-top: 32px; }
`;
const HEART = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>';

function sharedPage(title, inner) {
    return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${html(title)}</title><style>${PAGE_CSS}</style></head>
<body><main>${inner}</main></body></html>`;
}

const PAGE_HEADERS = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // the token is in the address: never pass it on to the cover hosts
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow'
};

function sharedWishlist(ctx, { query }) {
    const radar = require('./radar');
    const found = radar.feedEntryFor(ctx, qstr(query.token), 'wishlist');
    if (!found) {
        return {
            status: 404,
            body: sharedPage('Wunschliste nicht gefunden', `<h1>${HEART} Wunschliste nicht gefunden</h1>
<p class="lead">Dieser Link gilt nicht mehr: die Wunschliste wird nicht mehr geteilt oder es gibt einen neuen Link.</p>`),
            headers: PAGE_HEADERS
        };
    }
    radar.touchFeed(ctx, found);
    const owner = ctx.db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(found.entry.user_id);
    const q = scoped(OWN_WISHES_SQL, access.accessibleShelfIds({ ...ctx, user: owner }));
    const rows = ctx.db.prepare(q.sql).all(owner.id, ...q.params);
    const items = rows.map((r) => {
        const cover = safeCover(r.cover_image);
        const known = r.known_missing > 0 ? `<span class="known">${r.known_missing === 1 ? '1 Band bekannt' : `${r.known_missing} Bände bekannt`}</span>` : '';
        return `<li>${cover ? `<img class="cover" src="${html(cover)}" alt="" loading="lazy">` : '<div class="cover" aria-hidden="true"></div>'}
<div><p class="title">${html(r.title)}</p>${r.publisher ? `<p class="meta">${html(r.publisher)}</p>` : ''}
<span class="prio">${html(PRIORITY_TEXT[r.priority] || 'Wunsch')}</span>${known}</div></li>`;
    }).join('\n');
    const heading = `Wunschliste von ${owner.username}`;
    const body = sharedPage(heading, `<h1>${HEART} ${html(heading)}</h1>
<p class="lead">${rows.length === 1 ? '1 Reihe' : `${rows.length} Reihen`} · nur zum Ansehen, aus Manga Shelf</p>
${rows.length ? `<ul>${items}</ul>` : '<p class="empty">Gerade steht nichts auf der Wunschliste.</p>'}
<footer>Wer den Link hat, kann diese Liste sehen. Ändern lässt sie sich nur in Manga Shelf.</footer>`);
    return { body, headers: PAGE_HEADERS };
}

module.exports = { wishedSeries, wishedSummary, setOwnWish, sharedWishlist };
