// JWT auth: sessions are cookie or bearer tokens bound to users.password_changed_at; the signing secret lives in a file.
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { db, dataDir } = require('../db');
const { config } = require('../utils/config');
const log = require('../utils/logger').child('auth');
const { bearerToken } = require('./originCheck');
const { loginGuard, accountKey, clientIp } = require('./rateLimit');
const { AUTH_TEXTS, HttpError, badRequest } = require('../core/errors');

// An explicit JWT_SECRET is only accepted if it is long enough and not a well-known placeholder from the repo;
// otherwise a random secret is kept in <DATA_DIR>/secret.key. Never in the database: backups would carry it.
const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER_SECRET = /change[-_ ]?this|changeme|secret-key|your[-_ ]?secret|example/i;
const SECRET_FILE = path.join(dataDir, 'secret.key');
const LEGACY_SECRET_KEY = 'jwt_secret';
const REVOKED_SESSIONS_KEY = 'revoked_sessions';

const validEnvSecret = (value) => !!value && value.length >= MIN_SECRET_LENGTH && !PLACEHOLDER_SECRET.test(value);

/** Removes the secret older versions kept in app_settings; true if there was one. */
function dropLegacySecret() {
    return db.prepare('DELETE FROM app_settings WHERE key = ?').run(LEGACY_SECRET_KEY).changes > 0;
}

function readSecretFile() {
    let content;
    try {
        content = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    } catch (e) {
        if (e.code === 'ENOENT') return null;
        // No silent per-process fallback: an unreadable key must stop the start, not log everyone out on each restart
        throw new Error(`Signatur-Schlüssel ${SECRET_FILE} nicht lesbar: ${e.message}`);
    }
    if (content.length >= MIN_SECRET_LENGTH) {
        if (process.platform !== 'win32') {
            try {
                if (fs.statSync(SECRET_FILE).mode & 0o077) fs.chmodSync(SECRET_FILE, 0o600);
            } catch (e) {
                log.warn(`[Auth] Rechte von ${SECRET_FILE} konnten nicht auf 0600 gesetzt werden:`, e);
            }
        }
        return content;
    }
    log.warn(`[Auth] ${SECRET_FILE} ist leer oder zu kurz und wird neu erzeugt.`);
    return null;
}

