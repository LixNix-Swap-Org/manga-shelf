/**
 * Minimal in-memory rate limiter (fixed window, per client IP).
 * Sufficient for a single-process self-hosted deployment; no extra dependency required.
 */
function createRateLimiter({ windowMs, max, message }) {
    const hits = new Map();

    const timer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of hits) {
            if (entry.resetAt <= now) hits.delete(key);
        }
    }, windowMs);
    timer.unref();

    return (req, res, next) => {
        const now = Date.now();
        const key = req.ip || req.socket?.remoteAddress || 'unknown';
        let entry = hits.get(key);
        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(key, entry);
        }
        entry.count++;
        if (entry.count > max) {
            res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
            return res.status(429).json({ error: message || 'Zu viele Anfragen. Bitte später erneut versuchen.' });
        }
        next();
    };
}

const loginLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Zu viele Anmeldeversuche. Bitte in einigen Minuten erneut versuchen.'
});

const setupLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Zu viele Anfragen. Bitte in einigen Minuten erneut versuchen.'
});

/**
 * Failed attempts per key (e.g. username), independent of the client IP, so rotating X-Forwarded-For does not help
 * against password guessing on one account. A successful login clears the counter.
 */
function createFailureTracker({ windowMs, max }) {
    const entries = new Map();
    const timer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of entries) {
            if (entry.resetAt <= now) entries.delete(key);
        }
    }, windowMs);
    timer.unref();

    const live = (key) => {
        const entry = entries.get(key);
        return entry && entry.resetAt > Date.now() ? entry : null;
    };
    return {
        isLocked: (key) => (live(key)?.count || 0) >= max,
        retryAfterSeconds: (key) => Math.max(1, Math.ceil(((live(key)?.resetAt || 0) - Date.now()) / 1000)),
        fail(key) {
            const entry = live(key) || { count: 0, resetAt: Date.now() + windowMs };
            entry.count++;
            entries.set(key, entry);
        },
        reset: (key) => { entries.delete(key); }
    };
}

const loginFailures = createFailureTracker({ windowMs: 15 * 60 * 1000, max: 10 });

module.exports = { createRateLimiter, createFailureTracker, loginLimiter, setupLimiter, loginFailures };
