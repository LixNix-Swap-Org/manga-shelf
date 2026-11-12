// Form defaults, texts and small helpers of "Neuer Manga" (split from AddMangaModal.jsx).
import { apiFetch, readJson, TIMEOUTS } from '../../../utils/api';
import { DEFAULT_WISH_PRIORITY } from '../../../utils/priority';
import { editionLanguage } from '../../../utils/editions';
import { foldText } from '../../../utils/search';
import { t } from '../../../i18n/index.js';

// i18n
export const EMPTY_FORM = {
  title: '',
  alt_title: '',
  author: '',
  publisher: '',
  status: 'Laufend',
  total_volumes: '',
  // print (by volume) or webtoon (by chapter, with its known chapter count)
  format: 'print',
  total_chapters: '',
  tags: '',
  description: '',
  cover_image: '',
  manga_passion_id: null,
  // edition (ISO codes); the dialog starts with the account's default language (editionDefaults)
  language: 'de',
  region: '',
  currency: 'EUR',
  work_key: null,
  wish: false,
  wish_priority: String(DEFAULT_WISH_PRIORITY)
};
// i18n
export const STEPS = ['Finden', 'Edition & Regal', 'Bände'];

export const MAX_COVER_BYTES = 15 * 1024 * 1024;
// i18n
export const NETWORK_ERROR = 'Netzwerkfehler – bitte Verbindung prüfen und erneut versuchen.';
// i18n
export const LOOKUP_SOURCES_HINT = 'Sucht in Manga Passion (deutsche Ausgaben), AniList und MyAnimeList';
// i18n
export const LOOKUP_SOURCES_HINT_OTHER = 'Sucht in AniList und MyAnimeList (Manga Passion kennt nur deutsche Ausgaben)';

export const isRemoteUrl = (url) => /^https?:\/\//i.test(url || '');
export const isBlobUrl = (url) => typeof url === 'string' && url.startsWith('blob:');

export async function request(url, init) {
  try {
    return await apiFetch(url, init);
  } catch {
    throw new Error(t(NETWORK_ERROR));
  }
}

/** Copies a remote image into /uploads through the server; resolves to the local URL, or '' when that fails. */
export async function cacheRemoteCover(url) {
  try {
    const res = await apiFetch('/api/upload-remote', { method: 'POST', body: { url }, timeout: TIMEOUTS.remote });
    if (!res.ok) return '';
    return (await readJson(res))?.url || '';
  } catch {
    return '';
  }
}

/**
 * Series of the collection that this form would duplicate: the same title (or alternative title) after folding,
 * the same edition language and the same format. A second edition stays allowed; the dialog only points at them.
 */
export function sameTitleSeries(mangas, form) {
  const key = foldText(form?.title).trim();
  if (!key || !Array.isArray(mangas)) return [];
  const language = editionLanguage(form);
  const format = form.format || 'print';
  return mangas.filter((m) => m && [m.title, m.alt_title].some((title) => title && foldText(title).trim() === key)
    && editionLanguage(m) === language && (m.format || 'print') === format);
}
