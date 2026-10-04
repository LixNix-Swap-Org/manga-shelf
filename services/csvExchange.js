// CSV-Austausch: Export der Sammlung und Import aus einer solchen Datei. Reine Funktionen, keine DB.
const { normalizeIsbn, isValidIsbn } = require('../utils/isbn');
const { inferVolumeType } = require('../utils/volumeType');
const { isLegacyReadStatus, OWNED_STATUS } = require('../utils/owners');
const { canonicalVolumeNumber } = require('../utils/volumeNumber');

const DELIMITER = ';';
const STATUSES = ['Vorhanden', 'Fehlt', 'Vorbestellt', 'Erscheint bald', 'Bestellt'];
const TYPES = ['volume', 'special_edition', 'schuber', 'special'];
const MAX_AMOUNT = 99999;

// Reihenverlag = Verlag der Reihe, Verlag = abweichender Verlag des Bandes (leer = wie die Reihe).
// Besitzer bleibt die letzte Spalte.
const COLUMNS = [
    ['series', 'Reihe'], ['series_publisher', 'Reihenverlag'], ['publisher', 'Verlag'], ['author', 'Autor'], ['type', 'Typ'],
    ['volume_number', 'Bandnummer'], ['status', 'Status'], ['isbn', 'ISBN'], ['price', 'Preis'],
    ['target_price', 'Zielpreis'], ['priority', 'Priorität'], ['release_date', 'Erscheinungsdatum'],
    ['release_year', 'Erscheinungsjahr'], ['purchase_date', 'Kaufdatum'], ['condition', 'Zustand'],
    ['pages', 'Seiten'], ['notes', 'Notizen'], ['readers', 'Gelesen von'], ['owners', 'Besitzer']
];

// Grenzen für Benutzernamen-Zellen (Besitzer, Gelesen von)
const MAX_NAMES_CELL_LENGTH = 1000;
const MAX_NAMES_PER_CELL = 50;
// Wie POST/PUT /volumes. Der Formelschutz des Exports kann eine Zelle um bis zur Hälfte verlängern: Zellen bis
// 2 * MAX_NOTES_LENGTH + 2 sind daher noch kein Fehler der ganzen Datei, längere ein Fehler der Zeile.
const MAX_NOTES_LENGTH = 10000;
const MAX_CELL_LENGTH = 2 * MAX_NOTES_LENGTH + 2;

class CsvFormatError extends Error {
    constructor(message, line) {
        super(message);
        this.name = 'CsvFormatError';
        this.line = line;
        this.status = 400;
    }
}

/** Vergleichsschlüssel für Titel, Nummern und Namen: Unicode-sicher (NFC, volle Kleinschreibung), ohne Rand-Leerzeichen. */
const matchKey = (s) => String(s ?? '').trim().normalize('NFC').toLowerCase();


// Tabellenprogramme werten Zellen, die mit = + - @ (auch nach Tab/CR) beginnen, als Formel aus
const FORMULA_START = /^(?:[=+@\t\r]|-(?![\d.,]+$))/;
const needsFormulaGuard = (s) => FORMULA_START.test(s.replace(/^'+/, ''));
// Excel mit Komma als Listentrenner (en-US) teilt die Zeile an jedem Komma: dort beginnt dann eine eigene Zelle
const EMBEDDED_FORMULA = /,(\s*)('*)(?=[=+@\t\r]|-(?![\d.]+(?:,|$)))/g;
const EMBEDDED_GUARDED = /,(\s*)'('*)(?=[=+@\t\r]|-(?![\d.]+(?:,|$)))/g;

/** Setzt ein ' vor Formelzeichen am Zellanfang und nach jedem Komma; unescapeCell nimmt genau diese wieder heraus. */
function guardFormulas(value) {
    let s = value.replace(EMBEDDED_FORMULA, ",$1'$2");
    // Auch schon mit ' beginnende Werte bekommen eines dazu, damit der Import genau eines entfernen kann
    if (needsFormulaGuard(s)) s = "'" + s;
    return s;
}

function escapeCell(value) {
    const s = guardFormulas(value === null || value === undefined ? '' : String(value));
    return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Gegenstück zu guardFormulas: entfernt genau die vom Export eingefügten '. */
function unescapeCell(s) {
    const head = s.startsWith("'") && needsFormulaGuard(s.slice(1)) ? s.slice(1) : s;
    return head.replace(EMBEDDED_GUARDED, ',$1$2');
}

const formatAmount = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))
    ? v
    : String(Math.round(Number(v) * 100) / 100).replace('.', ','));

