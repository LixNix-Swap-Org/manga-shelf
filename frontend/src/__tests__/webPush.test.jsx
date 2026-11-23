// Release-day reminders by Web Push in the browser (U7): feature check, subscribe/unsubscribe against the server routes,
// the settings switch, the logout hook and the service worker's push and click handlers.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { webPushSupport, keyBytes, pushTexts, enableWebPush, disableWebPush, installWebPushLogout, canWebPush } from '../utils/webPush';
import WebPushSwitch from '../components/modals/WebPushSwitch';
import { runBeforeLogout } from '../appShell';
import { fakeResponse } from './fakeResponse';

const swSource = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/sw.js'), 'utf8');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SERVER_KEY = btoa(String.fromCharCode(4, ...new Array(64).fill(7))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function fakeSubscription(endpoint = 'https://fcm.googleapis.com/fcm/send/abc', key = keyBytes(SERVER_KEY)) {
  const sub = {
    endpoint,
    options: { applicationServerKey: key.buffer },
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'P', auth: 'A' } }),
    unsubscribe: vi.fn(async () => true)
  };
  return sub;
}

function fakeNav(existing = null) {
  let current = existing;
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async () => { current = fakeSubscription(); return current; })
  };
  const reg = { pushManager };
  return { serviceWorker: { ready: Promise.resolve(reg), getRegistration: vi.fn(async () => reg) }, pushManager };
}

function stubServer() {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push([init.method || 'GET', String(url), body]);
    if (String(url) === '/api/push/key') return fakeResponse(200, { publicKey: SERVER_KEY });
    if (String(url) === '/api/push/subscriptions/status') return fakeResponse(200, { subscribed: true, hour: 7, mode: 'day', volumes: true, episodes: false, loans: true });
    return fakeResponse(200, { success: true });
  }));
  return calls;
}

describe('web push helpers', () => {
  it('needs a secure context, a service worker, PushManager and Notification', () => {
    const win = (extra) => ({ navigator: { serviceWorker: {} }, isSecureContext: true, PushManager: {}, Notification: {}, ...extra });
    expect(webPushSupport(win())).toBe('ok');
    expect(webPushSupport(win({ isSecureContext: false }))).toBe('insecure');
    const noPush = win();
    delete noPush.PushManager;
    expect(webPushSupport(noPush)).toBe('unsupported');
    expect(webPushSupport(null)).toBe('unsupported');
    expect(canWebPush({ role: 'editor' })).toBe(true);
    expect(canWebPush({ role: 'guest' })).toBe(false);
    expect(canWebPush({ role: 'admin', offline: true })).toBe(false);
  });

  it('keyBytes decodes base64url; the texts carry every template', () => {
    expect(Array.from(keyBytes('AQID_-8'))).toEqual([1, 2, 3, 255, 239]);
    expect(Object.keys(pushTexts()).sort()).toEqual(['box', 'episode', 'loan', 'loanTitle', 'more', 'test', 'title', 'tomorrow', 'volume', 'week', 'weekdays']);
    expect(pushTexts().weekdays.split(',')).toHaveLength(7);
    expect(pushTexts().episode).toBe('{title} – Folge {episode}');
  });

  it('enable asks for the permission, subscribes with the server key and stores the subscription with the texts', async () => {
    const calls = stubServer();
    const nav = fakeNav();
    const notification = { permission: 'default', requestPermission: vi.fn(async () => 'granted') };
    expect(await enableWebPush({ nav, notification })).toEqual({ enabled: true });
    expect(nav.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: keyBytes(SERVER_KEY) });
    const [method, url, body] = calls.at(-1);
    expect([method, url]).toEqual(['PUT', '/api/push/subscriptions']);
    expect(body.endpoint).toBe('https://fcm.googleapis.com/fcm/send/abc');
    expect(body.texts.title).toBe('Heute neu erschienen');
    expect(body).not.toHaveProperty('hour');
  });

  it('a denied permission subscribes nothing; a subscription with another key is replaced', async () => {
    stubServer();
    const nav = fakeNav();
    expect(await enableWebPush({ nav, notification: { permission: 'default', requestPermission: async () => 'denied' } })).toEqual({ enabled: false, denied: true });
    expect(nav.pushManager.subscribe).not.toHaveBeenCalled();

    const old = fakeSubscription('https://fcm.googleapis.com/fcm/send/old', new Uint8Array(65).fill(1));
    const nav2 = fakeNav(old);
    await enableWebPush({ nav: nav2, notification: { permission: 'granted' } });
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(nav2.pushManager.subscribe).toHaveBeenCalled();
  });

  it('disable tells the server and drops the browser subscription', async () => {
    const calls = stubServer();
    const sub = fakeSubscription();
    expect(await disableWebPush({ nav: fakeNav(sub) })).toEqual({ enabled: false });
    expect(calls).toContainEqual(['DELETE', '/api/push/subscriptions', { endpoint: sub.endpoint }]);
    expect(sub.unsubscribe).toHaveBeenCalled();
  });

  it('a logout ends the reminders of this browser while the session is valid', async () => {
    const calls = stubServer();
    const sub = fakeSubscription();
    const target = new EventTarget();
    const stop = installWebPushLogout(target, fakeNav(sub));
    await runBeforeLogout({ target });
    expect(calls).toContainEqual(['DELETE', '/api/push/subscriptions', { endpoint: sub.endpoint }]);
    expect(sub.unsubscribe).toHaveBeenCalled();
    stop();
  });
});

