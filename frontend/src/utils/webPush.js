// Release-day reminders in the browser by Web Push (routes/push.js, services/push.js on the server; public/sw.js shows
// them). Per browser: the switch subscribes this browser's push service with the server's VAPID key and hands the
// subscription to the server, with the notification texts in the current UI language (the server has no catalog).
// The apps plan their reminders on the device instead (app/reminders).
import api, { isAppMode } from './api';
import { BEFORE_LOGOUT_EVENT } from '../appShell';
import { t } from '../i18n/index.js';

const READY_TIMEOUT_MS = 5000;
const PUSH_ROLES = ['admin', 'editor'];

/** Editors and admins of a server in a browser build (read-only roles have no radar reminders either). */
export const canWebPush = (user) => !isAppMode() && Boolean(user) && !user.offline && PUSH_ROLES.includes(user.role);

/** 'ok', 'insecure' (plain http on a LAN address: browsers only offer push over HTTPS) or 'unsupported'. */
export function webPushSupport(env = globalThis) {
  const win = env?.window ?? env;
  if (!win || !win.navigator) return 'unsupported';
  if (!win.isSecureContext) return 'insecure';
  if (!('serviceWorker' in win.navigator) || !('PushManager' in win) || !('Notification' in win)) return 'unsupported';
  return 'ok';
}

/** The notification texts in the current UI language, for the server to fill in. */
export function pushTexts() {
  return {
    title: t('Heute neu erschienen'),
    volume: t('Band {num}'),
    box: t('Schuber {num}'),
    episode: t('{title} – Folge {episode}'),
    more: t('+ {n} weitere'),
    test: t('Erinnerungen sind eingeschaltet')
  };
}

/** Base64url (the server's public key) → the bytes PushManager.subscribe() wants. */
export function keyBytes(base64url) {
  const base64 = String(base64url).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** The active service worker registration, or null when none comes up in time (dev server, blocked worker). */
async function registration(nav = navigator) {
  let timer;
  try {
    return await Promise.race([
      nav.serviceWorker.ready,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), READY_TIMEOUT_MS); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** This browser's push subscription, or null. */
export async function currentSubscription(nav = navigator) {
  try {
    const reg = await nav.serviceWorker.getRegistration();
    return (await reg?.pushManager?.getSubscription()) || null;
  } catch (_) {
    return null;
  }
}

/** Is this browser subscribed for the signed-in account? Re-sends the texts, so a language change reaches the server. */
export async function readWebPushState(nav = navigator) {
  const sub = await currentSubscription(nav);
  if (!sub) return false;
  const { subscribed } = await api.post('/api/push/subscriptions/status', { endpoint: sub.endpoint });
  if (subscribed) await api.put('/api/push/subscriptions', { ...sub.toJSON(), texts: pushTexts() }).catch(() => {});
  return Boolean(subscribed);
}

/**
 * Switches the reminders on: asks for the permission, subscribes with the server's key (a subscription made with
 * another key is replaced) and stores it on the server. Resolves { enabled, denied, unsupported }.
 */
export async function enableWebPush({ nav = navigator, notification = globalThis.Notification } = {}) {
  const permission = notification.permission === 'granted' ? 'granted' : await notification.requestPermission();
  if (permission !== 'granted') return { enabled: false, denied: true };
  const reg = await registration(nav);
  if (!reg?.pushManager) return { enabled: false, unsupported: true };
  const { publicKey } = await api.get('/api/push/key');
  const key = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  const sameKey = (s) => {
    const own = s?.options?.applicationServerKey;
    if (!own) return true;
    const bytes = new Uint8Array(own);
    return bytes.length === key.length && bytes.every((b, i) => b === key[i]);
  };
  if (sub && !sameKey(sub)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api.put('/api/push/subscriptions', { ...sub.toJSON(), texts: pushTexts() });
  return { enabled: true };
}

/** Switches them off for this browser: the server forgets the subscription, the browser drops it. */
export async function disableWebPush({ nav = navigator } = {}) {
  const sub = await currentSubscription(nav);
  if (!sub) return { enabled: false };
  await api.request('DELETE', '/api/push/subscriptions', { endpoint: sub.endpoint });
  await sub.unsubscribe().catch(() => {});
  return { enabled: false };
}

/** Sends a test message to this browser. Resolves true when the push service took it. */
export async function testWebPush(nav = navigator) {
  const sub = await currentSubscription(nav);
  if (!sub) return false;
  const res = await api.post('/api/push/test', { endpoint: sub.endpoint });
  return Boolean(res?.success);
}

/**
 * A logout ends the reminders of this browser: the next account on it must not get them. Installed once from main.jsx
 * (browser builds); the work runs while the session is still valid.
 */
export function installWebPushLogout(target = globalThis.window, nav = globalThis.navigator) {
  if (!target?.addEventListener || isAppMode() || !nav?.serviceWorker) return () => {};
  const onLogout = (event) => {
    event.detail?.waitUntil?.((async () => {
      const sub = await currentSubscription(nav);
      if (!sub) return;
      await api.request('DELETE', '/api/push/subscriptions', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    })());
  };
  target.addEventListener(BEFORE_LOGOUT_EVENT, onLogout);
  return () => target.removeEventListener(BEFORE_LOGOUT_EVENT, onLogout);
}
