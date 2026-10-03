// CSV-Austausch: Export der Sammlung und Import aus einer solchen Datei. Reine Funktionen, keine DB.
const { normalizeIsbn } = require('../utils/isbn');

const DELIMITER = ';';
const STATUSES = ['Vorhanden', 'Fehlt', 'Vorbestellt', 'Erscheint bald', 'Bestellt', 'Gelesen'];
const TYPES = ['volume', 'special_edition', 'schuber', 'special'];

const COLUMNS = [
    ['series', 'Reihe'], ['publisher', 'Verlag'], ['author', 'Autor'], ['type', 'Typ'],
    ['volume_number', 'Bandnummer'], ['status', 'Status'], ['isbn', 'ISBN'], ['price', 'Preis'],
    ['release_date', 'Erscheinungsdatum'], ['purchase_date', 'Kaufdatum'], ['condition', 'Zustand'],
    ['pages', 'Seiten'], ['notes', 'Notizen']
];

function escapeCell(value) {
    let s = value === null || value === undefined ? '' : String(value);
    // Excel führt Zellen aus, die mit = + - @ beginnen, als Formel aus
    if (/^[=+@]/.test(s) || /^-(?![\d.,]+$)/.test(s)) s = "'" + s;
    return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** rows: Objekte mit den Schlüsseln aus COLUMNS. Mit BOM, damit Excel UTF-8 erkennt. */
function toCsv(rows) {
    const lines = [COLUMNS.map(c => c[1]).join(DELIMITER)];
    for (const row of rows) {
        lines.push(COLUMNS.map(([key]) => {
            const v = key === 'price' && row[key] != null ? String(row[key]).replace('.', ',') : row[key];
            return escapeCell(v);
        }).join(DELIMITER));
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Zerlegt CSV-Text in Zeilen von Zellen (Anführungszeichen, "" als Escape, ; oder , als Trenner). */
function parseCsv(text) {
    let src = String(text || '').replace(/^\uFEFF/, '');
    const firstLine = src.split(/\r?\n/, 1)[0] || '';
    const delim = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (quoted) {
            if (ch === '"') {
                if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
            } else cell += ch;
        } else if (ch === '"' && cell === '') quoted = true;
        else if (ch === delim) { row.push(cell); cell = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && src[i + 1] === '\n') i++;
            row.push(cell); cell = '';
            if (row.some(c => c.trim() !== '')) rows.push(row);
            row = [];
        } else cell += ch;
    }
    row.push(cell);
    if (row.some(c => c.trim() !== '')) rows.push(row);
    return rows;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-zäöüß0-9]/g, '');
const HEADER_ALIASES = {
    series: ['reihe', 'serie', 'series', 'titel', 'title'], publisher: ['verlag', 'publisher'], author: ['autor', 'author'],
    type: ['typ', 'type'], volume_number: ['bandnummer', 'band', 'nummer', 'volumenumber', 'volume'],
    status: ['status'], isbn: ['isbn'], price: ['preis', 'price'], release_date: ['erscheinungsdatum', 'releasedate'],
    purchase_date: ['kaufdatum', 'purchasedate'], condition: ['zustand', 'condition'], pages: ['seiten', 'pages'],
    notes: ['notizen', 'notes']
};

const TYPE_ALIASES = {
    volume: 'volume', einzelband: 'volume', band: 'volume',
    specialedition: 'special_edition', collectorsedition: 'special_edition', limitededition: 'special_edition',
    schuber: 'schuber', special: 'special', extra: 'special', sonderband: 'special'
};

function cleanDate(v) {
    const s = String(v || '').trim();
    if (!s) return { value: null };
    let m = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
    if (m) return { value: s };
    m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) return { value: `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` };
    return { error: true };
}

/**
 * Wandelt geparste CSV-Zeilen in geprüfte Datensätze um.
 * Liefert { records, errors: [{ line, message }] }; Zeilennummern zählen die Kopfzeile als 1.
 */
function mapCsvRows(rows) {
    if (!rows.length) return { records: [], errors: [{ line: 1, message: 'Datei ist leer' }] };
    const headers = rows[0].map(norm);
    const index = {};
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
        const i = headers.findIndex(h => aliases.includes(h));
        if (i >= 0) index[key] = i;
    }
    if (index.series === undefined || index.volume_number === undefined) {
        return { records: [], errors: [{ line: 1, message: 'Kopfzeile braucht mindestens die Spalten „Reihe“ und „Bandnummer“' }] };
    }
    const get = (row, key) => (index[key] === undefined ? '' : String(row[index[key]] ?? '').trim());
    const records = [];
    const errors = [];
    rows.slice(1).forEach((row, n) => {
        const line = n + 2;
        const series = get(row, 'series');
        const volumeNumber = get(row, 'volume_number');
        if (!series || !volumeNumber) return errors.push({ line, message: 'Reihe und Bandnummer sind Pflicht' });
        if (series.length > 300 || volumeNumber.length > 80) return errors.push({ line, message: 'Reihe oder Bandnummer ist zu lang' });
        const status = get(row, 'status') || 'Vorhanden';
        const statusMatch = STATUSES.find(s => s.toLowerCase() === status.toLowerCase());
        if (!statusMatch) return errors.push({ line, message: `Unbekannter Status „${status}“` });
        const rawType = get(row, 'type');
        const type = rawType ? (TYPES.includes(rawType) ? rawType : TYPE_ALIASES[norm(rawType)]) : 'volume';
        if (!type) return errors.push({ line, message: `Unbekannter Typ „${rawType}“` });
        const priceRaw = get(row, 'price').replace(/[€\s]/g, '').replace(',', '.');
        const price = priceRaw === '' ? null : Number(priceRaw);
        if (price !== null && (!Number.isFinite(price) || price < 0)) return errors.push({ line, message: `Ungültiger Preis „${get(row, 'price')}“` });
        const release = cleanDate(get(row, 'release_date'));
        const purchase = cleanDate(get(row, 'purchase_date'));
        if (release.error || purchase.error) return errors.push({ line, message: 'Ungültiges Datum (erwartet JJJJ-MM-TT oder TT.MM.JJJJ)' });
        const pagesRaw = get(row, 'pages');
        const pages = pagesRaw === '' ? null : parseInt(pagesRaw, 10);
        if (pages !== null && (!Number.isInteger(pages) || pages < 0)) return errors.push({ line, message: `Ungültige Seitenzahl „${pagesRaw}“` });
        records.push({
            line, series, publisher: get(row, 'publisher') || null, author: get(row, 'author') || null,
            type, volume_number: volumeNumber, status: statusMatch, isbn: normalizeIsbn(get(row, 'isbn')) || null,
            price, release_date: release.value, purchase_date: purchase.value,
            condition: get(row, 'condition') || null, pages, notes: get(row, 'notes') || null
        });
    });
    return { records, errors };
}

module.exports = { COLUMNS, toCsv, parseCsv, mapCsvRows };