describe('settings switch', () => {
  it('is greyed out with the reason on plain http', () => {
    render(<WebPushSwitch env={{ navigator: { serviceWorker: {} }, isSecureContext: false }} />);
    expect(screen.getByRole('checkbox', { name: 'Erinnerungen am Erscheinungstag' }).disabled).toBe(true);
    expect(screen.getByText('Geht nur, wenn Manga Shelf über HTTPS aufgerufen wird.')).toBeTruthy();
  });

  it('shows the server state and the choices while on, and stores a change', async () => {
    const calls = stubServer();
    const sub = fakeSubscription();
    vi.stubGlobal('navigator', { ...globalThis.navigator, ...fakeNav(sub) });
    render(<WebPushSwitch env={{ navigator: { serviceWorker: {} }, isSecureContext: true, PushManager: {}, Notification: {} }} />);
    const box = screen.getByRole('checkbox', { name: 'Erinnerungen am Erscheinungstag' });
    await waitFor(() => expect(box.checked).toBe(true));
    expect(calls[0]).toEqual(['POST', '/api/push/subscriptions/status', { endpoint: sub.endpoint }]);
    const hour = screen.getByRole('combobox', { name: 'Uhrzeit' });
    expect(hour.value).toBe('7');
    fireEvent.change(hour, { target: { value: '18' } });
    await waitFor(() => expect(calls.some(([m, u, b]) => m === 'PUT' && u === '/api/push/subscriptions' && b?.hour === 18)).toBe(true));
    expect(hour.value).toBe('18');
    const when = screen.getByRole('combobox', { name: 'Wann' });
    expect(when.value).toBe('day');
    fireEvent.change(when, { target: { value: 'week' } });
    await waitFor(() => expect(calls.some(([m, , b]) => m === 'PUT' && b?.mode === 'week')).toBe(true));
    expect(screen.getByRole('option', { name: 'Einmal pro Woche (montags)' }).selected).toBe(true);
    const episodes = screen.getByRole('checkbox', { name: 'Neue Anime-Folgen' });
    expect(episodes.checked).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Überfällige Ausleihen' }));
    await waitFor(() => expect(calls.some(([m, , b]) => m === 'PUT' && b?.loans === false)).toBe(true));
    // the last one left cannot be switched off
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Neue Bände' }).disabled).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Test senden' }));
    await waitFor(() => expect(calls.some(([m, u]) => m === 'POST' && u === '/api/push/test')).toBe(true));
  });
});

describe('service worker', () => {
  function loadWorker() {
    const listeners = {};
    const shown = [];
    const tabs = [];
    const self = {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: vi.fn(),
      location: { origin: 'https://shelf.example' },
      registration: { showNotification: vi.fn(async (title, options) => { shown.push({ title, ...options }); }) },
      clients: { claim: vi.fn(), matchAll: vi.fn(async () => tabs), openWindow: vi.fn(async () => null) }
    };
    new Function('self', 'caches', 'fetch', 'Response', 'URL', 'console', swSource)(self, {}, vi.fn(), Response, URL, { warn: () => {} });
    const dispatch = async (type, event) => {
      let pending;
      listeners[type]({ ...event, waitUntil: (p) => { pending = p; } });
      await pending;
    };
    return { self, shown, tabs, dispatch };
  }

  it('shows the pushed reminder and keeps only same-site links', async () => {
    const w = loadWorker();
    await w.dispatch('push', { data: { json: () => ({ title: 'Heute neu erschienen', body: 'A\nB', url: '/?view=radar', tag: 'release-day-2026-11-22' }) } });
    expect(w.shown[0]).toMatchObject({ title: 'Heute neu erschienen', body: 'A\nB', tag: 'release-day-2026-11-22', data: { url: '/?view=radar' } });
    await w.dispatch('push', { data: { json: () => ({ title: 'x', url: '//evil.example/' }) } });
    expect(w.shown[1].data.url).toBe('/');
    await w.dispatch('push', { data: { json: () => { throw new Error('not json'); } } });
    expect(w.shown[2].title).toBe('Manga Shelf');
  });

  it('a tap focuses an open tab on the target, else opens one', async () => {
    const w = loadWorker();
    const notification = { close: vi.fn(), data: { url: '/?view=radar' } };
    await w.dispatch('notificationclick', { notification });
    expect(notification.close).toHaveBeenCalled();
    expect(w.self.clients.openWindow).toHaveBeenCalledWith('https://shelf.example/?view=radar');
    const tab = { url: 'https://shelf.example/', focus: vi.fn(async () => {}), navigate: vi.fn(async () => {}) };
    w.tabs.push(tab);
    await w.dispatch('notificationclick', { notification });
    expect(tab.focus).toHaveBeenCalled();
    expect(tab.navigate).toHaveBeenCalledWith('https://shelf.example/?view=radar');
  });
});
