// Fakes for the Crunchyroll history tests (watch*.test.jsx): the native bridge of version 3 and a scripted Crunchyroll.
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

/** In-memory plugins of mobile/src/native-bridge.mjs (version 3) plus a scripted Crunchyroll behind WebLogin.request. */
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
  const bridge = { version: 3, platform: 'ios', plugins, constants: { KeychainAccess: { whenUnlocked: 0, whenUnlockedThisDeviceOnly: 1 } } };
  const emit = (event, data) => (listeners[event] || []).forEach((fn) => fn(data));
  return { bridge, prefs, secure, calls, answers, emit, listeners };
}
