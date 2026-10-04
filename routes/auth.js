// Setup, login, session and user-management routes.
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pkg = require('../package.json');
const { db, hasAdmin, runTransaction, getInstanceId, createCtx } = require('../db');
const {
    AUTH_ERRORS,
    signSessionToken,
    bumpSessionVersion,
    endSession,
    tokenFromRequest,
    sameUsername,
    setAuthCookie,
    clearAuthCookie,
    requireAuth,
    requireAdmin,
    requireEditor
} = require('../middleware/auth');
const { loginLimiter, logoutLimiter, setupLimiter, passwordChangeLimiter, loginGuard, accountKey, clientIp } = require('../middleware/rateLimit');
const log = require('../utils/logger').child('auth');
const { config, normalizeSetupToken } = require('../utils/config');
const { HttpError, msg, badRequest, notFound, sendError } = require('../utils/httpError');
const { purchaseDateFromRemainingOwners } = require('../utils/owners');
const { revokeFeedTokens } = require('../core/handlers/radar');
const listSync = require('../core/anime/listSync');
const { parseProfileBody, saveProfile, readProfile } = require('../core/lib/locales');

const ROLES = ['admin', 'editor', 'visitor', 'guest'];
const ROLE_ERROR = msg('Ungültige Rolle (erlaubt: {allowed})', { allowed: ROLES.join(', ') });
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72; // bcrypt ignores everything beyond 72 bytes
const passwordError = (pw) => {
    if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH) {
        return msg('Passwort muss mindestens {min} Zeichen lang sein', { min: MIN_PASSWORD_LENGTH });
    }
    if (Buffer.byteLength(pw) > MAX_PASSWORD_LENGTH) {
        return msg('Passwort darf höchstens {max} Bytes lang sein', { max: MAX_PASSWORD_LENGTH });
    }
    return null;
};

// --- SYSTEM & VERSION ---
router.get('/version', (req, res) => {
    res.json({ version: pkg.version });
});

// --- SETUP & AUTH ---
router.get('/setup/status', (req, res) => {
    res.json({ needsSetup: !hasAdmin(), version: pkg.version });
});

const MAX_USERNAME_LENGTH = 64;
// ',' and '|' separate owner names in the CSV exchange
// eslint-disable-next-line no-control-regex
const USERNAME_FORBIDDEN = /[,|\u0000-\u001f\u007f-\u009f]/;
const usernameError = (cleanUsername) => {
    if (cleanUsername.length > MAX_USERNAME_LENGTH) return msg('Benutzername ist zu lang (maximal {max} Zeichen)', { max: MAX_USERNAME_LENGTH });
    if (USERNAME_FORBIDDEN.test(cleanUsername)) return 'Benutzername darf weder Komma, senkrechten Strich (|) noch Steuerzeichen enthalten';
    return null;
};
// First-run code: whoever reaches a fresh public instance first must not become its admin. SETUP_TOKEN (normalised and
// length-checked in utils/config.js) overrides the generated code, which only lives in memory; index.js prints it.
const SETUP_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
let generatedSetupToken = null;

function generateSetupToken() {
    const chars = Array.from({ length: 16 }, () => SETUP_CODE_ALPHABET[crypto.randomInt(SETUP_CODE_ALPHABET.length)]);
    return chars.join('').match(/.{4}/g).join('-');
}

function currentSetupToken() {
    const configured = config.setupToken;
    if (configured) return configured;
    if (!generatedSetupToken) generatedSetupToken = generateSetupToken();
    return generatedSetupToken;
}

function setupTokenMatches(candidate) {
    if (typeof candidate !== 'string') return false;
    const given = normalizeSetupToken(candidate);
    if (!given) return false;
    const digest = (v) => crypto.createHash('sha256').update(v).digest();
    return crypto.timingSafeEqual(digest(given), digest(normalizeSetupToken(currentSetupToken())));
}

/** Startup banner line while no admin exists (null afterwards). */
function setupNotice() {
    if (hasAdmin()) return null;
    if (config.setupToken) return 'Ersteinrichtung: Einrichtungscode ist der Wert von SETUP_TOKEN';
    return `Ersteinrichtung: Einrichtungscode für das erste Admin-Konto: ${currentSetupToken()}`;
}

if (!hasAdmin()) currentSetupToken();

// App clients (X-Client: app, or a request made with a bearer token) also get the session token in the body; the
// cookie is set for every client.
const wantsTokenInBody = (req) => String(req.get('X-Client') || '').trim().toLowerCase() === 'app'
    || req.body?.client === 'app' || req.authScheme === 'bearer';

/** Signs a session for `user`, sets the cookie and returns the body fields ({ token } for app clients). */
function issueSession(req, res, user) {
    const token = signSessionToken(user);
    setAuthCookie(req, res, token);
    return wantsTokenInBody(req) ? { token } : {};
}

