// Crunchyroll history sync (opt-in, foreground only): in the apps through core/watch/crunchyrollFlow.js over the cookie-less
// WebLogin.request of the native plugin, on the desktop through the main process. Only the parsed items go to
// POST /api/anime/watch-sync (device core in-process in local mode). Never through the outbox, never window.fetch.
import crunchyroll from '../../../../core/watch/crunchyroll.js';
import crunchyrollFlow from '../../../../core/watch/crunchyrollFlow.js';
import api, { isLocalMode } from '../../utils/api';
import { notify } from '../../utils/notify';
import { formatCount } from '../../utils/format';
import { t } from '../../i18n/index.js';
import { getActiveServerId } from '../serverStore';
import { readSecret, writeSecret, deleteSecret, hasSecret } from './crunchyrollSecret';
import {
  SERVICE, WATCH_SYNC_EVENT, watchBridge, desktopCall, canSync, readState, patchState, loadUnmatched, saveUnmatched, clearUnmatched,
  clearSkipped, readSkipped, resetUnmatchedView
} from './watchState';

const { createFlow, FlowError } = crunchyrollFlow;

export const SYNC_FLOOR_MS = 15 * 60 * 1000;
const FOREGROUND_SLACK_MS = 60000;
const POST_TIMEOUT_MS = 30000;
const THROTTLE_FALLBACK_S = 30;
const SKIP_LIMIT = 200;
const ADDED_TOAST_MS = 15000;

// i18n
export const SYNC_TEXTS = {
  failed: 'Abgleich fehlgeschlagen',
  loginFailed: 'Anmeldung bei Crunchyroll fehlgeschlagen',
  loginBusy: 'Die Crunchyroll-Anmeldung ist schon offen',
  noCookie: 'Anmeldung nicht abgeschlossen – bitte erneut verbinden',
  serverMissing: 'Der Server kennt den Crunchyroll-Abgleich noch nicht.',
  serverUnreachable: 'Sammlung nicht erreichbar – nächster Versuch beim nächsten Öffnen',
  readOnly: 'Nur Bearbeiter können ihren Fortschritt speichern.'
};

class SyncFailure extends Error {}

/** The run lost its owner ('Trennen', opt-out, new login, server or user switch): it writes nothing any more. */
class Stale extends Error {}

const QUIET_CODES = ['stale', 'not_connected', 'background', 'locked', 'unreadable'];
const MESSAGE_CODES = ['reconnect', 'blocked', 'rate_limited', 'unavailable', 'bad_response'];

/** The collection the unmatched series belong to: device profile or server, plus the user. */
export const scopeOf = (user) => `${isLocalMode() ? 'local' : getActiveServerId() || 'server'}:${user?.id ?? ''}`;

async function isOnline(bridge) {
  if (globalThis.navigator?.onLine === false) return false;
  if (bridge.kind !== 'capacitor') return true;
  try {
    return (await bridge.native.plugins.Network?.getStatus?.())?.connected !== false;
  } catch (_) {
    return true;
  }
}

