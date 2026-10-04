// ctx.http of the standalone mode: requests go straight from the device. In the browser build a source that sends no
// CORS headers fails like a network error; that is reported once per host (onBlocked) instead of failing silently.
// In the apps Capacitor's native HTTP replaces fetch, so the same code reaches DNB and Manga Passion too.
import imageCheck from '../../../core/lib/imageCheck.js';

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const TEXT_LIMIT_BYTES = 5 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 20000;

export const corsText = (host) => `${host} lässt Anfragen aus dem Browser nicht zu (CORS). In der App oder mit einem Server funktioniert diese Quelle.`;

const hostOf = (url) => {
  try { return new URL(url).host; } catch (_) { return String(url); }
};

export function createBrowserHttp({ fetchImpl = (...args) => globalThis.fetch(...args), onBlocked = () => {}, isOnline = () => globalThis.navigator?.onLine !== false } = {}) {
  const blocked = new Set();
  const call = async (url, init) => {
    try {
      return await fetchImpl(url, init);
    } catch (err) {
      if (err?.name === 'AbortError' || !(err instanceof TypeError) || !isOnline()) throw err;
      const host = hostOf(url);
      if (!blocked.has(host)) {
        blocked.add(host);
        onBlocked(host);
      }
      throw Object.assign(new Error(corsText(host)), { code: 'CORS_BLOCKED', cause: err });
    }
  };

  const withTimeout = async (url, timeoutMs, read) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await call(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await read(res);
    } catch (err) {
      if (controller.signal.aborted) throw new Error('Timeout');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    blockedHosts: () => [...blocked],
    fetch: (url, init) => call(url, init),
    fetchText: (url, timeoutMs = 7000) => withTimeout(url, timeoutMs, async (res) => {
      const text = await res.text();
      if (text.length > TEXT_LIMIT_BYTES) throw new Error('Antwort zu groß');
      return text;
    }),
    async fetchImage(url) {
      let parsed;
      try { parsed = new URL(url); } catch (_) { throw new Error('Ungültige Bild-URL'); }
      if (parsed.protocol !== 'https:') throw new Error('Nur https-Adressen sind für Bilder erlaubt');
      return withTimeout(url, IMAGE_TIMEOUT_MS, async (res) => {
        if (Number(res.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error('Das Bild ist zu groß');
        const buffer = new Uint8Array(await res.arrayBuffer());
        if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Das Bild ist zu groß');
        const ext = imageCheck.detectImageExt(buffer);
        if (!ext) throw new Error('Die Datei ist kein gültiges Bild');
        return { buffer, ext };
      });
    }
  };
}
