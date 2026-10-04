// CSV export of the collection and import from such a file. Pure functions, no database.
const { normalizeIsbn, isValidIsbn } = require('./lib/isbn');
const { inferVolumeType } = require('./lib/volumeType');
const { isLegacyReadStatus, OWNED_STATUS } = require('./lib/owners');
const { canonicalVolumeNumber } = require('./lib/volumeNumber');
const { msg, msgData, isMsg } = require('./errors');
const { VOLUME_STATUSES: STATUSES, VOLUME_TYPES: TYPES, MANGA_STATUSES } = require('./lib/validate');
const { parseLanguage, normalizeRegion, normalizeCurrency, isWorkKey } = require('./lib/language');

const DELIMITER = ';';
const MAX_AMOUNT = 99999;
// Type of a series row (a series without a volume)
const SERIES_ROW_TYPE = 'Reihe';
// same as COLLECTING_STATUSES in core/handlers/mangas.js; empty = active
const COLLECTING_STATUSES = ['aktiv', 'pausiert', 'abgebrochen'];

// "Reihenverlag" is the series publisher, "Verlag" a volume's differing publisher (empty = the series').
// The series wish is on every row of the series, the other series fields only on its first row.
// "Gelesen von" and the owners stay the last columns. "Sprache" is a language code; region, currency and work key of the
// edition follow it, "Bandsprache" (empty = the series') is a volume's own language.
const COLUMNS = [
    ['series', 'Reihe'], ['series_publisher', 'Reihenverlag'], ['publisher', 'Verlag'], ['author', 'Autor'], ['type', 'Typ'],
    ['volume_number', 'Bandnummer'], ['status', 'Status'], ['isbn', 'ISBN'], ['price', 'Preis'],
    ['target_price', 'Zielpreis'], ['priority', 'Priorität'], ['release_date', 'Erscheinungsdatum'],
    ['release_year', 'Erscheinungsjahr'], ['purchase_date', 'Kaufdatum'], ['condition', 'Zustand'],
    ['pages', 'Seiten'], ['notes', 'Notizen'],
    ['series_wish', 'Reihen-Wunsch'], ['series_status', 'Reihenstatus'], ['series_collecting', 'Sammelstatus'], ['series_total', 'Gesamtbände'],
    ['series_alt_title', 'Alternativtitel'], ['series_language', 'Sprache'], ['series_region', 'Region'], ['series_currency', 'Währung'],
    ['series_work_key', 'Werk'], ['series_tags', 'Tags'],
    ['series_mp_id', 'Manga-Passion-ID'], ['series_cover', 'Reihen-Cover'], ['series_banner', 'Reihen-Banner'],
    ['series_description', 'Beschreibung'], ['cover_image', 'Band-Cover'], ['images', 'Bilder'], ['mp_volume_id', 'MP-Band-ID'],
    ['volume_language', 'Bandsprache'], ['readers', 'Gelesen von'], ['owners', 'Besitzer']
];
// Series fields that the export writes only on the first row of a series
const SERIES_DETAIL_KEYS = [
    'series_status', 'series_collecting', 'series_total', 'series_alt_title', 'series_language', 'series_region', 'series_currency',
    'series_work_key', 'series_tags', 'series_mp_id', 'series_cover', 'series_banner', 'series_description'
];

// Limits for user-name cells (owners, read by)
const MAX_NAMES_CELL_LENGTH = 1000;
const MAX_NAMES_PER_CELL = 50;
// Same as POST/PUT /volumes. The export's formula guard can lengthen a cell by up to half, so cells up to
// 2 * MAX_NOTES_LENGTH + 2 are not yet a file-level error; longer ones are a row error.
const MAX_NOTES_LENGTH = 10000;
const MAX_CELL_LENGTH = 2 * MAX_NOTES_LENGTH + 2;

