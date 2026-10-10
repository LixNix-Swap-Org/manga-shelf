// Fakes for the Crunchyroll history tests (watch*.test.jsx): the native bridge of version 3 with a scripted Crunchyroll, and
// the desktop watch bridge.
import { vi } from 'vitest';

export const COOKIE = 'etpRtCookieValue-0123456789';
export const ROTATED = 'etpRtRotatedValue-9876543210';
export const ACCESS = 'access-token-abcdef';
export const EDITOR = { id: 3, role: 'editor', username: 'kim' };

export const historyRecord = ({ series = 'GSERIES001', title = 'Sousou no Frieren', episode = 7, season = 1, fully = true } = {}) => ({
  panel: {
    id: `GEP${series.slice(-4)}${episode}X`, type: 'episode', slug_title: 'folge',
    episode_metadata: { series_id: series, series_title: title, season_number: season, episode_number: episode, duration_ms: 1440000 }
  },
  playhead: fully ? 1440 : 300,
  fully_watched: fully,
  date_played: '2026-10-01T20:00:00Z'
});

/** `.bridge` is the watchBridge() value of the apps; `.bridge.native` the in-memory window.mangashelfNative (version 3). */
export function fakeBridge({ token = {}, history = { data: [historyRecord()] }, discover = { data: [] }, connected = true } = {}) {
  const prefs = new Map();
  const secure = new Map();
  const listeners = {};
  const calls = [];
  const answers = {
    token: { status: 200, text: JSON.stringify({ access_token: ACCESS, account_id: 'acc-1', expires_in: 300 }), headers: {}, cookies: [], ...token },
    me: { status: 200, text: JSON.stringify({ account_id: 'acc-1' }), headers: {} },
    watch: { status: 200, text: JSON.stringify(history), headers: {} },
    discover: { status: 200, text: JSON.stringify(discover), headers: {} }
  };
  const plugins = {
    Preferences: {
      get: vi.fn(async ({ key }) => ({ value: prefs.has(key) ? prefs.get(key) : null })),
      set: vi.fn(async ({ key, value }) => { prefs.set(key, value); }),
      remove: vi.fn(async ({ key }) => { prefs.delete(key); })
    },
    SecureStorage: {
      get: vi.fn(async (key) => (secure.has(key) ? JSON.parse(secure.get(key).data) : null)),
      set: vi.fn(async (key, data, convertDate, sync, access) => { secure.set(key, { data: JSON.stringify(data), convertDate, sync, access }); }),
      remove: vi.fn(async (key) => secure.delete(key))
    },
    Network: { getStatus: vi.fn(async () => ({ connected })) },
    App: {
      addListener: vi.fn(async (event, fn) => {
        (listeners[event] ||= []).push(fn);
        return { remove: vi.fn(() => { listeners[event] = listeners[event].filter((f) => f !== fn); }) };
      })
    },
    WebLogin: {
      open: vi.fn(async () => ({ cookie: { value: COOKIE, expires: null }, scriptResult: JSON.stringify({ accountAuthClientId: 'webClient_123' }) })),
      request: vi.fn(async (req) => {
        calls.push(req);
        if (req.url.endsWith('/auth/v1/token')) return answers.token;
        if (req.url.endsWith('/accounts/v1/me')) return answers.me;
        if (req.url.includes('/watch-history')) return answers.watch;
        if (req.url.includes('/discover/')) return answers.discover;
        return { status: 404, text: '', headers: {} };
      })
    }
  };
  const native = { version: 3, platform: 'ios', plugins, constants: { KeychainAccess: { whenUnlocked: 0, whenUnlockedThisDeviceOnly: 1 } } };
  const bridge = { kind: 'capacitor', platform: 'ios', native };
  const emit = (event, data) => (listeners[event] || []).forEach((fn) => fn(data));
  return { bridge, prefs, secure, calls, answers, emit, listeners };
}

const PREF_KEYS = ['watch-sync:crunchyroll:state', 'watch-sync:crunchyroll:unmatched', 'watch-sync:crunchyroll:skipped'];
const PREF_LIMIT = 262144;

/**
 * window.mangashelfDesktop.watch of the preload with scripted answers (each an object or a function of the call); `calls` lists
 * every `{ method, args }` in order, `foreground()` fires the onForeground callbacks. Tests install `{ watch }` themselves.
 */
export function fakeDesktopBridge({
  platform = 'macos', status = { ok: true, available: true, connected: true }, login = { ok: true }, sync = { ok: true, items: [] }
} = {}) {
  const prefs = new Map();
  const calls = [];
  const foregroundListeners = new Set();
  const call = (method, answer) => vi.fn(async (...args) => {
    const entry = { method, args };
    calls.push(entry);
    return typeof answer === 'function' ? answer(entry) : answer;
  });
  const prefsAnswer = (method, fn) => vi.fn(async (...args) => {
    calls.push({ method, args });
    const [key, value] = args;
    if (!PREF_KEYS.includes(key)) return { ok: false, code: 'not_allowed' };
    return fn(key, value);
  });
  const watch = {
    platform,
    status: call('status', status),
    login: call('login', login),
    sync: call('sync', sync),
    logout: call('logout', { ok: true }),
    prefs: {
      get: prefsAnswer('prefs.get', (key) => ({ ok: true, value: prefs.has(key) ? prefs.get(key) : null })),
      set: prefsAnswer('prefs.set', (key, value) => {
        if (typeof key !== 'string' || typeof value !== 'string') return { ok: false, code: 'not_allowed' };
        if (new TextEncoder().encode(value).length > PREF_LIMIT) return { ok: false, code: 'too_large' };
        prefs.set(key, value);
        return { ok: true };
      }),
      remove: prefsAnswer('prefs.remove', (key) => {
        prefs.delete(key);
        return { ok: true };
      })
    },
    onForeground: vi.fn((cb) => {
      calls.push({ method: 'onForeground', args: [cb] });
      foregroundListeners.add(cb);
      return () => foregroundListeners.delete(cb);
    })
  };
  const bridge = { kind: 'desktop', platform, watch };
  const foreground = () => [...foregroundListeners].forEach((cb) => cb());
  return { bridge, watch, prefs, calls, foreground, foregroundListeners };
}
