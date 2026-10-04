// Who a request acts for when it changes ownership or reading state.
const { HttpError, badRequest, notFound } = require('../errors');

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

module.exports = { resolveTargetUser };
