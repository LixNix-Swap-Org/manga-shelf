import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ChangePasswordModal from '../components/modals/ChangePasswordModal';

const fill = (current, next, repeat) => {
  fireEvent.change(screen.getByLabelText('Aktuelles Passwort'), { target: { value: current } });
  fireEvent.change(screen.getByLabelText('Neues Passwort (mind. 8 Zeichen)'), { target: { value: next } });
  fireEvent.change(screen.getByLabelText('Neues Passwort wiederholen'), { target: { value: repeat } });
  fireEvent.click(screen.getByRole('button', { name: 'Passwort ändern' }));
};

const reply = (status, body) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe('ChangePasswordModal', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<ChangePasswordModal isOpen={false} onClose={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('different new passwords: message, no request', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<ChangePasswordModal isOpen onClose={vi.fn()} />);
    fill('altes-passwort', 'neues-passwort-1', 'neues-passwort-2');
    expect(screen.getByText('Die beiden neuen Passwörter sind nicht gleich.')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the server error message', async () => {
    vi.stubGlobal('fetch', reply(400, { error: 'Aktuelles Passwort ist falsch.' }));
    render(<ChangePasswordModal isOpen onClose={vi.fn()} />);
    fill('falsch-falsch', 'neues-passwort', 'neues-passwort');
    expect((await screen.findByRole('alert')).textContent).toBe('Aktuelles Passwort ist falsch.');
  });

  it('sends PUT /api/auth/password and confirms', async () => {
    const fetchMock = reply(200, { ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<ChangePasswordModal isOpen onClose={vi.fn()} />);
    fill('altes-passwort', 'neues-passwort', 'neues-passwort');
    expect(await screen.findByText(/Dein Passwort wurde geändert/)).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/password');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ current_password: 'altes-passwort', new_password: 'neues-passwort' });
  });

  it('Escape closes the dialog', () => {
    const onClose = vi.fn();
    render(<ChangePasswordModal isOpen onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
