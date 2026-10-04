// The one thing core/ handlers and modules get from their host: no Node API, no Express, only this object.
//
// ctx = {
//   db:     prepare(sql) -> { get, all, run }, exec(sql), transaction(fn) (synchronous fn, commit or rollback),
//           generation() (changes when the database file was reopened, e.g. after a restore)
//   files:  uploads; names are plain file names, url(name) = '/uploads/<name>' is what the database stores.
//           write(name, bytes, { image }) (image: extension, the host strips metadata), stat(name) -> { size } | null,
//           touch(name), remove(name), list()
//   http:   fetch(url, init) for JSON APIs, fetchText(url, timeoutMs) for the catalogues,
//           fetchImage(url) -> { buffer, ext } (public hosts only, size cap, image check by magic bytes)
//   now():  current Date
//   log:    { debug, info, warn, error } plus child(name)
//   user:   { id, username, role } of the caller, null for background work
//   config: { appTimeZone, anime? } (config.anime { anilistRpm, jikanRpm, sources } overrides core/anime/settings.js)
//   credentials (optional): provider from core/sources/credentials.js (own API keys per user, instance keys)
//   signal: AbortSignal of the caller (client went away), optional
//   limit(name): per-account budget of external lookups; the host answers 429 itself and throws ANSWERED
//   randomId(): unique id for file names
//   yield():    lets other work run between blocks of a long build
// }

const ANSWERED = Symbol('core.answered');

const noop = () => {};
const silentLog = { debug: noop, info: noop, warn: noop, error: noop, child: () => silentLog };

function unavailable(part, name) {
    return () => {
        throw new Error(`ctx.${part}.${name} ist in dieser Umgebung nicht verfügbar`);
    };
}

const uploadUrl = (name) => `/uploads/${name}`;
const missingFiles = Object.fromEntries(['write', 'read', 'stat', 'touch', 'remove', 'list'].map(n => [n, unavailable('files', n)]));
const missingHttp = Object.fromEntries(['fetch', 'fetchText', 'fetchImage'].map(n => [n, unavailable('http', n)]));

function randomId() {
    const hex = [];
    for (let i = 0; i < 32; i++) hex.push(Math.floor(Math.random() * 16).toString(16));
    const s = hex.join('');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * Synchronous transaction on a connection with exec(): BEGIN IMMEDIATE, commit on success, rollback on error.
 * An async callback is refused: whatever it does after its first await would run outside the transaction.
 */
function transactionFor(conn, log = silentLog) {
    return (fn) => {
        conn.exec('BEGIN IMMEDIATE;');
        try {
            const result = fn(conn);
            if (result && typeof result.then === 'function') {
                result.then(null, noop);
                throw new Error('runTransaction: asynchrone Callbacks sind nicht erlaubt');
            }
            conn.exec('COMMIT;');
            return result;
        } catch (err) {
            try { conn.exec('ROLLBACK;'); } catch (rbErr) { log.warn('ROLLBACK failed:', rbErr.message); }
            throw err;
        }
    };
}

/** ctx.db over a raw connection (prepare/exec), e.g. node:sqlite's DatabaseSync. */
function dbFromConnection(conn, { log, generation = () => 1 } = {}) {
    return {
        prepare: (sql) => conn.prepare(sql),
        exec: (sql) => conn.exec(sql),
        transaction: transactionFor(conn, log),
        generation
    };
}

/** Fills the optional parts; `db` is required. */
function createCtx(parts) {
    if (!parts || !parts.db || typeof parts.db.prepare !== 'function') throw new Error('createCtx: db fehlt');
    // the stored form of an upload is always /uploads/<name>; a host maps it to its own file URL when it shows one
    const files = { ...missingFiles, ...parts.files, url: uploadUrl };
    const http = { ...missingHttp, ...parts.http };
    return {
        now: () => new Date(),
        log: silentLog,
        user: null,
        config: { appTimeZone: 'Europe/Berlin' },
        signal: undefined,
        limit: noop,
        randomId,
        yield: () => new Promise(resolve => setTimeout(resolve, 0)),
        ...parts,
        db: { generation: () => 1, ...parts.db },
        files,
        http
    };
}

/** The same host parts for one caller (and request-scoped extras such as signal and limit). */
const withUser = (ctx, user, extra = {}) => ({ ...ctx, user: user || null, ...extra });

module.exports = { createCtx, withUser, dbFromConnection, transactionFor, silentLog, ANSWERED };