const SETUP_TOKEN_INVALID = 'Einrichtungscode fehlt oder ist falsch. Er steht in der Server-Konsole beim Start (oder in SETUP_TOKEN).';
const adminExists = (res) => sendError(res, 400, AUTH_ERRORS.ADMIN_EXISTS, 'ADMIN_EXISTS');
const isUniqueViolation = (err) => err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.errcode === 2067 || /UNIQUE constraint failed/i.test(err.message || ''));

router.post('/setup', setupLimiter, async (req, res) => {
    if (hasAdmin()) return adminExists(res);
    const { username, password, setup_token: setupToken } = req.body || {};
    if (!setupTokenMatches(setupToken)) {
        throw new HttpError(403, SETUP_TOKEN_INVALID, 'SETUP_TOKEN_INVALID');
    }
    if (typeof username !== 'string' || !username.trim() || typeof password !== 'string') {
        throw badRequest('Benutzername und Passwort sind erforderlich');
    }
    const pwErr = passwordError(password);
    if (pwErr) throw badRequest(pwErr);

    const cleanUsername = username.trim();
    const nameErr = usernameError(cleanUsername);
    if (nameErr) throw badRequest(nameErr);
    const hash = await bcrypt.hash(password, 10);

    // Re-check right before the (synchronous) insert so two concurrent setups cannot both create an admin
    if (hasAdmin()) return adminExists(res);
    const result = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(cleanUsername, hash, 'admin');
    const newUserId = Number(result.lastInsertRowid);
    generatedSetupToken = null;

    const session = issueSession(req, res, { id: newUserId, username: cleanUsername, role: 'admin', password_changed_at: null });
    res.json({ success: true, user: { id: newUserId, username: cleanUsername, role: 'admin' }, ...session });
});

// Pre-computed hash so unknown usernames cost the same time as wrong passwords (no user enumeration by timing)
const DUMMY_HASH = bcrypt.hashSync('manga-shelf-dummy-password', 10);

const tooManyLoginFailures = (res, retryAfter) => {
    res.setHeader('Retry-After', retryAfter);
    return sendError(res, 429, 'Zu viele fehlgeschlagene Anmeldeversuche für diesen Benutzer. Bitte in einigen Minuten erneut versuchen.', 'TOO_MANY_ATTEMPTS');
};

router.post('/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
        throw badRequest('Bitte Benutzername und Passwort eingeben');
    }
    const account = accountKey(username);
    const ip = clientIp(req);
    const lock = loginGuard.check(account, ip);
    if (lock.locked) return tooManyLoginFailures(res, lock.retryAfter);
    if (loginLimiter.consume(req, res, { exempt: loginGuard.knows(account, ip) })) return;
    // Counted before the await so parallel guesses cannot all pass the check; a success clears it again
    loginGuard.attempt(account, ip);

    // "Max" and "max" are the same account; an exact match wins if old data has both
    const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE ORDER BY (username = ?) DESC, id ASC LIMIT 1').get(username.trim(), username.trim());
    const valid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !valid) throw new HttpError(401, 'Ungültige Anmeldedaten', 'INVALID_CREDENTIALS');
    loginGuard.succeeded(account, ip);
    loginLimiter.refund(req);

    // Signed with the session version read together with the hash: a reset during the compare ends this session
    const session = issueSession(req, res, user);
    res.json({ success: true, user: { id: user.id, username: user.username, role: user.role }, ...session });
});

const PASSWORD_CHANGED_MEANWHILE = 'Das Passwort wurde in der Zwischenzeit geändert. Bitte neu laden und erneut versuchen.';
const authGone = (res) => sendError(res, 401, AUTH_ERRORS.SESSION_INVALID, 'SESSION_INVALID');
const WRONG_PASSWORD = 'Das aktuelle Passwort stimmt nicht';

