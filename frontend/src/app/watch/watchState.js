// Crunchyroll history (apps only): feature detection, the Preferences state and the unmatched series. Kept small and
// free of the sync code, because the anime tab and the account dialog import it in every build.
import { useMemo, useSyncExternalStore } from 'react';

export const SERVICE = 'crunchyroll';
export const WATCH_SYNC_EVENT = 'mangashelf:watch-sync';
export const STATE_KEY = 'watch-sync:crunchyroll:state';
export const UNMATCHED_KEY = 'watch-sync:crunchyroll:unmatched';
export const SKIPPED_KEY = 'watch-sync:crunchyroll:skipped';
const SKIPPED_LIMIT = 200;

// the one gate of every lazy watch import: Rollup drops the chunks when the build folds it to false
export const WATCH_BUILD = import.meta.env.VITE_APP_MODE === 'app' && import.meta.env.VITE_WATCH_CRUNCHYROLL !== 'off';

/** The native bridge when the feature exists here: app build, flag not 'off', WebLogin plugin present; else null. */
export function watchBridge(win = globalThis.window) {
  if (import.meta.env.VITE_APP_MODE !== 'app' || import.meta.env.VITE_WATCH_CRUNCHYROLL === 'off') return null;
  const bridge = win?.mangashelfNative;
  const p = bridge?.plugins;
  return p?.WebLogin && p.SecureStorage && p.Preferences ? bridge : null;
}

export const watchAvailable = (win) => Boolean(watchBridge(win));

/** Only editors write progress (POST /api/anime/watch-sync is an editor route); offline nothing is sent. */
export const canSync = (user) => Boolean(user) && !user.offline && (user.role === 'admin' || user.role === 'editor');

async function readJsonPref(bridge, key, fallback) {
  try {
    const raw = (await bridge.plugins.Preferences.get({ key }))?.value;
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

const writeJsonPref = (bridge, key, value) => bridge.plugins.Preferences.set({ key, value: JSON.stringify(value) });

const stateListeners = new Set();

/** { enabled, connected_at, last_attempt, last_ok, last_error, last_error_at } (all optional). */
export async function readState(bridge) {
  const state = await readJsonPref(bridge, STATE_KEY, {});
  return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
}

// read-modify-write in order, so a sync result never overwrites a toggle written meanwhile
let stateQueue = Promise.resolve();
export function patchState(bridge, patch) {
  const run = stateQueue.then(async () => {
    const next = { ...(await readState(bridge)), ...patch };
    await writeJsonPref(bridge, STATE_KEY, next);
    for (const fn of stateListeners) fn(next);
    return next;
  });
  stateQueue = run.catch(() => {});
  return run;
}

export function subscribeState(fn) {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}

let snapshot = { scope: null, items: [], skipped: [] };
const listeners = new Set();
const emit = (next) => {
  snapshot = next;
  for (const fn of listeners) fn();
};
const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

const cleanItems = (items) => (Array.isArray(items) ? items : [])
  .filter((u) => u && typeof u.external_id === 'string' && u.external_id && Number(u.episodes_watched ?? u.episode) > 0);

/** The stored unmatched series of this collection (scope = server or device + user); another scope starts empty. */
export async function loadUnmatched(bridge, scope) {
  const [stored, skipped] = await Promise.all([readJsonPref(bridge, UNMATCHED_KEY, null), readJsonPref(bridge, SKIPPED_KEY, [])]);
  emit({ scope, items: stored?.scope === scope ? cleanItems(stored.items) : [], skipped: Array.isArray(skipped) ? skipped : [] });
}

export async function saveUnmatched(bridge, scope, items) {
  const clean = cleanItems(items);
  await writeJsonPref(bridge, UNMATCHED_KEY, { scope, items: clean, at: Date.now() });
  if (snapshot.scope === scope) emit({ ...snapshot, items: clean });
}

export async function clearUnmatched(bridge) {
  emit({ ...snapshot, items: [] });
  if (bridge) await bridge.plugins.Preferences.remove({ key: UNMATCHED_KEY }).catch(() => {});
}

/** Logout or server switch: the tab of another collection must not see these series. */
export function resetUnmatchedView() {
  emit({ scope: null, items: [], skipped: snapshot.skipped });
}

/** One Crunchyroll series can span several entries (seasons): series id + season identify an unmatched item. */
export const unmatchedKey = (u) => `${u?.external_id}:${Number(u?.season) || 1}`;

/** A series confirmed in the dialog leaves the list at once (the next sync maps it through anime_links). */
export async function resolveUnmatched(bridge, item) {
  const key = unmatchedKey(item);
  const items = snapshot.items.filter((u) => unmatchedKey(u) !== key);
  emit({ ...snapshot, items });
  if (bridge && snapshot.scope) await writeJsonPref(bridge, UNMATCHED_KEY, { scope: snapshot.scope, items, at: Date.now() }).catch(() => {});
}

/** 'Überspringen': remembered on this device, the hint no longer counts the series. */
export async function skipUnmatched(bridge, item) {
  const key = unmatchedKey(item);
  const skipped = [...snapshot.skipped.filter((k) => k !== key), key].slice(-SKIPPED_LIMIT);
  emit({ ...snapshot, skipped });
  if (bridge) await writeJsonPref(bridge, SKIPPED_KEY, skipped).catch(() => {});
}

/** 'Trennen', the opt-out and 'Übersprungene wieder anzeigen': skipped series count again. */
export async function clearSkipped(bridge) {
  emit({ ...snapshot, skipped: [] });
  if (bridge) await bridge.plugins.Preferences.remove({ key: SKIPPED_KEY }).catch(() => {});
}

/** Skipped series stored on this device (read for the settings card, which may mount without the anime tab). */
export async function readSkipped(bridge) {
  const skipped = await readJsonPref(bridge, SKIPPED_KEY, []);
  return Array.isArray(skipped) ? skipped : [];
}

export const pendingUnmatched = (snap = snapshot) => snap.items.filter((u) => !snap.skipped.includes(unmatchedKey(u)));

const getSnapshot = () => snapshot;

/** The unmatched series still to confirm (skipped ones left out); always empty outside the apps. */
export function useWatchUnmatched() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => pendingUnmatched(snap), [snap]);
}
