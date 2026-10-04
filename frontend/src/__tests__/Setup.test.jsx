import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Setup from '../Setup';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fillAndSubmit({ token = '', username = 'admin', password = 'password123' } = {}) {
  fireEvent.change(screen.getByLabelText('Einrichtungscode'), { target: { value: token } });
  fireEvent.change(screen.getByLabelText('Admin-Benutzername'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: /Admin-Konto anlegen/ }));
}

describe('Setup', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks for the setup code first and explains where it is', () => {
    render(<Setup onComplete={vi.fn()} />);
    const field = screen.getByLabelText('Einrichtungscode');
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute('autocomplete')).toBe('off');
    const hint = document.getElementById(field.getAttribute('aria-describedby'));
    expect(hint.textContent).toMatch(/Server-Konsole/);
    expect(hint.textContent).toMatch(/SETUP_TOKEN/);
  });

  it('sends the trimmed code with the account', async () => {
    const fetchMock = vi.fn(async () => json(200, { success: true }));
    vi.stubGlobal('fetch', fetchMock);
    const onComplete = vi.fn(async () => {});
    render(<Setup onComplete={onComplete} />);
    fillAndSubmit({ token: '  abcd-efgh-jkmn-pqrs ' });
    fireEvent.click(await screen.findByRole('button', { name: 'Überspringen' }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/setup');
    expect(JSON.parse(init.body)).toEqual({ username: 'admin', password: 'password123', setup_token: 'abcd-efgh-jkmn-pqrs' });
  });

  it('shows the server message for a wrong code and stays on the form', async () => {
    const message = 'Einrichtungscode fehlt oder ist falsch. Er steht in der Server-Konsole beim Start (oder in SETUP_TOKEN).';
    vi.stubGlobal('fetch', vi.fn(async () => json(403, { error: message, code: 'SETUP_TOKEN_INVALID' })));
    const onComplete = vi.fn();
    render(<Setup onComplete={onComplete} />);
    fillAndSubmit({ token: 'falsch' });
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Einrichtungscode').value).toBe('falsch');
  });

  it('offers the optional "Quellen verbinden" step after the account; instance keys go to the admin route', async () => {
    const guides = [
      { id: 'mal', name: 'MyAnimeList', scope: 'both', benefit: 'Offizielle API.', secretLabel: 'Client-ID', secretHint: '32 Zeichen', pattern: '^[0-9a-fA-F]{32}$', minLength: 32, formatError: 'Eine MyAnimeList-Client-ID besteht aus genau 32 Zeichen (0–9, a–f).', steps: [{ text: 'App anlegen', link: 'https://myanimelist.net/apiconfig' }] },
      { id: 'google_books', name: 'Google Books', scope: 'instance', benefit: 'ISBN.', secretLabel: 'API-Schlüssel', secretHint: 'AIza…', pattern: '^AIza[0-9A-Za-z_-]{35}$', minLength: 39, formatError: 'Ein Google-API-Schlüssel beginnt mit „AIza“ und hat 39 Zeichen.', steps: [{ text: 'Books API aktivieren', link: 'https://console.cloud.google.com/' }] }
    ];
    const keyState = (provider, extra = {}) => ({ provider, configured: false, from_env: false, label: null, last4: null, last_ok_at: null, last_error: null, ...extra });
    const fetchMock = vi.fn(async (url, init = {}) => {
      if (url === '/api/setup') return json(200, { success: true });
      if (url === '/api/sources/guides') return json(200, guides);
      if (url === '/api/admin/api-keys') return json(200, { keys: [keyState('mal'), keyState('google_books')], users_with_keys: 0 });
      if (url === '/api/admin/api-keys/mal' && init.method === 'PUT') return json(200, keyState('mal', { configured: true, label: 'Client-ID …cdef' }));
      return json(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    const onComplete = vi.fn(async () => {});
    render(<Setup onComplete={onComplete} />);
    fillAndSubmit({ token: 'abcd-efgh-jkmn-pqrs' });
    expect(await screen.findByRole('heading', { name: 'Quellen verbinden (später möglich)' })).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();
    const malCard = (await screen.findByRole('heading', { name: 'MyAnimeList' })).closest('section');
    const field = malCard.querySelector('input[type="password"]');
    fireEvent.change(field, { target: { value: 'zu-kurz' } });
    fireEvent.click(malCard.querySelector('button[type="submit"]'));
    expect((await screen.findByText(/genau 32 Zeichen/)).getAttribute('role')).toBe('alert');
    expect(fetchMock.mock.calls.some(([u, i]) => u === '/api/admin/api-keys/mal' && i?.method === 'PUT')).toBe(false);
    fireEvent.change(field, { target: { value: '0123456789abcdef0123456789abcdef' } });
    fireEvent.click(malCard.querySelector('button[type="submit"]'));
    await waitFor(() => expect(malCard.textContent).toMatch(/verbunden als Client-ID …cdef/));
    const put = fetchMock.mock.calls.find(([u, i]) => u === '/api/admin/api-keys/mal' && i?.method === 'PUT');
    expect(JSON.parse(put[1].body)).toEqual({ secret: '0123456789abcdef0123456789abcdef' });
    expect(field.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: /Weiter zur Sammlung/ }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });
});
