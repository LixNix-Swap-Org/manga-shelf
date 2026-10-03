// ISBN helpers: one canonical stored form (digits only, ISBN-13) so that barcode scans, manual input
// and Manga Passion / DNB data all compare equal ("978-3-551-74581-1", "9783551745811" and the
// ISBN-10 "3551745811" are the same book).

/** ISBN-13 check digit for the first 12 digits. */
function isbn13CheckDigit(first12) {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
    return String((10 - (sum % 10)) % 10);
}

/**
 * Returns the canonical ISBN-13 for valid-looking input, otherwise the input stripped of hyphens/spaces
 * (never throws away what the user typed), or null for empty input.
 */
function normalizeIsbn(value) {
    if (value === undefined || value === null) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    const compact = raw.replace(/[\s-]/g, '').toUpperCase();
    if (/^\d{13}$/.test(compact)) return compact;
    if (/^\d{9}[\dX]$/.test(compact)) {
        const first12 = '978' + compact.slice(0, 9);
        return first12 + isbn13CheckDigit(first12);
    }
    return compact || null;
}

/**
 * True for a real ISBN: 13 digits starting with 978/979 with a correct check digit, or 10 characters with a correct
 * ISBN-10 check digit. Hyphens and spaces are ignored. A misread barcode (or an EAN that is no book) is false.
 */
function isValidIsbn(value) {
    const compact = String(value ?? '').replace(/[\s-]/g, '').toUpperCase();
    if (/^\d{13}$/.test(compact)) {
        return /^97[89]/.test(compact) && isbn13CheckDigit(compact.slice(0, 12)) === compact[12];
    }
    if (/^\d{9}[\dX]$/.test(compact)) {
        let sum = 0;
        for (let i = 0; i < 10; i++) sum += (compact[i] === 'X' ? 10 : Number(compact[i])) * (10 - i);
        return sum % 11 === 0;
    }
    return false;
}

module.exports = { normalizeIsbn, isbn13CheckDigit, isValidIsbn };