/** `message` is text or a msg(); the msg() stays on `detail` for the error answer (core/handlers/csv.js). */
class CsvFormatError extends Error {
    constructor(message, line) {
        super(String(message));
        if (isMsg(message)) this.detail = message;
        this.name = 'CsvFormatError';
        this.line = line;
        this.status = 400;
    }
}

/** Comparison key for titles, numbers and names: Unicode-safe (NFC, full case folding), trimmed. */
const matchKey = (s) => String(s ?? '').trim().normalize('NFC').toLowerCase();


// Spreadsheet programs evaluate cells starting with = + - @ (also after tab/CR) as formulas
const FORMULA_START = /^(?:[=+@\t\r]|-(?![\d.,]+$))/;
const needsFormulaGuard = (s) => FORMULA_START.test(s.replace(/^'+/, ''));
// Excel with a comma list separator (en-US) splits the line at every comma, so a formula can start mid-cell
const EMBEDDED_FORMULA = /,(\s*)('*)(?=[=+@\t\r]|-(?![\d.]+(?:,|$)))/g;
const EMBEDDED_GUARDED = /,(\s*)'('*)(?=[=+@\t\r]|-(?![\d.]+(?:,|$)))/g;

/** Prefixes a ' to formula characters at the cell start and after each comma; unescapeCell removes exactly these. */
function guardFormulas(value) {
    let s = value.replace(EMBEDDED_FORMULA, ",$1'$2");
    // Values already starting with ' get one more, so the import can strip exactly one
    if (needsFormulaGuard(s)) s = "'" + s;
    return s;
}

function escapeCell(value) {
    const s = guardFormulas(value === null || value === undefined ? '' : String(value));
    return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Counterpart of guardFormulas: removes exactly the ' that the export inserted. */
function unescapeCell(s) {
    const head = s.startsWith("'") && needsFormulaGuard(s.slice(1)) ? s.slice(1) : s;
    return head.replace(EMBEDDED_GUARDED, ',$1$2');
}

const formatAmount = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))
    ? v
    : String(Math.round(Number(v) * 100) / 100).replace('.', ','));

// Excel turns a 13-digit number into 9,78355E+12; with hyphens it stays text (the import removes them again)
const formatIsbn = (v) => (typeof v === 'string' && /^\d{13}$/.test(v) ? `${v.slice(0, 3)}-${v.slice(3)}` : v);

// Images: a JSON list in the database, joined by " | " in the CSV
const formatImages = (v) => {
    if (!v) return v;
    try {
        const list = JSON.parse(v);
        return Array.isArray(list) ? list.join(' | ') : v;
    } catch (_) {
        return v;
    }
};

const EXPORT_FORMATTERS = { price: formatAmount, target_price: formatAmount, isbn: formatIsbn, images: formatImages };

/** rows: objects keyed by COLUMNS. With a BOM so that Excel detects UTF-8. */
const csvHeader = () => COLUMNS.map(c => c[1]).join(DELIMITER);

/** The data lines of `rows`, without header and line breaks at the ends (toCsv in blocks). */
function csvLines(rows) {
    return rows.map(row => COLUMNS.map(([key]) => {
        const format = EXPORT_FORMATTERS[key];
        return escapeCell(format ? format(row[key]) : row[key]);
    }).join(DELIMITER));
}

/** The export file of `blocks` (arrays of lines): BOM, header, CRLF line ends. */
const joinCsv = (blocks) => '\uFEFF' + [csvHeader(), ...blocks.flat()].join('\r\n') + '\r\n';

function toCsv(rows) {
    return joinCsv([csvLines(rows)]);
}

/** Delimiter from the first non-empty line, without splitting the whole text. */
function detectDelimiter(src) {
    for (let start = 0; start < src.length;) {
        let semicolons = 0;
        let commas = 0;
        let blank = true;
        let i = start;
        for (; i < src.length && src[i] !== '\n' && src[i] !== '\r'; i++) {
            const ch = src[i];
            if (ch === ';') semicolons++;
            else if (ch === ',') commas++;
            if (blank && ch.trim() !== '') blank = false;
        }
        if (!blank) return semicolons >= commas ? ';' : ',';
        start = i + 1;
    }
    return ';';
}

