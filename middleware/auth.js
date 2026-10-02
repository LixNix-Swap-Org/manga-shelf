const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { db } = require('../db');

// Secure, persistent JWT secret. An explicit JWT_SECRET is only accepted if it is long enough and not a
// well-known placeholder from the repo; otherwise a random secret is generated and stored in app_settings.
const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER_SECRET = /change[-_ ]?this|changeme|secret-key|your[-_ ]?secret|example/i;

function resolveJwtSecret() {
    const fromEnv = process.env.JWT_SECRET;
    if (fromEnv) {
        if (fromEnv.length >= MIN_SECRET_LENGTH && !PLACEHOLDER_SECRET.test(fromEnv)) {
            return fromEnv;
        }
        console.warn(`[Auth] JWT_SECRET ist zu kurz (< ${MIN_SECRET_LENGTH} Zeichen) oder ein Platzhalter und wird ignoriert. Es wird ein zufälliges Secret aus der Datenbank verwendet.`);
    }
    // No silent per-process fallback: if the DB is unusable the app must not start with a throwaway secret.
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'jwt_secret'").get();
    if (row && row.value) return row.value;
    const generated = crypto.randomBytes(48).toString('hex');
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('jwt_secret', ?)").run(generated);
    return generated;
}

const JWT_SECRET = resolveJwtSecret();

// Helper for cookie options (supports direct HTTPS & reverse proxy / Cloudflare / Nginx)
const setAuthCookie = (req, res, token) => {
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === 'true';
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

const requireAuth = (req, res, next) => {
    const bearer = req.headers?.authorization?.split(' ')[1];
    const token = req.cookies?.token || bearer;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
    // Role and existence are always taken from the DB so deleted or demoted users lose access immediately.
    let user;
    try {
        user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(decoded.id);
    } catch (e) {
        console.error('[Auth] User lookup failed:', e);
        return res.status(500).json({ error: 'Authentifizierung fehlgeschlagen' });
    }
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    req.user = { id: user.id, username: user.username, role: user.role };
    next();
};

const requireAdmin = (req, res, next) => {
    requireAuth(req, res, () => {
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
        next();
    });
};

const requireEditor = (req, res, next) => {
    requireAuth(req, res, () => {
        const role = req.user?.role;
        if (role === 'visitor' || role === 'guest') {
            return res.status(403).json({ error: 'Nur Lesezugriff für Besucher/Gäste gestattet' });
        }
        next();
    });
};

module.exports = {
    JWT_SECRET,
    setAuthCookie,
    clearAuthCookie,
    requireAuth,
    requireAdmin,
    requireEditor
};
