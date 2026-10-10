/**
 * Minimal in-memory rate limiting (fixed window). Sufficient for a single-process self-hosted deployment; no extra
 * dependency required. Keys are bounded in length and every store has an entry cap, so hostile input cannot grow memory.
 */
const crypto = require('crypto');
const net = require('net');
const log = require('../utils/logger').child('rate-limit');

const MAX_KEY_LENGTH = 256;
const DEFAULT_MAX_ENTRIES = 50000;
const DEFAULT_MAX_PER_PREFIX = 256;
const SWEEP_INTERVAL_MS = 60 * 1000;
const FULL_SWEEP_MIN_GAP_MS = 1000;

const boundedKey = (key, maxLength = MAX_KEY_LENGTH) => {
    const s = String(key);
    return s.length <= maxLength ? s : 'sha256:' + crypto.createHash('sha256').update(s).digest('base64');
};

// "<account>\n2001:db8:1:2::/64" and "2001:db8:1:2::/64" belong to "<account>\n2001:db8:1::/48" and "2001:db8:1::/48"
const IPV6_64_KEY = /^([\s\S]*\n)?([0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}):[0-9a-f]{1,4}::\/64$/;
const prefixOf = (key) => {
    const m = IPV6_64_KEY.exec(key);
    return m ? `${m[1] || ''}${m[2]}::/48` : null;
};

/**
 * Fixed-window counters; an entry that reached `lockAt` is locked. At the cap the oldest unlocked entry goes (never
 * a live lock); an IPv6 /48 holds at most `maxPerPrefix` keys. All locked: unknown keys count as locked unless `failOpen`.
 */
function createWindowStore({ windowMs, lockAt, maxEntries = DEFAULT_MAX_ENTRIES, maxPerPrefix = DEFAULT_MAX_PER_PREFIX, failOpen = false, name }) {
    const entries = new Map();
    const unlocked = new Set();
    const perPrefix = new Map();
    let lastFullSweep = 0;
    let warnedFull = false;

    const remove = (key) => {
        if (!entries.delete(key)) return;
        unlocked.delete(key);
        const prefix = prefixOf(key);
        if (!prefix) return;
        const left = perPrefix.get(prefix) - 1;
        if (left > 0) perPrefix.set(prefix, left);
        else perPrefix.delete(prefix);
    };
    const sweep = () => {
        const now = Date.now();
        for (const [key, entry] of entries) {
            if (entry.resetAt <= now) remove(key);
        }
    };
    // A full store sweeps at most once per second, so a flood of new keys cannot make every request scan it
    const sweepWhenFull = () => {
        if (entries.size < maxEntries || Date.now() - lastFullSweep < FULL_SWEEP_MIN_GAP_MS) return;
        lastFullSweep = Date.now();
        sweep();
    };
    const resolve = (key) => {
        if (entries.has(key)) return key;
        const prefix = prefixOf(key);
        return prefix && (perPrefix.get(prefix) || 0) >= maxPerPrefix ? prefix : key;
    };
    const live = (key) => {
        const entry = entries.get(resolve(key));
        return entry && entry.resetAt > Date.now() ? entry : null;
    };
    const timer = setInterval(sweep, Math.min(windowMs, SWEEP_INTERVAL_MS));
    timer.unref();

    return {
        live,
        /** True while the store is full of live locks, so a key it does not know could not be counted. */
        saturated() {
            if (entries.size < maxEntries || unlocked.size > 0) return false;
            sweepWhenFull();
            return entries.size >= maxEntries && unlocked.size === 0;
        },
        increment(key) {
            const k = resolve(key);
            let entry = live(k);
            if (!entry) {
                remove(k);
                sweepWhenFull();
                if (entries.size >= maxEntries) {
                    const oldest = unlocked.values().next();
                    if (oldest.done) {
                        if (!warnedFull) {
                            warnedFull = true;
                            log.warn(`[RateLimit] ${name || 'Zähler'}: ${maxEntries} gesperrte Einträge erreicht, neue Schlüssel ${failOpen ? 'werden bis zum Ablauf nicht gezählt' : 'gelten bis zum Ablauf als gesperrt'}`);
                        }
                        return { count: failOpen ? 1 : Infinity, resetAt: Date.now() + windowMs, untracked: true };
                    }
                    remove(oldest.value);
                }
                warnedFull = false;
                entry = { count: 0, resetAt: Date.now() + windowMs };
                entries.set(k, entry);
                unlocked.add(k);
                const prefix = prefixOf(k);
                if (prefix) perPrefix.set(prefix, (perPrefix.get(prefix) || 0) + 1);
            }
            entry.count++;
            if (entry.count >= lockAt) unlocked.delete(k);
            return entry;
        },
        decrement(key) {
            const k = resolve(key);
            const entry = live(k);
            if (!entry || entry.count <= 0) return;
            entry.count--;
            if (entry.count < lockAt) unlocked.add(k);
        },
        delete: remove,
        deleteWithPrefix(prefix) {
            for (const key of [...entries.keys()]) {
                if (key.startsWith(prefix)) remove(key);
            }
        },
        clear: () => {
            entries.clear();
            unlocked.clear();
            perPrefix.clear();
        },
        size: () => entries.size,
        keys: () => [...entries.keys()]
    };
}

