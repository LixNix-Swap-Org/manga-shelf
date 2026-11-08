// Single copies of a volume (volume_copies, migration 44): purchase price, date and condition per copy, and who borrowed
// it (migration 47). PUT /volumes/:id/copies/:copyId changes one copy, GET /copies/lent lists what is lent out and what
// the caller borrowed.
const access = require('../lib/access');
const { badRequest, forbidden, notFound, msg } = require('../errors');
const { isBlank, parsePrice, parseDate, parseCondition } = require('../lib/validate');
const { zonedToday } = require('../radar');
const { copiesByVolume } = require('../lib/copies');

const MAX_NAME = 64;
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * `lent` of the body: null (given back), { user_id } (an account, not the copy's owner) or { name } (a person without an
 * account, 1-64 characters), with an optional { at } (date, default today in the app time zone).
 */
function readLending(ctx, lent, ownerId) {
    if (lent === null) return { lent_to_user_id: null, lent_to_name: null, lent_at: null };
    if (typeof lent !== 'object' || Array.isArray(lent)) throw badRequest('Ungültige Angabe zum Verleihen');
    const at = parseDate(lent.at);
    if (at.error) throw badRequest('Ungültiges Datum (erwartet: JJJJ-MM-TT)');
    const lentAt = at.value || isoDay(zonedToday(ctx.now(), ctx.config.appTimeZone));
    if (!isBlank(lent.user_id)) {
        const id = access.parseId(lent.user_id);
        const user = id && ctx.db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
        if (!user) throw badRequest('Unbekanntes Konto');
        if (user.id === ownerId) throw badRequest('Ein Exemplar kann nicht an seinen Besitzer verliehen werden');
        return { lent_to_user_id: user.id, lent_to_name: user.username, lent_at: lentAt };
    }
    const name = typeof lent.name === 'string' ? lent.name.trim() : '';
    if (!name) throw badRequest('Name oder Konto fehlt');
    if ([...name].some(ch => ch.charCodeAt(0) < 32)) throw badRequest('Ungültiger Name');
    if (name.length > MAX_NAME) throw badRequest(msg('Name zu lang (maximal {max} Zeichen)', { max: MAX_NAME }));
    return { lent_to_user_id: null, lent_to_name: name, lent_at: lentAt };
}

// PUT /volumes/:id/copies/:copyId { price?, purchase_date?, condition?, lent? }: the owner changes their copy, any editor
// of the shelf a household copy, an admin (a member there) every copy of the volume
function updateCopy(ctx, { params, body }) {
    const volumeId = access.parseId(params.id);
    const copyId = access.parseId(params.copyId);
    if (!volumeId || !copyId) throw notFound('Exemplar');
    access.volumeAccess(ctx, volumeId, 'editor');
    const copy = ctx.db.prepare('SELECT id, owner_user_id FROM volume_copies WHERE id = ? AND volume_id = ?').get(copyId, volumeId);
    if (!copy) throw notFound('Exemplar');
    if (copy.owner_user_id !== null && copy.owner_user_id !== ctx.user.id && ctx.user.role !== 'admin') {
        throw forbidden('Nur wer das Exemplar besitzt, kann es ändern');
    }

    const set = {};
    const given = (key) => Object.prototype.hasOwnProperty.call(body || {}, key);
    if (given('price')) {
        const price = parsePrice(body.price);
        if (price.error) throw badRequest('Ungültiger Preis');
        set.purchase_price = price.value;
    }
    if (given('purchase_date')) {
        const date = parseDate(body.purchase_date);
        if (date.error) throw badRequest('Ungültiges Datum (erwartet: JJJJ-MM-TT)');
        set.purchase_date = date.value;
    }
    if (given('condition')) {
        const condition = parseCondition(body.condition);
        if (condition.error) throw badRequest('Ungültiger Zustand');
        set.condition = condition.value;
    }
    if (given('lent')) Object.assign(set, readLending(ctx, body.lent, copy.owner_user_id));
    const keys = Object.keys(set);
    if (keys.length) {
        ctx.db.prepare(`UPDATE volume_copies SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => set[k]), copy.id);
    }
    const copies = copiesByVolume(ctx.db, 'c.volume_id = ?', [volumeId]).get(volumeId) || [];
    return { body: { success: true, copy: copies.find(c => c.id === copy.id) || null, copies } };
}

// GET /copies/lent: { lent_out } = lent copies in the caller's shelves, { borrowed } = copies lent to the caller (also
// from a shelf the caller does not belong to: the owner named them; manga_id is then null, so nothing links there)
function lentCopies(ctx) {
    const shelfIds = access.accessibleShelfIds(ctx);
    const shelves = new Set(shelfIds);
    const scope = access.inShelves('m.shelf_id', shelfIds);
    const select = `
        SELECT c.id, c.volume_id, v.volume_number, v.type, m.id AS manga_id, m.title, m.shelf_id, s.name AS shelf_name,
               o.username AS owner, c.lent_to_user_id, COALESCE(b.username, c.lent_to_name) AS lent_to, c.lent_at
        FROM volume_copies c
        JOIN volumes v ON v.id = c.volume_id
        JOIN mangas m ON m.id = v.manga_id
        JOIN shelves s ON s.id = m.shelf_id
        LEFT JOIN users o ON o.id = c.owner_user_id
        LEFT JOIN users b ON b.id = c.lent_to_user_id`;
    const order = 'ORDER BY c.lent_at, m.title COLLATE NOCASE, v.number_sort, v.id';
    const shape = (r, visible) => ({
        copy_id: r.id,
        volume_id: visible ? r.volume_id : null,
        manga_id: visible ? r.manga_id : null,
        title: r.title,
        volume_number: r.volume_number,
        type: r.type,
        shelf_name: visible ? r.shelf_name : null,
        owner: r.owner ?? null,
        lent_to: r.lent_to,
        lent_at: r.lent_at
    });
    const lentOut = ctx.db.prepare(`${select} WHERE (c.lent_to_user_id IS NOT NULL OR c.lent_to_name IS NOT NULL) AND ${scope.sql} ${order}`)
        .all(...scope.params).map(r => shape(r, true));
    const borrowed = ctx.db.prepare(`${select} WHERE c.lent_to_user_id = ? ${order}`)
        .all(ctx.user.id).map(r => shape(r, shelves.has(r.shelf_id)));
    return { body: { lent_out: lentOut, borrowed } };
}

module.exports = { updateCopy, lentCopies };
