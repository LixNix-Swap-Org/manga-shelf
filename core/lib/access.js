// Who a request acts for, and which shelves (collections) it may see. A shelf is a collection with members; a member is
// owner, editor or viewer. A user outside a shelf gets 404 for everything in it (ids cannot be probed), a viewer who
// tries to write gets 403. A server admin sees no foreign shelves.
const { HttpError, badRequest, notFound } = require('../errors');

const ROLE_WEIGHT = { viewer: 1, editor: 2, owner: 3 };
const DEFAULT_SHELF_NAME = 'Sammlung';
const SHELF_COLOR = '#6366f1';

/**
 * Non-admins may only act for themselves; sending their own id is fine (the UI always sends one). Returns the user id
 * or throws 400/403/404.
 */
function resolveTargetUser(ctx, raw) {
    if (raw === undefined || raw === null || raw === '') return ctx.user.id;
    const text = String(raw).trim();
    const id = (typeof raw === 'number' || typeof raw === 'string') && /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(id)) throw badRequest('Ungültige user_id');
    if (id !== Number(ctx.user.id) && ctx.user.role !== 'admin') {
        throw new HttpError(403, 'Nur Administratoren dürfen das für andere Benutzer ändern', 'FORBIDDEN');
    }
    if (!ctx.db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw notFound('Benutzer');
    return id;
}

const memberships = new WeakMap();

function roleOfGlobal(user) {
    if (user.role === 'admin') return 'owner';
    if (user.role === 'editor') return 'editor';
    return 'viewer';
}

/**
 * Makes sure the user belongs to at least one shelf. The first user of an instance (or one whose shelf is still
 * unowned) joins the collection that exists since migration 32; everyone else gets a personal, empty shelf.
 */
function ensureMembership(ctx) {
    const user = ctx.user;
    if (!user) return;
    const key = `${typeof ctx.db.generation === 'function' ? ctx.db.generation() : 0}:${user.id}`;
    const cache = memberships.get(ctx.db) || new Map();
    memberships.set(ctx.db, cache);
    if (cache.get(user.id) === key) return;
    const has = ctx.db.prepare('SELECT 1 FROM shelf_members WHERE user_id = ? LIMIT 1').get(user.id);
    if (!has) {
        // Upgrade-safe default: a user nobody gave a shelf of their own joins the household collection (shelf 1),
        // like before shelves existed. POST /users with separate_shelf creates a personal shelf instead.
        const home = ctx.db.prepare('SELECT s.id, s.owner_user_id AS owner FROM shelves s WHERE s.is_default = 1 ORDER BY s.id LIMIT 1').get();
        if (home) {
            const members = ctx.db.prepare('SELECT COUNT(*) AS n FROM shelf_members WHERE shelf_id = ?').get(home.id).n;
            const role = members === 0 ? 'owner' : roleOfGlobal(user);
            if (members === 0) ctx.db.prepare('UPDATE shelves SET owner_user_id = ? WHERE id = ?').run(user.id, home.id);
            ctx.db.prepare('INSERT INTO shelf_members (shelf_id, user_id, role) VALUES (?, ?, ?)').run(home.id, user.id, role);
        } else {
            createPersonalShelf(ctx.db, user.id);
        }
    }
    cache.set(user.id, `${ctx.db.generation()}:${user.id}`);
}

function createPersonalShelf(db, userId) {
    // "Sammlung von <name>" keeps several personal shelves apart in the shelf filter and the shelves dialog.
    const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
    const name = owner && owner.username ? `${DEFAULT_SHELF_NAME} von ${owner.username}` : DEFAULT_SHELF_NAME;
    const info = db.prepare('INSERT INTO shelves (name, owner_user_id, is_default, color) VALUES (?, ?, 0, ?)').run(name, userId, SHELF_COLOR);
    db.prepare("INSERT INTO shelf_members (shelf_id, user_id, role) VALUES (?, ?, 'owner')").run(Number(info.lastInsertRowid), userId);
    return Number(info.lastInsertRowid);
}

