// Shelves = collections with members (owner / editor / viewer): GET/POST /shelves, GET/PUT/DELETE /shelves/:id,
// members under /shelves/:id/members, PUT /mangas/:id/shelf to move a series and GET /mangas/:id/shelf-move to preview it.
const { HttpError, msg, badRequest, notFound, conflict, forbidden } = require('../errors');
const { parsePositiveInt } = require('../lib/validate');
const { qstr } = require('../lib/query');
const access = require('../lib/access');
const { syncStatusWithOwners, purchaseDateFromRemainingOwners } = require('../lib/owners');
const { rememberUndo } = require('./volumes');

const ROLES = ['owner', 'editor', 'viewer'];
const MAX_NAME = 80;
const MAX_DESCRIPTION = 500;

function shelfId(params) {
    const id = parsePositiveInt(params.id);
    if (!id) throw notFound('Regal');
    return id;
}

function cleanText(value, max, tooLong, { required = false } = {}) {
    if (value === undefined) return undefined;
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) {
        if (required) throw badRequest('Name fehlt');
        return null;
    }
    if (text.length > max) throw badRequest(tooLong);
    return text;
}

function cleanColor(value) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) throw badRequest('Ungültige Farbe');
    return value.toLowerCase();
}

function cleanRole(value) {
    if (!ROLES.includes(value)) throw badRequest('Ungültige Rolle (owner, editor oder viewer)');
    return value;
}

function describe(ctx, row, role) {
    const counts = ctx.db.prepare(`
        SELECT (SELECT count(*) FROM mangas WHERE shelf_id = ?) AS series,
               (SELECT count(*) FROM shelf_members WHERE shelf_id = ?) AS members`).get(row.id, row.id);
    return {
        id: row.id, name: row.name, description: row.description || null, color: row.color,
        is_default: Boolean(row.is_default), role, series_count: counts.series, member_count: counts.members
    };
}

function list(ctx) {
    const scope = access.inShelves('s.id', access.accessibleShelfIds(ctx));
    const rows = ctx.db.prepare(`
        SELECT s.* FROM shelves s WHERE ${scope.sql} ORDER BY s.is_default DESC, s.name COLLATE NOCASE, s.id
    `).all(...scope.params);
    return { body: { shelves: rows.map(r => describe(ctx, r, access.shelfRole(ctx, r.id))) } };
}

const SHELF_VOLUMES = 'SELECT v.id FROM volumes v JOIN mangas g ON g.id = v.manga_id WHERE g.shelf_id = m.shelf_id';

// Members with the role that counts (read-only accounts are viewers), their account role (`app_role`, which caps the
// shelf role) and how many ownership and reading marks of this shelf they hold, plus the webtoons with their chapter
// progress (`chapters`). Leaving or a removal deletes the ownership marks; reads and chapters stay on the catalog, hidden
// from this shelf until its member is back.
function membersOf(ctx, id) {
    return ctx.db.prepare(`
        SELECT m.user_id, u.username, CASE WHEN u.role IN ('visitor', 'guest') THEN 'viewer' ELSE m.role END AS role,
               u.role AS app_role,
               (SELECT count(*) FROM volume_owners vo WHERE vo.user_id = m.user_id AND vo.volume_id IN (${SHELF_VOLUMES})) AS owned,
               (SELECT count(*) FROM shelf_volume_reads vr WHERE vr.user_id = m.user_id AND vr.volume_id IN (${SHELF_VOLUMES})) AS read_count,
               (SELECT count(*) FROM shelf_chapter_progress cp JOIN mangas g ON g.id = cp.manga_id WHERE cp.user_id = m.user_id AND g.shelf_id = m.shelf_id) AS chapters
        FROM shelf_members m JOIN users u ON u.id = m.user_id
        WHERE m.shelf_id = ?
        ORDER BY CASE WHEN u.role IN ('visitor', 'guest') THEN 2 WHEN m.role = 'owner' THEN 0 WHEN m.role = 'editor' THEN 1 ELSE 2 END,
                 u.username COLLATE NOCASE
    `).all(id).map(({ owned, read_count: read, chapters, ...member }) => ({ ...member, marks: { owned, read, chapters } }));
}

