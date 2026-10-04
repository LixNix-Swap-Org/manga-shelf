// Input parsers shared by the routes. Most return { value } or { error: true }; the exceptions say so.

// Statuses the app works with (volume editor, shopping list, release radar, Manga Passion import).
// The legacy 'Gelesen' is still accepted as input and stored as 'Vorhanden' plus a read entry (core/lib/owners.js).
const VOLUME_STATUSES = ['Vorhanden', 'Fehlt', 'Vorbestellt', 'Erscheint bald', 'Bestellt'];
const VOLUME_TYPES = ['volume', 'special_edition', 'schuber', 'special'];
// The UI offers Laufend/Abgeschlossen/Pausiert/Geplant; the AniList lookup also sends Abgebrochen.
const MANGA_STATUSES = ['Laufend', 'Abgeschlossen', 'Pausiert', 'Abgebrochen', 'Geplant'];

const isBlank = (val) => val === null || val === undefined || (typeof val === 'string' && val.trim() === '');

// Prices as typed in German forms: "7,50", "€ 7,99", "1.234,56"; plain numbers from JSON. Empty clears the field.
const parsePrice = (val) => {
    if (isBlank(val)) return { value: null };
    let num;
    if (typeof val === 'number') {
        num = val;
    } else if (typeof val === 'string') {
        let s = val.replace(/€|eur/gi, '').replace(/\s/g, '');
        if (s === '') return { value: null };
        if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
        if (!/^\d+(\.\d{1,2})?$/.test(s)) return { error: true };
        num = Number(s);
    } else {
        return { error: true };
    }
    if (!Number.isFinite(num) || num < 0 || num > 99999) return { error: true };
    return { value: Math.round(num * 100) / 100 };
};

const parseIntInRange = (min, max) => (val) => {
    if (isBlank(val)) return { value: null };
    if (typeof val !== 'number' && !(typeof val === 'string' && /^\d+$/.test(val.trim()))) return { error: true };
    const n = Number(val);
    return Number.isInteger(n) && n >= min && n <= max ? { value: n } : { error: true };
};
const parsePages = parseIntInRange(1, 99999);
const parseYear = parseIntInRange(1900, 2999);

// JSON booleans as well as "true"/"false"/"0"/"1" strings ("false" must not count as true)
const parseFlag = (val) => !(val === false || val === 0 || val === null || /^(false|0|no|nein|)$/i.test(String(val).trim()));

/** Only true, 'true', 1 and '1' are true; absent (undefined/null) gives the fallback. */
const parseTrueFlag = (value, fallback) => {
    if (value === undefined || value === null) return fallback;
    return value === true || value === 'true' || value === 1 || value === '1';
};

/** 0 (keine) bis 3 (hoch); leer = 0, alles andere null (ungültig). */
const parsePriority = (val) => {
    if (val === undefined || val === null || val === '') return 0;
    const n = Number(val);
    return Number.isInteger(n) && n >= 0 && n <= 3 ? n : null;
};

/** Wish priority of a series: null/'' = not wished, otherwise 0 to 3 (same scale as volumes.priority). */
const parseWishPriority = (val) => {
    if (val === null || val === '') return { value: null };
    const text = typeof val === 'number' ? String(val) : (typeof val === 'string' ? val.trim() : null);
    if (text === '') return { value: null };
    if (text === null || !/^[0-3]$/.test(text)) return { error: true };
    return { value: Number(text) };
};

// Dates as the forms and imports write them: YYYY, YYYY-MM or YYYY-MM-DD (empty = not set); full dates must exist
const isValidDate = (val) => {
    if (isBlank(val)) return true;
    if (typeof val !== 'string' && typeof val !== 'number') return false;
    const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(String(val).trim());
    if (!m) return false;
    const year = parseInt(m[1], 10);
    const month = m[2] ? parseInt(m[2], 10) : 1;
    const day = m[3] ? parseInt(m[3], 10) : 1;
    if (year < 1900 || year > 2999 || month < 1 || month > 12) return false;
    const dt = new Date(Date.UTC(year, month - 1, day));
    return dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
};
// volume_reads.read_at as SQLite's CURRENT_TIMESTAMP writes it (UTC)
const isValidReadAt = (val) => {
    if (typeof val !== 'string') return false;
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(val.trim());
    if (!m || !isValidDate(`${m[1]}-${m[2]}-${m[3]}`)) return false;
    return Number(m[4]) < 24 && Number(m[5]) < 60 && Number(m[6]) < 60;
};
const parseDate = (val) => (isValidDate(val) ? { value: isBlank(val) ? null : String(val).trim() } : { error: true });

