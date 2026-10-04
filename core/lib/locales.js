// Language settings of a user (PUT /auth/profile on the server and in the device core).
const { badRequest } = require('../errors');
const { isLanguageCode } = require('./language');

// UI languages (contract I18N-C); the frontend offers those that have a catalog
const UI_LOCALES = ['de', 'en', 'fr', 'es', 'it', 'pt-BR', 'nl', 'pl', 'ja', 'ko', 'zh-Hans', 'ru', 'tr'];

/** Canonical spelling of a supported UI locale ('EN' -> 'en', 'pt-br' -> 'pt-BR'), else null. */
function uiLocale(value) {
    if (typeof value !== 'string') return null;
    const wanted = value.trim().replace(/_/g, '-').toLowerCase();
    return UI_LOCALES.find((code) => code.toLowerCase() === wanted) || null;
}

/**
 * The changed fields of a profile body: locale (supported code, or null = follow the device) and
 * default_language (ISO 639-1). Throws 400 LOCALE_INVALID / LANGUAGE_INVALID / BAD_REQUEST.
 */
function parseProfileBody(body) {
    const out = {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Ungültige Anfrage');
    if (Object.prototype.hasOwnProperty.call(body, 'locale')) {
        const raw = body.locale;
        if (raw === null || raw === '') out.locale = null;
        else {
            const locale = uiLocale(raw);
            if (!locale) throw badRequest('Unbekannte Sprache', 'LOCALE_INVALID');
            out.locale = locale;
        }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'default_language')) {
        const raw = typeof body.default_language === 'string' ? body.default_language.trim().toLowerCase() : '';
        if (!isLanguageCode(raw)) throw badRequest('Ungültiger Sprachcode (zwei Buchstaben, z. B. de)', 'LANGUAGE_INVALID');
        out.default_language = raw;
    }
    if (!Object.keys(out).length) throw badRequest('Keine Änderung angegeben');
    return out;
}

/** Writes the parsed fields to the users row; returns { locale, default_language } as stored. */
function saveProfile(db, userId, fields) {
    const sets = Object.keys(fields).map((key) => `${key} = ?`);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...Object.values(fields), userId);
    return readProfile(db, userId);
}

/** { locale, default_language } of a user; defaults when the row is missing. */
function readProfile(db, userId) {
    const row = db.prepare('SELECT locale, default_language FROM users WHERE id = ?').get(userId);
    return { locale: row ? row.locale ?? null : null, default_language: (row && row.default_language) || 'de' };
}

module.exports = { UI_LOCALES, uiLocale, parseProfileBody, saveProfile, readProfile };