function userPrimaryShelf(db, userId) {
    const id = Number(userId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const owned = db.prepare(`
        SELECT s.id FROM shelves s
        JOIN shelf_members sm ON sm.shelf_id = s.id AND sm.user_id = ?
        ORDER BY (sm.role = 'owner') DESC, s.is_default DESC, s.id ASC
        LIMIT 1
    `).get(id);
    return owned ? owned.id : null;
}

function setupUserShelf(db, newUser, options = {}) {
    const role = (options.share_role === 'viewer' || newUser.role === 'visitor' || newUser.role === 'guest') ? 'viewer' : 'editor';
    const targetUserId = (options.share_with_user_id !== undefined && options.share_with_user_id !== null && options.share_with_user_id !== '')
        ? Number(options.share_with_user_id)
        : null;
    const mode = options.shelf_mode || (options.separate_shelf === false ? 'household' : 'personal');

    if (mode === 'share_same' && targetUserId) {
        const targetShelfId = userPrimaryShelf(db, targetUserId);
        if (targetShelfId) {
            db.prepare('INSERT OR IGNORE INTO shelf_members (shelf_id, user_id, role) VALUES (?, ?, ?)').run(targetShelfId, newUser.id, role);
            return { shelfId: targetShelfId, mode: 'share_same' };
        }
    }

    if (mode === 'share_mutual' && targetUserId) {
        const newShelfId = createPersonalShelf(db, newUser.id);
        const targetShelfId = userPrimaryShelf(db, targetUserId);
        if (targetShelfId) {
            db.prepare('INSERT OR IGNORE INTO shelf_members (shelf_id, user_id, role) VALUES (?, ?, ?)').run(targetShelfId, newUser.id, role);
            db.prepare('INSERT OR IGNORE INTO shelf_members (shelf_id, user_id, role) VALUES (?, ?, ?)').run(newShelfId, targetUserId, 'editor');
        }
        return { shelfId: newShelfId, mode: 'share_mutual' };
    }

    if (mode === 'household') {
        const home = db.prepare('SELECT s.id FROM shelves s WHERE s.is_default = 1 ORDER BY s.id LIMIT 1').get();
        if (home) {
            db.prepare('INSERT OR IGNORE INTO shelf_members (shelf_id, user_id, role) VALUES (?, ?, ?)').run(home.id, newUser.id, role);
            return { shelfId: home.id, mode: 'household' };
        }
    }

    // Default: 'personal' -> gets an own shelf
    const personalShelfId = createPersonalShelf(db, newUser.id);
    return { shelfId: personalShelfId, mode: 'personal' };
}

/** Role of the caller in a shelf ('owner' | 'editor' | 'viewer' | null). A read-only account never writes. */
function shelfRole(ctx, shelfId) {
    if (!ctx.user) return 'owner';
    ensureMembership(ctx);
    const row = ctx.db.prepare('SELECT role FROM shelf_members WHERE shelf_id = ? AND user_id = ?').get(Number(shelfId), ctx.user.id);
    if (!row) return null;
    if (ctx.user.role === 'visitor' || ctx.user.role === 'guest') return 'viewer';
    return row.role;
}

function requireShelf(ctx, shelfId, minRole = 'viewer') {
    const role = shelfRole(ctx, shelfId);
    if (!role) throw notFound('Regal');
    if (ROLE_WEIGHT[role] < ROLE_WEIGHT[minRole]) {
        throw new HttpError(403, 'Keine ausreichende Berechtigung für dieses Regal', 'FORBIDDEN');
    }
    return role;
}

/** Ids of the shelves the caller belongs to with at least `minRole`; every shelf for background work (no user). */
function accessibleShelfIds(ctx, minRole = 'viewer') {
    if (!ctx.user) return ctx.db.prepare('SELECT id FROM shelves').all().map(r => r.id);
    ensureMembership(ctx);
    const rows = ctx.db.prepare('SELECT shelf_id, role FROM shelf_members WHERE user_id = ?').all(ctx.user.id);
    const read = ctx.user.role === 'visitor' || ctx.user.role === 'guest';
    return rows.filter(r => ROLE_WEIGHT[read ? 'viewer' : r.role] >= ROLE_WEIGHT[minRole]).map(r => r.shelf_id);
}

/** ?shelf_id=<n> narrows to one shelf (checked), anything else (or "all") means every shelf of the caller. */
function requestedShelfIds(ctx, raw, minRole = 'viewer') {
    if (raw === undefined || raw === null || raw === '' || raw === 'all') return accessibleShelfIds(ctx, minRole);
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) throw notFound('Regal');
    requireShelf(ctx, id, minRole);
    return [id];
}

