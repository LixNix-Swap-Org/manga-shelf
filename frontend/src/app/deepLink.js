// manga-shelf://connect?url=<address>&name=<name>&id=<instance id> from the QR code in the web footer. The shells
// hand an opened link to window.mangashelfOpenUrl(url) or dispatch OPEN_URL_EVENT with { detail: { url } }.
import { normalizeBase } from './serverStore.js';

export const CONNECT_PREFIX = 'manga-shelf://connect';
export const DEEP_LINK_EVENT = 'mangashelf:deep-link';
export const OPEN_URL_EVENT = 'mangashelf:open-url';

/** { url, name, instanceId } of a connect link (or of a plain http(s) address), null for anything else. */
export function parseConnectLink(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    const url = normalizeBase(raw);
    return url ? { url, name: '', instanceId: null } : null;
  }
  let parsed;
  try { parsed = new URL(raw); } catch (_) { return null; }
  if (parsed.protocol !== 'manga-shelf:') return null;
  const target = (parsed.host || parsed.pathname.replace(/^\/+/, '')).toLowerCase();
  if (target !== 'connect') return null;
  const url = normalizeBase(parsed.searchParams.get('url') || '');
  if (!url) return null;
  return {
    url,
    name: (parsed.searchParams.get('name') || '').trim().slice(0, 80),
    instanceId: (parsed.searchParams.get('id') || '').trim() || null
  };
}

export function buildConnectLink({ url, name, instanceId }) {
  const params = new URLSearchParams({ url });
  if (name) params.set('name', name);
  if (instanceId) params.set('id', instanceId);
  return `${CONNECT_PREFIX}?${params}`;
}

let pending = null;

/** Keeps the link for the server screen and tells a mounted app about it. Returns the parsed link or null. */
export function receiveDeepLink(raw, target = globalThis.window) {
  const link = parseConnectLink(raw);
  if (!link) return null;
  pending = link;
  target?.dispatchEvent?.(new CustomEvent(DEEP_LINK_EVENT, { detail: link }));
  return link;
}

export function takePendingDeepLink() {
  const link = pending;
  pending = null;
  return link;
}

/** Entry points for the shells; links that arrive before the app mounted wait in `pending`. */
export function installDeepLinkBridge(win = globalThis.window) {
  if (!win) return () => {};
  const onOpenUrl = (e) => { receiveDeepLink(e?.detail?.url, win); };
  win.mangashelfOpenUrl = (url) => receiveDeepLink(url, win);
  win.addEventListener(OPEN_URL_EVENT, onOpenUrl);
  return () => {
    win.removeEventListener(OPEN_URL_EVENT, onOpenUrl);
    delete win.mangashelfOpenUrl;
  };
}
