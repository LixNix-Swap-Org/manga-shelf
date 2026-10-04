// Crunchyroll history sync of the apps (opt-in, foreground only, silent): token, account and history through the
// cookie-less WebLogin.request of the native plugin, parsing in core/watch/crunchyroll.js, and only the parsed items go
// to POST /api/anime/watch-sync (device core in-process in local mode). Never through the outbox, never window.fetch.
import crunchyroll from '../../../../core/watch/crunchyroll.js';
import api, { isLocalMode } from '../../utils/api';
import { getActiveServerId } from '../serverStore';
import { readSecret, writeSecret, deleteSecret } from './crunchyrollSecret';
import {
  SERVICE, WATCH_SYNC_EVENT, watchBridge, canSync, readState, patchState, loadUnmatched, saveUnmatched, clearUnmatched, clearSkipped,
  resetUnmatchedView
} from './watchState';

export const SYNC_FLOOR_MS = 15 * 60 * 1000;
const POST_TIMEOUT_MS = 30000;

export const SYNC_TEXTS = {
  failed: 'Abgleich fehlgeschlagen',
  loginFailed: 'Anmeldung bei Crunchyroll fehlgeschlagen',
  noCookie: 'Anmeldung nicht abgeschlossen – bitte erneut verbinden',
  serverMissing: 'Der Server kennt den Crunchyroll-Abgleich noch nicht.',
  serverUnreachable: 'Sammlung nicht erreichbar – nächster Versuch beim nächsten Öffnen',
  readOnly: 'Nur Bearbeiter können ihren Fortschritt speichern.'
};

class SyncFailure extends Error {
  constructor(message, { clearSecret = false } = {}) {
    super(message);
    this.clearSecret = clearSecret;
  }
}

/** The run lost its owner ('Trennen', opt-out, new login, server or user switch): it writes nothing any more. */
class Stale extends Error {}

const fail = (failure, fallback = SYNC_TEXTS.failed) => new SyncFailure(failure?.message || fallback, { clearSecret: Boolean(failure?.clear_secret) });

/** The collection the unmatched series belong to: device profile or server, plus the user. */
export const scopeOf = (user) => `${isLocalMode() ? 'local' : getActiveServerId() || 'server'}:${user?.id ?? ''}`;

async function isOnline(bridge) {
  if (globalThis.navigator?.onLine === false) return false;
  try {
    return (await bridge.plugins.Network?.getStatus?.())?.connected !== false;
  } catch (_) {
    return true;
  }
}

/** One native request; a transport error (DNS, TLS, timeout, host not allowed) counts as status 0. */
async function send(bridge, request) {
  try {
    const res = await bridge.plugins.WebLogin.request(request);
    return {
      status: Number(res?.status) || 0,
      headers: res?.headers || {},
      text: typeof res?.text === 'string' ? res.text : '',
      cookies: Array.isArray(res?.cookies) ? res.cookies : []
    };
  } catch (_) {
    return { status: 0, headers: {}, text: '', cookies: [] };
  }
}

async function historyItems(bridge, accountId, accessToken) {
  const kinds = [['watch', crunchyroll.ENDPOINTS.watchHistory], ['discover', crunchyroll.ENDPOINTS.discoverHistory]];
  const lists = [];
  let firstFailure = null;
  for (const [kind, urlOf] of kinds) {
    if (typeof urlOf !== 'function') continue;
    const parsed = crunchyroll.parseHistoryResponse(await send(bridge, crunchyroll.buildApiRequest(urlOf(accountId), accessToken)), kind);
    if (parsed?.ok) lists.push(parsed.items || []);
    else firstFailure ||= parsed;
  }
  if (!lists.length) throw fail(firstFailure);
  return crunchyroll.mergeItems(...lists);
}

