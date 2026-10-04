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
});