// Excel macht aus einer 13-stelligen Zahl 9,78355E+12; mit Bindestrich bleibt sie Text (der Import entfernt ihn wieder)
const formatIsbn = (v) => (typeof v === 'string' && /^\d{13}$/.test(v) ? `${v.slice(0, 3)}-${v.slice(3)}` : v);

const EXPORT_FORMATTERS = { price: formatAmount, target_price: formatAmount, isbn: formatIsbn };

/** rows: Objekte mit den Schlüsseln aus COLUMNS. Mit BOM, damit Excel UTF-8 erkennt. */
function toCsv(rows) {
    const lines = [COLUMNS.map(c => c[1]).join(DELIMITER)];
    for (const row of rows) {
        lines.push(COLUMNS.map(([key]) => {
            const format = EXPORT_FORMATTERS[key];
            return escapeCell(format ? format(row[key]) : row[key]);
        }).join(DELIMITER));
    }
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/** Trennzeichen aus der ersten nicht leeren Zeile, ohne den ganzen Text zu zerlegen. */
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

/**
 * Zerlegt CSV-Text in Zeilen von Zellen (Anführungszeichen, "" als Escape, ; oder , als Trenner).
 * Jede Zeile trägt in `row.line` (nicht aufzählbar) die Textzeile, in der sie beginnt; Leerzeilen und
 * Zeilenumbrüche in Zellen zählen mit. Ein nicht geschlossenes Anführungszeichen wirft CsvFormatError.
 * limits: { maxRows (Datenzeilen nach der Kopfzeile), maxCells (pro Zeile), maxCellLength }; wer eine Grenze
 * überschreitet, bekommt CsvFormatError, bevor der Rest der Datei in den Speicher gelesen wird.
 */
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
        if (cell.length > maxCellLength) throw new CsvFormatError(`Zelle in Zeile ${rowStart} ist zu lang (maximal ${maxCellLength} Zeichen)`, rowStart);
        if (row.length >= maxCells) throw new CsvFormatError(`Zeile ${rowStart} hat zu viele Spalten (maximal ${maxCells})`, rowStart);
        row.push(cell);
        cell = '';
    };
    const pushRow = () => {
        pushCell();
        if (row.some(c => c.trim() !== '')) {
            if (rows.length > maxRows) throw new CsvFormatError(`Zu viele Zeilen (maximal ${maxRows})`, rowStart);
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
    if (quoted) throw new CsvFormatError(`Anführungszeichen ab Zeile ${quoteStart} nicht geschlossen`, quoteStart);
    pushRow();
    return rows;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-zäöüß0-9]/g, '');
// Reihenfolge der Aliasse = Vorrang: spezifische Namen vor allgemeinen ("Titel" ist oft der Bandtitel)
const HEADER_ALIASES = {
    series: ['reihe', 'serie', 'series', 'titel', 'title'],
    series_publisher: ['reihenverlag', 'seriespublisher'],
    publisher: ['verlag', 'publisher', 'bandverlag'], author: ['autor', 'author'],
    type: ['typ', 'type'], volume_number: ['bandnummer', 'volumenumber', 'nummer', 'band', 'volume'],
    status: ['status'], isbn: ['isbn'], price: ['preis', 'price'],
    target_price: ['zielpreis', 'targetprice', 'wunschpreis'], priority: ['priorität', 'prioritaet', 'prioritat', 'priority', 'prio'],
    release_date: ['erscheinungsdatum', 'releasedate'], release_year: ['erscheinungsjahr', 'releaseyear'],
    purchase_date: ['kaufdatum', 'purchasedate'], condition: ['zustand', 'condition'], pages: ['seiten', 'pages'],
    notes: ['notizen', 'notes'], readers: ['gelesenvon', 'readby', 'readers'], owners: ['besitzer', 'owners', 'owner']
};
const SERIES_KEYS = new Set(['series', 'series_publisher', 'publisher', 'author']);

