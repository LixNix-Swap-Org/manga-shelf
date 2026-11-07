// The series link of an anime is a link to its work (migration 45). animes.work_id names the work for everyone; a shelf can pin
// the edition it shows (anime_work_links: origin 'manual', relation 'SOURCE', scope_shelf_id, manga_id) or hide the link for
// itself (the same row with hidden = 1 and the work it hides). What a caller sees is resolved per shelf they belong to: a pin of
// one of their shelves, else their own edition of the work (their default language first, then the lowest id). Nothing about a
// series in a foreign shelf leaves this module. Changing a link touches only the caller's editable shelves, except that the
// link for everyone moves while every edition of its work sits in those shelves (or none is left): then it is the caller's.
const access = require('./access');
const { manualWorkKey } = require('./language');
const { readProfile } = require('./locales');
const { notFound } = require('../errors');

const SHELF_ROW = "origin = 'manual' AND relation = 'SOURCE' AND scope_shelf_id IS NOT NULL";

/** works.id of the series; a series without a work gets a manual key of its own first (the triggers add the works row). */
function ensureWork(ctx, mangaId) {
    const row = ctx.db.prepare('SELECT work_id FROM mangas WHERE id = ?').get(mangaId);
    if (!row) return null;
    if (row.work_id) return row.work_id;
    ctx.db.prepare('UPDATE mangas SET work_key = ? WHERE id = ?').run(manualWorkKey(ctx.randomId()), mangaId);
    return ctx.db.prepare('SELECT work_id FROM mangas WHERE id = ?').get(mangaId).work_id;
}

/** Whether no edition of the work lies outside the shelves the caller may edit (also when none is left at all). */
function ownsWork(ctx, workId) {
    const editable = access.accessibleShelfIds(ctx, 'editor');
    const outside = editable.length ? `AND shelf_id NOT IN (${editable.map(() => '?').join(',')})` : '';
    return !ctx.db.prepare(`SELECT 1 AS hit FROM mangas WHERE work_id = ? ${outside} LIMIT 1`).get(workId, ...editable);
}

/**
 * The link of anime rows as the caller sees it, with a constant number of queries (animeId narrows it to one row).
 * Returns row => { id, title, shelf_id } | null; `row` needs `id` and `work_id`.
 */
function linkResolver(ctx, animeId = null) {
    const shelves = access.accessibleShelfIds(ctx);
    if (!shelves.length) return () => null;
    const one = animeId === null ? '' : ' AND anime_id = ?';
    const oneParams = animeId === null ? [] : [animeId];
    const scope = access.inShelves('scope_shelf_id', shelves);
    const rows = ctx.db.prepare(`SELECT anime_id, work_id, scope_shelf_id, hidden, manga_id FROM anime_work_links
        WHERE ${SHELF_ROW} AND ${scope.sql}${one}`).all(...scope.params, ...oneParams);
    const hidden = new Set();
    const pins = new Map();
    for (const r of rows) {
        if (r.hidden) { hidden.add(`${r.anime_id}:${r.scope_shelf_id}:${r.work_id}`); continue; }
        if (!pins.has(r.anime_id)) pins.set(r.anime_id, []);
        pins.get(r.anime_id).push(r);
    }
    const editionScope = access.inShelves('m.shelf_id', shelves);
    const editions = ctx.db.prepare(`SELECT m.id, m.title, m.language, m.work_id, m.shelf_id FROM mangas m
        WHERE ${editionScope.sql} AND m.work_id IN (
            SELECT work_id FROM animes WHERE work_id IS NOT NULL${animeId === null ? '' : ' AND id = ?'}
            UNION SELECT work_id FROM anime_work_links WHERE ${SHELF_ROW} AND hidden = 0 AND ${scope.sql}${one}
        ) ORDER BY m.id`).all(...editionScope.params, ...oneParams, ...scope.params, ...oneParams);
    const byWork = new Map();
    const byId = new Map();
    for (const m of editions) {
        byId.set(m.id, m);
        if (!byWork.has(m.work_id)) byWork.set(m.work_id, []);
        byWork.get(m.work_id).push(m);
    }
    const language = ctx.user ? readProfile(ctx.db, ctx.user.id).default_language : 'de';
    return (row) => {
        let best = null;
        let bestKey = null;
        const consider = (m, rank) => {
            const key = [rank, m.language === language ? 0 : 1, m.id];
            if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
                best = m;
                bestKey = key;
            }
        };
        for (const pin of pins.get(row.id) || []) {
            const pinned = pin.manga_id ? byId.get(pin.manga_id) : null;
            if (pinned && pinned.shelf_id === pin.scope_shelf_id && pinned.work_id === pin.work_id) consider(pinned, 0);
            for (const m of byWork.get(pin.work_id) || []) if (m.shelf_id === pin.scope_shelf_id) consider(m, 1);
        }
        if (row.work_id) {
            for (const m of byWork.get(row.work_id) || []) {
                if (!hidden.has(`${row.id}:${m.shelf_id}:${row.work_id}`)) consider(m, 2);
            }
        }
        return best ? { id: best.id, title: best.title, shelf_id: best.shelf_id } : null;
    };
}

