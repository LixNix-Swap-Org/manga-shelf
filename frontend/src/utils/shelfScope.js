import { apiFetch, getApiBase, readJson } from './api';

// The shelf chosen in the collection toolbar narrows the collection, statistics, trash, shopping list and radar. It is
// remembered per server and account ('ALL' = every shelf of the user); the device-wide key of older builds is dropped.
const FILTER_KEY = 'mangashelf_shelf_filter';

export const isShelfId = (value) => typeof value === 'string' && /^\d+$/.test(value) && Number(value) > 0;

/** Server and account a remembered shelf filter or a loaded shelf list belongs to. */
export const shelvesScope = (userId) => `${getApiBase()}|${userId ?? ''}`;

export const shelfFilterKey = (userId) => `${FILTER_KEY}:${shelvesScope(userId)}`;

export function readShelfFilter(userId) {
  try {
    const value = window.localStorage.getItem(shelfFilterKey(userId));
    return isShelfId(value) ? value : 'ALL';
  } catch (_) {
    return 'ALL';
  }
}

export function writeShelfFilter(userId, value) {
  try {
    if (isShelfId(value)) window.localStorage.setItem(shelfFilterKey(userId), value);
    else window.localStorage.removeItem(shelfFilterKey(userId));
    window.localStorage.removeItem(FILTER_KEY);
  } catch (_) { /* storage unavailable */ }
}

/** '?shelf_id=3' (with prefix '&': '&shelf_id=3') for a chosen shelf, '' for every shelf. */
export function shelfQuery(shelfId, prefix = '?') {
  const id = String(shelfId ?? '');
  return isShelfId(id) ? `${prefix}shelf_id=${id}` : '';
}

// GET /api/shelves of the signed-in user, shared by the filter chip, the collection grid and the series page: one
// request per user at a time, an answer is reused for FRESH_MS. invalidateShelves() (a shelf changed, a scoped request
// answered 404) makes every mounted reader fetch again; the previous list stays visible until the new one arrives.
const FRESH_MS = 30 * 1000;
let state = { scope: null, list: null, at: 0, pending: null, token: null };
let version = 0;
let generation = 0;
const listeners = new Set();
const emit = () => {
  version += 1;
  listeners.forEach((listener) => listener());
};

export const subscribeShelves = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const shelvesVersion = () => version;
export const shelvesGeneration = () => generation;
export const shelvesOf = (scope) => (state.scope === scope ? state.list : null);

/** The shelves of `scope` ({ id, name, role, is_default, … }[]), or null without an answer. */
export function loadShelves(scope, { now = Date.now() } = {}) {
  if (state.scope !== scope) state = { scope, list: null, at: 0, pending: null, token: null };
  const current = state;
  if (current.pending) return current.pending;
  if (current.list && now - current.at < FRESH_MS) return Promise.resolve(current.list);
  const token = {};
  current.token = token;
  current.pending = apiFetch('/api/shelves')
    .then(async (res) => {
      if (!res.ok) return null;
      const data = await readJson(res);
      return Array.isArray(data?.shelves) ? data.shelves : null;
    })
    .catch(() => null)
    .then((list) => {
      if (state !== current || current.token !== token) return list;
      current.pending = null;
      if (list) {
        current.list = list;
        current.at = Date.now();
        emit();
      }
      return list ?? current.list;
    });
  return current.pending;
}

export function invalidateShelves() {
  state.at = 0;
  state.pending = null;
  state.token = null;
  generation += 1;
  emit();
}

/** Forgets the loaded list as well (nothing stays visible until the next answer). */
export function clearShelves() {
  state = { scope: null, list: null, at: 0, pending: null, token: null };
  generation += 1;
  emit();
}
