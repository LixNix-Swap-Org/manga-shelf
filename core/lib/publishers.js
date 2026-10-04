// Canonical German manga publishers: the built-in map plus the aliases stored in publisher_aliases (merge screen).
const CANONICAL_PUBLISHERS = {
    'altraverse': 'Altraverse',
    'carlsen manga': 'Carlsen Manga',
    'crunchyroll': 'Crunchyroll',
    'dani books': 'Dani Books',
    'dark horse manga': 'Dark Horse Manga',
    'egmont manga': 'Egmont Manga',
    'hayabusa': 'Hayabusa',
    'kazé manga': 'Kazé Manga',
    'kaze manga': 'Kazé Manga',
    'manga cult': 'Manga Cult',
    'manga jam session': 'Manga JAM Session',
    'panini verlag gmbh': 'Panini Verlags GmbH',
    'panini verlags gmbh': 'Panini Verlags GmbH',
    'panini': 'Panini Verlags GmbH',
    'panini manga': 'Panini Verlags GmbH',
    'papertoons': 'Papertoons',
    'schreiber&leser': 'Schreiber&Leser',
    'schreiber & leser': 'Schreiber&Leser',
    'tokyopop': 'TOKYOPOP'
};

// Spellings measured from DNB and Manga Passion (2026-10); migration 22 stores them in publisher_aliases
const PUBLISHER_ALIAS_SEED = {
    'carlsen verlag gmbh': 'Carlsen Manga',
    'carlsen verlag': 'Carlsen Manga',
    'egmont manga & anime': 'Egmont Manga',
    'ema': 'Egmont Manga',
    'tokyopop gmbh': 'TOKYOPOP'
};

// legal suffixes a catalogue appends ("TOKYOPOP GmbH"); only used when the full name is not known
const LEGAL_SUFFIX = /(?:(?:\s*[,&]\s*|\s+)(?:gmbh|verlag|verlags|co|kg|ag|mbh)\.?)+$/i;

let storedAliases = new Map();

// own keys only ("constructor" is no publisher); Object.hasOwn is newer than the app build's browser targets
const builtInPublisher = (key) => (Object.prototype.hasOwnProperty.call(CANONICAL_PUBLISHERS, key) ? CANONICAL_PUBLISHERS[key] : undefined);

/** Lookup key of a publisher name: trimmed, lower case, without the trailing "!" of "Carlsen Manga!". */
const publisherKey = (name) => (typeof name === 'string' ? name.trim().toLowerCase().replace(/\s*!+$/, '') : '');

// Canonical name for `name` with the given alias map (key -> canonical). Stored aliases win over the built-in map;
// a canonical name that was itself merged into another follows that alias once (an identity row "tokyopop" ->
// "Tokyopop" keeps a renamed built-in spelling).
function resolvePublisher(name, aliases = storedAliases) {
    if (!name || typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (!trimmed) return null;
    const key = publisherKey(trimmed);
    const stripped = key.replace(LEGAL_SUFFIX, '').trim();
    let result = aliases.get(key) || builtInPublisher(key)
        || (stripped && stripped !== key ? aliases.get(stripped) || builtInPublisher(stripped) : null)
        || trimmed.replace(/\s*!+$/, '');
    const followKey = publisherKey(result);
    const followed = aliases.get(followKey) || builtInPublisher(followKey);
    if (followed) result = followed;
    return result;
}

const normalizePublisher = (name) => resolvePublisher(name, storedAliases);

/** Replaces the stored aliases normalizePublisher uses ([{ alias, canonical }] or a Map). */
function setPublisherAliases(rows) {
    const map = new Map();
    for (const row of rows instanceof Map ? [...rows].map(([alias, canonical]) => ({ alias, canonical })) : rows || []) {
        const key = publisherKey(row.alias);
        if (key && typeof row.canonical === 'string' && row.canonical.trim()) map.set(key, row.canonical.trim());
    }
    storedAliases = map;
}

/** Reads publisher_aliases of a connection (prepare(sql).all()) into normalizePublisher; no table, no aliases. */
function loadPublisherAliases(conn) {
    try {
        const table = conn.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'publisher_aliases'").get();
        setPublisherAliases(table ? conn.prepare('SELECT alias, canonical FROM publisher_aliases').all() : []);
    } catch (e) {
        setPublisherAliases([]);
    }
}

const publisherAliases = () => new Map(storedAliases);

/** True when `name` is a canonical name of the built-in map or of a stored alias. */
function isKnownPublisher(name) {
    const key = publisherKey(name);
    if (!key) return false;
    if (Object.values(CANONICAL_PUBLISHERS).some(c => c.toLowerCase() === key)) return true;
    for (const canonical of storedAliases.values()) if (canonical.toLowerCase() === key) return true;
    return false;
}

module.exports = {
    CANONICAL_PUBLISHERS,
    PUBLISHER_ALIAS_SEED,
    normalizePublisher,
    resolvePublisher,
    publisherKey,
    setPublisherAliases,
    loadPublisherAliases,
    publisherAliases,
    isKnownPublisher
};
