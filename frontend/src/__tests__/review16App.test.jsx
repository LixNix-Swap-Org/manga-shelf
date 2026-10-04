// Token rotation keeps the trusted addresses of the session.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AccountModal from '../components/modals/AccountModal';
import SystemModal from '../components/modals/SystemModal';
import UserManagementModal from '../components/modals/UserManagementModal';
import { rememberToken } from '../utils/api';
import { activateServer, getToken, resetConnection, setActiveBase, setToken } from '../app/connection';
import { getServer, resetServers, saveServer, setStorageAdapter } from '../app/serverStore';
import { recordToasts } from './toastLog';

const HOME = 'https://home.example';
const LAN = 'http://192.168.1.10:3000';
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function serve(routes) {
  const fn = vi.fn(async (url, init = {}) => {
    const handler = routes[`${init.method || 'GET'} ${url.replace(HOME, '')}`];
    return handler ? handler(init) : json(404, { error: 'Nicht gefunden' });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

let server;
let toasts;
beforeEach(() => {
  localStorage.clear();
  setStorageAdapter(null);
  resetServers();
  resetConnection();
  vi.stubEnv('VITE_APP_MODE', 'app');
  server = saveServer({ name: 'Zuhause', urls: [HOME, LAN], token: 'old', tokenOrigins: [HOME, LAN] });
  activateServer(server.id);
  setActiveBase(HOME);
  toasts = recordToasts();
});
afterEach(() => {
  toasts.stop();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const trustedAfterRotation = () => expect(getServer(server.id)).toMatchObject({ token: 'rotated', tokenOrigins: [HOME, LAN] });

describe('token rotation keeps the trusted addresses of the session (app build)', () => {
  it('rememberToken passes the options on; without rotate a token starts over at the active address', () => {
    rememberToken({ token: 'rotated' }, { rotate: true });
    trustedAfterRotation();
    rememberToken({ token: 'fresh' });
    expect(getServer(server.id)).toMatchObject({ token: 'fresh', tokenOrigins: [HOME] });
  });

  it('password change in the account dialog', async () => {
    serve({
      'PUT /api/auth/password': () => json(200, { success: true, token: 'rotated' }),
      'GET /api/sources/guides': () => json(200, []),
      'GET /api/auth/api-keys': () => json(200, [])
    });
    render(<AccountModal isOpen onClose={vi.fn()} user={{ id: 2, role: 'editor' }} initialTab="password" />);
    fireEvent.change(screen.getByLabelText('Aktuelles Passwort'), { target: { value: 'altes-passwort' } });
    fireEvent.change(screen.getByLabelText('Neues Passwort (mind. 8 Zeichen)'), { target: { value: 'neues-passwort' } });
    fireEvent.change(screen.getByLabelText('Neues Passwort wiederholen'), { target: { value: 'neues-passwort' } });
    fireEvent.click(screen.getByRole('button', { name: 'Passwort ändern' }));
    await screen.findByText(/Dein Passwort wurde geändert/);
    trustedAfterRotation();
    setActiveBase(LAN);
    expect(getToken()).toBe('rotated');
  });

  it('"Alle Sitzungen beenden" in the system dialog', async () => {
    serve({
      'GET /api/system': () => json(200, { version: '2.19.1', jobs: { running: [] } }),
      'POST /api/system/sessions/end-all': () => json(200, { success: true, users: 2, token: 'rotated' })
    });
    render(<SystemModal isOpen onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Alle Sitzungen beenden/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Ja, beenden' }));
    await waitFor(() => expect(toasts.messages('success')[0]).toMatch(/^Alle Sitzungen beendet/));
    trustedAfterRotation();
  });

  it('an own password reset in the user management', async () => {
    serve({
      'GET /api/users': () => json(200, [{ id: 1, username: 'admin', role: 'admin', created_at: '2026-01-01T00:00:00Z' }, { id: 2, username: 'erika', role: 'editor', created_at: '2026-02-01T00:00:00Z' }]),
      'PUT /api/users/2': () => json(200, { success: true, token: 'rotated' })
    });
    render(<UserManagementModal isOpen onClose={vi.fn()} currentUser={{ id: 1, username: 'admin', role: 'admin' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Passwort von erika zurücksetzen' }));
    fireEvent.change(screen.getByLabelText('Neues Passwort für erika'), { target: { value: 'ganz-neues-passwort' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zurücksetzen' }));
    await screen.findByText(/Neues Passwort für "erika" gesetzt/);
    trustedAfterRotation();
    setToken('relogin');
    expect(getServer(server.id).tokenOrigins).toEqual([HOME]);
  });
});