// Own password: needs the current one; ends all other sessions and keeps this one logged in with a fresh token.
// Wrong current passwords count toward the same lock as failed logins (whoever guesses here already holds a session).
router.put('/auth/password', requireAuth, passwordChangeLimiter, async (req, res) => {
    const { current_password, new_password } = req.body || {};
    if (typeof current_password !== 'string' || !current_password) {
        throw badRequest('Bitte das aktuelle Passwort eingeben');
    }
    const pwErr = passwordError(new_password);
    if (pwErr) throw badRequest(pwErr);

    const user = db.prepare('SELECT id, username, role, password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!user) throw new HttpError(403, WRONG_PASSWORD, 'WRONG_PASSWORD');
    const account = accountKey(user.username);
    const ip = clientIp(req);
    const lock = loginGuard.check(account, ip);
    if (lock.locked) {
        res.setHeader('Retry-After', lock.retryAfter);
        return sendError(res, 429, 'Zu viele Versuche, das Passwort zu ändern. Bitte in einigen Minuten erneut versuchen.', 'TOO_MANY_ATTEMPTS');
    }
    loginGuard.attempt(account, ip);
    if (!(await bcrypt.compare(current_password, user.password_hash))) {
        throw new HttpError(403, WRONG_PASSWORD, 'WRONG_PASSWORD');
    }
    loginGuard.succeeded(account, ip);
    const hash = await bcrypt.hash(new_password, 10);
    // Only while the row is still this user with the hash just compared: a restore or another change may have
    // happened during the bcrypt awaits
    const outcome = runTransaction(() => {
        const version = bumpSessionVersion(user.id, hash, { username: user.username, passwordHash: user.password_hash });
        if (version !== null) {
            revokeFeedTokens(db, user.id);
            return { version };
        }
        const now = db.prepare('SELECT username FROM users WHERE id = ?').get(user.id);
        return { gone: !now || !sameUsername(now.username, user.username) };
    });
    if (outcome.gone) return authGone(res);
    if (outcome.version === undefined) throw new HttpError(409, PASSWORD_CHANGED_MEANWHILE, 'CHANGED_MEANWHILE');

    res.json({ success: true, ...issueSession(req, res, { ...user, password_changed_at: outcome.version }) });
});

// Ends this session for good (also copies of the token); works without a valid token and always clears the cookie
router.post('/auth/logout', (req, res) => {
    clearAuthCookie(res);
    if (logoutLimiter.consume(req, res)) return;
    try {
        endSession(tokenFromRequest(req));
    } catch (err) {
        log.warn('Logout: session could not be revoked:', err);
    }
    res.json({ success: true });
});

router.get('/auth/me', requireAuth, (req, res) => {
    res.json({ user: { ...req.user, ...readProfile(db, req.user.id) } });
});

// Own language settings; guests too (only their own row). locale null = follow the device.
router.put('/auth/profile', requireAuth, (req, res) => {
    const fields = parseProfileBody(req.body);
    res.json({ user: { ...req.user, ...saveProfile(db, req.user.id, fields) } });
});

// QR code "Mit App verbinden": the address this browser used plus the instance id the app checks on /api/health
router.get('/auth/connect-info', requireEditor, (req, res) => {
    const url = `${req.protocol}://${req.get('host')}`;
    const instanceId = getInstanceId();
    const params = new URLSearchParams({ url, name: 'Manga Shelf', ...(instanceId ? { id: instanceId } : {}) });
    res.set('Cache-Control', 'no-store');
    res.json({ url, name: 'Manga Shelf', instance_id: instanceId, link: `manga-shelf://connect?${params}` });
});

// --- USER MANAGEMENT (Admin only) ---
router.get('/users', requireAdmin, (req, res) => {
    const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id ASC').all();
    res.json(users);
});

router.post('/users', requireAdmin, async (req, res) => {
    const { username, password, role = 'editor' } = req.body || {};
    if (!ROLES.includes(role)) {
        throw badRequest(ROLE_ERROR);
    }
    if (typeof username !== 'string' || !username.trim()) {
        throw badRequest('Benutzername darf nicht leer sein');
    }
    const pwErr = passwordError(password);
    if (pwErr) throw badRequest(pwErr);
    const cleanUsername = username.trim();
    const nameErr = usernameError(cleanUsername);
    if (nameErr) throw badRequest(nameErr);
    const cleanRole = role;

    const usernameTaken = () => sendError(res, 400, 'Dieser Benutzername existiert bereits', 'USERNAME_TAKEN');
    if (db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(cleanUsername)) return usernameTaken();

    const hash = await bcrypt.hash(password, 10);
    // Check again after the await, synchronously with the insert: a parallel create of "Max"/"max" may have won.
    // (COLLATE NOCASE folds ASCII only, like the login lookup.)
    let result;
    try {
        result = runTransaction(() => {
            if (db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(cleanUsername)) return null;
            return db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(cleanUsername, hash, cleanRole);
        });
    } catch (err) {
        if (isUniqueViolation(err)) return usernameTaken();
        throw err;
    }
    if (!result) return usernameTaken();

    res.json({
        success: true,
        user: {
            id: Number(result.lastInsertRowid),
            username: cleanUsername,
            role: cleanRole
        }
    });
});

const LAST_ADMIN_DEMOTE = 'Der letzte verbleibende Administrator kann nicht herabgestuft werden';
const USER_CHANGED_MEANWHILE = 'Der Benutzer wurde in der Zwischenzeit geändert. Bitte neu laden und erneut versuchen.';

router.put('/users/:id', requireAdmin, async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const { role, password } = req.body || {};
    const user = db.prepare('SELECT id, username, role, password_hash FROM users WHERE id = ?').get(userId);
    if (!user) throw notFound('Benutzer');

    if (role && !ROLES.includes(role)) {
        throw badRequest(ROLE_ERROR);
    }
    if (password) {
        const pwErr = passwordError(password);
        if (pwErr) throw badRequest(pwErr);
    }
    const hash = password ? await bcrypt.hash(password, 10) : null;

    // Re-read and write in one synchronous step: two admins demoting each other in parallel must not both pass
    // the last-admin check while the other request waits for bcrypt. The id must still name the same person with
    // the same hash (a restore or another reset may have happened during the await).
    const outcome = runTransaction(() => {
        const caller = db.prepare('SELECT username, role FROM users WHERE id = ?').get(req.user.id);
        if (!caller || caller.role !== 'admin' || !sameUsername(caller.username, req.user.username)) return { status: 403 };
        const current = db.prepare('SELECT id, username, role, password_hash, password_changed_at FROM users WHERE id = ?').get(userId);
        if (!current) return { status: 404 };
        if (!sameUsername(current.username, user.username) || (hash && current.password_hash !== user.password_hash)) return { status: 409 };
        const newRole = role || current.role;
        if (current.role === 'admin' && newRole !== 'admin') {
            const others = db.prepare("SELECT count(*) AS count FROM users WHERE role = 'admin' AND id != ?").get(userId);
            if (!others || others.count < 1) return { status: 400 };
        }
        const version = hash ? bumpSessionVersion(userId, hash, { username: user.username, passwordHash: user.password_hash }) : current.password_changed_at;
        if (hash && version === null) return { status: 409 };
        if (hash) revokeFeedTokens(db, userId);
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(newRole, userId);
        listSync.onRoleChanged(createCtx(), userId, newRole);
        return { status: 200, user: { id: current.id, username: current.username, role: newRole, password_changed_at: version } };
    });
    if (outcome.status === 403) return sendError(res, 403, AUTH_ERRORS.FORBIDDEN, 'FORBIDDEN');
    if (outcome.status === 404) throw notFound('Benutzer');
    if (outcome.status === 409) throw new HttpError(409, USER_CHANGED_MEANWHILE, 'CHANGED_MEANWHILE');
    if (outcome.status === 400) throw badRequest(LAST_ADMIN_DEMOTE);

    const updated = outcome.user;
    let session = {};
    if (hash) {
        loginGuard.clear(accountKey(updated.username));
        // Own password reset here ends the other sessions, not this one
        if (userId === req.user.id) session = issueSession(req, res, updated);
    }
    res.json({ success: true, user: { id: userId, username: updated.username, role: updated.role }, ...session });
});