// Splits CSV text into rows of cells (quotes, "" as escape, ; or , as delimiter). `row.line` (non-enumerable) is the
// text line a row starts on; blank lines and line breaks inside cells count. An unclosed quote throws CsvFormatError.
// limits: { maxRows, maxCells, maxCellLength }; exceeding one throws before the rest of the file is read into memory.
function parseCsv(text, limits = {}) {
    const { maxRows = Infinity, maxCells = Infinity, maxCellLength = Infinity } = limits;
    const src = String(text || '').replace(/^\uFEFF/, '');
    const delim = detectDelimiter(src);
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    let line = 1;
    let rowStart = 1;
    let quoteStart = 0;
    const pushCell = () => {
        if (cell.length > maxCellLength) throw new CsvFormatError(msg('Zelle in Zeile {line} ist zu lang (maximal {max} Zeichen)', { line: rowStart, max: maxCellLength }), rowStart);
        if (row.length >= maxCells) throw new CsvFormatError(msg('Zeile {line} hat zu viele Spalten (maximal {max})', { line: rowStart, max: maxCells }), rowStart);
        row.push(cell);
        cell = '';
    };
    const pushRow = () => {
        pushCell();
        if (row.some(c => c.trim() !== '')) {
            if (rows.length > maxRows) throw new CsvFormatError(msg('Zu viele Zeilen (maximal {max})', { max: maxRows }), rowStart);
            Object.defineProperty(row, 'line', { value: rowStart, enumerable: false });
            rows.push(row);
        }
        row = [];
    };
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (quoted) {
            if (ch === '"') {
                if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
            } else {
                if (ch === '\n' || (ch === '\r' && src[i + 1] !== '\n')) line++;
                cell += ch;
            }
        } else if (ch === '"' && cell === '') { quoted = true; quoteStart = line; }
        else if (ch === delim) pushCell();
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && src[i + 1] === '\n') i++;
            pushRow();
            line++;
            rowStart = line;
        } else cell += ch;
    }
    if (quoted) throw new CsvFormatError(msg('Anführungszeichen ab Zeile {line} nicht geschlossen', { line: quoteStart }), quoteStart);
    pushRow();
    return rows;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-zäöüß0-9]/g, '');
// Alias order = precedence: specific names before general ones ("Titel" is often the volume title)
const HEADER_ALIASES = {
    series: ['reihe', 'serie', 'series', 'titel', 'title'],
    series_publisher: ['reihenverlag', 'seriespublisher'],
    publisher: ['verlag', 'publisher', 'bandverlag'], author: ['autor', 'author'],
    type: ['typ', 'type'], volume_number: ['bandnummer', 'volumenumber', 'nummer', 'band', 'volume'],
    status: ['status'], isbn: ['isbn'], price: ['preis', 'price'],
    target_price: ['zielpreis', 'targetprice', 'wunschpreis'], priority: ['priorität', 'prioritaet', 'prioritat', 'priority', 'prio'],
    release_date: ['erscheinungsdatum', 'releasedate'], release_year: ['erscheinungsjahr', 'releaseyear'],
    purchase_date: ['kaufdatum', 'purchasedate'], condition: ['zustand', 'condition'], pages: ['seiten', 'pages'],
    notes: ['notizen', 'notes'], readers: ['gelesenvon', 'readby', 'readers'], owners: ['besitzer', 'owners', 'owner'],
    series_wish: ['reihenwunsch', 'wunschreihe', 'wishpriority'], series_status: ['reihenstatus', 'seriesstatus'],
    series_collecting: ['sammelstatus', 'collecting', 'seriescollecting'],
    series_total: ['gesamtbände', 'gesamtbaende', 'totalvolumes'], series_alt_title: ['alternativtitel', 'alttitle'],
    series_language: ['sprache', 'language'], series_region: ['region'], series_currency: ['währung', 'waehrung', 'wahrung', 'currency'],
    series_work_key: ['werk', 'work', 'workkey'], series_tags: ['tags', 'genres'],
    series_mp_id: ['mangapassionid', 'mangapassionedition', 'mpid'], series_cover: ['reihencover', 'seriescover'],
    series_banner: ['reihenbanner', 'banner'], series_description: ['beschreibung', 'description'],
    cover_image: ['bandcover', 'cover', 'volumecover'], images: ['bilder', 'images', 'fotos'],
    mp_volume_id: ['mpbandid', 'mpvolumeid'], volume_language: ['bandsprache', 'volumelanguage']
};
const SERIES_META_KEYS = [
    'series_wish', 'series_status', 'series_collecting', 'series_total', 'series_alt_title', 'series_language', 'series_region',
    'series_currency', 'series_work_key', 'series_tags', 'series_mp_id', 'series_cover', 'series_banner', 'series_description'
];
const SERIES_KEYS = new Set(['series', 'series_publisher', 'publisher', 'author', ...SERIES_META_KEYS]);
const MAX_IMAGES = 50;
const MAX_URL_LENGTH = 2048;