/** Whole number (number or digit string) or null; no range check beyond safe integers. */
const parseWholeNumber = (val) => {
    const text = typeof val === 'number' ? String(val) : (typeof val === 'string' ? val.trim() : '');
    if (!/^\d+$/.test(text)) return null;
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : null;
};

/** Positive integer id (number or digit string) or null; parseInt would accept '12abc' or 1.5. */
const parsePositiveInt = (value) => {
    const n = parseWholeNumber(value);
    return n !== null && n > 0 ? n : null;
};

/** Optional id: empty and 0 mean none ({ value: null }), anything but a positive integer is { error: true }. */
const parseOptionalId = (value) => {
    if (value === undefined || value === null || value === '' || value === 0) return { value: null };
    const id = parsePositiveInt(value);
    return id ? { value: id } : { error: true };
};

/** 1 to `max` positive ids (numbers or digit strings), duplicates dropped in order; { value } or { error: true }. */
const parseIdList = (val, max) => {
    if (!Array.isArray(val) || val.length === 0 || val.length > max) return { error: true };
    const ids = [];
    for (const raw of val) {
        const id = parsePositiveInt(raw);
        if (id === null) return { error: true };
        if (!ids.includes(id)) ids.push(id);
    }
    return { value: ids };
};

const MAX_CONDITION_LENGTH = 200;
/** Free-text condition: empty clears it, other strings are trimmed and at most 200 characters. */
const parseCondition = (val) => {
    if (isBlank(val)) return { value: null };
    if (typeof val !== 'string' || val.trim().length > MAX_CONDITION_LENGTH) return { error: true };
    return { value: val.trim() };
};

const parseVolumeStatus = (val) => (typeof val === 'string' && VOLUME_STATUSES.includes(val) ? { value: val } : { error: true });
const parsePriorityField = (val) => {
    const n = parsePriority(val);
    return n === null ? { error: true } : { value: n };
};

// Columns a bulk edit may set on every selected volume, with their parsers
const BULK_SET_PARSERS = {
    status: parseVolumeStatus,
    price: parsePrice,
    purchase_date: parseDate,
    condition: parseCondition,
    priority: parsePriorityField,
    target_price: parsePrice,
    release_date: parseDate
};
const BULK_SET_FIELDS = Object.keys(BULK_SET_PARSERS);

/**
 * The `set` object of a bulk edit: only known keys, each valid. Returns { value: { column: value } } (possibly empty)
 * or { error: key } naming the first invalid or unknown key.
 */
const parseBulkSet = (set) => {
    if (set === undefined || set === null) return { value: {} };
    if (typeof set !== 'object' || Array.isArray(set)) return { error: 'set' };
    const value = {};
    for (const [key, raw] of Object.entries(set)) {
        const parse = BULK_SET_PARSERS[key];
        if (!parse) return { error: key };
        const parsed = parse(raw);
        if (parsed.error) return { error: key };
        value[key] = parsed.value;
    }
    return { value };
};

module.exports = {
    VOLUME_STATUSES, VOLUME_TYPES, MANGA_STATUSES, BULK_SET_FIELDS,
    isBlank, parsePrice, parseIntInRange, parsePages, parseYear, parseFlag, parseTrueFlag, parsePriority, parseWishPriority,
    isValidDate, isValidReadAt, parseDate, parseWholeNumber, parsePositiveInt, parseOptionalId,
    parseIdList, parseCondition, parseBulkSet
};
