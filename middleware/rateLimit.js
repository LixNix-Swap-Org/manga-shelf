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

module.exports = { createRateLimiter, loginLimiter, setupLimiter };
