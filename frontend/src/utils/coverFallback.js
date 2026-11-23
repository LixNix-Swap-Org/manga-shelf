// Foreign covers load through the server's cover cache (/api/covers?url=…, utils/api.js assetImgProps). The server
// answers 404 for a URL it does not know (search results, a photo link not saved yet) or cannot fetch right now; then
// this one image loads from its host, as it did before the cache. A capture listener on the document sees the error
// before the element's own onError, which only runs when the host fails too.
const COVER_PATH = '/api/covers';

/** The original URL of a cover cache address, or null for any other address. */
export function originalCoverUrl(src) {
  let parsed;
  try { parsed = new URL(String(src || ''), 'http://local.invalid'); } catch (_) { return null; }
  if (parsed.pathname !== COVER_PATH) return null;
  const original = parsed.searchParams.get('url');
  return original && /^https:\/\//i.test(original) ? original : null;
}

function onImageError(event) {
  const img = event.target;
  if (!img || img.tagName !== 'IMG') return;
  const original = originalCoverUrl(img.getAttribute('src'));
  if (!original) return;
  event.stopPropagation();
  // the server's CORS answer is not needed for the host
  img.removeAttribute('crossorigin');
  img.setAttribute('src', original);
}

/** Installs the fallback once per document; returns a function that removes it (tests). */
export function installCoverFallback(doc = document) {
  if (!doc || doc.__mangashelfCoverFallback) return () => {};
  doc.addEventListener('error', onImageError, true);
  doc.__mangashelfCoverFallback = true;
  return () => {
    doc.removeEventListener('error', onImageError, true);
    delete doc.__mangashelfCoverFallback;
  };
}
