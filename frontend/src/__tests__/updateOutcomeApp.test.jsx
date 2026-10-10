import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../utils/offlineStore', () => ({
  saveUser: vi.fn(async () => {}),
  loadUser: vi.fn(async () => null),
  loadMeta: vi.fn(async () => null),
  loadMangaList: vi.fn(async () => []),
  clearOfflineData: vi.fn(async () => {}),
  syncOfflineCopy: vi.fn(async () => true),
  formatAge: vi.fn(() => 'vor 5 Min.')
}));

vi.mock('../Dashboard', () => ({
  default: function DashboardStub({ user }) {
    return <p>Dashboard von {user.username}</p>;
  }
}));

import App from '../App';
import { UPDATE_RESULT_KEY, UPDATE_WATCH_KEY, getUpdateWatch, stopUpdateWatch } from '../utils/updateWatcher';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const admin = { id: 1, username: 'admin', role: 'admin' };

function signedIn() {
  vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const key = `${(init.method || 'GET').toUpperCase()} ${new URL(url, 'http://localhost').pathname}`;
    if (key === 'GET /api/setup/status') return json(200, { needsSetup: false });
    if (key === 'GET /api/auth/me') return json(200, { user: admin });
    throw new TypeError(`unexpected fetch ${key}`);
  }));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  stopUpdateWatch();
  sessionStorage.clear();
});

describe('update outcome after the reload', () => {
  it('shows "Aktualisiert auf v…" once on the shelf', async () => {
    sessionStorage.setItem(UPDATE_RESULT_KEY, JSON.stringify({ result: 'ok', version: '3.2.0', from: '3.0.0' }));
    signedIn();
    render(<App />);
    expect(await screen.findByText('Dashboard von admin')).toBeTruthy();
    expect(screen.getAllByText('Aktualisiert auf v3.2.0')).toHaveLength(1);
    expect(sessionStorage.getItem(UPDATE_RESULT_KEY)).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a rollback stays as a red toast', async () => {
    sessionStorage.setItem(UPDATE_RESULT_KEY, JSON.stringify({ result: 'rolled_back', version: '3.2.0', from: '3.0.0' }));
    signedIn();
    render(<App />);
    expect(await screen.findByText('Dashboard von admin')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('v3.2.0 ist nicht gestartet, die vorherige Version läuft wieder.');
  });

  it('a wait cut off by a manual reload goes on as a standing toast', async () => {
    sessionStorage.setItem(UPDATE_WATCH_KEY, JSON.stringify({ version: '3.2.0', from: '3.0.0', restart: 'supervised', acceptedAt: Date.now() - 5000 }));
    signedIn();
    render(<App />);
    expect(await screen.findByText('Dashboard von admin')).toBeTruthy();
    await waitFor(() => expect(getUpdateWatch()).toMatchObject({ phase: 'waiting', version: '3.2.0' }));
    expect(screen.getByText(/^Server startet neu auf v3\.2\.0 · Wartet seit/)).toBeTruthy();
  });
});
