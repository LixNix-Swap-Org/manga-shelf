// App wiring of the Crunchyroll history sync: the scheduler start in App.jsx and the anime list reload.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// WATCH_BUILD is read when watchState loads (the build folds it)
vi.hoisted(() => { vi.stubEnv('VITE_APP_MODE', 'app'); });
import fs from 'fs';
import path from 'path';
import { fakeResponse } from './fakeResponse';
import { fakeBridge } from './watchFakes';
import { WATCH_SYNC_EVENT } from '../app/watch/watchState';

const sync = vi.hoisted(() => {
  const stop = vi.fn();
  return { stop, start: vi.fn(() => stop) };
});
vi.mock('../app/watch/crunchyrollSync.js', () => ({ startWatchSync: sync.start }));

import useWatchSync from '../app/watch/useWatchSync';
import useAnimeList from '../hooks/useAnimeList';

const EDITOR = { id: 3, role: 'editor' };

beforeEach(() => {
  vi.stubEnv('VITE_APP_MODE', 'app');
  window.mangashelfNative = fakeBridge().bridge;
  sync.start.mockClear();
  sync.stop.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete window.mangashelfNative;
  localStorage.clear();
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
    window.mangashelfNative = fakeBridge().bridge;
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
    expect(read('app/watch/watchState.js')).toMatch(
      /export const WATCH_BUILD = import\.meta\.env\.VITE_APP_MODE === 'app' && import\.meta\.env\.VITE_WATCH_CRUNCHYROLL !== 'off';/
    );
    for (const file of ['components/modals/AccountModal.jsx', 'app/SourcesPanel.jsx', 'components/dashboard/AnimeView.jsx']) {
      const text = read(file);
      const imports = text.match(/import\('[^']*watch\/[^']+'\)/g) || [];
      expect(imports.length, file).toBeGreaterThan(0);
      expect(text.match(/WATCH_BUILD \? lazy\(\(\) => import\('[^']*watch\/[^']+'\)\)/g) || [], file).toHaveLength(imports.length);
    }
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
    act(() => { window.dispatchEvent(new CustomEvent(WATCH_SYNC_EVENT, { detail: { applied: 0, changed: false } })); });
    expect(lists()).toBe(1);
    act(() => { window.dispatchEvent(new CustomEvent(WATCH_SYNC_EVENT, { detail: { applied: 2, changed: true } })); });
    await waitFor(() => expect(lists()).toBe(2));
  });
});
