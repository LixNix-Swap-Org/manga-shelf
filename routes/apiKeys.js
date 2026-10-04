// Personal and instance API keys: stored encrypted in user_api_credentials, checked
// live before saving, never returned. Also the server's credential provider for the core gateway.
const express = require('express');
const { db, runTransaction, createCtx } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { createRateLimiter, clientIp } = require('../middleware/rateLimit');
const { HttpError, badRequest, notFound } = require('../utils/httpError');
const { sealForServer, openForServer, UNREADABLE } = require('../utils/secretBox');
const log = require('../utils/logger').child('api-keys');
const { config } = require('../utils/config');
const { setCredentialProvider } = require('../core/sources/credentials');
const { guideFor, formatError, userProviders, instanceProviders } = require('../core/sources/guides');
const animeSettings = require('../core/anime/settings');
const gateway = require('../core/anime/gateway');
const { SourceError } = require('../core/anime/request');

const MIN_SECRET = 10;
const MAX_SECRET = 4096;
const USED_WRITE_GAP_MS = 60 * 1000;
// MAL_CLIENT_ID and GOOGLE_BOOKS_KEY (utils/config.js)
const ENV_KEYS = { mal: 'malClientId', google_books: 'googleBooksKey' };

const envSecret = (provider) => {
    const key = ENV_KEYS[provider];
    return (key && config[key]) || null;
};

// an environment key the provider refused: { secret, message } by provider, until the variable changes
const envFailures = new Map();
const envFailure = (provider) => {
    const failure = envFailures.get(provider);
    return failure && failure.secret === envSecret(provider) ? failure.message : null;
};

const rowFor = (userId, provider) => (userId === null
    ? db.prepare('SELECT * FROM user_api_credentials WHERE user_id IS NULL AND provider = ?').get(provider)
    : db.prepare('SELECT * FROM user_api_credentials WHERE user_id = ? AND provider = ?').get(userId, provider));

/** Masked view of a stored key: never the secret. */
function masked(provider, row, { instance = false } = {}) {
    const fromEnv = instance && Boolean(envSecret(provider));
    return {
        provider,
        name: guideFor(provider)?.name || provider,
        configured: Boolean(row) || fromEnv,
        from_env: fromEnv,
        label: fromEnv && !row ? 'aus der Umgebung gesetzt' : row?.label || null,
        last4: row?.last4 || null,
        allow_background: Boolean(row?.allow_background),
        last_ok_at: row?.last_ok_at || null,
        last_error: (fromEnv && envFailure(provider)) || row?.last_error || null
    };
}

// decrypted secrets by row id and ciphertext; cleared on every change
const plainCache = new Map();
const lastUsedWrite = new Map();

function decrypt(row) {
    const key = `${row.id}:${row.secret_enc}`;
    if (plainCache.has(key)) return plainCache.get(key);
    try {
        const plain = openForServer(row.secret_enc);
        plainCache.set(key, plain);
        return plain;
    } catch (err) {
        db.prepare('UPDATE user_api_credentials SET last_error = ? WHERE id = ?').run(UNREADABLE, row.id);
        log.warn(`Gespeicherter ${guideFor(row.provider)?.name || row.provider}-Schlüssel ${row.user_id === null ? 'der Instanz' : `von Benutzer ${row.user_id}`} ist nicht mehr lesbar (anderes JWT-Secret?)`);
        return null;
    }
}

