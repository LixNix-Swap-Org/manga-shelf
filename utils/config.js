// Typed, validated access to every environment variable; bad values fall back to a default with a German warning.
const path = require('path');
const fs = require('fs');
const { parseTrustProxy } = require('./trustProxy');

const APP_DIR = path.join(__dirname, '..');
const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'];
const LOG_FORMATS = ['text', 'json'];

const blank = (raw) => raw === undefined || raw === null || String(raw).trim() === '';
const ok = (value) => ({ value });
const warn = (value, warning) => ({ value, warning });

function validTimeZone(zone) {
    try {
        new Intl.DateTimeFormat('de-DE', { timeZone: zone });
        return true;
    } catch (e) {
        return false;
    }
}

const intIn = (min, max, fallback) => (raw, name) => {
    if (blank(raw)) return ok(fallback);
    const text = String(raw).trim();
    const n = /^\d+$/.test(text) ? Number(text) : NaN;
    if (Number.isSafeInteger(n) && n >= min && n <= max) return ok(n);
    if (Number.isFinite(n) && n > max) return warn(max, `${name}="${text}" ist zu groß (erlaubt: ${min} bis ${max}), es gilt ${max}`);
    return warn(fallback, `${name}="${text}" ist ungültig (erlaubt: ganze Zahl von ${min} bis ${max}), es gilt ${fallback}`);
};

// Snapshot retention: an unreadable value must never prune more than the admin meant, so it keeps everything
const KEEP_ALL = Infinity;
const keepCount = (fallback) => {
    const parse = intIn(1, 1000, fallback);
    return (raw, name) => {
        const text = String(raw ?? '').trim();
        if (blank(raw) || (/^\d+$/.test(text) && Number(text) >= 1)) return parse(raw, name);
        return warn(KEEP_ALL, `${name}="${text}" ist ungültig (erlaubt: ganze Zahl von 1 bis 1000), bis zur Korrektur werden keine Snapshots dieser Art gelöscht`);
    };
};

const oneOf = (allowed, fallback) => (raw, name) => {
    if (blank(raw)) return ok(fallback);
    const text = String(raw).trim().toLowerCase();
    if (allowed.includes(text)) return ok(text);
    return warn(fallback, `${name}="${String(raw).trim()}" ist unbekannt (erlaubt: ${allowed.join(', ')}), es gilt ${fallback}`);
};

const flag = (fallback) => (raw, name) => {
    if (blank(raw)) return ok(fallback);
    const text = String(raw).trim();
    if (/^(true|1|yes|on|ja)$/i.test(text)) return ok(true);
    if (/^(false|0|no|off|nein)$/i.test(text)) return ok(false);
    return warn(fallback, `${name}="${text}" ist unbekannt (erlaubt: true oder false), es gilt ${fallback}`);
};

const text = (fallback = null) => (raw) => ok(blank(raw) ? fallback : String(raw).trim());

// onInvalid null = the server's own time zone
const timeZone = (fallback, onInvalid) => (raw, name) => {
    if (blank(raw)) return ok(fallback);
    const zone = String(raw).trim();
    if (validTimeZone(zone)) return ok(zone);
    return warn(onInvalid, `${name}="${zone}" ist keine bekannte Zeitzone (z. B. Europe/Berlin), es gilt ${onInvalid || 'die Zeitzone des Servers'}`);
};

const sslDefault = (name) => path.join(APP_DIR, 'ssl', name);

// Origins of the bundled apps: Capacitor iOS, Capacitor Android (androidScheme https), older Ionic shells, Electron.
// They get CORS without credentials: the apps authenticate with a bearer token, never with the cookie.
const DEFAULT_APP_ORIGINS = Object.freeze(['capacitor://localhost', 'https://localhost', 'ionic://localhost', 'app://manga-shelf']);
const ORIGIN_FORMAT = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]+$/;

const appOrigins = (raw, name) => {
    if (blank(raw)) return ok(DEFAULT_APP_ORIGINS);
    const text = String(raw).trim();
    if (text.toLowerCase() === 'none') return ok(Object.freeze([]));
    const list = text.split(',').map(o => o.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean);
    const invalid = list.filter(o => !ORIGIN_FORMAT.test(o));
    const valid = Object.freeze([...new Set(list.filter(o => ORIGIN_FORMAT.test(o)))]);
    if (invalid.length === 0) return ok(valid);
    return warn(valid, `${name} enthält ungültige Ursprünge (${invalid.join(', ')}; erwartet z. B. capacitor://localhost), sie werden ignoriert`);
};