const TYPE_ALIASES = {
    volume: 'volume', einzelband: 'volume', band: 'volume',
    specialedition: 'special_edition', collectorsedition: 'special_edition', limitededition: 'special_edition',
    schuber: 'schuber', special: 'special', extra: 'special', sonderband: 'special'
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
 * Datum aus einer CSV-Zelle: JJJJ, JJJJ-M(M), JJJJ-MM-TT, TT.MM.JJJJ, MM.JJJJ, MM/JJJJ und Excels Monatsform
 * ("Mrz 25", "März 2025"). Ergebnis ist JJJJ, JJJJ-MM oder JJJJ-MM-TT mit Bereichsprüfung, sonst { error }.
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

/** Betrag in Euro: "6,95", "6.95", "€ 7" (höchstens zwei Nachkommastellen, bis 99999), leer = null. */
function parseAmount(v) {
    const s = String(v ?? '').replace(/[€\s]/g, '');
    if (!s) return { value: null };
    if (!/^\d{1,5}(?:[.,]\d{1,2})?$/.test(s)) return { error: true };
    const value = Number(s.replace(',', '.'));
    return value > MAX_AMOUNT ? { error: true } : { value };
}

/** Ganze Zahl 0..max ohne Vorzeichen, Exponent oder Anhängsel; leer = null. */
function parseCount(v, max = MAX_AMOUNT) {
    const s = String(v ?? '').trim();
    if (!s) return { value: null };
    if (!/^\d{1,5}$/.test(s)) return { error: true };
    const value = Number(s);
    return value > max ? { error: true } : { value };
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

/**
 * Wandelt geparste CSV-Zeilen in geprüfte Datensätze um.
 * Liefert { records, errors, warnings: [{ line, message }], columns }. `line` ist die Textzeile aus parseCsv
 * (Kopfzeile meist 1); bei Zeilen ohne diese Angabe zählt die Position, Kopfzeile = 1.
 * Eine Zeile mit Reihe, aber ohne Bandnummer und ohne Banddaten legt nur die Reihe an (series_only).
 * Fehler, deren Band sich schon bestimmen ließ, tragen ihn in `error.record` (nicht aufzählbar), damit der Import
 * Zeilen, die ohnehin übersprungen würden, nicht als Fehler meldet.
 */
function mapCsvRows(rows) {
    if (!rows.length) return { records: [], errors: [{ line: 1, message: 'Datei ist leer' }], warnings: [], columns: [] };
    const index = resolveColumns(rows[0].map(norm));
    const columns = Object.keys(index);
    if (index.series === undefined || index.volume_number === undefined) {
        return { records: [], errors: [{ line: rows[0].line ?? 1, message: 'Kopfzeile braucht mindestens die Spalten „Reihe“ und „Bandnummer“' }], warnings: [], columns };
    }
    const get = (row, key) => (index[key] === undefined ? '' : unescapeCell(String(row[index[key]] ?? '').trim()).trim());
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
        if (series && !volumeNumber && columns.every(key => SERIES_KEYS.has(key) || key === 'volume_number' || !get(row, key))) {
            if (series.length > 300) return errors.push({ line, message: 'Reihe oder Bandnummer ist zu lang' });
            return records.push({ line, series_only: true, ...seriesFields });
        }
        if (!series || !volumeNumber) return errors.push({ line, message: 'Reihe und Bandnummer sind Pflicht' });
        if (series.length > 300 || volumeNumber.length > 80) return errors.push({ line, message: 'Reihe oder Bandnummer ist zu lang' });

        const notes = get(row, 'notes') || null;
        const rawType = get(row, 'type');
        const typeInferred = !rawType;
        const type = typeInferred
            ? inferVolumeType({ volume_number: volumeNumber, notes })
            : (TYPES.includes(rawType) ? rawType : TYPE_ALIASES[norm(rawType)]);
        if (!type) return errors.push({ line, message: `Unbekannter Typ „${rawType}“` });

        const identity = { ...seriesFields, type, type_inferred: typeInferred, volume_number: canonicalVolumeNumber(volumeNumber, type) };
        const fail = (message) => {
            const err = { line, message };
            Object.defineProperty(err, 'record', { value: identity, enumerable: false });
            errors.push(err);
        };

        if (row.some(c => String(c ?? '').length > MAX_CELL_LENGTH)) return fail(`Eine Zelle ist zu lang (maximal ${MAX_CELL_LENGTH} Zeichen)`);
        if (notes && notes.length > MAX_NOTES_LENGTH) return fail(`Notizen sind zu lang (maximal ${MAX_NOTES_LENGTH} Zeichen)`);

        const rawStatus = get(row, 'status') || OWNED_STATUS;
        const markRead = isLegacyReadStatus(rawStatus);
        const status = markRead ? OWNED_STATUS : STATUSES.find(s => s.toLowerCase() === rawStatus.toLowerCase());
        if (!status) return fail(`Unbekannter Status „${rawStatus}“`);

        const price = parseAmount(get(row, 'price'));
        if (price.error) return fail(`Ungültiger Preis „${get(row, 'price')}“`);
        const targetPrice = parseAmount(get(row, 'target_price'));
        if (targetPrice.error) return fail(`Ungültiger Zielpreis „${get(row, 'target_price')}“`);
        const priority = parseCount(get(row, 'priority'), 3);
        if (priority.error) return fail(`Ungültige Priorität „${get(row, 'priority')}“ (0 bis 3)`);

        const release = normalizeDate(get(row, 'release_date'));
        const purchase = normalizeDate(get(row, 'purchase_date'));
        if (release.error || purchase.error) return fail('Ungültiges Datum (erwartet JJJJ, JJJJ-MM, JJJJ-MM-TT oder TT.MM.JJJJ)');
        const releaseYearRaw = get(row, 'release_year');
        const releaseYear = parseCount(releaseYearRaw, 9999);
        if (releaseYear.error || (releaseYear.value !== null && releaseYear.value < 1000)) return fail(`Ungültiges Erscheinungsjahr „${releaseYearRaw}“`);

        const pagesRaw = get(row, 'pages');
        const pages = parseCount(pagesRaw);
        if (pages.error) return fail(`Ungültige Seitenzahl „${pagesRaw}“`);

        const isbnRaw = get(row, 'isbn');
        if (/^\d+(?:[.,]\d+)?E[+-]?\d+$/i.test(isbnRaw)) {
            return fail(`ISBN „${isbnRaw}“ wurde von Excel als Zahl gespeichert (Spalte als Text formatieren)`);
        }
        const isbn = normalizeIsbn(isbnRaw) || null;
        if (isbn && !isValidIsbn(isbn)) warnings.push({ line, message: `ISBN „${isbnRaw}“ ist keine gültige ISBN (wird trotzdem übernommen)` });

        const ownersRaw = get(row, 'owners');
        const readersRaw = get(row, 'readers');
        for (const [raw, label] of [[ownersRaw, 'Besitzer'], [readersRaw, 'Gelesen von']]) {
            if (raw.length > MAX_NAMES_CELL_LENGTH || raw.split(/[,|]/).length > MAX_NAMES_PER_CELL) {
                return fail(`Spalte „${label}“ ist zu lang (maximal ${MAX_NAMES_PER_CELL} Namen, ${MAX_NAMES_CELL_LENGTH} Zeichen)`);
            }
        }
        records.push({
            line, ...seriesFields,
            type, type_inferred: typeInferred, volume_number: identity.volume_number, status: status, mark_read: markRead, isbn,
            price: price.value, target_price: targetPrice.value, priority: priority.value ?? 0,
            release_date: release.value, release_year: releaseYear.value, purchase_date: purchase.value,
            condition: get(row, 'condition') || null, pages: pages.value, notes,
            owners: ownersRaw.split(/[,|]/).map(s => s.trim()).filter(Boolean),
            owners_raw: ownersRaw,
            readers_raw: readersRaw
        });
    });
    return { records, errors, warnings, columns };
}

module.exports = {
    COLUMNS, CsvFormatError, toCsv, parseCsv, mapCsvRows, matchKey, canonicalVolumeNumber, escapeCell, unescapeCell,
    guardFormulas, normalizeDate, parseAmount, parseCount, MAX_NOTES_LENGTH, MAX_CELL_LENGTH
};
