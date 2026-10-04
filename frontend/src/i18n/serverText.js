// Server error texts in the UI language. German: always the server's own text, byte for byte. Other languages:
// a text the client owns for the code, else the template (msg/params) of a dynamic message, else the catalog entry
// of the exact German text, else the German text itself.
import { getLanguage, SOURCE_LANGUAGE, t } from './index.js';
import { formatNumber } from '../utils/format.js';

// i18n
export const CODE_TEXTS = {
  AUTH_REQUIRED: 'Nicht angemeldet',
  SESSION_INVALID: 'Sitzung abgelaufen oder ungültig – bitte neu anmelden',
  READ_ONLY: 'Nur Lesezugriff für Besucher/Gäste gestattet',
  NOT_AVAILABLE_LOCALLY: 'Im Modus ohne Server nicht verfügbar'
};

// numbers get the UI number format; plain strings are user content (titles, names, paths) and stay as sent; only a
// nested message ({ msg, params }: enum value, field name, a cause inside a sentence) is translated
function localParams(params, depth = 0) {
  const out = {};
  if (!params || typeof params !== 'object') return out;
  for (const [name, value] of Object.entries(params)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[name] = formatNumber(value, 2);
    else if (typeof value === 'string') out[name] = value;
    // i18n-dynamic: a server template, collected from the server sources
    else if (value && typeof value === 'object' && typeof value.msg === 'string' && depth < 3) out[name] = t(value.msg, localParams(value.params, depth + 1));
    else if (value !== null && value !== undefined) out[name] = String(value);
  }
  return out;
}

/** UI text of a server error body ({ error, code, msg?, params? }); '' when it has none. */
export function serverText(body) {
  const error = typeof body?.error === 'string' && body.error.trim() ? body.error : '';
  if (!error || getLanguage() === SOURCE_LANGUAGE) return error;
  const code = typeof body.code === 'string' ? body.code : '';
  if (code && Object.prototype.hasOwnProperty.call(CODE_TEXTS, code) && CODE_TEXTS[code] === error) return t(CODE_TEXTS[code]);
  // a hidden 500 never shows its template, even when the server still sends one
  if (code !== 'INTERNAL_ERROR' && typeof body.msg === 'string' && body.msg) return t(body.msg, localParams(body.params));
  return t(error);
}

/**
 * UI text of a text inside a 2xx payload: `body[field]`, or with `index` the entry `body[field][index]` (a string or
 * { message }); '' when there is none. German: the server's text unchanged. Other languages: the template in
 * `<field>_msg` (for lists an array parallel to the field), else the catalog entry of the exact German text, else the
 * text itself. List entries beyond a sent `<field>_msg` array were added by the client in the UI language already.
 */
export function payloadText(body, field, index) {
  const value = body?.[field];
  const entry = index === undefined ? value : Array.isArray(value) ? value[index] : undefined;
  const text = typeof entry === 'string' ? entry : typeof entry?.message === 'string' ? entry.message : '';
  if (!text || getLanguage() === SOURCE_LANGUAGE) return text;
  const data = body[`${field}_msg`];
  const template = index === undefined ? data : Array.isArray(data) ? data[index] : undefined;
  // i18n-dynamic: a server template, collected from the server sources
  if (template && typeof template.msg === 'string' && template.msg) return t(template.msg, localParams(template.params));
  if (index !== undefined && Array.isArray(data) && index >= data.length) return text;
  // i18n-dynamic: the exact German server text
  return t(text);
}
