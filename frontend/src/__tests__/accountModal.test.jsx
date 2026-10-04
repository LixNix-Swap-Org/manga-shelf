// Covers the account modal, including local mode and source guides.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { fakeResponse } from './fakeResponse';

const mode = vi.hoisted(() => ({ local: false }));
vi.mock('../utils/api', async (importOriginal) => ({ ...(await importOriginal()), isLocalMode: () => mode.local }));

import AccountModal from '../components/modals/AccountModal';
import { setOpenExternal } from '../app/openExternal';
import { keyFormatError, stepLink } from '../components/modals/ApiKeyCard';

// the real guides as the server sends them (GET /api/sources/guides)
const GUIDES = JSON.parse(JSON.stringify(createRequire(import.meta.url)('../../../core/sources/guides.js').GUIDES));
const TOKEN = `eyJ0eXAiOiJKV1QifQ.${'a'.repeat(80)}.${'b'.repeat(30)}`;
const state = (provider, extra = {}) => ({ provider, configured: false, from_env: false, label: null, last4: null, allow_background: false, last_ok_at: null, last_error: null, ...extra });

function serve(extra = () => undefined) {
  const fetchMock = vi.fn(async (url, init = {}) => {
    const custom = extra(url, init);
    if (custom) return custom;
    if (url === '/api/sources/guides') return fakeResponse(200, GUIDES);
    if (url === '/api/auth/api-keys') return fakeResponse(200, [state('anilist'), state('mal')]);
    if (url === '/api/admin/api-keys') return fakeResponse(200, { keys: [state('mal', { configured: true, from_env: true, label: 'aus der Umgebung gesetzt' }), state('google_books')], users_with_keys: 1 });
    if (url === '/api/auth/api-keys/anilist' && init.method === 'PUT') return fakeResponse(200, state('anilist', { configured: true, label: 'kim-al', last4: TOKEN.slice(-4) }));
    return fakeResponse(404, { error: 'Nicht gefunden' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const openKeys = async (user) => {
  render(<AccountModal isOpen onClose={vi.fn()} user={user} initialTab="keys" />);
  return (await screen.findByRole('heading', { name: 'AniList' })).closest('section');
};

afterEach(() => {
  vi.unstubAllGlobals();
  mode.local = false;
});

describe('AccountModal: API keys', () => {
  it('sends the secret only to PUT /api/auth/api-keys/:provider and empties the field after success', async () => {
    const fetchMock = serve();
    const card = await openKeys({ id: 2, role: 'editor' });
    const field = within(card).getByLabelText(/Zugriffstoken/);
    expect(field.getAttribute('type')).toBe('password');
    expect(field.getAttribute('autocomplete')).toBe('off');
    fireEvent.change(field, { target: { value: TOKEN } });
    fireEvent.click(within(card).getByLabelText('Auch für automatische Aktualisierungen verwenden'));
    fireEvent.click(within(card).getByRole('button', { name: 'Prüfen & speichern' }));
    await waitFor(() => expect(within(card).getByTestId('key-state').textContent).toMatch(/verbunden als kim-al/));
    expect(field.value).toBe('');
    const withSecret = fetchMock.mock.calls.filter(([, init]) => init?.body && String(init.body).includes(TOKEN));
    expect(withSecret).toHaveLength(1);
    expect(withSecret[0][0]).toBe('/api/auth/api-keys/anilist');
    expect(withSecret[0][1].method).toBe('PUT');
    expect(JSON.parse(withSecret[0][1].body)).toEqual({ secret: TOKEN, allow_background: true });
  });

  it('the format check blocks the request; the sign-in link comes from the client id', async () => {
    const fetchMock = serve();
    const card = await openKeys({ id: 2, role: 'editor' });
    fireEvent.change(within(card).getByLabelText(/Zugriffstoken/), { target: { value: 'kurz' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Prüfen & speichern' }));
    expect(within(card).getByRole('alert').textContent).toMatch(/drei durch Punkte getrennte Teile/);
    expect(fetchMock.mock.calls.some(([u, i]) => u.startsWith('/api/auth/api-keys/') && i?.method === 'PUT')).toBe(false);

    fireEvent.click(within(card).getByRole('button', { name: /Schritt-für-Schritt-Anleitung/ }));
    expect(within(card).getByRole('link', { name: /anilist\.co\/settings\/developer/ }).getAttribute('target')).toBe('_blank');
    expect(within(card).getByText('https://anilist.co/api/v2/oauth/pin')).toBeTruthy();
    expect(within(card).queryByTestId('authorize-link')).toBeNull();
    fireEvent.change(within(card).getByLabelText('Client-ID'), { target: { value: '4242' } });
    expect(within(card).getByTestId('authorize-link').getAttribute('href')).toBe('https://anilist.co/api/v2/oauth/authorize?client_id=4242&response_type=token');
    expect(within(card).getByText(/Zugriff auf dein AniList-Konto/)).toBeTruthy();
  });

  it('admins see the instance section (environment marked), others do not', async () => {
    serve();
    await openKeys({ id: 1, role: 'admin' });
    const instance = await screen.findByTestId('instance-keys');
    expect(within(instance).getByRole('heading', { name: 'Für alle (Instanz)' })).toBeTruthy();
    expect(within(instance).getByText('aus der Umgebung gesetzt')).toBeTruthy();
    expect(within(instance).getByRole('heading', { name: 'Google Books' })).toBeTruthy();
  });

  it('card headings follow the outline (h3 under the dialog h2, h4 under the instance h3) and regions have unique names', async () => {
    serve();
    await openKeys({ id: 1, role: 'admin' });
    const instance = await screen.findByTestId('instance-keys');
    expect(screen.getByRole('heading', { name: 'Konto' }).tagName).toBe('H2');
    expect(screen.getByRole('heading', { name: 'AniList' }).tagName).toBe('H3');
    expect(within(instance).getByRole('heading', { name: 'Google Books' }).tagName).toBe('H4');
    const names = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label')).filter(Boolean);
    expect(names).toEqual(expect.arrayContaining(['MyAnimeList (persönlich)', 'MyAnimeList (für alle)']));
    expect(new Set(names).size).toBe(names.length);
  });

  it('visitors keep their own keys but get no instance section', async () => {
    const fetchMock = serve();
    await openKeys({ id: 3, role: 'visitor' });
    expect(screen.queryByTestId('instance-keys')).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => u === '/api/admin/api-keys')).toBe(false);
  });

  it('shows the refusal of the provider without storing anything', async () => {
    serve((url, init) => (url === '/api/auth/api-keys/anilist' && init.method === 'PUT' ? fakeResponse(400, { error: 'AniList lehnt den Token ab (401)' }) : undefined));
    const card = await openKeys({ id: 2, role: 'editor' });
    const field = within(card).getByLabelText(/Zugriffstoken/);
    fireEvent.change(field, { target: { value: TOKEN } });
    fireEvent.click(within(card).getByRole('button', { name: 'Prüfen & speichern' }));
    expect((await within(card).findByRole('alert')).textContent).toBe('AniList lehnt den Token ab (401)');
    expect(field.value).toBe(TOKEN);
    expect(within(card).getByTestId('key-state').textContent).toBe('nicht verbunden');
  });

  it('format helpers match core/sources/guides.js', () => {
    expect(keyFormatError(GUIDES[1], '0123456789abcdef0123456789abcdef')).toBeNull();
    expect(keyFormatError(GUIDES[1], '')).toBe('Bitte Client-ID eingeben.');
    expect(stepLink(GUIDES[0].steps.find((st) => st.linkTemplate), { client_id: 'x1' }, GUIDES[0].steps)).toBeNull();
  });
});

describe('AccountModal: tabs', () => {
  it('follows the ARIA tabs pattern: panel, roving tabIndex, arrow keys, Home and End', async () => {
    serve();
    render(<AccountModal isOpen onClose={vi.fn()} user={{ id: 2, role: 'editor' }} />);
    const password = screen.getByRole('tab', { name: 'Passwort' });
    const keys = screen.getByRole('tab', { name: 'API-Schlüssel' });
    const panel = screen.getByRole('tabpanel');
    expect(password.getAttribute('aria-controls')).toBe(panel.id);
    expect(keys.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(password.id);
    expect([password.tabIndex, keys.tabIndex]).toEqual([0, -1]);

    fireEvent.keyDown(password, { key: 'ArrowRight' });
    expect(keys.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(keys);
    expect([password.tabIndex, keys.tabIndex]).toEqual([-1, 0]);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(keys.id);
    expect(await screen.findByRole('heading', { name: 'AniList' })).toBeTruthy();

    fireEvent.keyDown(keys, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(password);
    expect(screen.getByLabelText('Aktuelles Passwort')).toBeTruthy();
    fireEvent.keyDown(password, { key: 'End' });
    expect(document.activeElement).toBe(keys);
    fireEvent.keyDown(keys, { key: 'Home' });
    expect(document.activeElement).toBe(password);
    fireEvent.keyDown(password, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(keys);
    fireEvent.keyDown(keys, { key: 'Enter' });
    expect(keys.getAttribute('aria-selected')).toBe('true');
  });
});

describe('AccountModal without a server (local mode)', () => {
  it('has no password tab, opens on the keys even when asked for the password', async () => {
    mode.local = true;
    serve();
    render(<AccountModal isOpen onClose={vi.fn()} user={{ id: 1, role: 'admin' }} initialTab="password" />);
    expect(await screen.findByRole('heading', { name: 'AniList' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /Passwort/ })).toBeNull();
    expect(screen.getByRole('tab', { name: /API-Schlüssel/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByLabelText('Aktuelles Passwort')).toBeNull();
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('API-Schlüssel');
  });

  it('with a server the password tab stays first', () => {
    serve();
    render(<AccountModal isOpen onClose={vi.fn()} user={{ id: 1, role: 'editor' }} />);
    expect(screen.getByRole('tab', { name: /Passwort/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText('Aktuelles Passwort')).toBeTruthy();
  });
});

describe('ApiKeyCard guide links', () => {
  it('open through openExternal (the shells use the system browser); modified clicks stay with the browser', async () => {
    serve();
    const opened = [];
    setOpenExternal((url) => opened.push(url));
    try {
      const card = await openKeys({ id: 2, role: 'editor' });
      fireEvent.click(within(card).getByRole('button', { name: /Schritt-für-Schritt-Anleitung/ }));
      const guide = within(card).getByRole('link', { name: /anilist\.co\/settings\/developer/ });
      expect(fireEvent.click(guide)).toBe(false);
      expect(opened).toEqual([guide.href]);
      fireEvent.change(within(card).getByLabelText('Client-ID'), { target: { value: '4242' } });
      fireEvent.click(within(card).getByTestId('authorize-link'));
      expect(opened[1]).toBe('https://anilist.co/api/v2/oauth/authorize?client_id=4242&response_type=token');
      expect(fireEvent.click(guide, { ctrlKey: true })).toBe(true);
      expect(opened).toHaveLength(2);
    } finally {
      setOpenExternal((url) => { globalThis.window?.open?.(url, '_blank', 'noopener,noreferrer'); });
    }
  });
});
