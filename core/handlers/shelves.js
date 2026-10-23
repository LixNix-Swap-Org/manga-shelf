// Shelves = collections with members (owner / editor / viewer): GET/POST /shelves, GET/PUT/DELETE /shelves/:id,
// members under /shelves/:id/members, PUT /mangas/:id/shelf to move a series and GET /mangas/:id/shelf-move to preview it.
const { msg, badRequest, notFound, conflict } = require('../errors');
const { parsePositiveInt } = require('../lib/validate');
const { qstr } = require('../lib/query');
const access = require('../lib/access');
const { syncStatusWithOwners, purchaseDateFromRemainingOwners } = require('../lib/owners');

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
// progress (`chapters`): what leaving or a removal deletes.
function membersOf(ctx, id) {
    return ctx.db.prepare(`
        SELECT m.user_id, u.username, CASE WHEN u.role IN ('visitor', 'guest') THEN 'viewer' ELSE m.role END AS role,
               u.role AS app_role,
               (SELECT count(*) FROM volume_owners vo WHERE vo.user_id = m.user_id AND vo.volume_id IN (${SHELF_VOLUMES})) AS owned,
               (SELECT count(*) FROM volume_reads vr WHERE vr.user_id = m.user_id AND vr.volume_id IN (${SHELF_VOLUMES})) AS read_count,
               (SELECT count(*) FROM chapter_progress cp JOIN mangas g ON g.id = cp.manga_id WHERE cp.user_id = m.user_id AND g.shelf_id = m.shelf_id) AS chapters
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
    const members = ctx.db.prepare('SELECT user_id FROM shelf_members WHERE shelf_id = ?').all(id).map(r => r.user_id);
    ctx.db.transaction(() => {
        // what is left in its trash belonged to this shelf only, so it goes with it
        ctx.db.prepare('DELETE FROM trash WHERE shelf_id = ?').run(id);
        ctx.db.prepare('DELETE FROM shelves WHERE id = ?').run(id);
        for (const userId of members) {
            if (!ctx.db.prepare('SELECT 1 FROM shelf_members WHERE user_id = ? LIMIT 1').get(userId)) {
                access.createPersonalShelf(ctx.db, userId);
            }
        }
    });
    return { body: { success: true } };
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
 * Whoever leaves a shelf no longer has access to it, so their ownership and reading marks on its volumes (and their
 * chapter progress on its webtoons) go too;
 * otherwise a volume would keep counting as owned (and read) by someone who cannot see it. A volume that loses its
 * last owner becomes "Fehlt".
 */
function forgetMarks(ctx, shelfId, userId) {
    const inShelf = 'SELECT v.id FROM volumes v JOIN mangas m ON m.id = v.manga_id WHERE m.shelf_id = ?';
    const owned = ctx.db.prepare(`SELECT volume_id FROM volume_owners WHERE user_id = ? AND volume_id IN (${inShelf})`).all(userId, shelfId).map(r => r.volume_id);
    ctx.db.prepare(`DELETE FROM volume_owners WHERE user_id = ? AND volume_id IN (${inShelf})`).run(userId, shelfId);
    ctx.db.prepare(`DELETE FROM volume_reads WHERE user_id = ? AND volume_id IN (${inShelf})`).run(userId, shelfId);
    ctx.db.prepare('DELETE FROM chapter_progress WHERE user_id = ? AND manga_id IN (SELECT id FROM mangas WHERE shelf_id = ?)').run(userId, shelfId);
    for (const volumeId of owned) {
        purchaseDateFromRemainingOwners(ctx.db, volumeId);
        syncStatusWithOwners(ctx.db, volumeId);
    }
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
    ctx.db.transaction(() => {
        ctx.db.prepare('DELETE FROM shelf_members WHERE shelf_id = ? AND user_id = ?').run(id, userId);
        forgetMarks(ctx, id, userId);
        if (!ctx.db.prepare('SELECT 1 FROM shelf_members WHERE user_id = ? LIMIT 1').get(userId)) {
            access.createPersonalShelf(ctx.db, userId);
        }
    });
    return { body: { success: true, members: own ? undefined : membersOf(ctx, id) } };
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
 * Users whose marks on the series a move into `target` deletes (they are not members there), with their counts;
 * `chapters` is their chapter of a webtoon (0 without one).
 */
function marksLostOnMove(ctx, mangaId, target) {
    return ctx.db.prepare(`
        SELECT u.id AS user_id, u.username,
               (SELECT count(*) FROM volume_owners vo WHERE vo.user_id = u.id AND vo.volume_id IN (${IN_MANGA})) AS owned,
               (SELECT count(*) FROM volume_reads vr WHERE vr.user_id = u.id AND vr.volume_id IN (${IN_MANGA})) AS read,
               COALESCE((SELECT cp.chapters_read FROM chapter_progress cp WHERE cp.user_id = u.id AND cp.manga_id = ?), 0) AS chapters
        FROM users u
        WHERE u.id NOT IN (${TARGET_MEMBERS})
          AND (EXISTS (SELECT 1 FROM volume_owners vo WHERE vo.user_id = u.id AND vo.volume_id IN (${IN_MANGA}))
               OR EXISTS (SELECT 1 FROM volume_reads vr WHERE vr.user_id = u.id AND vr.volume_id IN (${IN_MANGA}))
               OR EXISTS (SELECT 1 FROM chapter_progress cp WHERE cp.user_id = u.id AND cp.manga_id = ?))
        ORDER BY u.username COLLATE NOCASE, u.id
    `).all(mangaId, mangaId, mangaId, target, mangaId, mangaId, mangaId)
        .map(r => ({ user_id: r.user_id, username: r.username, owned: r.owned, read: r.read, chapters: r.chapters }));
}

/** GET /mangas/:id/shelf-move?shelf_id=: whose ownership, reading and chapter marks PUT /mangas/:id/shelf would delete. */
function movePreview(ctx, { params, query }) {
    const { mangaId, target } = moveTarget(ctx, params.id, qstr(query && query.shelf_id));
    return { body: { manga_id: mangaId, shelf_id: target, affected: marksLostOnMove(ctx, mangaId, target) } };
}

/**
 * PUT /mangas/:id/shelf { shelf_id }: the series (and so its volumes) moves; needs the owner role in the shelf it
 * leaves and editor rights in the target. Marks of users who are not members of the target are deleted (the move
 * preview names them).
 */
function moveManga(ctx, { params, body }) {
    const { mangaId, target } = moveTarget(ctx, params.id, body.shelf_id);
    ctx.db.transaction(() => {
        ctx.db.prepare('UPDATE mangas SET shelf_id = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?').run(target, ctx.user.id, mangaId);
        ctx.db.prepare('UPDATE trash SET shelf_id = ? WHERE manga_id = ?').run(target, mangaId);
        const owned = ctx.db.prepare(`SELECT DISTINCT volume_id FROM volume_owners WHERE volume_id IN (${IN_MANGA}) AND user_id NOT IN (${TARGET_MEMBERS})`).all(mangaId, target).map(r => r.volume_id);
        ctx.db.prepare(`DELETE FROM volume_owners WHERE volume_id IN (${IN_MANGA}) AND user_id NOT IN (${TARGET_MEMBERS})`).run(mangaId, target);
        ctx.db.prepare(`DELETE FROM volume_reads WHERE volume_id IN (${IN_MANGA}) AND user_id NOT IN (${TARGET_MEMBERS})`).run(mangaId, target);
        ctx.db.prepare(`DELETE FROM chapter_progress WHERE manga_id = ? AND user_id NOT IN (${TARGET_MEMBERS})`).run(mangaId, target);
        for (const volumeId of owned) {
            purchaseDateFromRemainingOwners(ctx.db, volumeId);
            syncStatusWithOwners(ctx.db, volumeId);
        }
    });
    return { body: { success: true, id: mangaId, shelf_id: target } };
}

function directory(ctx) {
  const users = ctx.db.prepare('SELECT id, username FROM users ORDER BY username COLLATE NOCASE').all();
  return { body: { users } };
}

module.exports = { directory, list, detail, create, update, remove, addMember, setMemberRole, removeMember, movePreview, moveManga };