function detail(ctx, { params }) {
    const id = shelfId(params);
    const role = access.requireShelf(ctx, id, 'viewer');
    const row = ctx.db.prepare('SELECT * FROM shelves WHERE id = ?').get(id);
    return { body: { ...describe(ctx, row, role), members: membersOf(ctx, id) } };
}

function create(ctx, { body }) {
    access.ensureMembership(ctx);
    const name = cleanText(body.name, MAX_NAME, msg('Der Name ist zu lang'), { required: true });
    const description = cleanText(body.description, MAX_DESCRIPTION, msg('Die Beschreibung ist zu lang')) ?? null;
    const color = cleanColor(body.color) || '#6366f1';
    const id = ctx.db.transaction(() => {
        const info = ctx.db.prepare('INSERT INTO shelves (name, description, color, owner_user_id, is_default) VALUES (?, ?, ?, ?, 0)').run(name, description, color, ctx.user.id);
        const newId = Number(info.lastInsertRowid);
        ctx.db.prepare("INSERT INTO shelf_members (shelf_id, user_id, role) VALUES (?, ?, 'owner')").run(newId, ctx.user.id);
        return newId;
    });
    const row = ctx.db.prepare('SELECT * FROM shelves WHERE id = ?').get(id);
    return { status: 201, body: describe(ctx, row, 'owner') };
}