const ANIME_SOURCE_NAMES = ['anilist', 'jikan', 'mal'];
const DEFAULT_ANIME_SOURCES = Object.freeze(['anilist', 'jikan']);

// "jikan" and "mal" both mean the MyAnimeList side (core/anime/settings.js)
const animeSources = (raw, name) => {
    if (blank(raw)) return ok(DEFAULT_ANIME_SOURCES);
    const list = String(raw).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const unknown = list.filter(s => !ANIME_SOURCE_NAMES.includes(s));
    const valid = Object.freeze([...new Set(list.filter(s => ANIME_SOURCE_NAMES.includes(s)))]);
    const allowed = `erlaubt: ${ANIME_SOURCE_NAMES.join(', ')}`;
    if (!valid.length) {
        return warn(DEFAULT_ANIME_SOURCES, `${name}="${String(raw).trim()}" nennt keine bekannte Quelle (${allowed}), es gilt ${DEFAULT_ANIME_SOURCES.join(',')}`);
    }
    if (unknown.length) return warn(valid, `${name} enthält unbekannte Quellen (${unknown.join(', ')}; ${allowed}), es gilt ${valid.join(',')}`);
    return ok(valid);
};

const MIN_SETUP_TOKEN_LENGTH = 12;
/** Setup codes are compared without spaces and dashes and regardless of case. */
const normalizeSetupToken = (value) => String(value).replace(/[\s-]/g, '').toUpperCase();

const setupToken = (raw, name) => {
    if (blank(raw)) return ok(null);
    const normalized = normalizeSetupToken(raw);
    if (normalized.length >= MIN_SETUP_TOKEN_LENGTH) return ok(normalized);
    return warn(null, `${name} ist zu kurz (mindestens ${MIN_SETUP_TOKEN_LENGTH} Zeichen ohne Leerzeichen und Bindestriche) und wird ignoriert, es gilt der beim Start erzeugte Einrichtungscode`);
};

/**
 * Every environment variable the server reads. `key` is the property on the config object; `fatal` entries stop the
 * start instead of falling back. `doc: false` marks internal switches that do not belong into .env.example.
 */
const ENTRIES = [
    {
        key: 'port', name: 'PORT', aliases: ['SERVER_PORT'], fatal: true,
        parse: (raw, name) => {
            if (blank(raw)) return ok(3000);
            const value = String(raw).trim();
            const n = /^\d+$/.test(value) ? Number(value) : NaN;
            if (Number.isInteger(n) && n >= 0 && n <= 65535) return ok(n);
            return { error: `${name}="${value}" ist kein gültiger Port (erlaubt: 0 bis 65535)` };
        }
    },
    { key: 'dataDir', name: 'DATA_DIR', parse: (raw) => ok(blank(raw) ? path.join(APP_DIR, 'data') : path.resolve(String(raw).trim())) },
    { key: 'frontendDir', name: 'FRONTEND_DIR', parse: (raw) => ok(blank(raw) ? null : path.resolve(String(raw).trim())) },
    {
        key: 'trustProxy', name: 'TRUST_PROXY', fatal: true,
        parse: (raw) => {
            try { return ok(parseTrustProxy(raw)); } catch (e) { return { error: e.message }; }
        }
    },
    { key: 'corsOrigins', name: 'CORS_ORIGIN', parse: (raw) => ok(String(raw || '').split(',').map(o => o.trim()).filter(Boolean)) },
    { key: 'appOrigins', name: 'APP_ORIGINS', parse: appOrigins },
    { key: 'cookieSecure', name: 'COOKIE_SECURE', parse: flag(false) },
    { key: 'sslKeyPath', name: 'SSL_KEY_PATH', parse: (raw) => ok(blank(raw) ? sslDefault('privkey.pem') : String(raw).trim()) },
    {
        key: 'sslCertPath', name: 'SSL_CERT_PATH',
        parse: (raw) => {
            if (!blank(raw)) return ok(String(raw).trim());
            return ok(fs.existsSync(sslDefault('fullchain.pem')) ? sslDefault('fullchain.pem') : sslDefault('cert.pem'));
        }
    },
    { key: 'jwtSecret', name: 'JWT_SECRET', parse: text() },
    { key: 'setupToken', name: 'SETUP_TOKEN', parse: setupToken },
    { key: 'logLevel', name: 'LOG_LEVEL', parse: oneOf(LOG_LEVELS, 'info') },
    { key: 'logFormat', name: 'LOG_FORMAT', parse: oneOf(LOG_FORMATS, 'text') },
    { key: 'appTimeZone', name: 'APP_TIMEZONE', parse: timeZone('Europe/Berlin', null) },
    { key: 'backupHour', name: 'BACKUP_HOUR', parse: intIn(0, 23, 3) },
    { key: 'backupTimeZone', name: 'BACKUP_TIMEZONE', parse: timeZone('Europe/Berlin', 'UTC') },
    { key: 'backupKeepDaily', name: 'BACKUP_KEEP_DAILY', parse: keepCount(7) },
    { key: 'backupKeepManual', name: 'BACKUP_KEEP_MANUAL', parse: keepCount(10) },
    { key: 'backupKeepPreRestore', name: 'BACKUP_KEEP_PRE_RESTORE', parse: keepCount(3) },
    { key: 'backupKeepPreUpdate', name: 'BACKUP_KEEP_PRE_UPDATE', parse: keepCount(3) },
    { key: 'migrateWithoutSnapshot', name: 'MIGRATE_WITHOUT_SNAPSHOT', parse: flag(false) },
    { key: 'adminConsole', name: 'ADMIN_CONSOLE', parse: flag(true) },
    { key: 'updateCheck', name: 'UPDATE_CHECK', parse: flag(true) },
    { key: 'animeAnilistRpm', name: 'ANIME_ANILIST_RPM', parse: intIn(1, 600, 30) },
    { key: 'animeJikanRpm', name: 'ANIME_JIKAN_RPM', parse: intIn(1, 600, 60) },
    { key: 'animeSources', name: 'ANIME_SOURCES', parse: animeSources },
    { key: 'malClientId', name: 'MAL_CLIENT_ID', parse: text() },
    { key: 'googleBooksKey', name: 'GOOGLE_BOOKS_KEY', parse: text() },
    { key: 'restoreMaxDbBytes', name: 'RESTORE_MAX_DB_BYTES', parse: intIn(1, Number.MAX_SAFE_INTEGER, 2 * 1024 ** 3) },
    { key: 'restoreMaxUploadsBytes', name: 'RESTORE_MAX_UPLOADS_BYTES', parse: intIn(1, Number.MAX_SAFE_INTEGER, 4 * 1024 ** 3) },
    { key: 'restoreMaxEntries', name: 'RESTORE_MAX_ENTRIES', parse: intIn(1, 10000000, 100000) },
    { key: 'noListen', name: 'MANGA_SHELF_NO_LISTEN', doc: false, parse: (raw) => ok(String(raw ?? '').trim() === '1') }
];