function ipv6Groups(address) {
    let addr = address.split('%')[0].toLowerCase();
    const v4 = addr.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
    if (v4) {
        const [a, b, c, d] = v4[2].split('.').map(Number);
        addr = v4[1] + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
    }
    const [head, tail] = addr.split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const fill = addr.includes('::') ? 8 - left.length - right.length : 0;
    return [...left, ...Array(Math.max(0, fill)).fill('0'), ...right].map(g => parseInt(g, 16) || 0);
}

/**
 * Rate-limit key of an address. An IPv6 client usually owns a whole /64, so per-address keys would hand it 2^64
 * budgets; IPv4-mapped addresses count as the IPv4 address.
 */
function clientKey(address) {
    if (typeof address !== 'string' || !net.isIPv6(address.split('%')[0])) return address;
    const g = ipv6Groups(address);
    if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {
        return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.');
    }
    return g.slice(0, 4).map(x => x.toString(16)).join(':') + '::/64';
}

const clientIp = (req) => clientKey(req.ip || req.socket?.remoteAddress) || 'unknown';

let warnedIgnoredForwardedFor = false;
// An X-Forwarded-For that Express did not use means either a spoofing client or a proxy that TRUST_PROXY does not
// cover; in the second case every client shares the proxy's rate-limit bucket.
function noteIgnoredForwardedFor(req) {
    if (warnedIgnoredForwardedFor || !req.headers?.['x-forwarded-for']) return;
    const remote = req.socket?.remoteAddress;
    if (!remote || req.ip !== remote) return;
    warnedIgnoredForwardedFor = true;
    log.warn(`[RateLimit] X-Forwarded-For von ${remote} wird ignoriert. Läuft ein Reverse-Proxy davor, TRUST_PROXY setzen (z. B. 1), sonst teilen sich alle Clients dessen Rate-Limit.`);
}

const allLimiters = new Set();

/**
 * Per-client request limiter (by address unless `keyFn`). Middleware, or in a handler `consume(req, res)` (true when
 * it answered 429; `{ exempt: true }` counts without refusing), `tryConsume(req)` (counts, never answers: true while
 * within the limit) and `refund(req)`. A saturated store fails open.
 */
function createRateLimiter({ windowMs, max, message, keyFn, maxEntries, maxPerPrefix }) {
    const store = createWindowStore({ windowMs, lockAt: max + 1, maxEntries, maxPerPrefix, failOpen: true, name: 'Rate-Limit' });
    const keyOf = (req) => boundedKey(keyFn ? keyFn(req) : clientIp(req));

    const consume = (req, res, { exempt = false } = {}) => {
        noteIgnoredForwardedFor(req);
        const entry = store.increment(keyOf(req));
        if (entry.count <= max || exempt) return false;
        res.setHeader('Retry-After', Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000)));
        res.status(429).json({ error: message || 'Zu viele Anfragen. Bitte später erneut versuchen.' });
        return true;
    };
    const middleware = (req, res, next) => {
        if (!consume(req, res)) next();
    };
    middleware.consume = consume;
    middleware.tryConsume = (req) => store.increment(keyOf(req)).count <= max;
    middleware.refund = (req) => store.decrement(keyOf(req));
    middleware.reset = () => store.clear();
    middleware.size = () => store.size();
    allLimiters.add(middleware);
    return middleware;
}

/**
 * Store for express-rate-limit with the same key length, entry and IPv6 /48 caps.
 */
function createLimiterStore({ windowMs, maxEntries, maxPerPrefix, name }) {
    const store = createWindowStore({ windowMs, lockAt: Infinity, maxEntries, maxPerPrefix, failOpen: true, name });
    const info = (entry) => ({ totalHits: entry.count, resetTime: new Date(entry.resetAt) });
    const limiterStore = {
        localKeys: true,
        get: (key) => {
            const entry = store.live(boundedKey(key));
            return entry ? info(entry) : undefined;
        },
        increment: (key) => info(store.increment(boundedKey(key))),
        decrement: (key) => store.decrement(boundedKey(key)),
        resetKey: (key) => store.delete(boundedKey(key)),
        resetAll: () => store.clear(),
        reset: () => store.clear(),
        size: () => store.size(),
        keys: () => store.keys()
    };
    allLimiters.add(limiterStore);
    return limiterStore;
}

/** Counts failures per key; `isLocked` once `max` failures fall into the window. */
function createFailureTracker({ windowMs, max, maxEntries, name }) {
    const store = createWindowStore({ windowMs, lockAt: max, maxEntries, name: name || 'Fehlversuche' });
    const isLocked = (key) => {
        const entry = store.live(boundedKey(key));
        return entry ? entry.count >= max : store.saturated();
    };
    return {
        isLocked,
        retryAfterSeconds: (key) => Math.max(1, Math.ceil(((store.live(boundedKey(key))?.resetAt || Date.now() + windowMs) - Date.now()) / 1000)),
        /** Returns the failure count after this one. */
        fail: (key) => store.increment(boundedKey(key)).count,
        reset: (key) => store.delete(boundedKey(key)),
        resetWithPrefix: (prefix) => store.deleteWithPrefix(prefix),
        clear: () => store.clear(),
        size: () => store.size(),
        keys: () => store.keys()
    };
}

