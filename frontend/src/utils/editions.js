// Editions in different languages (wave I18N-D): codes of a series, display names, the account's default edition
// language and the defaults of the add/edit forms. Stored values are ISO codes; names come from Intl.DisplayNames.
import languageLib from '../../../core/lib/language.js';
import { getLocaleTag } from '../i18n/index.js';

const { normalizeLanguage, normalizeRegion, normalizeCurrency, workKeyOfHit, DEFAULT_LANGUAGE, DEFAULT_CURRENCY, MP_LANGUAGE } = languageLib;
export { workKeyOfHit, DEFAULT_LANGUAGE, DEFAULT_CURRENCY };

// offered in the selects (any other stored code is added to the options of that form)
export const EDITION_LANGUAGES = ['de', 'en', 'ja', 'fr', 'it', 'es', 'pt', 'nl', 'pl', 'ko', 'zh', 'ru', 'tr', 'sv', 'da', 'no', 'fi', 'cs', 'hu'];
export const EDITION_REGIONS = ['DE', 'AT', 'CH', 'GB', 'US', 'CA', 'AU', 'FR', 'BE', 'IT', 'ES', 'MX', 'PT', 'BR', 'NL', 'PL', 'SE', 'DK', 'NO', 'FI', 'CZ', 'HU', 'TR', 'RU', 'JP', 'KR', 'CN', 'TW'];
export const EDITION_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD', 'PLN', 'SEK', 'DKK', 'NOK', 'CZK', 'HUF', 'TRY', 'BRL', 'MXN', 'KRW', 'CNY', 'TWD', 'RUB'];

const REGION_CURRENCY = {
  DE: 'EUR', AT: 'EUR', FR: 'EUR', BE: 'EUR', IT: 'EUR', ES: 'EUR', PT: 'EUR', NL: 'EUR', FI: 'EUR', IE: 'EUR', LU: 'EUR',
  CH: 'CHF', GB: 'GBP', US: 'USD', CA: 'CAD', AU: 'AUD', JP: 'JPY', PL: 'PLN', SE: 'SEK', DK: 'DKK', NO: 'NOK', CZ: 'CZK',
  HU: 'HUF', TR: 'TRY', BR: 'BRL', MX: 'MXN', KR: 'KRW', CN: 'CNY', TW: 'TWD', RU: 'RUB'
};

/** Edition language of a series or volume row as an ISO code; old names ('Deutsch') and empty values are read as codes. */
export const editionLanguage = (row) => normalizeLanguage(row?.language ?? null, DEFAULT_LANGUAGE);

/** Language of a volume: its own override, else the series language. */
export const volumeLanguage = (volume, manga) => (volume?.language ? normalizeLanguage(volume.language, editionLanguage(manga)) : editionLanguage(manga));

/** Currency code of a series ('EUR' when missing or invalid). */
export const editionCurrency = (row) => normalizeCurrency(row?.currency ?? '') || DEFAULT_CURRENCY;

export const editionRegion = (row) => normalizeRegion(row?.region ?? '');

/** Manga Passion only knows German editions: gaps, autofill and edition matching run for these only. */
export const isMpEdition = (row) => editionLanguage(row) === MP_LANGUAGE;

/** A volume of its own other language (even in a German series) gets no Manga Passion lookup either (409 MP_LANGUAGE). */
export const isMpVolume = (volume, manga) => isMpEdition(manga) && volumeLanguage(volume, manga) === MP_LANGUAGE;

const displayNames = new Map();
function displayName(type, code) {
  const key = `${getLocaleTag()}|${type}`;
  let names = displayNames.get(key);
  if (names === undefined) {
    try {
      names = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames([getLocaleTag()], { type, fallback: 'code' }) : null;
    } catch (_) {
      names = null;
    }
    displayNames.set(key, names);
  }
  try {
    return (names && names.of(code)) || code;
  } catch (_) {
    return code;
  }
}

