const { createRateLimiter, clientIp } = require('./rateLimit');

const ONE_MINUTE = 60 * 1000;
const PER_MINUTE = 30;

// Mounted after requireAuth/requireEditor: one budget per account, so a shared guest login cannot get the server's
// address throttled by Manga Passion, AniList or the catalogues for everyone.
const userKey = (req) => 'user:' + (req.user?.id ?? clientIp(req));

/** Searches that ask external services (Manga Passion, AniList, DNB/K10plus/Google Books). */
const lookupLimiter = createRateLimiter({
    windowMs: ONE_MINUTE,
    max: PER_MINUTE,
    keyFn: userKey,
    message: 'Zu viele Suchanfragen in kurzer Zeit. Bitte eine Minute warten und erneut versuchen.'
});

/** Downloads of remote images (POST /api/upload-remote). */
const remoteImageLimiter = createRateLimiter({
    windowMs: ONE_MINUTE,
    max: PER_MINUTE,
    keyFn: userKey,
    message: 'Zu viele Bild-Downloads in kurzer Zeit. Bitte eine Minute warten und erneut versuchen.'
});

module.exports = { lookupLimiter, remoteImageLimiter, USER_LOOKUPS_PER_MINUTE: PER_MINUTE };
