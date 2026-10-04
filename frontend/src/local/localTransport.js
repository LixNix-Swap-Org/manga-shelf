// The `local` transport of utils/api.js: a request below /api goes to the standalone core on the device and comes back
// as a Response, so every caller (request, apiFetch, downloadFile) works unchanged. The core loads on first use.
import { getLocalProfile, setLocalProfile, storedModeIsLocal } from './profile.js';

let runtimePromise = null;
let runtime = null;
let adapters = {};
let blockedListener = null;

// the database lock of this window between two runtimes (reopen, profile switch): a waiting window must not get it
const keptLocks = new Map();
export const windowLocks = {
  keep(name, lock) {
    const previous = keptLocks.get(name);
    keptLocks.set(name, lock);
    if (previous && previous !== lock) previous.release();
  },
  take(name) {
    const lock = keptLocks.get(name) ?? null;
    keptLocks.delete(name);
    return lock;
  },
  releaseAll() {
    for (const lock of keptLocks.values()) lock.release();
    keptLocks.clear();
  }
};

/**
 * The apps plug in their own storage/http (see capacitor.js); call before the first request. `boot(profile)` replaces
 * the whole start (tests, shells with their own runtime).
 */
export function setLocalAdapters(next) {
  adapters = next || {};
}

/** Called once per host whose requests the browser blocks (CORS); App shows a notice. */
export function onSourceBlocked(listener) {
  blockedListener = listener;
}

// only the app build has the standalone mode: the web build drops the import (and sql.js, the wasm file, the core)
const loadBoot = () => (import.meta.env?.VITE_APP_MODE === 'app'
  ? import('./boot.js')
  : Promise.reject(new Error('Der Modus ohne Server gibt es nur in der App')));

export function getLocalRuntime() {
  if (!runtimePromise) {
    const options = { profile: getLocalProfile(), adapters, onBlocked: (host) => blockedListener?.(host) };
    runtimePromise = (adapters.boot ? Promise.resolve().then(() => adapters.boot(options)) : loadBoot().then(({ bootLocalRuntime }) => bootLocalRuntime(options)))
      .then((rt) => {
        runtime = rt;
        const profile = rt.getProfile();
        const stored = getLocalProfile();
        // a pending profile (negative id) of a window that does not hold the database yet is not remembered
        if (profile.id > 0 && (!stored || stored.id !== profile.id || stored.name !== profile.username)) setLocalProfile({ id: profile.id, name: profile.username });
        return rt;
      })
      .catch((err) => {
        runtimePromise = null;
        throw err;
      });
  }
  return runtimePromise;
}

/** The runtime once loaded (synchronous callers such as assetUrl), else null. */
export const loadedLocalRuntime = () => runtime;

/**
 * Closes the core; the next request opens it again. Still in the standalone mode (profile switch, reopen) this window
 * keeps the database lock for its next runtime; after leaving the mode the lock is given back.
 */
export async function resetLocalRuntime() {
  const current = runtimePromise;
  runtimePromise = null;
  runtime = null;
  const keepLock = storedModeIsLocal();
  if (current) await current.then((rt) => rt.close({ keepLock })).catch(() => {});
  if (!keepLock) windowLocks.releaseAll();
}

/** For tests: use this runtime instead of booting one. */
export function useLocalRuntime(rt) {
  runtime = rt;
  runtimePromise = rt ? Promise.resolve(rt) : null;
}

const NO_BODY = new Set([204, 205, 304]);

function abortError() {
  try { return new DOMException('Aborted', 'AbortError'); } catch (_) { return Object.assign(new Error('Aborted'), { name: 'AbortError' }); }
}

/** Upload paths keep their FormData; JSON bodies go through JSON like on the wire (undefined dropped, dates as text). */
function wireBody(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return body;
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch (_) { return body; }
  }
  return JSON.parse(JSON.stringify(body));
}

export async function localTransport(method, path, body, { signal } = {}) {
  if (signal?.aborted) throw abortError();
  const rt = await getLocalRuntime();
  if (signal?.aborted) throw abortError();
  const answer = await rt.request(method, path, wireBody(body));
  if (signal?.aborted) throw abortError();
  const headers = new Headers(answer.headers || {});
  const text = typeof answer.body === 'string';
  if (!headers.has('content-type')) headers.set('content-type', text ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
  const payload = NO_BODY.has(answer.status) || answer.body === undefined ? null : (text ? answer.body : JSON.stringify(answer.body));
  return new Response(payload, { status: answer.status, headers });
}

/** Blob URL of a local upload ('/uploads/<name>'), or null. */
export function localUploadUrl(path) {
  if (!runtime || typeof path !== 'string' || !path.startsWith('/uploads/')) return null;
  return runtime.files.urlFor(decodeURIComponent(path.slice('/uploads/'.length).split(/[?#]/)[0]));
}