function update(ctx, { params, body }) {
    const id = shelfId(params);
    access.requireShelf(ctx, id, 'owner');
    const name = cleanText(body.name, MAX_NAME, msg('Der Name ist zu lang'), { required: body.name !== undefined });
    const description = cleanText(body.description, MAX_DESCRIPTION, msg('Die Beschreibung ist zu lang'));
    const color = cleanColor(body.color);
    const sets = [];
    const values = [];
    for (const [column, value] of [['name', name], ['description', description], ['color', color]]) {
        if (value === undefined) continue;
        sets.push(`${column} = ?`);
        values.push(value);
    }
    if (!sets.length) throw badRequest('Keine Änderung angegeben');
    ctx.db.prepare(`UPDATE shelves SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values, id);
    const row = ctx.db.prepare('SELECT * FROM shelves WHERE id = ?').get(id);
    return { body: describe(ctx, row, 'owner') };
}

function remove(ctx, { params }) {
    const id = shelfId(params);
    access.requireShelf(ctx, id, 'owner');
    const row = ctx.db.prepare('SELECT * FROM shelves WHERE id = ?').get(id);
    if (row.is_default) throw conflict('Das Standard-Regal lässt sich nicht löschen', 'SHELF_DEFAULT');
    if (ctx.db.prepare('SELECT 1 FROM mangas WHERE shelf_id = ? LIMIT 1').get(id)) {
        throw conflict('Das Regal ist nicht leer. Reihen zuerst verschieben oder löschen.', 'SHELF_NOT_EMPTY');
    }
    const members = ctx.db.prepare('SELECT m.user_id, u.username FROM shelf_members m JOIN users u ON u.id = m.user_id WHERE m.shelf_id = ?').all(id);
    // members left without any shelf get an empty one of their own; the answer names them so the owner is told
    const personal = [];
    ctx.db.transaction(() => {
        // what is left in its trash belonged to this shelf only, so it goes with it
        ctx.db.prepare('DELETE FROM trash WHERE shelf_id = ?').run(id);
        ctx.db.prepare('DELETE FROM shelves WHERE id = ?').run(id);
        for (const { user_id: userId, username } of members) {
            if (!ctx.db.prepare('SELECT 1 FROM shelf_members WHERE user_id = ? LIMIT 1').get(userId)) {
                access.createPersonalShelf(ctx.db, userId);
                personal.push(username);
            }
        }
    });
    personal.sort((a, b) => a.localeCompare(b));
    return { body: { success: true, personal_shelves: personal } };
}

const LAST_OWNER = 'Das Regal braucht mindestens einen Besitzer';
const READ_ONLY_CAP = 'Besucher- und Gastkonten können in einem Regal nur Leser sein';

/** A member whose role counts as owner: stored owner of an account that may write (admin or editor). */
const activeOwner = (member) => member.role === 'owner' && !access.isReadOnlyAccount(member.app_role);

function addMember(ctx, { params, body }) {
    const id = shelfId(params);
    access.requireShelf(ctx, id, 'owner');
    const role = cleanRole(body.role || 'viewer');
    let user;
    if (body.user_id !== undefined && body.user_id !== null && body.user_id !== '') {
        const userId = parsePositiveInt(body.user_id);
        user = userId && ctx.db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId);
    } else if (typeof body.username === 'string' && body.username.trim()) {
        user = ctx.db.prepare('SELECT id, username, role FROM users WHERE username = ? COLLATE NOCASE').get(body.username.trim());
    } else {
        throw badRequest('Benutzername fehlt');
    }
    if (!user) throw notFound('Benutzer');
    if (access.isReadOnlyAccount(user.role) && role !== 'viewer') throw badRequest(READ_ONLY_CAP, 'SHELF_ROLE_CAPPED');
    if (ctx.db.prepare('SELECT 1 FROM shelf_members WHERE shelf_id = ? AND user_id = ?').get(id, user.id)) {
        throw conflict('Der Benutzer hat dieses Regal schon', 'SHELF_MEMBER_EXISTS');
    }
    ctx.db.prepare('INSERT INTO shelf_members (shelf_id, user_id, role) VALUES (?, ?, ?)').run(id, user.id, role);
    return { status: 201, body: { members: membersOf(ctx, id) } };
}

function memberTarget(ctx, params) {
    const id = shelfId(params);
    const userId = parsePositiveInt(params.userId);
    const member = userId && ctx.db.prepare(`
        SELECT m.role, u.role AS app_role FROM shelf_members m JOIN users u ON u.id = m.user_id WHERE m.shelf_id = ? AND m.user_id = ?
    `).get(id, userId);
    return { id, userId, member };
}

function setMemberRole(ctx, { params, body }) {
    const { id, userId, member } = memberTarget(ctx, params);
    access.requireShelf(ctx, id, 'owner');
    if (!member) throw notFound('Mitglied');
    const role = cleanRole(body.role);
    if (access.isReadOnlyAccount(member.app_role) && role !== 'viewer') throw badRequest(READ_ONLY_CAP, 'SHELF_ROLE_CAPPED');
    if (activeOwner(member) && role !== 'owner' && access.activeOwnerCount(ctx.db, id, userId) === 0) {
        throw conflict(LAST_OWNER, 'SHELF_LAST_OWNER');
    }
    ctx.db.prepare('UPDATE shelf_members SET role = ? WHERE shelf_id = ? AND user_id = ?').run(role, id, userId);
    return { body: { members: membersOf(ctx, id) } };
}

/**
 * Whoever leaves a shelf no longer has access to it, so their ownership marks on its volumes go too; otherwise a volume
 * would keep counting as owned by someone who cannot see it. A volume that loses its last owner becomes "Fehlt".
 * Reading marks and chapter progress stay on the catalog: the shelf no longer shows them (only members' marks show) and
 * shows them again when the user comes back.
 */
function forgetMarks(ctx, shelfId, userId) {
    const inShelf = 'SELECT v.id FROM volumes v JOIN mangas m ON m.id = v.manga_id WHERE m.shelf_id = ?';
    const snapshot = snapshotCopies(ctx, `owner_user_id = ? AND volume_id IN (${inShelf})`, [userId, shelfId]);
    ctx.db.prepare(`DELETE FROM volume_copies WHERE owner_user_id = ? AND volume_id IN (${inShelf})`).run(userId, shelfId);
    settleVolumes(ctx, snapshot.volumes.map(v => v.id));
    return snapshot;
}

/**
 * The copies `where` names (all their columns) and the purchase date of their volumes, taken before they are deleted, so
 * that POST /shelves/undo can put them back exactly.
 */
function snapshotCopies(ctx, where, params) {
    const copies = ctx.db.prepare(`SELECT * FROM volume_copies WHERE ${where} ORDER BY id`).all(...params);
    const ids = [...new Set(copies.map(c => c.volume_id))];
    const volumes = ids.map(id => ctx.db.prepare('SELECT id, purchase_date FROM volumes WHERE id = ?').get(id)).filter(Boolean);
    return { copies, volumes };
}

/** After copies went: a volume takes the earliest purchase date of the owners left, and without any it is "Fehlt". */
function settleVolumes(ctx, volumeIds) {
    for (const volumeId of volumeIds) {
        purchaseDateFromRemainingOwners(ctx.db, volumeId);
        syncStatusWithOwners(ctx.db, volumeId);
    }
}

/**
 * Puts copies of a snapshot back where their volume still exists and the owner holds no copy of it yet (the copy id is
 * kept: ids are never reused), then the volumes' purchase dates. Returns how many came back.
 */
function restoreCopies(ctx, snapshot, keep = () => true) {
    const columns = new Set(ctx.db.prepare('PRAGMA table_info(volume_copies)').all().map(c => c.name));
    let restored = 0;
    for (const copy of snapshot.copies) {
        if (!keep(copy)) continue;
        if (!ctx.db.prepare('SELECT 1 FROM volumes WHERE id = ?').get(copy.volume_id)) continue;
        if (copy.owner_user_id !== null && !ctx.db.prepare('SELECT 1 FROM users WHERE id = ?').get(copy.owner_user_id)) continue;
        const fields = Object.keys(copy).filter(k => columns.has(k));
        const info = ctx.db.prepare(`INSERT OR IGNORE INTO volume_copies (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`)
            .run(...fields.map(k => copy[k]));
        restored += Number(info.changes || 0);
    }
    for (const v of snapshot.volumes) {
        ctx.db.prepare("UPDATE volumes SET purchase_date = ? WHERE id = ? AND status = 'Vorhanden'").run(v.purchase_date, v.id);
    }
    return restored;
}

// An owner removes anyone; everybody can leave a shelf themselves.
function removeMember(ctx, { params }) {
    const { id, userId, member } = memberTarget(ctx, params);
    const own = userId === Number(ctx.user.id);
    access.requireShelf(ctx, id, own ? 'viewer' : 'owner');
    if (!member) throw notFound('Mitglied');
    if (activeOwner(member) && access.activeOwnerCount(ctx.db, id, userId) === 0) {
        throw conflict(LAST_OWNER, 'SHELF_LAST_OWNER');
    }
    const undo = ctx.db.transaction(() => {
        ctx.db.prepare('DELETE FROM shelf_members WHERE shelf_id = ? AND user_id = ?').run(id, userId);
        const snapshot = forgetMarks(ctx, id, userId);
        const personal = ctx.db.prepare('SELECT 1 FROM shelf_members WHERE user_id = ? LIMIT 1').get(userId)
            ? null : access.createPersonalShelf(ctx.db, userId);
        return { kind: 'member', shelfId: id, userId, role: member.role, own, personal, ...snapshot };
    });
    return { body: { success: true, members: own ? undefined : membersOf(ctx, id), ...rememberUndo(ctx, undo, 'viewer') } };
}

const IN_MANGA = 'SELECT id FROM volumes WHERE manga_id = ?';
const TARGET_MEMBERS = 'SELECT user_id FROM shelf_members WHERE shelf_id = ?';

/** Source owner and target editor checked; returns { mangaId, target }. */
function moveTarget(ctx, rawManga, rawTarget) {
    const mangaId = parsePositiveInt(rawManga);
    if (!mangaId) throw notFound('Manga');
    // an editor of somebody else's shelf must not be able to take its series away from the owners
    access.mangaAccess(ctx, mangaId, 'owner');
    const target = parsePositiveInt(rawTarget);
    if (!target) throw badRequest('Ungültiges Regal');
    access.requireShelf(ctx, target, 'editor');
    return { mangaId, target };
}

/**
 * Users whose ownership marks on the series a move into `target` deletes (they are not members there), with their counts;
 * `read` and `chapters` (their chapter of a webtoon, 0 without one) stay on the catalog and are only hidden there.
 */
function marksLostOnMove(ctx, mangaId, target) {
    return ctx.db.prepare(`
        SELECT u.id AS user_id, u.username,
               (SELECT count(*) FROM volume_owners vo WHERE vo.user_id = u.id AND vo.volume_id IN (${IN_MANGA})) AS owned,
               (SELECT count(*) FROM shelf_volume_reads vr WHERE vr.user_id = u.id AND vr.volume_id IN (${IN_MANGA})) AS read,
               COALESCE((SELECT cp.chapters_read FROM shelf_chapter_progress cp WHERE cp.user_id = u.id AND cp.manga_id = ?), 0) AS chapters
        FROM users u
        WHERE u.id NOT IN (${TARGET_MEMBERS})
          AND EXISTS (SELECT 1 FROM volume_owners vo WHERE vo.user_id = u.id AND vo.volume_id IN (${IN_MANGA}))
        ORDER BY u.username COLLATE NOCASE, u.id
    `).all(mangaId, mangaId, mangaId, target, mangaId)
        .map(r => ({ user_id: r.user_id, username: r.username, owned: r.owned, read: r.read, chapters: r.chapters }));
}

/** GET /mangas/:id/shelf-move?shelf_id=: whose ownership marks PUT /mangas/:id/shelf would delete. */
function movePreview(ctx, { params, query }) {
    const { mangaId, target } = moveTarget(ctx, params.id, qstr(query && query.shelf_id));
    return { body: { manga_id: mangaId, shelf_id: target, affected: marksLostOnMove(ctx, mangaId, target) } };
}

/**
 * PUT /mangas/:id/shelf { shelf_id }: the series (and so its volumes) moves; needs the owner role in the shelf it
 * leaves and editor rights in the target. Ownership marks of users who are not members of the target are deleted (the
 * move preview names them); their reads and chapters stay on the catalog, hidden in the target shelf.
 */
function moveManga(ctx, { params, body }) {
    const { mangaId, target } = moveTarget(ctx, params.id, body.shelf_id);
    const source = ctx.db.prepare('SELECT shelf_id FROM mangas WHERE id = ?').get(mangaId).shelf_id;
    const { snapshot, removed } = ctx.db.transaction(() => moveSeries(ctx, mangaId, target));
    const answer = { success: true, id: mangaId, shelf_id: target, removed_owners: removed };
    if (!snapshot.copies.length || source === target) return { body: answer };
    return { body: { ...answer, ...rememberUndo(ctx, { kind: 'move', mangaId, source, target, ...snapshot }) } };
}

/** Moves a series into `target` and drops the copies of users who are no members there; returns their snapshot and names. */
function moveSeries(ctx, mangaId, target) {
    const lost = `volume_id IN (${IN_MANGA}) AND owner_user_id NOT IN (${TARGET_MEMBERS})`;
    const snapshot = snapshotCopies(ctx, lost, [mangaId, target]);
    const removed = ctx.db.prepare(`SELECT username FROM users WHERE id IN (SELECT owner_user_id FROM volume_copies WHERE ${lost}) ORDER BY username COLLATE NOCASE`)
        .all(mangaId, target).map(r => r.username);
    ctx.db.prepare('UPDATE mangas SET shelf_id = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?').run(target, ctx.user.id, mangaId);
    ctx.db.prepare('UPDATE trash SET shelf_id = ? WHERE manga_id = ?').run(target, mangaId);
    ctx.db.prepare(`DELETE FROM volume_copies WHERE ${lost}`).run(mangaId, target);
    settleVolumes(ctx, snapshot.volumes.map(v => v.id));
    return { snapshot, removed };
}

const UNDO_GONE = 'Rückgängig ist nicht mehr möglich (abgelaufen oder schon ausgeführt)';
const UNDO_CHANGED = 'Das lässt sich nicht mehr rückgängig machen, weil sich das Regal inzwischen geändert hat';

/**
 * POST /shelves/undo { undo_token }: takes back a removal from a shelf (or leaving it) or a move of a series, with the
 * ownership copies that went (price, date, condition, lending). Only the caller who made the change, within the bulk
 * undo window, and only while the shelf allows it: the remover must still own the shelf, a move needs editor rights on
 * both sides again, and nothing comes back over a membership or a move made since.
 */
function undo(ctx, { body }) {
    const token = body && body.undo_token;
    if (typeof token !== 'string' || token.trim() === '' || token.length > 100) throw badRequest('Ungültige Rückgängig-Daten', 'SHELF_UNDO');
    const entry = ctx.undo.get(token);
    const kind = entry && entry.previous && entry.previous.kind;
    if (!entry || (kind !== 'member' && kind !== 'move') || entry.expires <= ctx.now().getTime() || entry.generation !== ctx.db.generation()) {
        if (entry && (kind === 'member' || kind === 'move')) ctx.undo.delete(token);
        throw new HttpError(410, UNDO_GONE, 'SHELF_UNDO_EXPIRED');
    }
    if (entry.userId !== ctx.user.id) throw forbidden('Nur wer die Änderung gemacht hat, kann sie rückgängig machen', 'SHELF_UNDO_FORBIDDEN');
    const prev = entry.previous;
    const result = kind === 'member' ? undoMember(ctx, prev) : undoMove(ctx, prev);
    ctx.undo.delete(token);
    return { body: { success: true, ...result } };
}

function undoMember(ctx, prev) {
    const shelf = ctx.db.prepare('SELECT id FROM shelves WHERE id = ?').get(prev.shelfId);
    const user = ctx.db.prepare('SELECT id, role FROM users WHERE id = ?').get(prev.userId);
    if (!shelf || !user) throw conflict(UNDO_CHANGED, 'SHELF_UNDO_CHANGED');
    if (!prev.own) access.requireShelf(ctx, prev.shelfId, 'owner');
    if (ctx.db.prepare('SELECT 1 FROM shelf_members WHERE shelf_id = ? AND user_id = ?').get(prev.shelfId, prev.userId)) {
        throw conflict(UNDO_CHANGED, 'SHELF_UNDO_CHANGED');
    }
    const role = access.isReadOnlyAccount(user.role) ? 'viewer' : prev.role;
    const restored = ctx.db.transaction(() => {
        ctx.db.prepare('INSERT INTO shelf_members (shelf_id, user_id, role) VALUES (?, ?, ?)').run(prev.shelfId, prev.userId, role);
        // the empty shelf that leaving made goes again while nothing happened in it
        const personal = prev.personal && ctx.db.prepare(`
            SELECT 1 FROM shelves s WHERE s.id = ? AND s.is_default = 0
               AND NOT EXISTS (SELECT 1 FROM mangas WHERE shelf_id = s.id) AND NOT EXISTS (SELECT 1 FROM trash WHERE shelf_id = s.id)
               AND (SELECT count(*) FROM shelf_members WHERE shelf_id = s.id) = 1
        `).get(prev.personal);
        if (personal) {
            ctx.db.prepare('DELETE FROM shelf_members WHERE shelf_id = ?').run(prev.personal);
            ctx.db.prepare('DELETE FROM shelves WHERE id = ?').run(prev.personal);
        }
        const inShelf = (copy) => ctx.db.prepare('SELECT 1 FROM volumes v JOIN mangas m ON m.id = v.manga_id WHERE v.id = ? AND m.shelf_id = ?').get(copy.volume_id, prev.shelfId);
        return restoreCopies(ctx, prev, (copy) => Boolean(inShelf(copy)));
    });
    access.ensureMembership(ctx);
    return { shelf_id: prev.shelfId, user_id: prev.userId, restored_copies: restored, members: prev.own ? undefined : membersOf(ctx, prev.shelfId) };
}

function undoMove(ctx, prev) {
    const row = ctx.db.prepare('SELECT shelf_id FROM mangas WHERE id = ?').get(prev.mangaId);
    if (!row || row.shelf_id !== prev.target) throw conflict(UNDO_CHANGED, 'SHELF_UNDO_CHANGED');
    access.mangaAccess(ctx, prev.mangaId, 'editor');
    access.requireShelf(ctx, prev.source, 'editor');
    // copies bought in the new shelf by someone who is no member of the old one would go: that is no undo any more
    if (ctx.db.prepare(`SELECT 1 FROM volume_copies WHERE volume_id IN (${IN_MANGA}) AND owner_user_id NOT IN (${TARGET_MEMBERS}) LIMIT 1`).get(prev.mangaId, prev.source)) {
        throw conflict(UNDO_CHANGED, 'SHELF_UNDO_CHANGED');
    }
    const restored = ctx.db.transaction(() => {
        moveSeries(ctx, prev.mangaId, prev.source);
        const member = (copy) => copy.owner_user_id === null
            || Boolean(ctx.db.prepare('SELECT 1 FROM shelf_members WHERE shelf_id = ? AND user_id = ?').get(prev.source, copy.owner_user_id));
        return restoreCopies(ctx, prev, member);
    });
    return { id: prev.mangaId, shelf_id: prev.source, restored_copies: restored };
}

/** GET /users/directory: the accounts the caller may see by name (shares a shelf with them; an admin sees all). */
function directory(ctx) {
    const users = ctx.db.prepare('SELECT id, username FROM users ORDER BY username COLLATE NOCASE').all();
    return { body: { users: access.visibleRows(ctx, users, 'id') } };
}

module.exports = { directory, list, detail, create, update, remove, addMember, setMemberRole, removeMember, movePreview, moveManga, undo };
