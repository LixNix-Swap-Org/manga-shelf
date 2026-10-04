// syncOfflineCopy and what it hands to the device runtime.
import { describe, it, expect, vi, afterEach } from 'vitest';

const local = vi.hoisted(() => ({ calls: [] }));
vi.mock('../local/localTransport', async (importOriginal) => ({
  ...(await importOriginal()),
  localTransport: vi.fn(async (...args) => { local.calls.push(args); return new Response('{}', { status: 500 }); })
}));

import { syncOfflineCopy } from '../utils/offlineStore';
import { fakeResponse } from './fakeResponse';

afterEach(() => {
  localStorage.removeItem('mangashelf_mode');
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('syncOfflineCopy', () => {
  it('does nothing in the local mode (the device reads its own database)', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(500, {}));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('VITE_APP_MODE', 'app');
    localStorage.setItem('mangashelf_mode', 'local');
    expect(await syncOfflineCopy({ force: true })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(local.calls).toEqual([]);
  });

  it('downloads the snapshot otherwise', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(500, {}));
    vi.stubGlobal('fetch', fetchMock);
    expect(await syncOfflineCopy({ force: true })).toBe(false);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/offline-snapshot']);
  });
});