/** 'en' -> 'Englisch' in a German UI, 'English' in an English one; the code itself without Intl.DisplayNames (Safari < 14.1). */
export const languageName = (code) => (code ? displayName('language', code) : '');
export const regionName = (code) => (code ? displayName('region', code) : '');
/** 'USD' -> 'US-Dollar' in a German UI. */
export const currencyName = (code) => (code ? displayName('currency', code) : '');

/** Two-letter label of the pill ('EN'); a region makes it 'EN-US'. */
export const editionCode = (language, region = null) => `${String(language || '').toUpperCase()}${region ? `-${region}` : ''}`;

/** 'Englisch (Vereinigte Staaten)' for the pill title and screen readers. */
export const editionName = (language, region = null) => (region ? `${languageName(language)} (${regionName(region)})` : languageName(language));

/** Region of the UI locale ('de-DE' -> 'DE'), offered as the default for an edition in the UI's own language. */
export function uiRegion() {
  const parts = String(getLocaleTag() || '').split('-');
  const region = parts.length > 1 ? parts[parts.length - 1] : '';
  return /^[A-Z]{2}$/.test(region) ? region : null;
}

/** Default region for an edition language: the UI locale's region when the languages match, else none. */
export function defaultRegionFor(language) {
  const uiLanguage = String(getLocaleTag() || '').split('-')[0].toLowerCase();
  return language && language === uiLanguage ? uiRegion() : null;
}

/** Currency of a region ('US' -> 'USD'); the euro when unknown. */
export const currencyForRegion = (region) => REGION_CURRENCY[normalizeRegion(region || '') || ''] || DEFAULT_CURRENCY;

/** Start values of the add form: the account's default language, the UI region for it and that region's currency. */
export function editionDefaults(language = getDefaultLanguage()) {
  const region = defaultRegionFor(language);
  return { language, region: region || '', currency: currencyForRegion(region) };
}

/** Options of a select: the offered list plus the current value when it is not in it. */
export const withCurrent = (list, value) => (value && !list.includes(value) ? [...list, value] : list);

/** Languages of a collection with their series counts, most used first: [{ code, count }]. */
export function availableLanguages(mangas) {
  const counts = new Map();
  for (const m of mangas || []) {
    const code = editionLanguage(m);
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/**
 * The other editions of a series: the detail's inline `editions`, else rows of the cached list with the same work_key
 * (offline copy of an older server). Never the series itself.
 */
export function editionsOf(manga, list = null) {
  if (!manga) return [];
  if (Array.isArray(manga.editions)) return manga.editions.filter((e) => e && String(e.id) !== String(manga.id));
  if (!manga.work_key || !Array.isArray(list)) return [];
  return list.filter((m) => m && m.work_key === manga.work_key && String(m.id) !== String(manga.id));
}

const titleKey = (text) => String(text || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();

/** "Ausgaben finden": series of the collection with the same title (or alternative title) and author, not linked yet. */
export function editionCandidates(manga, list) {
  if (!manga || !Array.isArray(list)) return [];
  const titles = new Set([titleKey(manga.title), titleKey(manga.alt_title)].filter(Boolean));
  const author = titleKey(manga.author);
  return list.filter((m) => m && String(m.id) !== String(manga.id)
    && !(manga.work_key && m.work_key === manga.work_key)
    && (titles.has(titleKey(m.title)) || (m.alt_title && titles.has(titleKey(m.alt_title))))
    && (!author || !m.author || titleKey(m.author) === author));
}

// the account's default edition language (users.default_language): the pill is hidden for it
let defaultLanguage = DEFAULT_LANGUAGE;
const listeners = new Set();

export const getDefaultLanguage = () => defaultLanguage;

/** App (after /auth/me) and the account dialog; an invalid value falls back to German. */
export function setDefaultLanguage(code) {
  const next = typeof code === 'string' && /^[a-z]{2}$/.test(code.trim().toLowerCase()) ? code.trim().toLowerCase() : DEFAULT_LANGUAGE;
  if (next === defaultLanguage) return;
  defaultLanguage = next;
  for (const listener of [...listeners]) listener(next);
}

export function subscribeDefaultLanguage(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