/** { sql, params } for `<column> IN (…)`; matches nothing when the list is empty. */
function inShelves(column, ids) {
    if (!ids.length) return { sql: '0', params: [] };
    return { sql: `${column} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

/** The shelf a new series lands in: ?shelf_id/body.shelf_id (needs editor), else the caller's first own shelf. */
function targetShelfId(ctx, raw) {
    if (raw !== undefined && raw !== null && raw !== '') {
        const id = Number(raw);
        if (!Number.isSafeInteger(id) || id <= 0) throw notFound('Regal');
        requireShelf(ctx, id, 'editor');
        return id;
    }
    const ids = accessibleShelfIds(ctx, 'editor');
    if (!ids.length) throw new HttpError(403, 'Keine ausreichende Berechtigung für dieses Regal', 'FORBIDDEN');
    const own = ctx.db.prepare(`SELECT id FROM shelves WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY (owner_user_id = ?) DESC, is_default DESC, id LIMIT 1`).get(...ids, ctx.user ? ctx.user.id : 0);
    return own.id;
}

function mangaAccess(ctx, mangaId, minRole = 'viewer') {
    const row = ctx.db.prepare('SELECT shelf_id FROM mangas WHERE id = ?').get(Number(mangaId));
    if (!row) throw notFound('Manga');
    try {
        requireShelf(ctx, row.shelf_id, minRole);
    } catch (err) {
        if (err.status === 404) throw notFound('Manga');
        throw err;
    }
    return row.shelf_id;
}

function volumeAccess(ctx, volumeId, minRole = 'viewer') {
    const row = ctx.db.prepare('SELECT manga_id FROM volumes WHERE id = ?').get(Number(volumeId));
    if (!row) throw notFound('Band');
    try {
        return mangaAccess(ctx, row.manga_id, minRole);
    } catch (err) {
        if (err.status === 404) throw notFound('Band');
        throw err;
    }
}

const SQL_WORDS = /^(WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|ON|GROUP|ORDER|LIMIT|HAVING|UNION|AND|OR|USING|SET)$/i;

/**
 * Rewrites `FROM|JOIN mangas [alias]` and `volumes [alias]` of an aggregate query into subselects that only see the
 * given shelves (ids are inlined integers). Lets the statistics queries stay as they are.
 */
function scopeSql(sql, shelfIds) {
    const list = shelfIds.length ? shelfIds.map(n => Number(n)).filter(Number.isSafeInteger).join(',') || '-1' : '-1';
    const mangas = `(SELECT * FROM mangas WHERE shelf_id IN (${list}))`;
    const volumes = `(SELECT * FROM volumes WHERE manga_id IN (SELECT id FROM mangas WHERE shelf_id IN (${list})))`;
    return sql.replace(/\b(FROM|JOIN)\s+(mangas|volumes)\b(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi, (all, kw, table, alias) => {
        const sub = table.toLowerCase() === 'mangas' ? mangas : volumes;
        if (alias && !SQL_WORDS.test(alias)) return `${kw} ${sub} ${alias}`;
        const rest = alias ? ` ${alias}` : '';
        return `${kw} ${sub} ${table}${rest}`;
    });
}

/** A ctx whose db.prepare sees only the given shelves (see scopeSql). */
function scopedCtx(ctx, shelfIds) {
    const db = Object.create(ctx.db);
    db.prepare = (sql) => ctx.db.prepare(scopeSql(sql, shelfIds));
    return { ...ctx, db };
}

module.exports = {
    scopeSql, scopedCtx,
    resolveTargetUser, ROLE_WEIGHT, ensureMembership, createPersonalShelf, userPrimaryShelf, setupUserShelf, shelfRole, requireShelf, accessibleShelfIds, requestedShelfIds,
    inShelves, targetShelfId, mangaAccess, volumeAccess, roleOfGlobal
};