/** core/sources/credentials.js provider on top of the table (and MAL_CLIENT_ID / GOOGLE_BOOKS_KEY). */
const serverProvider = {
    get(userId, provider) {
        const row = rowFor(userId, provider);
        if (!row || row.last_error) return null;
        const secret = decrypt(row);
        return secret ? { secret, allowBackground: Boolean(row.allow_background) } : null;
    },
    instance(provider) {
        const env = envSecret(provider);
        if (env && !envFailure(provider)) return { secret: env, fromEnv: true };
        const row = rowFor(null, provider);
        if (!row || row.last_error) return null;
        const secret = decrypt(row);
        return secret ? { secret, fromEnv: false } : null;
    },
    background(provider) {
        const rows = db.prepare('SELECT * FROM user_api_credentials WHERE provider = ? AND user_id IS NOT NULL AND allow_background = 1 AND last_error IS NULL ORDER BY user_id').all(provider);
        return rows.map((row) => ({ userId: row.user_id, secret: decrypt(row) })).filter((r) => r.secret);
    },
    // userId null = the instance key (`user_id IS NULL`); an environment key has no row and is remembered in memory
    failed(userId, provider, message) {
        if (userId === null && envSecret(provider) && !envFailure(provider)) {
            envFailures.set(provider, { secret: envSecret(provider), message });
            return;
        }
        db.prepare('UPDATE user_api_credentials SET last_error = ? WHERE user_id IS ? AND provider = ?').run(message, userId, provider);
    },
    used(userId, provider, ok) {
        if (userId === null && envSecret(provider) && !envFailure(provider)) return;
        const key = `${userId}:${provider}`;
        const now = Date.now();
        if (now - (lastUsedWrite.get(key) || 0) < USED_WRITE_GAP_MS) return;
        lastUsedWrite.set(key, now);
        db.prepare(`UPDATE user_api_credentials SET last_used_at = ?${ok ? ', last_ok_at = ?' : ''} WHERE user_id IS ? AND provider = ?`)
            .run(...(ok ? [now, now] : [now]), userId, provider);
    },
    status(userId, provider) {
        const row = rowFor(userId, provider);
        return row ? { configured: true, last_error: row.last_error } : { configured: false, last_error: null };
    }
};

/** Plugs the provider and the ANIME_* settings into the core (index.js and the console; idempotent). */
function registerServerSources() {
    setCredentialProvider(serverProvider);
    animeSettings.configure({
        anilistRpm: config.animeAnilistRpm,
        jikanRpm: config.animeJikanRpm,
        sources: config.animeSources
    });
}

function cleanSecret(provider, raw) {
    if (typeof raw !== 'string') throw badRequest('Bitte den Schlüssel eingeben');
    const secret = raw.trim();
    if (secret.length < MIN_SECRET || secret.length > MAX_SECRET) throw badRequest(`Der Schlüssel muss ${MIN_SECRET} bis ${MAX_SECRET} Zeichen lang sein`);
    const wrong = formatError(provider, secret);
    if (wrong) throw badRequest(wrong, 'KEY_FORMAT');
    return secret;
}

/** Live check at the provider: { label } or an HttpError 400 (refused) / 502 (not reachable). */
async function checkLive(provider, secret) {
    const name = guideFor(provider)?.name || provider;
    try {
        return await gateway.validateCredential(createCtx(), provider, secret);
    } catch (err) {
        if (err instanceof SourceError) {
            if (err.kind === 'auth' || err.kind === 'bad' || err.kind === 'notfound') {
                const what = provider === 'anilist' ? 'den Token' : provider === 'mal' ? 'die Client-ID' : 'den Schlüssel';
                throw new HttpError(400, `${name} lehnt ${what} ab (${err.status || 401})`, 'KEY_REJECTED');
            }
            throw new HttpError(502, `${name} ist gerade nicht erreichbar, der Schlüssel wurde nicht gespeichert. Bitte später erneut versuchen.`, 'PROVIDER_UNREACHABLE');
        }
        throw err;
    }
}

/**
 * Checks and stores a key (userId null = instance). Resolves with the masked view. Used by the routes below and by
 * the console command "quellen setzen".
 */