/** Token (rotated etp_rt persisted at once), account, history; resolves with the parsed items. */
async function fetchItems(bridge, secret, now, fence) {
  const token = crunchyroll.parseTokenResponse(await send(bridge, crunchyroll.buildTokenRequest(secret)));
  if (!token?.ok) throw fail(token);
  let current = secret;
  if (token.etp_rt && token.etp_rt !== current.etp_rt) current = await fence.writeSecret({ ...current, etp_rt: token.etp_rt });
  let accountId = token.account_id || current.account_id;
  if (!accountId) {
    const me = crunchyroll.parseMe(await send(bridge, crunchyroll.buildApiRequest(crunchyroll.ENDPOINTS.me, token.access_token)));
    if (!me?.ok) throw fail(me);
    accountId = me.account_id;
  }
  if (accountId !== current.account_id) await fence.writeSecret({ ...current, account_id: accountId });
  return historyItems(bridge, accountId, token.access_token);
}

function serverFailure(err) {
  if (err?.status === 404) return new SyncFailure(SYNC_TEXTS.serverMissing);
  if (err?.status === 403) return new SyncFailure(SYNC_TEXTS.readOnly);
  if (!err?.status) return new SyncFailure(SYNC_TEXTS.serverUnreachable);
  return new SyncFailure(err?.message || SYNC_TEXTS.failed);
}

let inflight = null;
let session = null;
// bumped by connect and disconnect: a run that started before writes no login, list or time any more
let generation = 0;

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

/**
 * One sync, single flight (a second call for the same collection joins the running one, another collection waits for
 * it). Skips without a request when the feature is off, the user is no editor, the last attempt is younger than 15 minutes
 * (unless `force`), the device is offline or not connected. Never throws: failures end up in the Preferences state and
 * console.warn.
 */
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

async function syncOnce({ bridge = watchBridge(), user, force = false, now = Date.now, post = api.post, win = globalThis.window } = {}) {
  if (!bridge) return { ran: false, reason: 'unavailable' };
  if (!canSync(user)) return { ran: false, reason: 'role' };
  const gen = generation;
  const owner = session;
  const state = await readState(bridge);
  if (!state.enabled) return { ran: false, reason: 'off' };
  if (!force && state.last_attempt && now() - state.last_attempt < SYNC_FLOOR_MS) return { ran: false, reason: 'floor' };
  if (!(await isOnline(bridge))) return { ran: false, reason: 'offline' };
  const secret = await readSecret(bridge);
  if (!secret) return { ran: false, reason: 'not_connected' };
  const scope = scopeOf(user);
  const disconnected = () => gen !== generation;
  const live = async () => {
    const present = await readSecret(bridge);
    if (!present || disconnected()) throw new Stale();
  };
  // 'Trennen' may run while a write is on its way and its delete may land first: then undo the write
  const guarded = async (write, undo) => {
    await live();
    const result = await write();
    if (disconnected()) {
      await undo();
      throw new Stale();
    }
    return result;
  };
  // the server, the user or the device collection changed: the answer would belong to another collection
  const sameScope = () => scopeOf(user) === scope && (!owner || scopeOf(session?.user) === scope);
  const fence = { writeSecret: (next) => guarded(() => writeSecret(bridge, next, now()), () => deleteSecret(bridge)) };
  if (disconnected()) return { ran: false, reason: 'disconnected' };
  await patchState(bridge, { last_attempt: now() });
  try {
    const items = await fetchItems(bridge, secret, now, fence);
    let answer = { applied: [], unmatched: [] };
    if (!sameScope()) {
      await patchState(bridge, { last_attempt: null });
      return { ran: false, reason: 'scope' };
    }
    await live();
    if (items.length) {
      try {
        answer = (await post('/api/anime/watch-sync', crunchyroll.syncBody(items), { timeout: POST_TIMEOUT_MS })) || answer;
      } catch (err) {
        throw serverFailure(err);
      }
    }
    // the server's 30-second limit: it wrote nothing, so the stored list stays as it is
    if (answer.throttled) return { ran: false, reason: 'throttled' };
    const applied = Array.isArray(answer.applied) ? answer.applied.length : 0;
    // the collection has the progress now, also when 'Trennen' stops the rest below
    win?.dispatchEvent?.(new CustomEvent(WATCH_SYNC_EVENT, { detail: { service: SERVICE, applied, changed: applied > 0 } }));
    await guarded(() => saveUnmatched(bridge, scope, answer.unmatched), () => clearUnmatched(bridge));
    await live();
    await patchState(bridge, { last_ok: now(), last_error: null, last_error_at: null });
    return { ran: true, applied, unmatched: Array.isArray(answer.unmatched) ? answer.unmatched.length : 0 };
  } catch (err) {
    if (err instanceof Stale || disconnected()) return { ran: false, reason: 'disconnected' };
    const message = err instanceof SyncFailure ? err.message : SYNC_TEXTS.failed;
    console.warn('[Crunchyroll] Abgleich übersprungen:', message);
    if (err?.clearSecret) {
      await deleteSecret(bridge);
      await clearUnmatched(bridge);
    }
    await patchState(bridge, { last_error: message, last_error_at: now(), ...(err?.clearSecret ? { connected_at: null } : {}) });
    return { ran: true, error: message };
  }
}

