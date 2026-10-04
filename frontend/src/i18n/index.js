// Translation core: the German source text is the key (gettext style); German needs no catalog.
// React-free and free of window access at import: node tests load utils/format.js, which imports this module.

export const LOCALE_KEY = 'mangashelf_locale';
export const SOURCE_LANGUAGE = 'de';

/** UI languages with a catalog, each in its own name; `tag` is the formatting locale. */
// i18n-ignore: the names are autonyms and never translated
export const LANGUAGES = Object.freeze([
  Object.freeze({ code: 'de', name: 'Deutsch', tag: 'de-DE' }),
  Object.freeze({ code: 'en', name: 'English', tag: 'en-GB' }),
  Object.freeze({ code: 'fr', name: 'Français', tag: 'fr-FR' }),
  Object.freeze({ code: 'es', name: 'Español', tag: 'es-ES' }),
  Object.freeze({ code: 'it', name: 'Italiano', tag: 'it-IT' }),
  Object.freeze({ code: 'pt-BR', name: 'Português (Brasil)', tag: 'pt-BR' }),
  Object.freeze({ code: 'nl', name: 'Nederlands', tag: 'nl-NL' }),
  Object.freeze({ code: 'pl', name: 'Polski', tag: 'pl-PL' }),
  Object.freeze({ code: 'ja', name: '日本語', tag: 'ja-JP' }),
  Object.freeze({ code: 'ko', name: '한국어', tag: 'ko-KR' }),
  Object.freeze({ code: 'zh-Hans', name: '简体中文', tag: 'zh-CN' }),
  Object.freeze({ code: 'ru', name: 'Русский', tag: 'ru-RU' }),
  Object.freeze({ code: 'tr', name: 'Türkçe', tag: 'tr-TR' })
]);

// languages with a translated PWA manifest (public/manifest.<code>.json)
const MANIFESTS = new Set(['en', 'fr', 'es', 'it', 'pt-BR', 'nl', 'pl', 'ja', 'ko', 'zh-Hans', 'ru', 'tr']);

// one lazy chunk per catalog (static paths, so Vite emits each as its own chunk); German has none
const LOADERS = {
  en: () => import('./locales/en.json'),
  fr: () => import('./locales/fr.json'),
  es: () => import('./locales/es.json'),
  it: () => import('./locales/it.json'),
  'pt-BR': () => import('./locales/pt-BR.json'),
  nl: () => import('./locales/nl.json'),
  pl: () => import('./locales/pl.json'),
  ja: () => import('./locales/ja.json'),
  ko: () => import('./locales/ko.json'),
  'zh-Hans': () => import('./locales/zh-Hans.json'),
  ru: () => import('./locales/ru.json'),
  tr: () => import('./locales/tr.json')
};

let language = SOURCE_LANGUAGE;
let localeTag = 'de-DE';
let catalog = null;
const listeners = new Set();
const warned = new Set();
const pluralCache = new Map();
const numberCache = new Map();

export const isAvailable = (code) => LANGUAGES.some((l) => l.code === code);
export const getLanguage = () => language;
export const getLocaleTag = () => localeTag;

const primary = (tag) => String(tag || '').toLowerCase().split(/[-_]/)[0];

/** Nearest available language for a list of BCP-47 tags: exact tag, then primary subtag; null when none fits. */
export function matchLanguage(tags) {
  for (const raw of Array.isArray(tags) ? tags : [tags]) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const tag = raw.trim().replace(/_/g, '-').toLowerCase();
    const exact = LANGUAGES.find((l) => l.code.toLowerCase() === tag);
    if (exact) return exact.code;
    const near = LANGUAGES.find((l) => primary(l.code) === primary(tag));
    if (near) return near.code;
  }
  return null;
}

