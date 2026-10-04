// manga-shelf://connect?url=<address>&name=<name>&id=<instance id> from the QR code in the web footer, and
// manga-shelf://share?text=…&url=…&subject=… (Android share sheet, a streaming link). The shells hand an opened link to
// window.mangashelfOpenUrl(url) or dispatch OPEN_URL_EVENT with { detail: { url } }.
import { normalizeBase } from './serverStore.js';
import links from '../../../core/watch/links.js';

export const CONNECT_PREFIX = 'manga-shelf://connect';
export const SHARE_PREFIX = 'manga-shelf://share';
export const DEEP_LINK_EVENT = 'mangashelf:deep-link';
export const SHARE_LINK_EVENT = 'mangashelf:share-link';
export const OPEN_URL_EVENT = 'mangashelf:open-url';
export const SHARE_TEXT_LIMIT = 2000;
// the iOS inbox keeps up to 20 shares and hands them over at once
const PENDING_SHARES_LIMIT = 20;

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

const shareValue = (value) => (typeof value === 'string' ? value.trim().slice(0, SHARE_TEXT_LIMIT) : '');

export function buildShareLink({ text, url, subject } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of [['text', text], ['url', url], ['subject', subject]]) {
    const clean = shareValue(value);
    if (clean) params.set(key, clean);
  }
  return `${SHARE_PREFIX}?${params}`;
}

/** { text, url, subject } of a share link, null for anything else. */
export function parseShareLink(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw.toLowerCase().startsWith(SHARE_PREFIX)) return null;
  let parsed;
  try { parsed = new URL(raw); } catch (_) { return null; }
  const target = (parsed.host || parsed.pathname.replace(/^\/+/, '')).toLowerCase();
  if (target !== 'share') return null;
  const get = (key) => shareValue(parsed.searchParams.get(key) || '');
  return { text: get('text'), url: get('url'), subject: get('subject') };
}

// a streaming link is never a server address, also when it arrives as plain text
function shareOf(raw) {
  const share = parseShareLink(raw);
  if (share) return share;
  const text = shareValue(raw);
  return text && links.detectLink(text) ? { text, url: '', subject: '' } : null;
}

let pending = null;
const pendingShares = [];

/**
 * Keeps the link for the server screen (or a share for the anime tab) and tells a mounted app about it. Returns the
 * parsed connect link, { share: true } for a share, or null.
 */
export function receiveDeepLink(raw, target = globalThis.window) {
  const share = shareOf(raw);
  if (share) {
    pendingShares.push(share);
    if (pendingShares.length > PENDING_SHARES_LIMIT) pendingShares.shift();
    target?.dispatchEvent?.(new CustomEvent(SHARE_LINK_EVENT, { detail: share }));
    return { share: true };
  }
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

export const hasPendingShare = () => pendingShares.length > 0;

/** The oldest share not yet taken (first in, first out), or null. */
export function takePendingShare() {
  return pendingShares.shift() ?? null;
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
