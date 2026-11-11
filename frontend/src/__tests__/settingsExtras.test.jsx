// The settings dialog's own parts: "Ansicht zurücksetzen", the overview "Wer sieht was", the calendar addresses on
// "Dienste" and the devices on "Konto" (QR code, POST /api/auth/logout-others).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { fakeResponse } from './fakeResponse';
import AccountModal from '../components/modals/AccountModal';
import { ResetViewField } from '../components/modals/SettingsExtras';
import { resetViewPreferences, VIEW_PREFERENCE_KEYS } from '../utils/viewReset';
import { clearDataCache } from '../utils/dataCache';
import { recordToasts } from './toastLog';

const USER = { id: 2, username: 'kim', role: 'editor' };
const ME = { ...USER, default_anime_visibility: 'public', share_anime_activity: true, show_todo: true };

function serve(routes = {}) {
  let me = { ...ME };
  const fetchMock = vi.fn(async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${url}`;
    if (routes[key]) return routes[key](init);
    if (key === 'GET /api/auth/me') return fakeResponse(200, { user: me });
    if (key === 'PUT /api/auth/profile') {
      me = { ...me, ...JSON.parse(init.body) };
      return fakeResponse(200, { user: me });
    }
    return fakeResponse(404, { error: 'Nicht gefunden' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const open = (tab, user = USER) => render(<AccountModal isOpen onClose={vi.fn()} user={user} initialTab={tab} />);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearDataCache();
});

describe('Ansicht zurücksetzen', () => {
  it('removes the view of this device, also the per-account variants, and nothing else', () => {
    for (const key of VIEW_PREFERENCE_KEYS) localStorage.setItem(key, 'x');
    localStorage.setItem('mangashelf_person_filter:srv:2', '7');
    localStorage.setItem('mangashelf_saved_filters:2', '[]');
    localStorage.setItem('mangashelf_locale', 'en');
    localStorage.setItem('mangashelf_search_scopeX', 'keep');
    sessionStorage.setItem('mangashelf_search', 'naruto');
    sessionStorage.setItem('mangashelf_shelf_scroll', '120');

    expect(resetViewPreferences()).toBe(VIEW_PREFERENCE_KEYS.length + 2);
    expect(Object.keys(localStorage).sort()).toEqual(['mangashelf_locale', 'mangashelf_saved_filters:2', 'mangashelf_search_scopeX']);
    expect(Object.keys(sessionStorage)).toEqual(['mangashelf_shelf_scroll']);
  });

  it('every key is one a hook or component of the app really stores', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(import.meta.dirname, '..');
    const sources = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'locales') continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.jsx?$/.test(entry.name) && !file.endsWith('viewReset.js')) sources.push(fs.readFileSync(file, 'utf8'));
      }
    };
    walk(root);
    const all = sources.join('\n');
    for (const key of VIEW_PREFERENCE_KEYS) expect(all.includes(`'${key}'`), key).toBe(true);
  });

  it('the button sits on "Allgemein", clears the view, drops the filter parameters and reloads onto the same tab', () => {
    serve();
    localStorage.setItem('mangashelf_sort_by', 'title_desc');
    window.history.replaceState(null, '', '/?status=READING');
    const reload = vi.fn();
    const alone = render(<ResetViewField reload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ansicht zurücksetzen' }));
    expect(localStorage.getItem('mangashelf_sort_by')).toBeNull();
    expect(window.location.search).toBe('');
    expect(sessionStorage.getItem('mangashelf_reopen_account')).toBe('general');
    expect(reload).toHaveBeenCalledTimes(1);
    alone.unmount();

    open('general');
    expect(screen.getByRole('heading', { name: 'Ansicht auf diesem Gerät' }).tagName).toBe('H3');
    expect(document.getElementById('btn-reset-view')).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Sprache', 'Sammlung', 'Ansicht auf diesem Gerät']);
  });
});

describe('Wer sieht was', () => {
  const rows = () => Object.fromEntries([...document.querySelectorAll('#settings-who-sees > div')].map((row) => [row.querySelector('dt').textContent, row.querySelector('dd').textContent]));

  it('lists who sees what and follows the two anime settings above it', async () => {
    serve();
    open('privacy');
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Anime', 'Wer sieht was']);
    const share = screen.getByLabelText('Meine Anime-Liste mit Namen zeigen');
    await waitFor(() => expect(share.disabled).toBe(false));
    expect(rows()).toEqual({
      'Sammlung, Besitz und Gelesen': 'Mitglieder deiner Regale',
      Wunschliste: 'Mitglieder deiner Regale',
      'Anime-Liste': 'Alle Konten, mit deinem Namen',
      'Neue Anime-Bewertungen': 'Alle Konten, mit deinem Namen',
      'Anime-Notizen': 'Nur du'
    });

    fireEvent.click(share);
    await waitFor(() => expect(rows()['Anime-Liste']).toBe('Nur du'));
    fireEvent.change(screen.getByLabelText('Sichtbarkeit deiner Anime-Bewertungen'), { target: { value: 'anonymous' } });
    await waitFor(() => expect(rows()['Neue Anime-Bewertungen']).toBe('Alle Konten, ohne Namen'));
    fireEvent.change(screen.getByLabelText('Sichtbarkeit deiner Anime-Bewertungen'), { target: { value: 'private' } });
    await waitFor(() => expect(rows()['Neue Anime-Bewertungen']).toBe('Nur du'));
  });
});

describe('Kalender-Abo on "Dienste"', () => {
  it('opens the radar or the anime address with its own token route, one at a time; offline there is none', async () => {
    const fetchMock = serve({
      'GET /api/sources/guides': () => fakeResponse(200, []),
      'GET /api/auth/api-keys': () => fakeResponse(200, []),
      'GET /api/radar/feed-token': () => fakeResponse(200, { active: false }),
      'GET /api/anime/feed-token': () => fakeResponse(200, { active: false })
    });
    const view = open('services');
    const section = (await screen.findByRole('heading', { name: 'Kalender-Abo' })).closest('section');
    const radar = within(section).getByRole('button', { name: 'Manga-Termine' });
    const anime = within(section).getByRole('button', { name: 'Anime-Folgen' });
    expect([radar.getAttribute('aria-expanded'), anime.getAttribute('aria-expanded')]).toEqual(['false', 'false']);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('feed-token'))).toBe(false);

    fireEvent.click(radar);
    expect(document.getElementById('radar-calendar-feed')).toBeTruthy();
    await within(section).findByRole('button', { name: 'Abo-Adresse erzeugen' });
    fireEvent.click(anime);
    expect(document.getElementById('radar-calendar-feed')).toBeNull();
    expect(document.getElementById('anime-calendar-feed')).toBeTruthy();
    expect([radar.getAttribute('aria-expanded'), anime.getAttribute('aria-expanded')]).toEqual(['false', 'true']);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/anime/feed-token')).toBe(true));
    fireEvent.click(anime);
    expect(document.getElementById('anime-calendar-feed')).toBeNull();
    view.unmount();

    open('services', { ...USER, offline: true });
    await screen.findByRole('tab', { name: 'Dienste' });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('heading', { name: 'Kalender-Abo' })).toBeNull();
  });
});

describe('Geräte on "Konto"', () => {
  it('editors get the QR code of the app; the footer control keeps its own id', () => {
    serve({ 'GET /api/auth/connect-info': () => fakeResponse(200, { url: 'http://shelf.test', name: 'Manga Shelf', instance_id: 'abc', link: 'manga-shelf://connect?url=x' }) });
    open('account');
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Passwort ändern', 'Geräte']);
    const qr = document.getElementById('settings-connect-app');
    expect(qr.textContent.trim()).toBe('Mit App verbinden');
    expect(document.getElementById('footer-connect-app')).toBeNull();
    fireEvent.click(qr);
    expect(screen.getByRole('dialog', { name: 'Mit App verbinden' })).toBeTruthy();
  });

  it('visitors get no QR code but can sign out their other devices', async () => {
    const toasts = recordToasts();
    const fetchMock = serve({ 'POST /api/auth/logout-others': () => fakeResponse(200, { success: true }) });
    open('account', { id: 4, username: 'gast', role: 'visitor' });
    expect(document.getElementById('settings-connect-app')).toBeNull();
    const button = screen.getByRole('button', { name: 'Auf anderen Geräten abmelden' });
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(fetchMock.mock.calls.filter(([url, init]) => url === '/api/auth/logout-others' && init?.method === 'POST')).toHaveLength(1);
    expect(toasts.messages()).toContain('Alle anderen Geräte sind abgemeldet.');
    toasts.stop();
  });

  it('a refusal shows the message of the server and nothing is claimed', async () => {
    const toasts = recordToasts();
    serve({ 'POST /api/auth/logout-others': () => fakeResponse(429, { error: 'Zu viele Versuche, das Passwort zu ändern. Bitte in einigen Minuten erneut versuchen.' }) });
    open('account');
    const button = screen.getByRole('button', { name: 'Auf anderen Geräten abmelden' });
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(toasts.messages().join(' ')).toMatch(/Zu viele Versuche/);
    expect(toasts.messages()).not.toContain('Alle anderen Geräte sind abgemeldet.');
    toasts.stop();
  });
});