const TYPE_ALIASES = {
    volume: 'volume', einzelband: 'volume', band: 'volume',
    specialedition: 'special_edition', collectorsedition: 'special_edition', limitededition: 'special_edition',
    schuber: 'schuber', special: 'special', extra: 'special', sonderband: 'special',
    reihe: 'series', series: 'series'
};

const MONTHS = {
    jan: 1, januar: 1, january: 1, feb: 2, februar: 2, february: 2, mär: 3, mrz: 3, märz: 3, mar: 3, march: 3,
    apr: 4, april: 4, mai: 5, may: 5, jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7, aug: 8, august: 8,
    sep: 9, sept: 9, september: 9, okt: 10, oktober: 10, oct: 10, october: 10, nov: 11, november: 11,
    dez: 12, dezember: 12, dec: 12, december: 12
};

const pad2 = (n) => String(n).padStart(2, '0');
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function buildDate(y, m, d) {
    if (y < 1000 || y > 9999) return { error: true };
    if (m === undefined) return { value: String(y) };
    if (m < 1 || m > 12) return { error: true };
    if (d === undefined) return { value: `${y}-${pad2(m)}` };
    if (d < 1 || d > daysInMonth(y, m)) return { error: true };
    return { value: `${y}-${pad2(m)}-${pad2(d)}` };
}

/**
 * Date from a CSV cell: YYYY, YYYY-M(M), YYYY-MM-DD, DD.MM.YYYY, MM.YYYY, MM/YYYY and Excel's month form ("Mrz 25").
 * Returns YYYY, YYYY-MM or YYYY-MM-DD with a range check, else { error }.
 */
function normalizeDate(v) {
    const s = String(v ?? '').trim();
    if (!s) return { value: null };
    const n = (x) => (x === undefined ? undefined : parseInt(x, 10));
    let m = s.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/);
    if (m) return buildDate(n(m[1]), n(m[2]), n(m[3]));
    m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) return buildDate(n(m[3]), n(m[2]), n(m[1]));
    m = s.match(/^(\d{1,2})[./](\d{4})$/);
    if (m) return buildDate(n(m[2]), n(m[1]));
    m = s.match(/^([a-zäöü]+)\.?[\s-]+(\d{2}|\d{4})$/i);
    if (m && MONTHS[m[1].toLowerCase()]) {
        const year = m[2].length === 2 ? 2000 + n(m[2]) : n(m[2]);
        return buildDate(year, MONTHS[m[1].toLowerCase()]);
    }
    return { error: true };
}

