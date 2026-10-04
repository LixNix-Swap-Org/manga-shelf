// ctx.http of the standalone mode: requests go straight from the device. In the browser build a source that sends no
// CORS headers fails like a network error; that is reported once per host (onBlocked) instead of failing silently.
// In the apps Capacitor's native HTTP replaces fetch, so the same code reaches DNB and Manga Passion too.
import imageCheck from '../../../core/lib/imageCheck.js';
import errors from '../../../core/errors.js';

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const TEXT_LIMIT_BYTES = 5 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 20000;

/** The CORS refusal as msg(): German text plus template/params, so localServer can answer with msg/params. */
// i18n-ignore: device-core error texts stay German; the core compares them and the client translates its answers
export const corsMsg = (host) => errors.msg('{host} lässt Anfragen aus dem Browser nicht zu (CORS). In der App oder mit einem Server funktioniert diese Quelle.', { host });
export const corsText = (host) => corsMsg(host).text;

// an error answer's first bytes let the caller tell a refused key from a quota (Google Books error reasons)
export const ERROR_BODY_BYTES = 4096;

async function readErrorBody(res) {
  try {
    const reader = res.body?.getReader?.();
    if (!reader) return (await res.text()).slice(0, ERROR_BODY_BYTES);
    const chunks = [];
    let size = 0;
    while (size < ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    reader.cancel().catch(() => {});
    const bytes = new Uint8Array(Math.min(size, ERROR_BODY_BYTES));
    let offset = 0;
    for (const chunk of chunks) {
      const part = chunk.subarray(0, bytes.length - offset);
      bytes.set(part, offset);
      offset += part.length;
      if (offset >= bytes.length) break;
    }
    return new TextDecoder().decode(bytes);
  } catch (_) {
    return '';
  }
}

const hostOf = (url) => {
  try { return new URL(url).host; } catch (_) { return String(url); }
};

export function createBrowserHttp({ fetchImpl = (...args) => globalThis.fetch(...args), onBlocked = () => {}, isOnline = () => globalThis.navigator?.onLine !== false } = {}) {
  const blocked = new Set();
  // `quiet`: an optional probe (the og:title of a shared link) fails without the CORS notice
  const call = async (url, init, { quiet = false } = {}) => {
    try {
      return await fetchImpl(url, init);
    } catch (err) {
      if (err?.name === 'AbortError' || !(err instanceof TypeError) || !isOnline()) throw err;
      const host = hostOf(url);
      if (!quiet && !blocked.has(host)) {
        blocked.add(host);
        onBlocked(host);
      }
      const text = corsMsg(host);
      throw Object.assign(new Error(text.text), { code: 'CORS_BLOCKED', cause: err, extra: { msg: text.template, params: text.params } });
    }
  };

  const withTimeout = async (url, timeoutMs, read, { errorBody = false, quiet = false } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await call(url, { signal: controller.signal }, { quiet });
      if (!res.ok) {
        const err = Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
        if (errorBody && res.status >= 300) err.body = await readErrorBody(res);
        throw err;
      }
      return await read(res);
    } catch (err) {
      if (controller.signal.aborted) throw new Error('Timeout'); // i18n-ignore
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    blockedHosts: () => [...blocked],
    fetch: (url, init) => call(url, init),
    fetchText: (url, timeoutMs = 7000, { quiet = false } = {}) => withTimeout(url, timeoutMs, async (res) => {
      const text = await res.text();
      if (text.length > TEXT_LIMIT_BYTES) throw new Error('Antwort zu groß'); // i18n-ignore
      return text;
    }, { errorBody: true, quiet }),
    async fetchImage(url) {
      let parsed;
      try { parsed = new URL(url); } catch (_) { throw new Error('Ungültige Bild-URL'); } // i18n-ignore
      if (parsed.protocol !== 'https:') throw new Error('Nur https-Adressen sind für Bilder erlaubt'); // i18n-ignore
      return withTimeout(url, IMAGE_TIMEOUT_MS, async (res) => {
        if (Number(res.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error('Das Bild ist zu groß'); // i18n-ignore
        const buffer = new Uint8Array(await res.arrayBuffer());
        if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Das Bild ist zu groß'); // i18n-ignore
        const ext = imageCheck.detectImageExt(buffer);
        if (!ext) throw new Error('Die Datei ist kein gültiges Bild'); // i18n-ignore
        return { buffer, ext };
      });
    }
  };
}