/**
 * Links the anime to the work of series `mangaId` (editor rights in its shelf; 404 outside the caller's shelves) and pins that
 * edition for its shelf. The link for everyone takes the work when it has none, already names it, or is the caller's (ownsWork).
 * Call inside a transaction. `row` is the animes row (`id`, `work_id`).
 */
function setLink(ctx, row, mangaId) {
    const shelfId = access.mangaAccess(ctx, mangaId, 'editor');
    const work = ensureWork(ctx, mangaId);
    ctx.db.prepare(`DELETE FROM anime_work_links WHERE anime_id = ? AND ${SHELF_ROW} AND scope_shelf_id = ?`).run(row.id, shelfId);
    if (row.work_id !== work && (!row.work_id || ownsWork(ctx, row.work_id))) {
        if (row.work_id) ctx.db.prepare(`DELETE FROM anime_work_links WHERE anime_id = ? AND ${SHELF_ROW} AND hidden = 1 AND work_id = ?`).run(row.id, row.work_id);
        ctx.db.prepare('UPDATE animes SET work_id = ? WHERE id = ?').run(work, row.id);
    }
    ctx.db.prepare(`INSERT INTO anime_work_links (anime_id, work_id, relation, origin, scope_shelf_id, hidden, created_by, manga_id)
        VALUES (?, ?, 'SOURCE', 'manual', ?, 0, ?, ?)`).run(row.id, work, shelfId, ctx.user ? ctx.user.id : null, mangaId);
}

/**
 * Takes the link away in the caller's editable shelves that show it now: their pins go, and the link for everyone is cleared
 * when it is the caller's (ownsWork), else hidden in those shelves. Returns false when no editable shelf shows a link; throws
 * 404 when the link shows only in shelves the caller may not edit. Call inside a transaction.
 */
function clearLink(ctx, row) {
    const editable = new Set(access.accessibleShelfIds(ctx, 'editor'));
    const shown = linkResolver(ctx, row.id);
    const shelves = access.accessibleShelfIds(ctx);
    const pinned = new Set(ctx.db.prepare(`SELECT scope_shelf_id FROM anime_work_links WHERE anime_id = ? AND ${SHELF_ROW} AND hidden = 0`)
        .all(row.id).map(r => r.scope_shelf_id));
    const globalIn = new Set();
    if (row.work_id) {
        const hiddenIn = new Set(ctx.db.prepare(`SELECT scope_shelf_id FROM anime_work_links WHERE anime_id = ? AND ${SHELF_ROW} AND hidden = 1 AND work_id = ?`)
            .all(row.id, row.work_id).map(r => r.scope_shelf_id));
        for (const r of ctx.db.prepare('SELECT DISTINCT shelf_id FROM mangas WHERE work_id = ?').all(row.work_id)) {
            if (!hiddenIn.has(r.shelf_id)) globalIn.add(r.shelf_id);
        }
    }
    const showing = shelves.filter((s) => pinned.has(s) || globalIn.has(s));
    const affected = showing.filter((s) => editable.has(s));
    if (!affected.length) {
        if (shown(row)) throw notFound('Reihe');
        return false;
    }
    const drop = ctx.db.prepare(`DELETE FROM anime_work_links WHERE anime_id = ? AND ${SHELF_ROW} AND scope_shelf_id = ?`);
    for (const s of affected) drop.run(row.id, s);
    if (row.work_id) {
        if (ownsWork(ctx, row.work_id)) {
            ctx.db.prepare(`DELETE FROM anime_work_links WHERE anime_id = ? AND ${SHELF_ROW} AND hidden = 1 AND work_id = ?`).run(row.id, row.work_id);
            ctx.db.prepare('UPDATE animes SET work_id = NULL WHERE id = ?').run(row.id);
        } else {
            const hide = ctx.db.prepare(`INSERT OR IGNORE INTO anime_work_links (anime_id, work_id, relation, origin, scope_shelf_id, hidden, created_by)
                VALUES (?, ?, 'SOURCE', 'manual', ?, 1, ?)`);
            for (const s of affected) if (globalIn.has(s)) hide.run(row.id, row.work_id, s, ctx.user ? ctx.user.id : null);
        }
    }
    return true;
}

module.exports = { ensureWork, ownsWork, linkResolver, setLink, clearLink };