/** Amount in euros: "6,95", "6.95", "€ 7" (at most two decimals, up to 99999), empty = null. */
function parseAmount(v) {
    const s = String(v ?? '').replace(/[€\s]/g, '');
    if (!s) return { value: null };
    if (!/^\d{1,5}(?:[.,]\d{1,2})?$/.test(s)) return { error: true };
    const value = Number(s.replace(',', '.'));
    return value > MAX_AMOUNT ? { error: true } : { value };
}

/** Whole number 0..max without sign, exponent or suffix; empty = null. */
function parseCount(v, max = MAX_AMOUNT) {
    const s = String(v ?? '').trim();
    if (!s) return { value: null };
    if (!/^\d{1,5}$/.test(s)) return { error: true };
    const value = Number(s);
    return value > max ? { error: true } : { value };
}

/** Positive whole number (ID), empty = null. */
function parseId(v) {
    const s = String(v ?? '').trim();
    if (!s) return { value: null };
    if (!/^\d{1,15}$/.test(s) || Number(s) < 1) return { error: true };
    return { value: Number(s) };
}

/**
 * Series fields of a row; only filled cells appear. Invalid values are ignored with a warning, so a typo in a
 * series column never discards the volume row.
 */
/** A row error or warning: { line, message } as before; the msg() rides along non-enumerable for `errors_msg`/`warnings_msg`. */
function rowNote(line, message) {
    const note = { line, message: String(message) };
    Object.defineProperty(note, 'message_msg', { value: msgData(message), enumerable: false });
    return note;
}

// label is the CSV header and raw the cell: both stay verbatim in every language; hint is text or a nested msg()
const ignoredValue = (line, label, raw, hint) => rowNote(line, hint
    ? msg('Ungültiger Wert „{raw}“ in „{label}“ ({hint}) wird ignoriert', { raw, label, hint })
    : msg('Ungültiger Wert „{raw}“ in „{label}“ wird ignoriert', { raw, label }));
const range = (min, max) => msg('{min} bis {max}', { min, max });
const maxChars = (max) => msg('maximal {max} Zeichen', { max });
const shorten = (value) => (value.length > 20 ? `${value.slice(0, 20)}…` : value);

function readSeriesMeta(get, line, warnings) {
    const meta = {};
    const warn = (label, raw, hint) => warnings.push(ignoredValue(line, label, raw, hint));
    const wish = get('series_wish');
    if (wish) {
        const r = parseCount(wish, 3);
        if (r.error) warn('Reihen-Wunsch', wish, range(0, 3));
        else meta.wish_priority = r.value;
    }
    const status = get('series_status');
    if (status) {
        const found = MANGA_STATUSES.find(s => s.toLowerCase() === status.toLowerCase());
        if (found) meta.status = found;
        else warn('Reihenstatus', status, MANGA_STATUSES.join(', '));
    }
    const collecting = get('series_collecting');
    if (collecting) {
        const found = COLLECTING_STATUSES.find(s => s === collecting.toLowerCase());
        if (found) meta.collecting = found;
        else warn('Sammelstatus', collecting, COLLECTING_STATUSES.join(', '));
    }
    const total = get('series_total');
    if (total) {
        const r = parseCount(total, 5000);
        if (r.error) warn('Gesamtbände', total, range(0, 5000));
        else meta.total_volumes = r.value || null;
    }
    const mpId = get('series_mp_id');
    if (mpId) {
        const r = parseId(mpId);
        if (r.error) warn('Manga-Passion-ID', mpId);
        else meta.manga_passion_id = r.value;
    }
    const language = get('series_language');
    if (language) {
        const parsed = parseLanguage(language);
        if (!parsed) warn('Sprache', shorten(language), msg('Sprachcode wie de, en oder ja'));
        else {
            meta.language = parsed.language;
            if (parsed.region) meta.region = parsed.region;
        }
    }
    const region = get('series_region');
    if (region) {
        if (normalizeRegion(region)) meta.region = normalizeRegion(region);
        else warn('Region', shorten(region), msg('zwei Buchstaben, z. B. US'));
    }
    const currency = get('series_currency');
    if (currency) {
        if (normalizeCurrency(currency)) meta.currency = normalizeCurrency(currency);
        else warn('Währung', shorten(currency), msg('drei Buchstaben, z. B. EUR'));
    }
    const workKey = get('series_work_key');
    if (workKey) {
        if (isWorkKey(workKey)) meta.work_key = workKey;
        else warn('Werk', shorten(workKey));
    }
    for (const [key, field, label, max] of [
        ['series_alt_title', 'alt_title', 'Alternativtitel', 300],
        ['series_tags', 'tags', 'Tags', 500], ['series_description', 'description', 'Beschreibung', MAX_NOTES_LENGTH],
        ['series_cover', 'cover_image', 'Reihen-Cover', MAX_URL_LENGTH], ['series_banner', 'banner_image', 'Reihen-Banner', MAX_URL_LENGTH]
    ]) {
        const value = get(key);
        if (!value) continue;
        if (value.length > max) warn(label, shorten(value), maxChars(max));
        else meta[field] = value;
    }
    return meta;
}