const randomId = () => {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

let inflight = null;
let session = null;
// bumped by connect and disconnect: a run that started before writes no login, list or time any more
let generation = 0;
const flows = new WeakMap();

async function nativeRequest(bridge, request) {
  const res = await bridge.native.plugins.WebLogin.request(request);
  return {
    status: Number(res?.status) || 0,
    headers: res?.headers && typeof res.headers === 'object' ? res.headers : {},
    text: typeof res?.text === 'string' ? res.text : '',
    cookies: Array.isArray(res?.cookies) ? res.cookies : []
  };
}

function flowOf(bridge) {
  if (!flows.has(bridge.native)) {
    flows.set(bridge.native, createFlow({
      send: (request) => nativeRequest(bridge, request),
      readSecret: () => readSecret(bridge),
      writeSecret: async (secret) => {
        const gen = generation;
        await writeSecret(bridge, secret, secret.saved_at ?? Date.now());
        if (gen !== generation) {
          await deleteSecret(bridge);
          throw new FlowError('stale');
        }
      },
      deleteSecret: () => deleteSecret(bridge),
      randomUUID: randomId,
      now: () => Date.now()
    }));
  }
  return flows.get(bridge.native);
}

function serverFailure(err) {
  if (err?.status === 404) return new SyncFailure(SYNC_TEXTS.serverMissing);
  if (err?.status === 403) return new SyncFailure(SYNC_TEXTS.readOnly);
  if (!err?.status) return new SyncFailure(SYNC_TEXTS.serverUnreachable);
  return new SyncFailure(err?.message || SYNC_TEXTS.failed);
}

function historyMessage(code) {
  if (MESSAGE_CODES.includes(code)) return crunchyroll.MESSAGES[code];
  if (code === 'network') return crunchyroll.MESSAGES.unavailable;
  return SYNC_TEXTS.failed;
}

const countOf = (list) => (Array.isArray(list) ? list.length : 0);

const throttleLeft = (state, scope, at) => {
  const until = state.throttle && typeof state.throttle === 'object' ? Number(state.throttle[scope]) : 0;
  return Number.isFinite(until) && until > at ? until - at : 0;
};

const rememberThrottle = (scope, until, at) => (current) => {
  const kept = Object.entries(current.throttle && typeof current.throttle === 'object' ? current.throttle : {})
    .filter(([key, value]) => key !== scope && Number(value) > at);
  return { throttle: Object.fromEntries([...kept, [scope, until]]) };
};

async function undoAdded(added, { post, win }) {
  let undone = 0;
  for (const entry of added) {
    try {
      await post('/api/anime/watch-sync/undo', { anime_id: entry.anime_id, external_id: entry.external_id, season: entry.season });
      undone += 1;
    } catch (err) {
      notify.error(err);
      break;
    }
  }
  if (undone > 0) {
    win?.dispatchEvent?.(new CustomEvent(WATCH_SYNC_EVENT, { detail: { service: SERVICE, applied: 0, added: 0, changed: true, watch: null } }));
  }
}

function showAdded(added, options) {
  const title = added.length === 1 && typeof added[0]?.title === 'string' ? added[0].title : null;
  const text = title
    ? t('Neu in der Liste: {title}', { title })
    : t('{count} neu in der Liste', { count: formatCount(added.length, 'Serie', 'Serien') });
  notify.success(text, { duration: ADDED_TOAST_MS, action: { label: t('Rückgängig'), onClick: () => { undoAdded(added, options); } } });
}

const runningListeners = new Set();
const setRunning = (entry) => {
  inflight = entry;
  for (const fn of runningListeners) fn(Boolean(entry));
};

/** True while a sync (automatic or 'Jetzt abgleichen') runs; the card locks 'Trennen' and the switch meanwhile. */
export const isSyncRunning = () => Boolean(inflight);

export function subscribeRunning(fn) {
  runningListeners.add(fn);
  return () => runningListeners.delete(fn);
}

// One sync, single flight (a second call for the same collection joins the running one, another collection waits). Skips without
// a request when the feature is off, the user is no editor, the last attempt is under 15 minutes old (unless `force`), or the
// device is offline or not connected. Never throws: failures land in the stored state and console.warn.
export function runWatchSync(options = {}) {
  const user = 'user' in options ? options.user : session?.user;
  const scope = scopeOf(user);
  if (inflight?.scope === scope) return inflight.promise;
  const before = inflight ? inflight.promise.catch(() => {}) : Promise.resolve();
  // a failing storage plugin must not break the caller either
  const entry = { scope };
  entry.promise = before
    .then(() => syncOnce({ ...options, user }))
    .catch(() => ({ ran: false, reason: 'error' }))
    .finally(() => { if (inflight === entry) setRunning(null); });
  setRunning(entry);
  return entry.promise;
}

async function syncOnce({
  bridge = watchBridge(), user, force = false, foreground = false, now = Date.now, post = api.post, win = globalThis.window
} = {}) {
  if (!bridge) return { ran: false, reason: 'unavailable' };
  if (!canSync(user)) return { ran: false, reason: 'role' };
  const desktop = bridge.kind === 'desktop';
  const gen = generation;
  const owner = session;
  const state = await readState(bridge);
  if (!state.enabled) return { ran: false, reason: 'off' };
  const scope = scopeOf(user);
  const wait = force ? throttleLeft(state, scope, now()) : 0;
  if (wait > 0) return { ran: false, reason: 'throttled', retryIn: Math.ceil(wait / 1000) };
  const floor = foreground ? SYNC_FLOOR_MS - FOREGROUND_SLACK_MS : SYNC_FLOOR_MS;
  if (!force && state.last_attempt && now() - state.last_attempt < floor) return { ran: false, reason: 'floor' };
  if (!(await isOnline(bridge))) return { ran: false, reason: 'offline' };
  if (!desktop && !(await readSecret(bridge))) return { ran: false, reason: 'not_connected' };
  const stale = () => gen !== generation;
  const live = async () => {
    if ((!desktop && !(await readSecret(bridge))) || stale()) throw new Stale();
  };
  const guarded = async (write, undo) => {
    await live();
    const result = await write();
    if (stale()) {
      await undo();
      throw new Stale();
    }
    return result;
  };
  // the server, the user or the device collection changed: the answer would belong to another collection
  const sameScope = () => scopeOf(user) === scope && (!owner || scopeOf(session?.user) === scope);
  const failed = async (message, { reconnect = false } = {}) => {
    console.warn('[Crunchyroll] Abgleich übersprungen:', message);
    if (reconnect) await clearUnmatched(bridge);
    await patchState(bridge, {
      ...(desktop ? { last_attempt: now() } : {}), last_error: message, last_error_at: now(), ...(reconnect ? { connected_at: null } : {})
    });
    return { ran: true, error: message };
  };
  if (stale()) return { ran: false, reason: 'stale' };
  if (!desktop) await patchState(bridge, { last_attempt: now() });

  let items;
  try {
    items = desktop ? (await desktopCall(bridge, 'sync', { force: Boolean(force) })).items : (await flowOf(bridge).history()).items;
  } catch (err) {
    const code = typeof err?.code === 'string' ? err.code : null;
    if (code === 'too_soon') return { ran: false, reason: 'too_soon', retryIn: Number.isInteger(err.retryIn) ? err.retryIn : 1 };
    if (QUIET_CODES.includes(code)) return { ran: false, reason: code };
    if (stale()) return { ran: false, reason: 'stale' };
    return failed(historyMessage(code), { reconnect: code === 'reconnect' });
  }

  try {
    if (!sameScope()) {
      await patchState(bridge, { last_attempt: null });
      return { ran: false, reason: 'scope' };
    }
    await live();
    if (desktop) await patchState(bridge, { last_attempt: now() });
    let answer = { applied: [], unmatched: [] };
    const list = Array.isArray(items) ? items : [];
    if (list.length || force) {
      const skip = (await readSkipped(bridge)).filter((key) => typeof key === 'string').slice(-SKIP_LIMIT);
      const body = { ...crunchyroll.syncBody(list), skip, auto_add: true, platform: bridge.platform };
      try {
        answer = (await post('/api/anime/watch-sync', body, { timeout: POST_TIMEOUT_MS })) || answer;
      } catch (err) {
        throw serverFailure(err);
      }
    }
    // the server's limit: it wrote nothing, so the stored list stays as it is
    if (answer.throttled) {
      const retryIn = Number.isInteger(answer.retry_after) && answer.retry_after > 0 ? answer.retry_after : THROTTLE_FALLBACK_S;
      const at = now();
      await patchState(bridge, rememberThrottle(scope, at + retryIn * 1000, at));
      return { ran: false, reason: 'throttled', retryIn };
    }
    const applied = countOf(answer.applied);
    const added = Array.isArray(answer.added) ? answer.added.filter((a) => a && typeof a === 'object') : [];
    const watch = answer.watch && typeof answer.watch === 'object' ? answer.watch : null;
    // the collection has the progress now, also when 'Trennen' stops the rest below
    win?.dispatchEvent?.(new CustomEvent(WATCH_SYNC_EVENT, {
      detail: { service: SERVICE, applied, added: added.length, changed: applied + added.length > 0, watch }
    }));
    if (added.length) showAdded(added, { post, win });
    await guarded(() => saveUnmatched(bridge, scope, answer.unmatched), () => clearUnmatched(bridge));
    await live();
    await patchState(bridge, { last_ok: now(), last_error: null, last_error_at: null });
    return { ran: true, applied, added: added.length, unmatched: countOf(answer.unmatched) };
  } catch (err) {
    if (err instanceof Stale || stale()) return { ran: false, reason: 'stale' };
    return failed(err instanceof SyncFailure ? err.message : SYNC_TEXTS.failed);
  }
}

// Starts the foreground triggers for a signed-in user (or an opened device collection). Apps: once now, then on every return to
// the foreground (App appStateChange isActive). Desktop: only on the main process's foreground signals. Returns stop(). No
// background task: whenUnlocked keychain items and App Review both want foreground only.
export function startWatchSync({ user, bridge = watchBridge(), now = Date.now } = {}) {
  if (!bridge || !canSync(user)) return () => {};
  const mine = { user };
  session = mine;
  let stopped = false;
  let unsubscribe = null;
  let handle = null;
  const trigger = () => {
    if (!stopped) runWatchSync({ bridge, user, now, foreground: true }).catch(() => {});
  };
  const loaded = loadUnmatched(bridge, scopeOf(user)).catch(() => {});
  if (bridge.kind === 'desktop') {
    loaded.then(() => {
      if (stopped) return;
      try {
        unsubscribe = bridge.watch.onForeground(trigger);
      } catch (_) {
        unsubscribe = null;
      }
    });
  } else {
    loaded.then(trigger);
    handle = Promise.resolve()
      .then(() => bridge.native.plugins.App?.addListener?.('appStateChange', ({ isActive } = {}) => { if (isActive) trigger(); }))
      .catch(() => null);
  }
  return () => {
    stopped = true;
    if (session === mine) {
      session = null;
      resetUnmatchedView();
    }
    if (typeof unsubscribe === 'function') unsubscribe();
    handle?.then((h) => h?.remove?.()).catch(() => {});
  };
}

const isCancel = (err) => /cancel/i.test(String(err?.code || '')) || /cancel/i.test(String(err?.message || err || ''));

async function loginFailure(bridge, message, now) {
  await patchState(bridge, { last_error: message, last_error_at: now() });
  throw new SyncFailure(message);
}

const connectedState = (now) => ({ enabled: true, connected_at: now(), last_attempt: null, last_error: null, last_error_at: null });

async function connectDesktop(bridge, now) {
  try {
    await desktopCall(bridge, 'login');
  } catch (err) {
    if (err.code === 'cancelled') return { cancelled: true };
    if (['unavailable', 'locked', 'unreadable'].includes(err.code)) return { connected: false, reason: err.code };
    return loginFailure(bridge, err.code === 'busy' ? SYNC_TEXTS.loginBusy : SYNC_TEXTS.loginFailed, now);
  }
  await patchState(bridge, connectedState(now));
  return { connected: true };
}

/**
 * 'Mit Crunchyroll verbinden': the login sheet (apps) or window (desktop); the cookie and client id go straight into the
 * secure storage. Resolves { connected: true }, { cancelled: true } or { connected: false, reason }; a failed login is
 * written to the state and thrown.
 */
export async function connectCrunchyroll({ bridge = watchBridge(), now = Date.now } = {}) {
  generation += 1;
  if (bridge.kind === 'desktop') return connectDesktop(bridge, now);
  let result;
  try {
    result = await bridge.native.plugins.WebLogin.open(crunchyroll.LOGIN_OPTIONS);
  } catch (err) {
    if (isCancel(err)) return { cancelled: true };
    return loginFailure(bridge, err?.code === 'busy' ? SYNC_TEXTS.loginBusy : SYNC_TEXTS.loginFailed, now);
  }
  try {
    await flowOf(bridge).connect({ etpRt: result?.cookie?.value, scriptResult: result?.scriptResult ?? null, isCancelled: () => false });
  } catch (err) {
    if (err instanceof FlowError && err.code === 'stale') return { cancelled: true };
    return loginFailure(bridge, err instanceof FlowError && err.code === 'bad_response' ? SYNC_TEXTS.noCookie : SYNC_TEXTS.loginFailed, now);
  }
  await patchState(bridge, connectedState(now));
  return { connected: true };
}

/**
 * 'Trennen' (and the opt-out): secret, unmatched and skipped series and sync times go; the opt-out also switches the
 * feature off. A sync still running writes nothing back.
 */
export async function disconnectCrunchyroll({ bridge = watchBridge(), optOut = false } = {}) {
  generation += 1;
  if (bridge.kind === 'desktop') await desktopCall(bridge, 'logout').catch(() => {});
  else await flowOf(bridge).disconnect();
  await clearUnmatched(bridge);
  await clearSkipped(bridge);
  await patchState(bridge, {
    ...(optOut ? { enabled: false } : {}), connected_at: null, last_attempt: null, last_ok: null, last_error: null, last_error_at: null
  });
}

/** 'Jetzt abgleichen' and the first run after connecting: ignores the 15-minute floor, still single flight. */
export const syncNow = (options = {}) => runWatchSync({ ...options, force: true });

/** The refresh button: a forced run of the signed-in user, posted even without new items. */
export const refreshWatch = ({ user } = {}) => runWatchSync({ user, force: true });

/** Whether this device holds a Crunchyroll login (secure storage in the apps, the main process on the desktop). */
export async function watchConnected({ bridge = watchBridge() } = {}) {
  if (!bridge) return false;
  try {
    if (bridge.kind === 'desktop') return Boolean((await desktopCall(bridge, 'status')).connected);
    return await hasSecret(bridge);
  } catch (_) {
    return false;
  }
}