/**
 * Starts the foreground triggers for a signed-in user (or an opened device collection): once now, then on every return
 * to the foreground (App appStateChange isActive). Returns stop(). No background task: whenUnlocked keychain items and
 * App Review both want foreground only.
 */
export function startWatchSync({ user, bridge = watchBridge(), now = Date.now } = {}) {
  if (!bridge || !canSync(user)) return () => {};
  const mine = { user };
  session = mine;
  let stopped = false;
  const trigger = () => {
    if (!stopped) runWatchSync({ bridge, user, now }).catch(() => {});
  };
  loadUnmatched(bridge, scopeOf(user)).catch(() => {}).then(trigger);
  const handle = Promise.resolve()
    .then(() => bridge.plugins.App?.addListener?.('appStateChange', ({ isActive } = {}) => { if (isActive) trigger(); }))
    .catch(() => null);
  return () => {
    stopped = true;
    if (session === mine) {
      session = null;
      resetUnmatchedView();
    }
    handle.then((h) => h?.remove?.()).catch(() => {});
  };
}

const isCancel = (err) => /cancel/i.test(String(err?.code || '')) || /cancel/i.test(String(err?.message || err || ''));

const randomId = () => {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * 'Mit Crunchyroll verbinden': the native login sheet; the cookie and client id go straight into the secure storage.
 * Resolves { connected: true } or { cancelled: true }; a failed login is written to the state and thrown.
 */
export async function connectCrunchyroll({ bridge = watchBridge(), now = Date.now } = {}) {
  generation += 1;
  let result;
  try {
    result = await bridge.plugins.WebLogin.open(crunchyroll.LOGIN_OPTIONS);
  } catch (err) {
    if (isCancel(err)) return { cancelled: true };
    await patchState(bridge, { last_error: SYNC_TEXTS.loginFailed, last_error_at: now() });
    throw new SyncFailure(SYNC_TEXTS.loginFailed);
  }
  const previous = await readSecret(bridge);
  const secret = crunchyroll.secretFromLogin(result, { deviceId: previous?.device_id || randomId(), now: now() });
  if (!secret) {
    await patchState(bridge, { last_error: SYNC_TEXTS.noCookie, last_error_at: now() });
    throw new SyncFailure(SYNC_TEXTS.noCookie);
  }
  await writeSecret(bridge, secret, now());
  await patchState(bridge, { enabled: true, connected_at: now(), last_attempt: null, last_error: null, last_error_at: null });
  return { connected: true };
}

/**
 * 'Trennen' (and the opt-out): secret, unmatched and skipped series and sync times go; the opt-out also switches the
 * feature off. A sync still running writes nothing back.
 */
export async function disconnectCrunchyroll({ bridge = watchBridge(), optOut = false } = {}) {
  generation += 1;
  await deleteSecret(bridge);
  await clearUnmatched(bridge);
  await clearSkipped(bridge);
  await patchState(bridge, {
    ...(optOut ? { enabled: false } : {}), connected_at: null, last_attempt: null, last_ok: null, last_error: null, last_error_at: null
  });
}

/** 'Jetzt abgleichen' and the first run after connecting: ignores the 15-minute floor, still single flight. */
export const syncNow = (options = {}) => runWatchSync({ ...options, force: true });