router.delete('/users/:id', requireAdmin, (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (userId === req.user.id) {
        throw badRequest('Du kannst dein eigenes Administratorkonto nicht löschen');
    }
    const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
    if (!user) {
        throw notFound('Benutzer');
    }

    // Defensive: the caller is an admin and cannot delete itself, so another admin always remains today
    if (user.role === 'admin') {
        const adminCountRow = db.prepare("SELECT count(*) as count FROM users WHERE role = 'admin'").get();
        if (adminCountRow && adminCountRow.count <= 1) {
            throw badRequest('Der letzte verbleibende Administrator kann nicht gelöscht werden');
        }
    }

    // volume_reads go with the user; mangas/animes.updated_by are plain foreign keys and would block the delete otherwise
    runTransaction(() => {
        const shared = db.prepare(`
            SELECT volume_id FROM volume_owners
            WHERE user_id = ? AND volume_id IN (SELECT volume_id FROM volume_owners WHERE user_id != ?)
        `).all(userId, userId).map(r => r.volume_id);
        db.prepare('DELETE FROM volume_reads WHERE user_id = ?').run(userId);
        // Volumes only this user owned go to the deleting admin so the collection does not shrink
        db.prepare(`
            INSERT OR IGNORE INTO volume_owners (volume_id, user_id, price, purchase_date, condition)
            SELECT volume_id, ?, price, purchase_date, condition FROM volume_owners
            WHERE user_id = ? AND volume_id NOT IN (SELECT volume_id FROM volume_owners WHERE user_id != ?)
        `).run(req.user.id, userId, userId);
        db.prepare('DELETE FROM volume_owners WHERE user_id = ?').run(userId);
        for (const volumeId of shared) purchaseDateFromRemainingOwners(db, volumeId);
        db.prepare('UPDATE mangas SET updated_by = NULL WHERE updated_by = ?').run(userId);
        // anime progress and API keys go with the user (ON DELETE CASCADE)
        db.prepare('UPDATE animes SET updated_by = NULL WHERE updated_by = ?').run(userId);
        revokeFeedTokens(db, userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    });
    res.json({ success: true });
});

module.exports = router;
module.exports.setupNotice = setupNotice;
module.exports.setupTokenMatches = setupTokenMatches;
