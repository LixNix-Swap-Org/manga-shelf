// Shelves = collections with members (owner / editor / viewer): GET/POST /shelves, GET/PUT/DELETE /shelves/:id,
// members under /shelves/:id/members, and PUT /mangas/:id/shelf to move a series.
const { HttpError, msg, badRequest, notFound, conflict } = require('../errors');
const { parsePositiveInt } = require('../lib/validate');
const access = require('../lib/access');

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
    access.ensureMembership(ctx);
    const rows = ctx.db.prepare(`
        SELECT s.* FROM shelves s JOIN shelf_members m ON m.shelf_id = s.id WHERE m.user_id = ? ORDER BY s.is_default DESC, s.name COLLATE NOCASE, s.id
    `).all(ctx.user.id);
    return { body: { shelves: rows.map(r => describe(ctx, r, access.shelfRole(ctx, r.id))) } };
}

function membersOf(ctx, id) {
    return ctx.db.prepare(`
        SELECT m.user_id, u.username, m.role FROM shelf_members m JOIN users u ON u.id = m.user_id
        WHERE m.shelf_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.username COLLATE NOCASE
    `).all(id);
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
    if (ctx.db.prepare('SELECT 1 FROM mangas WHERE shelf_id = ? LIMIT 1').get(id)) {
        throw conflict('Das Regal ist nicht leer. Reihen zuerst verschieben oder löschen.', 'SHELF_NOT_EMPTY');
    }
    if (row.is_default) throw conflict('Das Standard-Regal lässt sich nicht löschen', 'SHELF_DEFAULT');
    ctx.db.prepare('DELETE FROM shelves WHERE id = ?').run(id);
    return { body: { success: true } };
}

function ownerCount(ctx, id) {
    return ctx.db.prepare("SELECT count(*) AS n FROM shelf_members WHERE shelf_id = ? AND role = 'owner'").get(id).n;
}

function addMember(ctx, { params, body }) {
    const id = shelfId(params);
    access.requireShelf(ctx, id, 'owner');
    const role = cleanRole(body.role || 'viewer');
    let user;
    if (body.user_id !== undefined && body.user_id !== null && body.user_id !== '') {
        const userId = parsePositiveInt(body.user_id);
        user = userId && ctx.db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
    } else if (typeof body.username === 'string' && body.username.trim()) {
        user = ctx.db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(body.username.trim());
    } else {
        throw badRequest('Benutzername fehlt');
    }
    if (!user) throw notFound('Benutzer');
    if (ctx.db.prepare('SELECT 1 FROM shelf_members WHERE shelf_id = ? AND user_id = ?').get(id, user.id)) {
        throw conflict('Der Benutzer hat dieses Regal schon', 'SHELF_MEMBER_EXISTS');
    }
    ctx.db.prepare('INSERT INTO shelf_members (shelf_id, user_id, role) VALUES (?, ?, ?)').run(id, user.id, role);
    return { status: 201, body: { members: membersOf(ctx, id) } };
}

function memberTarget(ctx, params) {
    const id = shelfId(params);
    const userId = parsePositiveInt(params.userId);
    const member = userId && ctx.db.prepare('SELECT role FROM shelf_members WHERE shelf_id = ? AND user_id = ?').get(id, userId);
    return { id, userId, member };
}

function setMemberRole(ctx, { params, body }) {
    const { id, userId, member } = memberTarget(ctx, params);
    access.requireShelf(ctx, id, 'owner');
    if (!member) throw notFound('Mitglied');
    const role = cleanRole(body.role);
    if (member.role === 'owner' && role !== 'owner' && ownerCount(ctx, id) <= 1) {
        throw conflict('Das Regal braucht mindestens einen Eigentümer', 'SHELF_LAST_OWNER');
    }
    ctx.db.prepare('UPDATE shelf_members SET role = ? WHERE shelf_id = ? AND user_id = ?').run(role, id, userId);
    return { body: { members: membersOf(ctx, id) } };
}

// An owner removes anyone; everybody can leave a shelf themselves.
function removeMember(ctx, { params }) {
    const { id, userId, member } = memberTarget(ctx, params);
    const own = userId === Number(ctx.user.id);
    access.requireShelf(ctx, id, own ? 'viewer' : 'owner');
    if (!member) throw notFound('Mitglied');
    if (member.role === 'owner' && ownerCount(ctx, id) <= 1) {
        throw conflict('Das Regal braucht mindestens einen Eigentümer', 'SHELF_LAST_OWNER');
    }
    ctx.db.prepare('DELETE FROM shelf_members WHERE shelf_id = ? AND user_id = ?').run(id, userId);
    return { body: { success: true, members: own ? undefined : membersOf(ctx, id) } };
}

/** PUT /mangas/:id/shelf { shelf_id }: the series (and so its volumes) moves; needs editor rights in both shelves. */
function moveManga(ctx, { params, body }) {
    const mangaId = parsePositiveInt(params.id);
    if (!mangaId) throw notFound('Manga');
    access.mangaAccess(ctx, mangaId, 'editor');
    const target = parsePositiveInt(body.shelf_id);
    if (!target) throw badRequest('Ungültiges Regal');
    access.requireShelf(ctx, target, 'editor');
    ctx.db.prepare('UPDATE mangas SET shelf_id = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?').run(target, ctx.user.id, mangaId);
    return { body: { success: true, id: mangaId, shelf_id: target } };
}

function directory(ctx) {
  const users = ctx.db.prepare('SELECT id, username FROM users ORDER BY username COLLATE NOCASE').all();
  return { body: { users } };
}

module.exports = { directory, list, detail, create, update, remove, addMember, setMemberRole, removeMember, moveManga };
