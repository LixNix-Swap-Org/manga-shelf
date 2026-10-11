export const COVER_ORIGIN_KEY = 'mangashelf_cover_origin';

/** The http(s) origin of an absolute URL, else null. */
export function originOf(url) {
  try {
    const parsed = new URL(String(url ?? ''));
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch (_) {
    return null;
  }
}

/** The stored origin of the last Manga Passion cover, or null. */
export function getCoverOrigin() {
  try {
    const value = window.localStorage.getItem(COVER_ORIGIN_KEY);
    return value && originOf(value) === value ? value : null;
  } catch (_) {
    return null;
  }
}

/** Stores the origin of `url` (a cover URL or an origin); ignores anything that has none. */
export function setCoverOrigin(url) {
  const origin = originOf(url);
  if (!origin) return;
  try { window.localStorage.setItem(COVER_ORIGIN_KEY, origin); } catch (_) {}
}
