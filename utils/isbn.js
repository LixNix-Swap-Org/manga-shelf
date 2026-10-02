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

module.exports = { normalizeIsbn, isbn13CheckDigit };