/** Formatting tag: English follows the region of an en-<REGION> device language, else the table entry. */
export function localeTagFor(code, deviceLanguage) {
  const entry = LANGUAGES.find((l) => l.code === code);
  if (!entry) {
    // only tests reach this (setLanguage takes available codes): a valid tag formats as itself
    try { return Intl.getCanonicalLocales(code)[0] || 'de-DE'; } catch (_) { return 'de-DE'; }
  }
  const device = typeof deviceLanguage === 'string' ? deviceLanguage.replace(/_/g, '-') : '';
  if (code === 'en' && /^en-[A-Za-z]{2}$/.test(device)) return `en-${device.slice(3).toUpperCase()}`;
  return entry.tag;
}

function deviceLanguages(env) {
  if (env?.languages) return env.languages;
  const desktop = typeof window !== 'undefined' ? window.mangashelfDesktop?.locale : null;
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const list = [];
  if (typeof desktop === 'string' && desktop) list.push(desktop);
  if (Array.isArray(nav?.languages)) list.push(...nav.languages);
  if (typeof nav?.language === 'string') list.push(nav.language);
  return list;
}

const firstDeviceLanguage = (env) => deviceLanguages(env).find((l) => typeof l === 'string' && l) || '';

function storage() {
  try { return globalThis.localStorage ?? null; } catch (_) { return null; }
}

/** The language the user chose on this device (mirror of users.locale), or null: follow the device. */
export function getStoredLanguage() {
  try {
    const value = storage()?.getItem(LOCALE_KEY);
    return value && isAvailable(value) ? value : null;
  } catch (_) {
    return null;
  }
}

function storeLanguage(code) {
  try {
    if (code) storage()?.setItem(LOCALE_KEY, code);
    else storage()?.removeItem(LOCALE_KEY);
  } catch (_) { /* storage unavailable */ }
}

/** Device default: the first device language with a catalog, else German. */
export const deviceLanguage = (env) => matchLanguage(deviceLanguages(env)) || SOURCE_LANGUAGE;

async function loadCatalog(code) {
  if (code === SOURCE_LANGUAGE) return null;
  const load = LOADERS[code];
  if (!load) return null;
  const mod = await load();
  // an empty module: the stale-chunk handler swallowed the failed import and reloads the page
  if (!mod) throw new Error('catalog chunk not loaded');
  return mod.default ?? mod;
}

function applyDocument(code) {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.lang = code;
  // only languages with a public/manifest.<code>.json; the base path of the build stays as it is
  const link = document.querySelector?.('link[rel="manifest"]');
  const href = link?.getAttribute('href');
  if (href) link.setAttribute('href', href.replace(/manifest(\.[A-Za-z-]+)?\.json/, MANIFESTS.has(code) ? `manifest.${code}.json` : 'manifest.json'));
}

function commit(code, nextCatalog, env) {
  language = code;
  catalog = nextCatalog;
  localeTag = localeTagFor(code, firstDeviceLanguage(env));
  applyDocument(code);
  for (const listener of [...listeners]) listener(code);
}

/**
 * Switches the UI language: the catalog loads first, then state, <html lang> and the manifest link change at once.
 * `persist`: true stores it as this device's choice, null clears the choice (follow the device), false leaves it.
 */
export async function setLanguage(code, { persist = true, env } = {}) {
  const next = isAvailable(code) ? code : SOURCE_LANGUAGE;
  let nextCatalog = null;
  try {
    nextCatalog = await loadCatalog(next);
  } catch (err) {
    if (typeof console !== 'undefined') console.warn('[i18n] Katalog nicht geladen:', next, err?.message || err);
    return language;
  }
  if (persist === true) storeLanguage(next);
  else if (persist === null) storeLanguage(null);
  if (next !== language || nextCatalog !== catalog) commit(next, nextCatalog, env);
  return language;
}

/** Back to the device language and forget this device's choice. */
export const followDevice = (options = {}) => setLanguage(deviceLanguage(options.env), { ...options, persist: null });