function resolveColumns(headers) {
    const index = {};
    const used = new Set();
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
        for (const alias of aliases) {
            const i = headers.findIndex((h, j) => h === alias && !used.has(j));
            if (i >= 0) { index[key] = i; used.add(i); break; }
        }
    }
    return index;
}

// Turns parsed CSV rows into validated records: { records, errors, warnings: [{ line, message }], columns }.
// `line` is parseCsv's text line (the header usually 1). A row with a series but no volume number or data only
// creates the series (series_only). Errors carry non-enumerable `record` (the volume, if known) and `series_source`
// (series fields still apply from rejected rows). Covers, images and series columns never reject a row.
function mapCsvRows(rows) {
    if (!rows.length) return { records: [], errors: [rowNote(1, msg('Datei ist leer'))], warnings: [], columns: [] };
    const index = resolveColumns(rows[0].map(norm));
    const columns = Object.keys(index);
    if (index.series === undefined || index.volume_number === undefined) {
        return { records: [], errors: [rowNote(rows[0].line ?? 1, msg('Kopfzeile braucht mindestens die Spalten „Reihe“ und „Bandnummer“'))], warnings: [], columns };
    }
    const get = (row, key) => (index[key] === undefined ? '' : unescapeCell(String(row[index[key]] ?? '').trim()).trim());
    const hasSeriesMeta = SERIES_META_KEYS.some(key => columns.includes(key));
    const lenientCells = new Set(['cover_image', 'images', ...SERIES_META_KEYS].map(key => index[key]).filter(i => i !== undefined));
    const records = [];
    const errors = [];
    const warnings = [];
    rows.slice(1).forEach((row, n) => {
        const line = row.line ?? n + 2;
        const series = get(row, 'series');
        const volumeNumber = get(row, 'volume_number');
        const seriesFields = {
            series,
            series_publisher: get(row, 'series_publisher') || null,
            publisher: get(row, 'publisher') || null,
            author: get(row, 'author') || null
        };
        const rawType = get(row, 'type');
        const seriesRow = TYPE_ALIASES[norm(rawType)] === 'series';
        if (series && (seriesRow || (!volumeNumber && columns.every(key => SERIES_KEYS.has(key) || key === 'volume_number' || !get(row, key))))) {
            if (series.length > 300) return errors.push(rowNote(line, msg('Reihe oder Bandnummer ist zu lang')));
            if (seriesRow && volumeNumber) warnings.push(rowNote(line, msg('Bandnummer in einer Reihen-Zeile wird ignoriert')));
            const meta = hasSeriesMeta ? readSeriesMeta((key) => get(row, key), line, warnings) : {};
            return records.push({ line, series_only: true, ...seriesFields, series_meta: meta });
        }
        const seriesMeta = series && series.length <= 300 && hasSeriesMeta ? readSeriesMeta((key) => get(row, key), line, warnings) : {};
        const reject = (message, record) => {
            const err = rowNote(line, message);
            if (record) Object.defineProperty(err, 'record', { value: record, enumerable: false });
            if (series && series.length <= 300) {
                const source = { line, series, series_publisher: seriesFields.series_publisher, series_meta: seriesMeta };
                Object.defineProperty(err, 'series_source', { value: source, enumerable: false });
            }
            errors.push(err);
        };
        if (!series || !volumeNumber) return reject(msg('Reihe und Bandnummer sind Pflicht'));
        if (series.length > 300 || volumeNumber.length > 80) return reject(msg('Reihe oder Bandnummer ist zu lang'));

        const notes = get(row, 'notes') || null;
        const typeInferred = !rawType;
        const type = typeInferred
            ? inferVolumeType({ volume_number: volumeNumber, notes })
            : (TYPES.includes(rawType) ? rawType : TYPE_ALIASES[norm(rawType)]);
        if (!type) return reject(msg('Unbekannter Typ „{type}“', { type: rawType }));

        const identity = { ...seriesFields, type, type_inferred: typeInferred, volume_number: canonicalVolumeNumber(volumeNumber, type) };
        const fail = (message) => reject(message, identity);

        if (row.some((c, i) => !lenientCells.has(i) && String(c ?? '').length > MAX_CELL_LENGTH)) return fail(msg('Eine Zelle ist zu lang (maximal {max} Zeichen)', { max: MAX_CELL_LENGTH }));
        if (notes && notes.length > MAX_NOTES_LENGTH) return fail(msg('Notizen sind zu lang (maximal {max} Zeichen)', { max: MAX_NOTES_LENGTH }));

        const rawStatus = get(row, 'status') || OWNED_STATUS;
        const markRead = isLegacyReadStatus(rawStatus);
        const status = markRead ? OWNED_STATUS : STATUSES.find(s => s.toLowerCase() === rawStatus.toLowerCase());
        if (!status) return fail(msg('Unbekannter Status „{status}“', { status: rawStatus }));

        const price = parseAmount(get(row, 'price'));
        if (price.error) return fail(msg('Ungültiger Preis „{value}“', { value: get(row, 'price') }));
        const targetPrice = parseAmount(get(row, 'target_price'));
        if (targetPrice.error) return fail(msg('Ungültiger Zielpreis „{value}“', { value: get(row, 'target_price') }));
        const priority = parseCount(get(row, 'priority'), 3);
        if (priority.error) return fail(msg('Ungültige Priorität „{value}“ (0 bis 3)', { value: get(row, 'priority') }));

        const release = normalizeDate(get(row, 'release_date'));
        const purchase = normalizeDate(get(row, 'purchase_date'));
        if (release.error || purchase.error) return fail(msg('Ungültiges Datum (erwartet JJJJ, JJJJ-MM, JJJJ-MM-TT oder TT.MM.JJJJ)'));
        const releaseYearRaw = get(row, 'release_year');
        const releaseYear = parseCount(releaseYearRaw, 9999);
        if (releaseYear.error || (releaseYear.value !== null && releaseYear.value < 1000)) return fail(msg('Ungültiges Erscheinungsjahr „{value}“', { value: releaseYearRaw }));

        const pagesRaw = get(row, 'pages');
        const pages = parseCount(pagesRaw);
        if (pages.error) return fail(msg('Ungültige Seitenzahl „{value}“', { value: pagesRaw }));

        const isbnRaw = get(row, 'isbn');
        if (/^\d+(?:[.,]\d+)?E[+-]?\d+$/i.test(isbnRaw)) {
            return fail(msg('ISBN „{isbn}“ wurde von Excel als Zahl gespeichert (Spalte als Text formatieren)', { isbn: isbnRaw }));
        }
        const isbn = normalizeIsbn(isbnRaw) || null;
        if (isbn && !isValidIsbn(isbn)) warnings.push(rowNote(line, msg('ISBN „{isbn}“ ist keine gültige ISBN (wird trotzdem übernommen)', { isbn: isbnRaw })));

        let coverImage = get(row, 'cover_image') || null;
        if (coverImage && coverImage.length > MAX_URL_LENGTH) {
            warnings.push(ignoredValue(line, 'Band-Cover', shorten(coverImage), maxChars(MAX_URL_LENGTH)));
            coverImage = null;
        }
        const imagesRaw = get(row, 'images');
        let imageList = imagesRaw ? imagesRaw.split('|').map(s => s.trim()).filter(Boolean) : [];
        if (imageList.length > MAX_IMAGES) {
            warnings.push(ignoredValue(line, 'Bilder', msg('{count} Bilder', { count: imageList.length }), msg('maximal {max}', { max: MAX_IMAGES })));
            imageList = [];
        }
        for (const image of imageList.filter(s => s.length > MAX_URL_LENGTH)) {
            warnings.push(ignoredValue(line, 'Bilder', shorten(image), msg('maximal {max} Zeichen je Bild', { max: MAX_URL_LENGTH })));
        }
        imageList = imageList.filter(s => s.length <= MAX_URL_LENGTH);
        const volumeLanguageRaw = get(row, 'volume_language');
        const volumeLanguage = volumeLanguageRaw ? parseLanguage(volumeLanguageRaw) : null;
        if (volumeLanguageRaw && !volumeLanguage) warnings.push(ignoredValue(line, 'Bandsprache', shorten(volumeLanguageRaw)));
        const mpVolumeId = parseId(get(row, 'mp_volume_id'));
        if (mpVolumeId.error) return fail(msg('Ungültige MP-Band-ID „{value}“', { value: get(row, 'mp_volume_id') }));

        const ownersRaw = get(row, 'owners');
        const readersRaw = get(row, 'readers');
        for (const [raw, label] of [[ownersRaw, 'Besitzer'], [readersRaw, 'Gelesen von']]) {
            if (raw.length > MAX_NAMES_CELL_LENGTH || raw.split(/[,|]/).length > MAX_NAMES_PER_CELL) {
                return fail(msg('Spalte „{label}“ ist zu lang (maximal {names} Namen, {max} Zeichen)', { label, names: MAX_NAMES_PER_CELL, max: MAX_NAMES_CELL_LENGTH }));
            }
        }
        records.push({
            line, ...seriesFields,
            type, type_inferred: typeInferred, volume_number: identity.volume_number, label: volumeNumber, status: status, mark_read: markRead, isbn,
            price: price.value, target_price: targetPrice.value, priority: priority.value ?? 0,
            release_date: release.value, release_year: releaseYear.value, purchase_date: purchase.value,
            condition: get(row, 'condition') || null, pages: pages.value, notes,
            cover_image: coverImage, images: imageList.length ? JSON.stringify(imageList) : null, manga_passion_volume_id: mpVolumeId.value,
            language: volumeLanguage ? volumeLanguage.language : null,
            series_meta: seriesMeta,
            owners: ownersRaw.split(/[,|]/).map(s => s.trim()).filter(Boolean),
            owners_raw: ownersRaw,
            readers_raw: readersRaw
        });
    });
    return { records, errors, warnings, columns };
}

module.exports = {
    COLUMNS, SERIES_DETAIL_KEYS, SERIES_ROW_TYPE, COLLECTING_STATUSES, CsvFormatError, rowNote, toCsv, csvLines, joinCsv, parseCsv, mapCsvRows, matchKey, canonicalVolumeNumber, escapeCell, unescapeCell,
    guardFormulas, normalizeDate, parseAmount, parseCount, MAX_NOTES_LENGTH, MAX_CELL_LENGTH
};