/** Lockout key of an account; must match for login, password change and admin reset. */
const accountKey = (username) => boundedKey(String(username).trim().toLowerCase(), 128);

/**
 * Guards password checks: a lock per account + IP after `maxPerClient` failures, one per account after
 * `maxPerAccount` (not for IPs that logged in before). Attempts are reserved before the async bcrypt check.
 */
function createLoginGuard({ windowMs, maxPerClient, maxPerAccount, knownClientsPerAccount = 10 }) {
    const perClient = createFailureTracker({ windowMs, max: maxPerClient, name: 'Fehlversuche je Client' });
    const perAccount = createFailureTracker({ windowMs, max: maxPerAccount, name: 'Fehlversuche je Konto' });
    const knownClients = new Map();
    const pairKey = (account, ip) => `${account}\n${ip}`;
    const label = (account) => (account.length > 64 ? account.slice(0, 64) + '…' : account);

    return {
        /** True when this address logged in to the account before (and the guard still remembers it). */
        knows: (account, ip) => Boolean(knownClients.get(account)?.has(ip)),
        check(account, ip) {
            const pair = pairKey(account, ip);
            if (perClient.isLocked(pair)) return { locked: true, retryAfter: perClient.retryAfterSeconds(pair) };
            if (perAccount.isLocked(account) && !knownClients.get(account)?.has(ip)) {
                return { locked: true, retryAfter: perAccount.retryAfterSeconds(account) };
            }
            return { locked: false, retryAfter: 0 };
        },
        attempt(account, ip) {
            if (perClient.fail(pairKey(account, ip)) === maxPerClient) {
                log.warn(`[Auth] Anmeldung für "${label(account)}" von ${ip} nach ${maxPerClient} Fehlversuchen vorübergehend gesperrt`);
            }
            if (perAccount.fail(account) === maxPerAccount) {
                log.warn(`[Auth] Konto "${label(account)}" nach ${maxPerAccount} Fehlversuchen von verschiedenen Adressen vorübergehend gesperrt (letzte: ${ip})`);
            }
        },
        succeeded(account, ip) {
            perClient.reset(pairKey(account, ip));
            perAccount.reset(account);
            const known = knownClients.get(account) || new Set();
            known.delete(ip);
            known.add(ip);
            while (known.size > knownClientsPerAccount) known.delete(known.values().next().value);
            knownClients.set(account, known);
        },
        /** Lifts every lock of an account (admin reset of its password). */
        clear(account) {
            perAccount.reset(account);
            perClient.resetWithPrefix(pairKey(account, ''));
        },
        reset() {
            perClient.clear();
            perAccount.clear();
            knownClients.clear();
        },
        size: () => ({ perClient: perClient.size(), perAccount: perAccount.size() }),
        keys: () => [...perClient.keys(), ...perAccount.keys()]
    };
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;

// Used inside the login handler after the account guard passed: counts failed attempts (successful ones are refunded)
// and never refuses an address that logged in to that account before, so clients sharing one address (NAT, a proxy
// TRUST_PROXY does not cover) cannot lock each other out.
const loginLimiter = createRateLimiter({
    windowMs: FIFTEEN_MINUTES,
    max: 50,
    message: 'Zu viele Anmeldeversuche. Bitte in einigen Minuten erneut versuchen.'
});

const logoutLimiter = createRateLimiter({
    windowMs: FIFTEEN_MINUTES,
    max: 30,
    message: 'Zu viele Abmeldungen. Bitte in einigen Minuten erneut versuchen.'
});

const setupLimiter = createRateLimiter({
    windowMs: FIFTEEN_MINUTES,
    max: 10,
    message: 'Zu viele Anfragen. Bitte in einigen Minuten erneut versuchen.'
});

// Runs after requireAuth: keyed by the account, so NAT neighbours never share this budget.
const passwordChangeLimiter = createRateLimiter({
    windowMs: FIFTEEN_MINUTES,
    max: 10,
    keyFn: (req) => 'user:' + (req.user?.id ?? clientIp(req)),
    message: 'Zu viele Versuche, das Passwort zu ändern. Bitte in einigen Minuten erneut versuchen.'
});

const loginGuard = createLoginGuard({ windowMs: FIFTEEN_MINUTES, maxPerClient: 10, maxPerAccount: 50 });

/** Clears all in-memory limiter state, also of limiters created elsewhere (tests). */
function resetRateLimits() {
    for (const limiter of allLimiters) limiter.reset();
    loginGuard.reset();
}

module.exports = {
    boundedKey,
    createWindowStore,
    createRateLimiter,
    createLimiterStore,
    createFailureTracker,
    createLoginGuard,
    accountKey,
    clientIp,
    clientKey,
    loginLimiter,
    logoutLimiter,
    setupLimiter,
    passwordChangeLimiter,
    loginGuard,
    resetRateLimits
};
