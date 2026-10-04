/**
 * Refuses browser-sent state-changing requests from another origin (SameSite=Lax allows sibling subdomains). Safe
 * methods, CORS_ORIGIN and bearer requests pass; else Sec-Fetch-Site or Origin must match. Proxy: keep Host unchanged.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MESSAGE = 'Anfrage von einer fremden Seite abgelehnt. Bitte Manga Shelf direkt über seine eigene Adresse öffnen.';

const normalizeOrigin = (origin) => String(origin).trim().replace(/\/+$/, '').toLowerCase();

/** CORS_ORIGIN value (comma separated) as a list of normalised origins. */
const parseOrigins = (value) => String(value || '').split(',').map(normalizeOrigin).filter(Boolean);

const BEARER = /^Bearer[ \t]+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)[ \t]*$/i;

/** The JWT of an `Authorization: Bearer <jwt>` header if it is well-formed (not verified), else null. */
function bearerToken(req) {
    const header = req.headers?.authorization;
    if (typeof header !== 'string') return null;
    const match = BEARER.exec(header);
    return match ? match[1] : null;
}

/** Whether the Cookie header names `token` the way cookie-parser reads it (names trimmed); value-less pairs do not count. */
function hasSessionCookie(req) {
    const header = req.headers.cookie;
    if (typeof header !== 'string') return false;
    return header.split(';').some(pair => {
        const eq = pair.indexOf('=');
        return eq !== -1 && pair.slice(0, eq).trim() === 'token';
    });
}

function originHost(origin) {
    try {
        return new URL(origin).host.toLowerCase();
    } catch {
        return null;
    }
}

function createOriginCheck({ allowedOrigins = [], appOrigins = [] } = {}) {
    const allowed = new Set(allowedOrigins.map(normalizeOrigin));
    const apps = new Set(appOrigins.map(normalizeOrigin));
    return function originCheck(req, res, next) {
        if (SAFE_METHODS.has(req.method)) return next();
        const origin = req.headers.origin;
        if (origin && allowed.has(normalizeOrigin(origin))) return next();
        if (!hasSessionCookie(req) && (bearerToken(req) || (origin && apps.has(normalizeOrigin(origin))))) return next();
        const site = req.headers['sec-fetch-site'];
        if (site) {
            if (site === 'same-origin' || site === 'none') return next();
        } else if (!origin || originHost(origin) === String(req.headers.host || '').toLowerCase()) {
            return next();
        }
        res.status(403).json({ error: MESSAGE, code: 'CROSS_ORIGIN' });
    };
}

module.exports = { createOriginCheck, parseOrigins, normalizeOrigin, bearerToken };
