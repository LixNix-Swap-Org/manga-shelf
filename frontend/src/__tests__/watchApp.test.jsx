// App wiring of the Crunchyroll history sync: the scheduler start in App.jsx and the anime list reload.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// WATCH_BUILD is read when watchState loads (the build folds it)
vi.hoisted(() => { vi.stubEnv('VITE_APP_MODE', 'app'); });
import fs from 'fs';
import path from 'path';
import { fakeResponse } from './fakeResponse';
import { render, screen } from '@testing-library/react';
import { fakeBridge } from './watchFakes';
import { WATCH_SYNC_EVENT } from '../app/watch/watchState';

const sync = vi.hoisted(() => {
  const stop = vi.fn();
  return { stop, start: vi.fn(() => stop), loads: 0 };
});
vi.mock('../app/watch/crunchyrollSync.js', () => {
  sync.loads += 1;
  return { startWatchSync: sync.start };
});

import useWatchSync from '../app/watch/useWatchSync';
import SourcesPanel from '../app/SourcesPanel';
import useAnimeList from '../hooks/useAnimeList';

const EDITOR = { id: 3, role: 'editor' };

beforeEach(() => {
  vi.stubEnv('VITE_APP_MODE', 'app');
  window.mangashelfNative = fakeBridge().bridge.native;
  sync.start.mockClear();
  sync.stop.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete window.mangashelfNative;
  delete window.mangashelfDesktop;
  localStorage.clear();
});

describe('the desktop build without the watch bridge', () => {
  it('WATCH_BUILD true and no window.mangashelfDesktop.watch → no card and no crunchyrollSync import', async () => {
    // first test of the file: nothing has loaded the sync module yet
    expect(sync.loads).toBe(0);
    delete window.mangashelfNative;
    window.mangashelfDesktop = { platform: 'darwin', locale: 'de' };
    vi.stubEnv('VITE_APP_MODE', '');
    vi.stubEnv('VITE_WATCH_DESKTOP', '1');
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.endsWith('/api/sources/guides')) return fakeResponse(200, []);
      if (url.endsWith('/api/auth/api-keys')) return fakeResponse(200, []);
      if (url.endsWith('/api/admin/api-keys')) return fakeResponse(200, { keys: [] });
      return fakeResponse(404, { error: 'Nicht gefunden' });
    }));
    renderHook(() => useWatchSync(EDITOR, 'local'));
    render(<SourcesPanel headingLevel={2} />);
    await waitFor(() => expect(document.getElementById('local-sources')).toBeTruthy());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('heading', { name: /Crunchyroll/ })).toBeNull();
    expect(sync.start).not.toHaveBeenCalled();
    expect(sync.loads).toBe(0);

    window.mangashelfDesktop = { platform: 'darwin', watch: { platform: 'macos', onForeground: () => () => {} } };
    renderHook(() => useWatchSync(EDITOR, 'local'));
    await waitFor(() => expect(sync.start).toHaveBeenCalledTimes(1));
    expect(sync.loads).toBe(1);
  });
});

describe('useWatchSync (App.jsx)', () => {
  it('starts for a signed-in user, restarts on user or server change and stops on logout', async () => {
    const { rerender, unmount } = renderHook(({ user, scope }) => useWatchSync(user, scope), { initialProps: { user: EDITOR, scope: 'srv-1' } });
    await waitFor(() => expect(sync.start).toHaveBeenCalledTimes(1));
    expect(sync.start.mock.calls[0][0].user).toBe(EDITOR);
    rerender({ user: { ...EDITOR }, scope: 'srv-1' });
    await new Promise((r) => setTimeout(r, 10));
    expect(sync.start).toHaveBeenCalledTimes(1);
    rerender({ user: EDITOR, scope: 'srv-2' });
    await waitFor(() => expect(sync.start).toHaveBeenCalledTimes(2));
    expect(sync.stop).toHaveBeenCalledTimes(1);
    rerender({ user: null, scope: 'srv-2' });
    expect(sync.stop).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('not for offline users, without the WebLogin plugin, or in the web build', async () => {
    renderHook(() => useWatchSync({ ...EDITOR, offline: true }, 'srv-1'));
    delete window.mangashelfNative;
    renderHook(() => useWatchSync(EDITOR, 'srv-1'));
    window.mangashelfNative = fakeBridge().bridge.native;
    vi.stubEnv('VITE_APP_MODE', '');
    renderHook(() => useWatchSync(EDITOR, 'srv-1'));
    await new Promise((r) => setTimeout(r, 10));
    expect(sync.start).not.toHaveBeenCalled();
  });

  it('App.jsx wires it after the shell (main.jsx awaits installCapacitorShell before rendering App)', () => {
    const app = fs.readFileSync(path.resolve(import.meta.dirname, '../App.jsx'), 'utf8');
    expect(app).toMatch(/useWatchSync\(user, localMode \? 'local' : activeServer\?\.id/);
    // the sync code stays out of the start chunk
    expect(app).not.toMatch(/import .*crunchyrollSync/);
  });
});

describe('WATCH_BUILD (VITE_WATCH_CRUNCHYROLL=off drops the chunks)', () => {
  const read = (file) => fs.readFileSync(path.resolve(import.meta.dirname, '..', file), 'utf8');

  it('every lazy import of watch code is behind the one build constant', () => {
    expect(read('app/watch/watchState.js')).toContain(
      "export const WATCH_BUILD = (import.meta.env.VITE_APP_MODE === 'app' || import.meta.env.VITE_WATCH_DESKTOP === '1') && import.meta.env.VITE_WATCH_CRUNCHYROLL !== 'off';"
    );
    for (const file of ['components/modals/AccountModal.jsx', 'app/SourcesPanel.jsx', 'components/dashboard/AnimeView.jsx']) {
      const text = read(file);
      const imports = text.match(/import\('[^']*watch\/[^']+'\)/g) || [];
      expect(imports.length, file).toBeGreaterThan(0);
      expect(text.match(/WATCH_BUILD \? lazy\(\(\) => import\('[^']*watch\/[^']+'\)\)/g) || [], file).toHaveLength(imports.length);
    }
    expect(read('app/watch/watchState.js').match(/^export const WATCH_BUILD = .*$/gm)).toHaveLength(1);
    const hook = read('app/watch/useWatchSync.js');
    expect(hook.indexOf('if (!WATCH_BUILD) return undefined;')).toBeGreaterThan(-1);
    expect(hook.indexOf('if (!WATCH_BUILD) return undefined;')).toBeLessThan(hook.indexOf("import('./crunchyrollSync.js')"));
  });
});

describe('useAnimeList after a Crunchyroll sync', () => {
  it('reloads the shown list when the sync or the match dialog changed progress', async () => {
    vi.stubEnv('VITE_APP_MODE', '');
    const fetchMock = vi.fn(async () => fakeResponse(200, []));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAnimeList({ user: EDITOR }));
    await act(() => result.current.fetchAnime());
    const lists = () => fetchMock.mock.calls.filter(([url]) => url === '/api/anime').length;
    expect(lists()).toBe(1);
    const detail = (applied, added) => ({ service: 'crunchyroll', applied, added, changed: applied + added > 0, watch: null });
    act(() => { window.dispatchEvent(new CustomEvent(WATCH_SYNC_EVENT, { detail: detail(0, 0) })); });
    expect(lists()).toBe(1);
    act(() => { window.dispatchEvent(new CustomEvent(WATCH_SYNC_EVENT, { detail: detail(2, 0) })); });
    await waitFor(() => expect(lists()).toBe(2));
  });
});