async function saveCredential(userId, provider, rawSecret, { allowBackground = false } = {}) {
    const secret = cleanSecret(provider, rawSecret);
    const { label } = await checkLive(provider, secret);
    const enc = sealForServer(secret);
    runTransaction(() => {
        if (userId === null) db.prepare('DELETE FROM user_api_credentials WHERE user_id IS NULL AND provider = ?').run(provider);
        else db.prepare('DELETE FROM user_api_credentials WHERE user_id = ? AND provider = ?').run(userId, provider);
        db.prepare(`
            INSERT INTO user_api_credentials (user_id, provider, secret_enc, label, last4, allow_background, last_ok_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(userId, provider, enc, label || null, secret.slice(-4), userId === null ? 0 : (allowBackground ? 1 : 0), Date.now());
    });
    plainCache.clear();
    if (userId !== null) gateway.forgetAccess(userId, provider);
    log.info(`${guideFor(provider)?.name || provider}-Schlüssel ${userId === null ? 'der Instanz' : `von Benutzer ${userId}`} gespeichert`);
    return masked(provider, rowFor(userId, provider), { instance: userId === null });
}

function removeCredential(userId, provider) {
    const removed = (userId === null
        ? db.prepare('DELETE FROM user_api_credentials WHERE user_id IS NULL AND provider = ?').run(provider)
        : db.prepare('DELETE FROM user_api_credentials WHERE user_id = ? AND provider = ?').run(userId, provider)).changes > 0;
    plainCache.clear();
    if (userId !== null) gateway.forgetAccess(userId, provider);
    if (removed) log.info(`${guideFor(provider)?.name || provider}-Schlüssel ${userId === null ? 'der Instanz' : `von Benutzer ${userId}`} entfernt`);
    return removed;
}

const listUser = (userId) => userProviders().map((p) => masked(p, rowFor(userId, p)));
const listInstance = () => instanceProviders().map((p) => masked(p, rowFor(null, p), { instance: true }));

function providerParam(req, allowed) {
    const provider = String(req.params.provider || '').toLowerCase();
    if (!allowed.includes(provider)) throw badRequest(`Unbekannter Anbieter (erlaubt: ${allowed.join(', ')})`, 'UNKNOWN_PROVIDER');
    return provider;
}

const noStore = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
};

const keyLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 5,
    keyFn: (req) => 'user:' + (req.user?.id ?? clientIp(req)),
    message: 'Zu viele Schlüssel-Prüfungen. Bitte eine Minute warten.'
});

const allowBackgroundOf = (body) => body?.allow_background === true || body?.allow_background === 1 || body?.allow_background === '1';

const router = express.Router();
router.use(['/auth/api-keys', '/admin/api-keys', '/users/:id/api-keys'], noStore);

router.get('/auth/api-keys', requireAuth, (req, res) => {
    res.json(listUser(req.user.id));
});

router.put('/auth/api-keys/:provider', requireAuth, keyLimiter, async (req, res) => {
    const provider = providerParam(req, userProviders());
    const body = req.body || {};
    if (body.secret === undefined && body.allow_background !== undefined) {
        const changed = db.prepare('UPDATE user_api_credentials SET allow_background = ? WHERE user_id = ? AND provider = ?')
            .run(allowBackgroundOf(body) ? 1 : 0, req.user.id, provider).changes;
        if (!changed) throw notFound('Schlüssel');
        return res.json(masked(provider, rowFor(req.user.id, provider)));
    }
    res.json(await saveCredential(req.user.id, provider, body.secret, { allowBackground: allowBackgroundOf(body) }));
});

router.delete('/auth/api-keys/:provider', requireAuth, (req, res) => {
    const provider = providerParam(req, userProviders());
    res.json({ success: true, removed: removeCredential(req.user.id, provider) });
});

// admins may remove another user's key, never read it (there is no read route for other users)
router.delete('/users/:id/api-keys/:provider', requireAdmin, (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(userId) || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) throw notFound('Benutzer');
    const provider = providerParam(req, userProviders());
    res.json({ success: true, removed: removeCredential(userId, provider) });
});

router.get('/admin/api-keys', requireAdmin, (req, res) => {
    const usersWithKeys = db.prepare('SELECT count(DISTINCT user_id) AS n FROM user_api_credentials WHERE user_id IS NOT NULL').get().n;
    res.json({ keys: listInstance(), users_with_keys: usersWithKeys });
});

router.get('/admin/api-keys/:provider', requireAdmin, (req, res) => {
    const provider = providerParam(req, instanceProviders());
    res.json(masked(provider, rowFor(null, provider), { instance: true }));
});

router.put('/admin/api-keys/:provider', requireAdmin, keyLimiter, async (req, res) => {
    const provider = providerParam(req, instanceProviders());
    res.json(await saveCredential(null, provider, (req.body || {}).secret));
});

router.delete('/admin/api-keys/:provider', requireAdmin, (req, res) => {
    const provider = providerParam(req, instanceProviders());
    res.json({ success: true, removed: removeCredential(null, provider) });
});

module.exports = router;
module.exports.registerServerSources = registerServerSources;
module.exports.serverProvider = serverProvider;
module.exports.saveCredential = saveCredential;
module.exports.removeCredential = removeCredential;
module.exports.listUser = listUser;
module.exports.listInstance = listInstance;
module.exports.envSecret = envSecret;
module.exports.keyLimiter = keyLimiter;