/** Boot only (main.jsx): stored choice, then the device languages, then German. Never runs on import. */
export function initI18n(options = {}) {
  const code = getStoredLanguage() || deviceLanguage(options.env);
  return setLanguage(code, { persist: false, env: options.env });
}

/** Listener gets the new language code; returns the unsubscribe function. */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// like JSX children: null, undefined and booleans render as nothing; an unknown name stays visible
function interpolate(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return whole;
    const value = vars[name];
    return value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
  });
}

// a server list template ('{v0}, {v1}') has no words to translate
const PLACEHOLDERS_ONLY = /^\{\w+\}(, \{\w+\})*$/;

function missing(key) {
  if (!import.meta.env?.DEV || import.meta.env.MODE === 'test' || warned.has(key) || PLACEHOLDERS_ONLY.test(key)) return;
  warned.add(key);
  console.warn(`[i18n] ${language}: keine Übersetzung für "${key}"`);
}

function lookup(key) {
  if (language === SOURCE_LANGUAGE || !catalog) return undefined;
  const value = catalog[key];
  if (value === undefined || value === '' || value === null) {
    missing(key);
    return undefined;
  }
  return value;
}

/** Text in the current language; `{name}` placeholders are filled from `vars`. Unknown keys fall back to German. */
export function t(source, vars) {
  const text = typeof source === 'string' ? source : String(source ?? '');
  const value = lookup(text);
  return interpolate(typeof value === 'string' ? value : text, vars);
}

/** Context form for a source text that needs two translations: key `context::source`. */
export function tc(context, source, vars) {
  const value = lookup(`${context}::${source}`);
  return typeof value === 'string' ? interpolate(value, vars) : t(source, vars);
}

/** Identity marker: the extractor collects the literal, the caller translates later with t(). */
export const msg = (source) => source;

function pluralCategory(n) {
  let rules = pluralCache.get(localeTag);
  if (!rules) {
    rules = new Intl.PluralRules(localeTag);
    pluralCache.set(localeTag, rules);
  }
  return rules.select(n);
}

function formatN(n) {
  let format = numberCache.get(localeTag);
  if (!format) {
    format = new Intl.NumberFormat(localeTag, { maximumFractionDigits: 2 });
    numberCache.set(localeTag, format);
  }
  return format.format(n);
}

export const pluralKey = (singular, plural) => `${singular}|${plural}`;

/**
 * Plural form for n: German picks singular/plural, other languages any category of Intl.PluralRules
 * (zero/one/two/few/many/other; missing ones fall back to other). `{n}` defaults to the formatted number.
 */
export function tn(singular, plural, n, vars) {
  const count = Number(n);
  const category = pluralCategory(Number.isFinite(count) ? count : 0);
  const fill = { n: Number.isFinite(count) ? formatN(count) : String(n), ...(vars || {}) };
  const entry = lookup(pluralKey(singular, plural));
  if (entry && typeof entry === 'object') {
    const form = entry[category] ?? entry.other;
    if (typeof form === 'string' && form) return interpolate(form, fill);
  }
  return interpolate(category === 'one' ? singular : plural, fill);
}

/**
 * Splits a translated sentence at its placeholders: strings and the raw `vars` values (React nodes stay objects).
 * i18n/react.jsx rich() renders the parts.
 */
export function richParts(source, vars = {}) {
  const text = t(source);
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(/\{(\w+)\}/g)) {
    if (!Object.prototype.hasOwnProperty.call(vars, match[1])) continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(vars[match[1]]);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Tests only: a catalog without the lazy import (null = back to German). */
export function __setCatalogForTests(code, nextCatalog, env) {
  if (!code || code === SOURCE_LANGUAGE) commit(SOURCE_LANGUAGE, null, env);
  else commit(code, nextCatalog || {}, env);
}

/** Tests only: German without a catalog, warnings shown again. */
export function resetI18nForTests() {
  warned.clear();
  language = SOURCE_LANGUAGE;
  localeTag = 'de-DE';
  catalog = null;
}