function writeSecretFile() {
    const secret = crypto.randomBytes(48).toString('base64url');
    const tmp = `${SECRET_FILE}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmp, secret + '\n', { mode: 0o600 });
        fs.renameSync(tmp, SECRET_FILE);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) { /* not there */ }
        throw new Error(`Signatur-Schlüssel ${SECRET_FILE} konnte nicht geschrieben werden: ${e.message}`);
    }
    return secret;
}

function resolveJwtSecret() {
    const fromEnv = config.jwtSecret;
    const hadLegacy = dropLegacySecret();
    if (fromEnv) {
        if (validEnvSecret(fromEnv)) return fromEnv;
        log.warn(`[Auth] JWT_SECRET ist zu kurz (< ${MIN_SECRET_LENGTH} Zeichen) oder ein Platzhalter und wird ignoriert. Es wird der Schlüssel aus ${SECRET_FILE} verwendet.`);
    }
    const stored = readSecretFile();
    if (stored) return stored;
    // The legacy secret is not carried over: every backup made before this version contains it
    const generated = writeSecretFile();
    if (hadLegacy) {
        db.prepare('DELETE FROM app_settings WHERE key = ?').run(REVOKED_SESSIONS_KEY);
        log.info('[Auth] Signatur-Schlüssel erneuert, alle Sitzungen wurden beendet');
    } else {
        log.info(`[Auth] Signatur-Schlüssel erzeugt (${SECRET_FILE})`);
    }
    return generated;
}

const JWT_SECRET = resolveJwtSecret();

/**
 * Hook for routes/backups.js after a restore (call before signing the admin's new token): ends every older session,
 * since the restored users table may hold another person under a live token's id, and drops a legacy signing secret.
 */
function persistJwtSecret() {
    dropLegacySecret();
    endAllSessions();
}

/**
 * `users.password_changed_at` doubles as the session version: tokens carry it (claim `pv`) and stop working once it
 * changes. New values are strictly increasing, so two changes in one millisecond still differ.
 */
const sessionVersion = (user) => user.password_changed_at || 0;
const NEXT_SESSION_VERSION = 'max(?, coalesce(password_changed_at, 0) + 1)';

/**
 * Sets a new password hash (or only a new session version); returns the new version or null. With `expected`
 * it writes only while the row still matches, so a restore during a bcrypt await cannot redirect it.
 */
function bumpSessionVersion(userId, passwordHash, expected) {
    const sets = passwordHash === undefined ? '' : 'password_hash = ?, ';
    const params = passwordHash === undefined ? [Date.now(), userId] : [passwordHash, Date.now(), userId];
    let where = 'id = ?';
    if (expected) {
        where += ' AND username = ? COLLATE NOCASE AND password_hash = ?';
        params.push(expected.username, expected.passwordHash);
    }
    const row = db.prepare(`UPDATE users SET ${sets}password_changed_at = ${NEXT_SESSION_VERSION} WHERE ${where} RETURNING password_changed_at`).get(...params);
    return row ? row.password_changed_at : null;
}

function endAllSessions() {
    db.prepare(`UPDATE users SET password_changed_at = ${NEXT_SESSION_VERSION}`).run(Date.now());
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(REVOKED_SESSIONS_KEY);
    // reloaded from whichever database is current, so a rolled-back restore gets its own list back
    revoked = null;
}

const TOKEN_LIFETIME = '7d';

/** `user` needs id, username, role and password_changed_at as read together with the password hash. */
function signSessionToken(user) {
    // jwtid: two logins in the same second must not produce the same token (a logout would end both)
    return jwt.sign({ id: user.id, username: user.username, role: user.role, pv: sessionVersion(user) }, JWT_SECRET, { expiresIn: TOKEN_LIFETIME, jwtid: crypto.randomUUID() });
}

// Tokens ended by a logout, until they expire (sha256 of the token -> exp). Kept in app_settings so a restart does not
// bring them back; a restore ends all sessions anyway and clears the list.
const MAX_REVOKED_SESSIONS = 5000;
let revoked = null;
const tokenDigest = (token) => crypto.createHash('sha256').update(token).digest('base64url');

function revokedSessions() {
    if (!revoked) {
        revoked = new Map();
        try {
            const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(REVOKED_SESSIONS_KEY);
            for (const [digest, exp] of Object.entries(JSON.parse(row?.value || '{}'))) revoked.set(digest, exp);
        } catch (e) {
            log.warn('[Auth] Liste abgemeldeter Sitzungen nicht lesbar, sie wird neu angelegt:', e);
        }
    }
    return revoked;
}

/** The session token and where it came from: the cookie wins over an `Authorization: Bearer` header (app clients). */
function sessionFromRequest(req) {
    if (req.cookies?.token) return { token: req.cookies.token, scheme: 'cookie' };
    const token = bearerToken(req);
    return token ? { token, scheme: 'bearer' } : { token: null, scheme: null };
}

const tokenFromRequest = (req) => sessionFromRequest(req).token;

const sameUsername = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

const MAX_CLOCK_SKEW_SECONDS = 60;

function sessionStillValid(decoded, user) {
    if (typeof decoded.pv !== 'number' || decoded.pv !== sessionVersion(user)) return false;
    if (typeof decoded.iat !== 'number' || decoded.iat > Math.floor(Date.now() / 1000) + MAX_CLOCK_SKEW_SECONDS) return false;
    return typeof decoded.exp === 'number';
}

const userForToken = (decoded) => db.prepare('SELECT id, username, role, password_changed_at FROM users WHERE id = ?').get(decoded.id);
const tokenMatchesUser = (decoded, user) => !!user && sameUsername(decoded.username, user.username) && sessionStillValid(decoded, user);

/** Logout: the presented token stops working even if a copy of it exists. Invalid, stale or missing tokens are ignored. */
function endSession(token) {
    if (!token) return;
    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return;
    }
    const list = revokedSessions();
    const digest = tokenDigest(token);
    if (list.has(digest)) return;
    const user = userForToken(decoded);
    if (!tokenMatchesUser(decoded, user)) return;
    const now = Math.floor(Date.now() / 1000);
    for (const [key, exp] of list) {
        if (exp <= now) list.delete(key);
    }
    if (list.size >= MAX_REVOKED_SESSIONS) {
        // List full: end all sessions of this user instead of growing it further
        bumpSessionVersion(user.id);
        return;
    }
    list.set(digest, decoded.exp);
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(REVOKED_SESSIONS_KEY, JSON.stringify(Object.fromEntries(list)));
}

// Helper for cookie options (supports direct HTTPS & reverse proxy / Cloudflare / Nginx)
const setAuthCookie = (req, res, token) => {
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https' || config.cookieSecure;
    res.cookie('token', token, {
        httpOnly: true,
        secure: isHttps,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
};

const clearAuthCookie = (res) => {
    res.clearCookie('token', {
        httpOnly: true,
        sameSite: 'lax'
    });
};

const AUTH_ERRORS = {
    ...AUTH_TEXTS,
    SESSION_INVALID: 'Sitzung abgelaufen oder ungültig – bitte neu anmelden',
    ADMIN_EXISTS: 'Es gibt bereits einen Administrator – bitte anmelden'
};
const authError = (res, status, code) => res.status(status).json({ error: AUTH_ERRORS[code], code });

const CURRENT_PASSWORD_MISSING = 'Bitte das aktuelle Passwort eingeben';
const WRONG_PASSWORD = 'Das aktuelle Passwort stimmt nicht';
const PASSWORD_LOCK_TEXTS = {
    signIn: 'Zu viele fehlgeschlagene Anmeldeversuche für diesen Benutzer. Bitte in einigen Minuten erneut versuchen.',
    passwordChange: 'Zu viele Versuche, das Passwort zu ändern. Bitte in einigen Minuten erneut versuchen.'
};

/** Checks the caller's current password under the sign-in lock; throws 400, 403 or 429 (Retry-After), returns the user row. */
async function confirmCurrentPassword(req, res, password, { lock = 'signIn' } = {}) {
    if (typeof password !== 'string' || !password) throw badRequest(CURRENT_PASSWORD_MISSING);
    const user = db.prepare('SELECT id, username, role, password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!user) throw new HttpError(403, WRONG_PASSWORD, 'WRONG_PASSWORD');
    const account = accountKey(user.username);
    const ip = clientIp(req);
    const state = loginGuard.check(account, ip);
    if (state.locked) {
        res.setHeader('Retry-After', state.retryAfter);
        throw new HttpError(429, PASSWORD_LOCK_TEXTS[lock], 'TOO_MANY_ATTEMPTS');
    }
    loginGuard.attempt(account, ip);
    if (!(await bcrypt.compare(password, user.password_hash))) throw new HttpError(403, WRONG_PASSWORD, 'WRONG_PASSWORD');
    loginGuard.succeeded(account, ip);
    return user;
}

const requireAuth = (req, res, next) => {
    const { token, scheme } = sessionFromRequest(req);
    if (!token) return authError(res, 401, 'AUTH_REQUIRED');
    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return authError(res, 401, 'SESSION_INVALID');
    }
    // Role and existence are always taken from the DB so deleted or demoted users lose access immediately.
    let user;
    try {
        user = userForToken(decoded);
        if (user && revokedSessions().has(tokenDigest(token))) user = null;
    } catch (e) {
        log.error('[Auth] User lookup failed:', e);
        return res.status(500).json({ error: 'Authentifizierung fehlgeschlagen' });
    }
    // The username check catches a token whose id now belongs to someone else (restored or recreated user)
    if (!tokenMatchesUser(decoded, user)) return authError(res, 401, 'SESSION_INVALID');
    req.user = { id: user.id, username: user.username, role: user.role };
    req.authScheme = scheme;
    next();
};

const requireAdmin = (req, res, next) => {
    requireAuth(req, res, () => {
        if (req.user?.role !== 'admin') return authError(res, 403, 'FORBIDDEN');
        next();
    });
};

const requireEditor = (req, res, next) => {
    requireAuth(req, res, () => {
        const role = req.user?.role;
        if (role === 'visitor' || role === 'guest') return authError(res, 403, 'READ_ONLY');
        next();
    });
};

module.exports = {
    JWT_SECRET,
    SECRET_FILE,
    AUTH_ERRORS,
    persistJwtSecret,
    signSessionToken,
    bumpSessionVersion,
    endSession,
    tokenFromRequest,
    sameUsername,
    confirmCurrentPassword,
    setAuthCookie,
    clearAuthCookie,
    requireAuth,
    requireAdmin,
    requireEditor
};
