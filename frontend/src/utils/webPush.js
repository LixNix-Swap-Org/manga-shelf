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
    test: t('Erinnerungen sind eingeschaltet'),
    tomorrow: t('Morgen erscheint'),
    week: t('Diese Woche'),
    loanTitle: t('Ausleihe überfällig'),
    loan: t('{title} {volumes} – seit {days} Tagen bei {name}'),
    // short weekday names Monday … Sunday for the weekly list
    weekdays: t('Mo,Di,Mi,Do,Fr,Sa,So')
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

/**
 * The choices of a subscription and their defaults (services/push.js): `hour` 0–23 in the server's time zone, `mode`
 * 'day' (release day), 'eve' (the day before) or 'week' (Mondays, for the week), and what it reports.
 */
export const WEB_PUSH_DEFAULTS = Object.freeze({ hour: 9, mode: 'day', volumes: true, episodes: true, loans: true });
export const WEB_PUSH_MODES = ['day', 'eve', 'week'];

/** The server's choices with the defaults for anything missing or invalid. */
function readPrefs(raw) {
  const prefs = { ...WEB_PUSH_DEFAULTS };
  if (Number.isInteger(raw?.hour) && raw.hour >= 0 && raw.hour <= 23) prefs.hour = raw.hour;
  if (WEB_PUSH_MODES.includes(raw?.mode)) prefs.mode = raw.mode;
  for (const kind of ['volumes', 'episodes', 'loans']) if (typeof raw?.[kind] === 'boolean') prefs[kind] = raw[kind];
  return prefs;
}

/**
 * Is this browser subscribed for the signed-in account, and with which choices? Resolves { subscribed, prefs }.
 * Re-sends the texts, so a language change reaches the server (without choices, so the stored ones stay).
 */
export async function readWebPushState(nav = navigator) {
  const sub = await currentSubscription(nav);
  if (!sub) return { subscribed: false, prefs: { ...WEB_PUSH_DEFAULTS } };
  const answer = await api.post('/api/push/subscriptions/status', { endpoint: sub.endpoint });
  if (answer?.subscribed) await api.put('/api/push/subscriptions', { ...sub.toJSON(), texts: pushTexts() }).catch(() => {});
  return { subscribed: Boolean(answer?.subscribed), prefs: readPrefs(answer) };
}

/** Stores changed choices ({ hour?, mode?, volumes?, episodes?, loans? }) of this browser. Resolves false without a subscription. */
export async function setWebPushPrefs(patch, nav = navigator) {
  const sub = await currentSubscription(nav);
  if (!sub) return false;
  await api.put('/api/push/subscriptions', { ...sub.toJSON(), texts: pushTexts(), ...patch });
  return true;
}

/**
 * Switches the reminders on: asks for the permission, subscribes with the server's key (a subscription made with
 * another key is replaced) and stores it on the server. Resolves { enabled, prefs } (the choices the server keeps for
 * this browser), { enabled: false, denied } (blocked), { enabled: false, dismissed } (the prompt was closed without an
 * answer: nothing is blocked, it can be asked again) or { enabled: false, unsupported }.
 */
export async function enableWebPush({ nav = navigator, notification = globalThis.Notification } = {}) {
  const permission = notification.permission === 'granted' ? 'granted' : await notification.requestPermission();
  if (permission === 'default') return { enabled: false, dismissed: true };
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
  // a browser that was subscribed already keeps its stored choices (the PUT above sends none)
  const answer = await api.post('/api/push/subscriptions/status', { endpoint: sub.endpoint }).catch(() => null);
  return { enabled: true, prefs: readPrefs(answer) };
}

/** Switches them off for this browser: the server forgets the subscription, the browser drops it. */
export async function disableWebPush({ nav = navigator } = {}) {
  const sub = await currentSubscription(nav);
  if (!sub) return { enabled: false };
  await api.request('DELETE', '/api/push/subscriptions', { endpoint: sub.endpoint });
  await sub.unsubscribe().catch(() => {});
  return { enabled: false };
}

/**
 * Sends a test message to this browser. Resolves { ok } (the push service took it) and `gone` when the push service no
 * longer knows this browser's subscription: the server forgot it, so the browser drops it too and the switch is off.
 */
export async function testWebPush(nav = navigator) {
  const sub = await currentSubscription(nav);
  if (!sub) return { ok: false, gone: true };
  const res = await api.post('/api/push/test', { endpoint: sub.endpoint });
  if (res?.gone) await sub.unsubscribe().catch(() => {});
  return { ok: Boolean(res?.success), gone: Boolean(res?.gone) };
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