/** Raw value and the variable it came from; SERVER_PORT (Pterodactyl) wins over PORT. */
function rawValue(entry, env) {
    for (const name of [...(entry.aliases || []), entry.name]) {
        if (!blank(env[name])) return { raw: env[name], name };
    }
    return { raw: undefined, name: entry.name };
}

function parseEntry(entry, env) {
    const { raw, name } = rawValue(entry, env);
    return entry.parse(raw, name);
}

/** Parses all variables of `env`: { values, warnings, errors } (German texts). Pure, for startup and tests. */
function readConfig(env = process.env) {
    const values = {};
    const warnings = [];
    const errors = [];
    for (const entry of ENTRIES) {
        const result = parseEntry(entry, env);
        if (result.error) errors.push(result.error);
        if (result.warning) warnings.push(result.warning);
        values[entry.key] = result.value;
    }
    return { values, warnings, errors };
}

// Every property is read from the current environment on access: tests and the console change variables at run
// time, and start() overrides are passed explicitly instead of being written back here.
const config = {};
for (const entry of ENTRIES) {
    Object.defineProperty(config, entry.key, {
        enumerable: true,
        get: () => {
            const result = parseEntry(entry, process.env);
            if (result.error) throw new Error(result.error);
            return result.value;
        }
    });
}
Object.freeze(config);

/**
 * Startup check: logs one German warning per unusable value (the default applies) and throws on the fatal ones
 * (port, TRUST_PROXY) so the start ends with a clear line instead of failing later.
 */
function validateConfig(log, env = process.env) {
    const { warnings, errors } = readConfig(env);
    for (const w of warnings) log.warn(`[Konfiguration] ${w}`);
    if (errors.length) {
        const err = new Error(errors.join('; '));
        err.code = 'CONFIG_INVALID';
        throw err;
    }
    return warnings;
}

/** Loads .env from the working directory without overriding variables that are already set. */
function loadDotenv() {
    require('dotenv').config({ quiet: true });
}

module.exports = { config, readConfig, KEEP_ALL, validateConfig, loadDotenv, normalizeSetupToken, ENTRIES, LOG_LEVELS, LOG_FORMATS, DEFAULT_APP_ORIGINS, MIN_SETUP_TOKEN_LENGTH };
