const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { db } = require('../db');

// Secure, persistent JWT Secret (stored in app_settings if not provided via environment)
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    try {
        const row = db.prepare("SELECT value FROM app_settings WHERE key = 'jwt_secret'").get();
        if (row && row.value) {
            JWT_SECRET = row.value;
        } else {
            JWT_SECRET = crypto.randomBytes(48).toString('hex');
            db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('jwt_secret', ?)").run(JWT_SECRET);
        }
    } catch (e) {
        JWT_SECRET = 'manga-shelf-fallback-' + crypto.randomBytes(32).toString('hex');
    }
}

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
    const token = req.cookies?.token || req.headers?.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (e) {
        res.status(401).json({ error: 'Invalid token' });
    }
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
