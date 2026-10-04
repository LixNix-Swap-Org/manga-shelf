// Locale-aware formatting with cached Intl formatters (creating one per call costs about 40x the formatting itself).
// No React imports: the node:test suites load this module directly.
import { getLocaleTag, t, tn } from '../i18n/index.js';

/** Formatting locale of the UI language ('de-DE' until a language is chosen); the formatter cache is keyed by it. */
export function getLocale() {
  return getLocaleTag();
}

const cache = new Map();
function cached(kind, options, create) {
  const key = `${kind}|${getLocale()}|${JSON.stringify(options)}`;
  let formatter = cache.get(key);
  if (!formatter) {
    formatter = create(getLocale(), options);
    cache.set(key, formatter);
  }
  return formatter;
}

const numberFormat = (options) => cached('number', options, (locale, o) => new Intl.NumberFormat(locale, o));
const dateFormat = (options) => cached('date', options, (locale, o) => new Intl.DateTimeFormat(locale, o));
const relativeFormat = () => cached('relative', { style: 'short', numeric: 'always' }, (locale, o) => new Intl.RelativeTimeFormat(locale, o));

/** Number or numeric string; null for null, '' and anything non-numeric. */
export function toFiniteNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 1234.5 -> '1.234,5' (up to `digits` decimals); `fixed` always shows that many. '' for non-numeric input. */
export function formatNumber(value, digits = 0, { fixed = false } = {}) {
  const n = toFiniteNumber(value);
  if (n === null) return '';
  return numberFormat({ minimumFractionDigits: fixed ? digits : 0, maximumFractionDigits: digits }).format(n);
}

/** 7.5 / '7.5' -> '7,50 €' (no-break space); `empty` (default '') for null, '' or non-numeric input. */
export function formatEuro(value, { empty = '' } = {}) {
  return formatMoney(value, 'EUR', { empty });
}

/** Amount in the currency of an edition ('USD' -> '7,50 $' in German); an invalid code formats as euro. */
export function formatMoney(value, currency = 'EUR', { empty = '' } = {}) {
  const n = toFiniteNumber(value);
  if (n === null) return empty;
  const code = /^[A-Z]{3}$/.test(String(currency || '')) ? currency : 'EUR';
  try {
    return numberFormat({ style: 'currency', currency: code }).format(n);
  } catch (_) {
    return numberFormat({ style: 'currency', currency: 'EUR' }).format(n);
  }
}

/** Symbol of a currency in the UI locale ('EUR' -> '€', 'USD' -> '$' in German, 'US$' in en-GB); an invalid code is the euro's. */
export function currencySymbol(currency = 'EUR', locale = getLocale()) {
  const code = /^[A-Z]{3}$/.test(String(currency || '')) ? currency : 'EUR';
  try {
    const parts = cached('number', { style: 'currency', currency: code, locale }, () => new Intl.NumberFormat(locale, { style: 'currency', currency: code })).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value || code;
  } catch (_) {
    return code === 'EUR' ? '€' : code;
  }
}

/** '1 Band' / '1.234 Bände' / '0 Bände', chosen by Intl.PluralRules; other languages through the tn() pair. */
export function formatCount(value, singular, plural) {
  const n = toFiniteNumber(value) ?? 0;
  // i18n-dynamic: the extractor collects the pairs at the formatCount/countLabel call sites
  return `${formatNumber(n, 2)} ${tn(singular, plural, n)}`;
}

/** 12.5 -> '12,5%' (no space, as in the stats). */
export function formatPercent(value, digits = 1) {
  return `${formatNumber(toFiniteNumber(value) ?? 0, digits)}%`;
}

/** Bytes as megabytes with two decimals: '1,50 MB'. */
export function formatMegabytes(bytes) {
  return `${formatNumber((toFiniteNumber(bytes) ?? 0) / (1024 * 1024), 2, { fixed: true })} MB`;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH = /^(\d{4})-(\d{2})$/;

// local midnight: new Date('2026-11-12') would be UTC and show the day before west of Greenwich
const localDate = (y, m, d = 1) => {
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.getMonth() === Number(m) - 1 && date.getDate() === Number(d) ? date : null;
};

/**
 * Release-style dates: 'YYYY-MM-DD' -> '12.11.2026', 'YYYY-MM' -> '11/2026', 'YYYY' -> '2026'.
 * With { long: true }: 'Donnerstag, 12. November 2026' / 'November 2026'. Other text is returned trimmed, null as ''.
 */
export function formatDate(value, { long = false } = {}) {
  if (value === null || value === undefined) return '';
  const s = String(value).trim();
  let m = ISO_DAY.exec(s);
  if (m) {
    const date = localDate(m[1], m[2], m[3]);
    if (!date) return s;
    return dateFormat(long
      ? { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }
      : { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
  }
  m = ISO_MONTH.exec(s);
  if (m) {
    const date = localDate(m[1], m[2]);
    if (!date) return s;
    return dateFormat(long ? { month: 'long', year: 'numeric' } : { month: '2-digit', year: 'numeric' }).format(date);
  }
  return s;
}

/** Day.month (plus the year when it differs from `now`'s): '03.10.' or '31.12.2025'. */
export function formatDayMonth(date, now = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const withYear = d.getFullYear() !== now.getFullYear();
  return dateFormat(withYear ? { day: '2-digit', month: '2-digit', year: 'numeric' } : { day: '2-digit', month: '2-digit' }).format(d);
}

/** '14:05'. */
export function formatTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return dateFormat({ hour: '2-digit', minute: '2-digit' }).format(d);
}

/** '02.10.2026, 14:05' (medium date, short time); '' for an invalid date. */
export function formatDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return dateFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

/** '02.10.2026'; '' for an invalid date. */
export function formatDay(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return dateFormat({ day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

/** Month names in calendar order: style 'long' ('März') or 'short' ('Mär'). */
export function monthNames(style = 'long') {
  return cached('months', { style }, () => {
    const format = dateFormat({ month: style });
    return Object.freeze(Array.from({ length: 12 }, (_, i) => format.format(new Date(2000, i, 15))));
  });
}

/** 'YYYY-MM' -> 'März 2026' (style 'short': 'Mär 2026'); a month number 1-12 -> its name; anything else unchanged. */
export function formatMonth(value, { style = 'long', year = true } = {}) {
  if (typeof value === 'number') return monthNames(style)[value - 1] || String(value);
  const s = String(value ?? '');
  const m = /^(\d{4})-(\d{1,2})/.exec(s);
  const name = m ? monthNames(style)[Number(m[2]) - 1] : null;
  if (!name) return s;
  return year ? `${name} ${m[1]}` : name;
}

/** 'gerade eben', 'vor 5 Min.', 'vor 3 Std.', 'vor 1 Tag', 'vor 2 Tagen'; null for an unknown time. */
export function formatRelative(timestamp, now = Date.now()) {
  const ms = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  if (!ms || Number.isNaN(ms)) return null;
  const mins = Math.max(0, Math.floor((now - ms) / 60000));
  if (mins < 1) return t('gerade eben');
  if (mins < 60) return relativeFormat().format(-mins, 'minute');
  const days = Math.floor(mins / 1440);
  if (days < 1) return relativeFormat().format(-Math.floor(mins / 60), 'hour');
  return relativeFormat().format(-days, 'day');
}
