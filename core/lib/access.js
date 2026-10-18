// Who a request acts for, and which shelves (collections) it may see. A shelf is a collection with members; a member is
// owner, editor or viewer. A user outside a shelf gets 404 for everything in it (ids cannot be probed), a viewer who
// tries to write gets 403. A server admin sees no foreign shelves.
const { HttpError, msg, badRequest, notFound } = require('../errors');

const ROLE_WEIGHT = { viewer: 1, editor: 2, owner: 3 };
const DEFAULT_SHELF_NAME = 'Sammlung';
const SHELF_COLOR = '#6366f1';
const READ_ONLY_ROLES = ['visitor', 'guest'];
const SHELF_MODES = ['household', 'personal', 'share_same', 'share_mutual'];

/** A positive id from a safe integer or a plain digit string ("12"); null for anything else ("1e1", " 1", "0x1", 1.5). */
function parseId(raw) {
    if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
    const id = Number(raw);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Visitors and guests never hold more than viewer rights in a shelf. */
const isReadOnlyAccount = (appRole) => READ_ONLY_ROLES.includes(appRole);

/** The shelf role an account gets when it joins a shelf without a choice: editor, viewer for read-only accounts. */
const joinRole = (appRole) => (isReadOnlyAccount(appRole) ? 'viewer' : 'editor');

const isMember = (db, shelfId, userId) => Boolean(db.prepare('SELECT 1 FROM shelf_members WHERE shelf_id = ? AND user_id = ?').get(shelfId, userId));

/**
 * Non-admins may only act for themselves; sending their own id is fine (the UI always sends one). With `shelfId`,
 * somebody else must be a member of that shelf. Returns the user id or throws 400/403/404.
 */
function resolveTargetUser(ctx, raw, shelfId) {
    if (raw === undefined || raw === null || raw === '') return ctx.user.id;
    const text = String(raw).trim();
    const id = (typeof raw === 'number' || typeof raw === 'string') && /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(id)) throw badRequest('Ungültige user_id');
    if (id !== Number(ctx.user.id) && ctx.user.role !== 'admin') {
        throw new HttpError(403, 'Nur Administratoren dürfen das für andere Benutzer ändern', 'FORBIDDEN');
    }
    if (!ctx.db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw notFound('Benutzer');
    if (shelfId !== undefined && id !== Number(ctx.user.id) && !isMember(ctx.db, shelfId, id)) throw notFound('Benutzer');
    return id;
}

/** Whether the caller may see another account by name: itself, as admin, or when both share a shelf. */
function canSeeUser(ctx, userId) {
    if (Number(userId) === Number(ctx.user.id) || ctx.user.role === 'admin') return true;
    return Boolean(ctx.db.prepare(`
        SELECT 1 FROM shelf_members a JOIN shelf_members b ON b.shelf_id = a.shelf_id
        WHERE a.user_id = ? AND b.user_id = ? LIMIT 1
    `).get(ctx.user.id, userId));
}

const memberships = new WeakMap();

const defaultShelf = (db) => db.prepare('SELECT id, name FROM shelves WHERE is_default = 1 ORDER BY id LIMIT 1').get();

/**
 * Makes sure an account without any shelf joins one: the household shelf (since migration 32), as its owner while it
 * has no members, else as editor (viewer for read-only accounts); a personal shelf when there is none. Writes nothing
 * for an id without a users row (the pending profile -1 of a local follower window, an account deleted meanwhile).
 */
function ensureMembership(ctx) {
    const user = ctx.user;
    if (!user) return;
    const userId = Number(user.id);
    if (!Number.isSafeInteger(userId) || userId <= 0) return;
    const generation = typeof ctx.db.generation === 'function' ? ctx.db.generation() : 0;
    const key = `${generation}:${userId}`;
    const cache = memberships.get(ctx.db) || new Map();
    memberships.set(ctx.db, cache);
    if (cache.get(userId) === key) return;
    const has = ctx.db.prepare('SELECT 1 FROM shelf_members WHERE user_id = ? LIMIT 1').get(userId);
    if (!has) {
        if (!ctx.db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return;
        const home = defaultShelf(ctx.db);
        if (home) {
            const members = ctx.db.prepare('SELECT COUNT(*) AS n FROM shelf_members WHERE shelf_id = ?').get(home.id).n;
            const role = members === 0 ? 'owner' : joinRole(user.role);
            if (members === 0) ctx.db.prepare('UPDATE shelves SET owner_user_id = ? WHERE id = ?').run(userId, home.id);
            ctx.db.prepare('INSERT INTO shelf_members (shelf_id, user_id, role) VALUES (?, ?, ?)').run(home.id, userId, role);
        } else {
            createPersonalShelf(ctx.db, userId);
        }
    }
    cache.set(userId, key);
}

/**
 * The caller's memberships [{ shelf_id, role }]. A pending local profile (id <= 0, no users row yet) reads the
 * household shelf, as it will once its row exists, and writes nowhere.
 */
function memberRows(ctx) {
    ensureMembership(ctx);
    const rows = ctx.db.prepare('SELECT shelf_id, role FROM shelf_members WHERE user_id = ?').all(ctx.user.id);
    if (rows.length || Number(ctx.user.id) > 0) return rows;
    const home = defaultShelf(ctx.db);
    return home ? [{ shelf_id: home.id, role: 'viewer' }] : [];
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

/**
 * The shelf fields of POST /users, checked before anything is written: { mode, shareRole, shareWith }. Without
 * shelf_mode, separate_shelf: true means 'personal', otherwise the account joins the household shelf. A read-only
 * account (`appRole` visitor or guest) gets no shelf of its own ('personal', 'share_mutual'): it could not fill it.
 */
function parseShelfSetup(body = {}, appRole = 'editor') {
    let mode = body.shelf_mode;
    if (mode === undefined || mode === null || mode === '') {
        if (body.separate_shelf !== undefined && body.separate_shelf !== null && typeof body.separate_shelf !== 'boolean') {
            throw badRequest('Ungültiger Wert für separate_shelf (true oder false)');
        }
        mode = body.separate_shelf === true ? 'personal' : 'household';
    } else if (!SHELF_MODES.includes(mode)) {
        throw badRequest(msg('Unbekannter Regal-Modus (erlaubt: {allowed})', { allowed: SHELF_MODES.join(', ') }), 'SHELF_MODE');
    }
    if (isReadOnlyAccount(appRole) && (mode === 'personal' || mode === 'share_mutual')) {
        throw badRequest('Besucher- und Gastkonten bekommen kein eigenes Regal, weil sie darin nichts anlegen können. Bitte das Haushaltsregal oder das Regal eines Benutzers wählen.', 'SHELF_MODE');
    }
    const shareRole = body.share_role === undefined || body.share_role === null || body.share_role === '' ? 'editor' : body.share_role;
    if (shareRole !== 'editor' && shareRole !== 'viewer') throw badRequest('Ungültige Regal-Rolle (editor oder viewer)', 'SHELF_ROLE');
    if (mode !== 'share_same' && mode !== 'share_mutual') return { mode, shareRole };
    const shareWith = parseId(typeof body.share_with_user_id === 'string' ? body.share_with_user_id.trim() : body.share_with_user_id);
    if (!shareWith) throw badRequest('Ungültige share_with_user_id', 'SHELF_SHARE_USER');
    return { mode, shareRole, shareWith };
}

function requireShelfOwnerFor(ctx, shelf) {
    if (shelfRole(ctx, shelf.id) !== 'owner') {
        throw badRequest(msg('Nur ein Besitzer des Regals „{name}“ kann neue Konten dort aufnehmen', { name: shelf.name }), 'SHELF_NOT_OWNER');
    }
}

/** A member's role as it counts: stored role, capped at viewer for read-only accounts; null for a non-member. */
function memberRole(db, shelfId, userId) {
    const row = db.prepare('SELECT m.role, u.role AS app_role FROM shelf_members m JOIN users u ON u.id = m.user_id WHERE m.shelf_id = ? AND m.user_id = ?').get(shelfId, userId);
    if (!row) return null;
    return isReadOnlyAccount(row.app_role) ? 'viewer' : row.role;
}

/**
 * Puts a new account (ctx.user created it) into its shelves as `plan` from parseShelfSetup says; call it in the
 * transaction of the users row. A shelf someone else is in only opens to the account when the caller owns it, and
 * the granted role never exceeds the role of the account it is shared from. Throws 400.
 */
function setupUserShelf(ctx, newUser, plan) {
    const db = ctx.db;
    const capped = joinRole(newUser.role);
    const wanted = plan.shareRole === 'viewer' ? 'viewer' : capped;
    const join = (shelfId, userId, role) => db.prepare('INSERT OR IGNORE INTO shelf_members (shelf_id, user_id, role) VALUES (?, ?, ?)').run(shelfId, userId, role);
    if (plan.mode === 'household') {
        const home = defaultShelf(db);
        if (home) {
            requireShelfOwnerFor(ctx, home);
            join(home.id, newUser.id, wanted);
            return { shelfId: home.id, mode: plan.mode };
        }
    }
    if (plan.mode === 'household' || plan.mode === 'personal') {
        return { shelfId: createPersonalShelf(db, newUser.id), mode: 'personal' };
    }
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(plan.shareWith);
    if (!target) throw badRequest('Das Konto zum Teilen gibt es nicht', 'SHELF_SHARE_USER');
    if (plan.mode === 'share_mutual' && target.id !== Number(ctx.user.id)) {
        throw badRequest('Gegenseitig teilen lässt sich nur mit deinem eigenen Konto', 'SHELF_SHARE_USER');
    }
    const shelfId = userPrimaryShelf(db, target.id);
    const shelf = shelfId && db.prepare('SELECT id, name FROM shelves WHERE id = ?').get(shelfId);
    if (!shelf) throw badRequest('Das Konto zum Teilen hat kein Regal', 'SHELF_SHARE_USER');
    requireShelfOwnerFor(ctx, shelf);
    const ceiling = memberRole(db, shelf.id, target.id) || 'viewer';
    const role = ROLE_WEIGHT[ceiling] < ROLE_WEIGHT[wanted] ? ceiling : wanted;
    if (plan.mode === 'share_same') {
        join(shelf.id, newUser.id, role);
        return { shelfId: shelf.id, mode: plan.mode };
    }
    const own = createPersonalShelf(db, newUser.id);
    join(shelf.id, newUser.id, role);
    join(own, target.id, 'editor');
    return { shelfId: own, mode: plan.mode };
}

/** Owners of a shelf that can act as owners (admin or editor accounts), apart from `exceptUserId`. */
function activeOwnerCount(db, shelfId, exceptUserId = 0) {
    return db.prepare(`
        SELECT count(*) AS n FROM shelf_members m JOIN users u ON u.id = m.user_id
        WHERE m.shelf_id = ? AND m.role = 'owner' AND u.role IN ('admin', 'editor') AND m.user_id != ?
    `).get(shelfId, exceptUserId).n;
}

/**
 * Follows a change of the account role in the shelves: admin -> editor gives up the owner role in every shelf it
 * does not own alone; visitor/guest -> editor/admin turns its viewer role in the household shelf into editor;
 * editor/admin -> visitor/guest makes every membership viewer. Returns { shelf } (its name, nothing written) when
 * that last step would leave a shelf without an owner, else null. Call it inside a transaction.
 */
function reconcileShelfRoles(db, userId, previousRole, newRole) {
    if (previousRole === newRole) return null;
    const wasReadOnly = isReadOnlyAccount(previousRole);
    const readOnly = isReadOnlyAccount(newRole);
    if (!wasReadOnly && readOnly) {
        const owned = db.prepare(`
            SELECT s.id, s.name FROM shelf_members m JOIN shelves s ON s.id = m.shelf_id
            WHERE m.user_id = ? AND m.role = 'owner' ORDER BY s.is_default DESC, s.id
        `).all(userId);
        const lonely = owned.find(s => activeOwnerCount(db, s.id, userId) === 0);
        if (lonely) return { shelf: lonely.name };
        db.prepare("UPDATE shelf_members SET role = 'viewer' WHERE user_id = ?").run(userId);
        return null;
    }
    if (wasReadOnly && !readOnly) {
        db.prepare(`
            UPDATE shelf_members SET role = 'editor'
            WHERE user_id = ? AND role = 'viewer' AND shelf_id IN (SELECT id FROM shelves WHERE is_default = 1)
        `).run(userId);
        return null;
    }
    if (previousRole === 'admin' && newRole === 'editor') {
        const owned = db.prepare("SELECT shelf_id FROM shelf_members WHERE user_id = ? AND role = 'owner'").all(userId);
        const demote = db.prepare("UPDATE shelf_members SET role = 'editor' WHERE shelf_id = ? AND user_id = ?");
        for (const { shelf_id: shelfId } of owned) {
            if (activeOwnerCount(db, shelfId, userId) > 0) demote.run(shelfId, userId);
        }
    }
    return null;
}

/** Role of the caller in a shelf ('owner' | 'editor' | 'viewer' | null). A read-only account never writes. */
function shelfRole(ctx, shelfId) {
    if (!ctx.user) return 'owner';
    const id = Number(shelfId);
    const row = memberRows(ctx).find(r => r.shelf_id === id);
    if (!row) return null;
    if (isReadOnlyAccount(ctx.user.role)) return 'viewer';
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
    const read = isReadOnlyAccount(ctx.user.role);
    return memberRows(ctx).filter(r => ROLE_WEIGHT[read ? 'viewer' : r.role] >= ROLE_WEIGHT[minRole]).map(r => r.shelf_id);
}

/** ?shelf_id=<n> narrows to one shelf (checked), anything else (or "all") means every shelf of the caller. */
function requestedShelfIds(ctx, raw, minRole = 'viewer') {
    if (raw === undefined || raw === null || raw === '' || raw === 'all') return accessibleShelfIds(ctx, minRole);
    const id = parseId(raw);
    if (!id) throw notFound('Regal');
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
        const id = parseId(raw);
        if (!id) throw notFound('Regal');
        requireShelf(ctx, id, 'editor');
        return id;
    }
    const ids = accessibleShelfIds(ctx, 'editor');
    if (!ids.length) throw new HttpError(403, 'Keine ausreichende Berechtigung für dieses Regal', 'FORBIDDEN');
    const own = ctx.db.prepare(`SELECT id FROM shelves WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY (owner_user_id = ?) DESC, is_default DESC, id LIMIT 1`).get(...ids, ctx.user ? ctx.user.id : 0);
    return own.id;
}

/** The shelf of a series after checking the caller's role there; 404 for an unknown or foreign id (see parseId). */
function mangaAccess(ctx, mangaId, minRole = 'viewer') {
    const id = parseId(mangaId);
    const row = id && ctx.db.prepare('SELECT shelf_id FROM mangas WHERE id = ?').get(id);
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
    const id = parseId(volumeId);
    const row = id && ctx.db.prepare('SELECT manga_id FROM volumes WHERE id = ?').get(id);
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
    const scopedSelect = sql.replace(/\b(FROM|JOIN)\s+(mangas|volumes)\b(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi, (all, kw, table, alias) => {
        const sub = table.toLowerCase() === 'mangas' ? mangas : volumes;
        if (alias && !SQL_WORDS.test(alias)) return `${kw} ${sub} ${alias}`;
        const rest = alias ? ` ${alias}` : '';
        return `${kw} ${sub} ${table}${rest}`;
    });
    return scopedSelect.replace(/\bUPDATE\s+(mangas|volumes)\b([\s\S]*?)\bWHERE\s+([\s\S]+)$/i, (all, table, mid, cond) => {
        const filter = table.toLowerCase() === 'mangas'
            ? `shelf_id IN (${list})`
            : `manga_id IN (SELECT id FROM mangas WHERE shelf_id IN (${list}))`;
        return `UPDATE ${table}${mid}WHERE ${filter} AND (${cond})`;
    });
}

const MARK_TABLES = /\b(volume_reads|volume_owners|trash)\b/i;
const SCOPED_TABLE = /\b(FROM|JOIN)\s+(mangas|volumes)\b/i;

/** Throws for a statement scopeSql cannot confine to the shelves; such a statement would read or write every shelf. */
function assertScopable(sql) {
    const text = String(sql).trim();
    const unscoped = (why) => new Error(`scopedCtx: ${why}: ${text.slice(0, 80)}`);
    if (/^(DELETE|INSERT|REPLACE)\b/i.test(text)) throw unscoped('DELETE und INSERT lassen sich nicht auf Regale beschränken');
    const update = /^UPDATE\s+(mangas|volumes)\b([\s\S]*?)(\bWHERE\b|$)/i.exec(text);
    if (update && !update[3]) throw unscoped('UPDATE ohne WHERE');
    if (update && /\bSELECT\b/i.test(update[2])) throw unscoped('UPDATE mit Unterabfrage vor dem WHERE');
    if (MARK_TABLES.test(text) && !SCOPED_TABLE.test(text)) throw unscoped('Lese- und Besitzmarken nur zusammen mit mangas oder volumes');
}

/** A ctx whose db.prepare sees only the given shelves (see scopeSql); statements it cannot confine throw. */
function scopedCtx(ctx, shelfIds) {
    const db = Object.create(ctx.db);
    db.prepare = (sql) => {
        assertScopable(sql);
        return ctx.db.prepare(scopeSql(sql, shelfIds));
    };
    return { ...ctx, db };
}

module.exports = {
    scopeSql, scopedCtx, parseId, isReadOnlyAccount, joinRole, isMember, canSeeUser, memberRole, activeOwnerCount,
    resolveTargetUser, ROLE_WEIGHT, ensureMembership, createPersonalShelf, userPrimaryShelf, parseShelfSetup, setupUserShelf,
    reconcileShelfRoles, shelfRole, requireShelf, accessibleShelfIds, requestedShelfIds,
    inShelves, targetShelfId, mangaAccess, volumeAccess
};
