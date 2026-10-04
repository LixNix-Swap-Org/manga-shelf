// Electron shell: server list storage adapter and desktop client mode.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installElectronShell, electronStorageAdapter, isElectronShell } from '../app/shell/electron';
import { SERVERS_KEY, ACTIVE_KEY, getServers, getActiveServer, saveServer, setStorageAdapter, resetServers } from '../app/serverStore';
import { openExternal, setOpenExternal } from '../app/openExternal';
import { OPEN_URL_EVENT, installDeepLinkBridge, buildShareLink, takePendingShare, takePendingDeepLink } from '../app/deepLink';

const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeBridge(initial = {}) {
  const data = { ...initial };
  const listeners = { url: [], resume: [] };
  const bridge = {
    appBuild: true,
    platform: 'darwin',
    storage: {
      getSync: vi.fn((key) => (key in data ? data[key] : null)),
      get: vi.fn(async (key) => (key in data ? data[key] : null)),
      set: vi.fn(async (key, value) => { data[key] = value; }),
      remove: vi.fn(async (key) => { delete data[key]; })
    },
    openExternal: vi.fn(),
    onOpenUrl: vi.fn((cb) => { listeners.url.push(cb); return () => { listeners.url = listeners.url.filter((f) => f !== cb); }; }),
    onResume: vi.fn((cb) => { listeners.resume.push(cb); return () => { listeners.resume = listeners.resume.filter((f) => f !== cb); }; })
  };
  return { bridge, data, listeners };
}

let uninstall = null;

beforeEach(() => {
  localStorage.clear();
  setStorageAdapter(null);
  resetServers();
});

afterEach(() => {
  if (typeof uninstall === 'function') uninstall();
  uninstall = null;
  delete window.mangashelfDesktop;
  delete window.mangashelfOpenUrl;
  setStorageAdapter(null);
  setOpenExternal((url) => window.open(url, '_blank', 'noopener,noreferrer'));
});

describe('Electron shell (desktop client mode)', () => {
  it('does nothing outside the Electron app build', () => {
    expect(installElectronShell(window)).toBe(false);
    expect(isElectronShell(window)).toBe(false);
    window.mangashelfDesktop = { appBuild: false, storage: null, openExternal: vi.fn() };
    expect(installElectronShell(window)).toBe(false);
    expect(installElectronShell(undefined)).toBe(false);
  });

  it('keeps saved servers and tokens in the safeStorage bridge, readable before the app mounts', async () => {
    const servers = JSON.stringify([{ id: 'srv-1', name: 'Zuhause', urls: ['https://manga.example.org'], token: 'jwt-1' }]);
    const { bridge, data } = fakeBridge({ [SERVERS_KEY]: servers, [ACTIVE_KEY]: 'srv-1' });
    window.mangashelfDesktop = bridge;
    uninstall = installElectronShell(window);
    expect(typeof uninstall).toBe('function');
    expect(isElectronShell(window)).toBe(true);
    expect(getActiveServer()).toMatchObject({ id: 'srv-1', name: 'Zuhause', token: 'jwt-1' });

    saveServer({ name: 'Büro', urls: ['https://buero.example.org'] });
    await flush();
    expect(JSON.parse(data[SERVERS_KEY]).map((s) => s.name)).toEqual(['Zuhause', 'Büro']);
    expect(localStorage.getItem(SERVERS_KEY) ?? '').not.toContain('jwt-1');
    expect(localStorage.getItem(SERVERS_KEY) ?? '').not.toContain('Büro');
    expect(getServers()).toHaveLength(2);
  });

  it('opens links in the system browser through the bridge', () => {
    const { bridge } = fakeBridge();
    window.mangashelfDesktop = bridge;
    uninstall = installElectronShell(window);
    expect(openExternal('https://anilist.co/settings/developer')).toBe(true);
    expect(bridge.openExternal).toHaveBeenCalledWith('https://anilist.co/settings/developer');
    expect(openExternal('javascript:alert(1)')).toBe(false);
    expect(bridge.openExternal).toHaveBeenCalledTimes(1);
  });

  it('hands manga-shelf://connect links to the app (bridge function or event)', () => {
    const { bridge, listeners } = fakeBridge();
    window.mangashelfDesktop = bridge;
    uninstall = installElectronShell(window);
    const link = 'manga-shelf://connect?url=http%3A%2F%2F192.168.1.10%3A3000';
    const seen = [];
    const onEvent = (e) => seen.push(e.detail.url);
    window.addEventListener(OPEN_URL_EVENT, onEvent);
    listeners.url[0](link);
    expect(seen).toEqual([link]);
    window.mangashelfOpenUrl = vi.fn();
    listeners.url[0](link);
    listeners.url[0]('');
    expect(window.mangashelfOpenUrl).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    window.removeEventListener(OPEN_URL_EVENT, onEvent);
    uninstall();
    expect(listeners.url).toHaveLength(0);
  });

  it('hands manga-shelf://share links the same way: a share, not a connect prompt', () => {
    const { bridge, listeners } = fakeBridge();
    window.mangashelfDesktop = bridge;
    const offBridge = installDeepLinkBridge(window);
    uninstall = installElectronShell(window);
    try {
      const opened = vi.spyOn(window, 'mangashelfOpenUrl');
      const text = 'https://www.crunchyroll.com/de/watch/GX9UQE0WJ/the-journeys-end';
      const link = buildShareLink({ text });
      listeners.url[0](link);
      expect(opened).toHaveBeenCalledWith(link);
      expect(takePendingShare()).toMatchObject({ text });
      expect(takePendingDeepLink()).toBeNull();
    } finally {
      offBridge();
    }
  });

  it('preferApp needs nothing extra: the system browser already hands app links on', () => {
    const { bridge } = fakeBridge();
    window.mangashelfDesktop = bridge;
    uninstall = installElectronShell(window);
    expect(openExternal('https://www.crunchyroll.com/de/series/GG5H5XQX4/frieren', { preferApp: true })).toBe(true);
    expect(bridge.openExternal).toHaveBeenCalledWith('https://www.crunchyroll.com/de/series/GG5H5XQX4/frieren');
  });

  it('checks the connection again after the computer wakes up', async () => {
    const { bridge, listeners } = fakeBridge();
    window.mangashelfDesktop = bridge;
    const recheck = vi.fn(() => Promise.reject(new Error('offline')));
    uninstall = installElectronShell(window, { recheck });
    listeners.resume[0]();
    await flush();
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it('storage adapter passes string values through', async () => {
    const { bridge, data } = fakeBridge({ a: '1' });
    const adapter = electronStorageAdapter(bridge.storage);
    expect(adapter.getSync('a')).toBe('1');
    expect(await adapter.get('b')).toBeNull();
    await adapter.set('b', '2');
    await adapter.remove('a');
    expect(data).toEqual({ b: '2' });
  });
});
