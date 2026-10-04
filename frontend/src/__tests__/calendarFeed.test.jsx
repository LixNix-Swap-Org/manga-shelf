// Covers the personal calendar feed address and token handling in the radar summary.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { fakeResponse } from './fakeResponse';
import { recordToasts } from './toastLog';
import PersonalSummary, { feedAddress } from '../components/dashboard/radar/PersonalSummary';

const TOKEN_A = 'a'.repeat(43);
const TOKEN_B = 'b'.repeat(43);
const active = (token, extra = {}) => ({
  active: true, path: `/api/radar/feed.ics?token=${token}`, url: `http://intern:3000/api/radar/feed.ics?token=${token}`,
  created_at: '2026-10-04T10:00:00Z', last_used_at: null, unreadable: false, ...extra
});

function serve(initial) {
  let state = initial;
  let next = TOKEN_A;
  const fetchMock = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    if (url !== '/api/radar/feed-token') return fakeResponse(404, { error: 'Nicht gefunden' });
    if (method === 'GET') return fakeResponse(200, state);
    if (method === 'POST') {
      state = active(next);
      next = TOKEN_B;
      return fakeResponse(200, state);
    }
    if (method === 'DELETE') {
      state = { active: false, path: null, url: null, created_at: null, last_used_at: null, unreadable: false };
      return fakeResponse(200, { success: true, removed: 1 });
    }
    return fakeResponse(405, { error: 'Methode nicht erlaubt' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const renderSummary = () => render(<PersonalSummary radarData={null} loadingRadar={false} fetchReleaseRadar={vi.fn()} />);
const openPanel = async () => {
  const toggle = screen.getByRole('button', { name: 'Kalender abonnieren' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  return document.getElementById('radar-calendar-feed');
};
const methods = (fetchMock) => fetchMock.mock.calls.map(([, init]) => init?.method || 'GET');

let toasts;
beforeEach(() => { toasts = recordToasts(); });
afterEach(() => {
  toasts.stop();
  vi.unstubAllGlobals();
});

describe('PersonalSummary: Kalender abonnieren', () => {
  it('loads nothing until opened; creates the address on demand and shows it as this client reaches the server', async () => {
    const fetchMock = serve({ active: false, path: null, url: null, created_at: null, last_used_at: null, unreadable: false });
    renderSummary();
    expect(fetchMock).not.toHaveBeenCalled();
    const panel = await openPanel();
    fireEvent.click(await within(panel).findByRole('button', { name: /Abo-Adresse erzeugen/ }));
    const field = await within(panel).findByLabelText('Kalender-Adresse');
    expect(field.value).toBe(`${window.location.origin}/api/radar/feed.ics?token=${TOKEN_A}`);
    expect(within(panel).getByRole('link', { name: /In Kalender-App öffnen/ }).getAttribute('href')).toBe(`webcal://${window.location.host}/api/radar/feed.ics?token=${TOKEN_A}`);
    expect(within(panel).getByText('Noch nicht abgerufen.')).toBeTruthy();
    expect(methods(fetchMock)).toEqual(['GET', 'POST']);
    expect(toasts.messages('success')).toContain('Kalender-Adresse erzeugt');
  });

  it('copies the address; a new address needs a confirmation; ending the subscription deletes it', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const fetchMock = serve(active(TOKEN_A, { last_used_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString() }));
    renderSummary();
    const panel = await openPanel();
    await within(panel).findByLabelText('Kalender-Adresse');
    expect(panel.textContent).toMatch(/Zuletzt abgerufen vor 2 Std\./);

    fireEvent.click(within(panel).getByRole('button', { name: /Kopieren/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/api/radar/feed.ics?token=${TOKEN_A}`));

    fireEvent.click(within(panel).getByRole('button', { name: 'Neue Adresse erzeugen' }));
    expect(methods(fetchMock)).toEqual(['GET']);
    fireEvent.click(within(panel).getByRole('button', { name: 'Neu erzeugen' }));
    await waitFor(() => expect(within(panel).getByLabelText('Kalender-Adresse').value).toContain(TOKEN_A));
    expect(toasts.messages('success')).toContain('Neue Adresse erzeugt – die alte funktioniert nicht mehr');

    fireEvent.click(within(panel).getByRole('button', { name: 'Abo beenden' }));
    await within(panel).findByRole('button', { name: /Abo-Adresse erzeugen/ });
    expect(methods(fetchMock)).toEqual(['GET', 'POST', 'DELETE']);
  });

  it('explains a stored address that cannot be shown any more, and a failed load', async () => {
    serve(active(TOKEN_A, { path: null, url: null, unreadable: true }));
    const { unmount } = renderSummary();
    const panel = await openPanel();
    expect((await within(panel).findByText(/lässt sich nicht mehr anzeigen/)).textContent).toMatch(/neu erzeugen/);
    unmount();

    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(500, { error: 'Interner Serverfehler' })));
    renderSummary();
    const failed = await openPanel();
    expect((await within(failed).findByRole('alert')).textContent).toContain('Interner Serverfehler');
  });

  it('has subscription steps for iPhone, Android and Thunderbird', async () => {
    serve({ active: false });
    renderSummary();
    const panel = await openPanel();
    const steps = within(panel).getByText('So abonnierst du den Kalender').closest('details');
    expect(steps.textContent).toMatch(/iPhone\/iPad:.*Kalenderabo hinzufügen/);
    expect(steps.textContent).toMatch(/Android:.*Per URL/);
    expect(steps.textContent).toMatch(/Thunderbird:.*Im Netzwerk/);
  });

  it('feedAddress resolves the path against this client and needs one', () => {
    expect(feedAddress(null)).toBeNull();
    expect(feedAddress({ active: true, path: null })).toBeNull();
    expect(feedAddress({ path: '/api/radar/feed.ics?token=x' })).toBe(`${window.location.origin}/api/radar/feed.ics?token=x`);
  });
});
