// MangaDetail page: structure, cached copy, scroll, back link and offline toggles.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('../utils/offlineStore', () => ({
  loadMangaDetail: vi.fn(async () => null),
  updateCachedManga: vi.fn(async () => {}),
  syncOfflineCopy: vi.fn(async () => true)
}));

import MangaDetail, { backLinkTarget, DETAIL_SCROLL_KEY } from '../MangaDetail';
import { loadMangaDetail } from '../utils/offlineStore';
import { fakeResponse } from './fakeResponse';
import { clearDataCache, writeCache, readCache, LIST_KEY, detailKey } from '../utils/dataCache';
import { recordToasts } from './toastLog';

let toasts;
beforeEach(() => {
  toasts = recordToasts();
  clearDataCache();
});
afterEach(() => { toasts.stop(); });

const json = (status, body) => fakeResponse(status, body);
const editor = { id: 2, username: 'ed', role: 'editor' };
const MANGA = { id: 5, title: 'Server Titel', status: 'Laufend', total_volumes: 3, volumes: [], reader_stats: [] };

function stubFetch(mangaResponse) {
  const fetchMock = vi.fn(async (url) => {
    if (url === '/api/mangas/5') return mangaResponse();
    if (url.startsWith('/api/mangas/5/gaps')) return json(200, { matched: false, gaps: [] });
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPage({ state, onUnauthorized, user = editor } = {}) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/manga/5', state }]}>
      <Routes>
        <Route path="/manga/:id" element={<MangaDetail user={user} onUnauthorized={onUnauthorized} />} />
        <Route path="/" element={<p>Regal</p>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('MangaDetail page', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a first-load server error shows a panel with retry and a way back', async () => {
    let answer = () => json(500, { error: 'kaputt' });
    const fetchMock = stubFetch(() => answer());
    renderPage({ state: { from: '/?view=shopping' } });
    expect(await screen.findByText('Server nicht erreichbar')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Zurück zur Übersicht/ }).getAttribute('href')).toBe('/?view=shopping');

    answer = () => json(200, MANGA);
    fireEvent.click(screen.getByRole('button', { name: /Erneut versuchen/ }));
    expect(await screen.findByText('Server Titel')).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/mangas/5')).toHaveLength(2);
  });

  it('a first-load 401 hands over to the session handler and shows the login hint', async () => {
    stubFetch(() => json(401, { error: 'Sitzung ungültig', code: 'SESSION_INVALID' }));
    const onUnauthorized = vi.fn();
    renderPage({ onUnauthorized });
    expect(await screen.findByText('Sitzung abgelaufen')).toBeTruthy();
    expect(onUnauthorized).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: /Zur Anmeldung/ })).toBeTruthy();
  });

  it('the back link of a loaded series returns to the page that linked here', async () => {
    stubFetch(() => json(200, MANGA));
    renderPage({ state: { from: '/?view=shopping' } });
    await screen.findByText('Server Titel');
    expect(screen.getByRole('link', { name: /Zurück zur Übersicht/ }).getAttribute('href')).toBe('/?view=shopping');
  });

  it('Escape typed in the title field keeps the edit form and what was typed', async () => {
    stubFetch(() => json(200, MANGA));
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderPage();
    await screen.findByText('Server Titel');
    fireEvent.click(screen.getByRole('button', { name: /Bearbeiten/ }));
    const title = await screen.findByDisplayValue('Server Titel');
    fireEvent.change(title, { target: { value: 'Getippter Titel' } });
    fireEvent.keyDown(title, { key: 'Escape', bubbles: true, cancelable: true });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Getippter Titel')).toBeTruthy();

    // outside a field Escape asks before discarding
    confirmSpy.mockReturnValueOnce(false);
    fireEvent.keyDown(document.body, { key: 'Escape', bubbles: true, cancelable: true });
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByDisplayValue('Getippter Titel')).toBeTruthy();
  });
});

describe('MangaDetail page structure', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a loaded series has a main landmark, a skip link, its title as tab name and a focusable h1', async () => {
    stubFetch(() => json(200, MANGA));
    renderPage();
    const heading = await screen.findByRole('heading', { level: 1, name: 'Server Titel' });
    expect(heading.tabIndex).toBe(-1);
    expect(document.title).toBe('Server Titel – Manga Shelf');
    const main = screen.getByRole('main');
    expect(main.contains(heading)).toBe(true);
    expect(screen.getByRole('link', { name: 'Zum Inhalt springen' }).getAttribute('href')).toBe(`#${main.id}`);
    expect(screen.getByRole('navigation', { name: 'Seitennavigation' })).toBeTruthy();
    expect(screen.getByRole('region', { name: /Bände-Checkliste/ })).toBeTruthy();
  });

  it('loading and not-found states are inside main too', async () => {
    stubFetch(() => json(404, { error: 'weg' }));
    renderPage();
    expect(screen.getByRole('main')).toBeTruthy();
    const heading = await screen.findByRole('heading', { level: 1, name: 'Manga nicht gefunden' });
    expect(screen.getByRole('main').contains(heading)).toBe(true);
    expect(document.title).toBe('Manga nicht gefunden – Manga Shelf');
  });
});

describe('MangaDetail: title, cached copy and scroll', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.scrollY = 0;
  });

  it('while loading, the tab shows the title the shelf already knows, never the generic one', async () => {
    writeCache(editor.id, LIST_KEY, [{ id: 5, title: 'Aus dem Regal' }]);
    document.title = 'Sammlung – Manga Shelf';
    let answer;
    stubFetch(() => new Promise((resolve) => { answer = resolve; }));
    renderPage();
    expect(screen.getByText('Lade Manga-Details...')).toBeTruthy();
    expect(document.title).toBe('Aus dem Regal – Manga Shelf');
    await act(async () => { answer(json(200, MANGA)); });
    expect(document.title).toBe('Server Titel – Manga Shelf');
  });

  it('a load error names the error in the tab', async () => {
    stubFetch(() => json(500, { error: 'kaputt' }));
    renderPage();
    await screen.findByText('Server nicht erreichbar');
    expect(document.title).toBe('Server nicht erreichbar – Manga Shelf');
  });

  it('a series seen before renders at once and is revalidated with its ETag; a 304 keeps it', async () => {
    writeCache(editor.id, detailKey('5'), { ...MANGA, title: 'Gemerkt' }, 'W/"d1"');
    const fetchMock = stubFetch(() => fakeResponse(304));
    renderPage();
    expect(screen.queryByText('Lade Manga-Details...')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Gemerkt' })).toBeTruthy();
    await act(async () => {});
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/mangas/5');
    expect(call[1].headers).toEqual({ 'If-None-Match': 'W/"d1"' });
    expect(screen.getByRole('heading', { level: 1, name: 'Gemerkt' })).toBeTruthy();
    expect(screen.queryByText(/Aktualisierung fehlgeschlagen/)).toBeNull();
  });

  it('a newer answer replaces the remembered copy and is remembered with its ETag', async () => {
    writeCache(editor.id, detailKey('5'), { ...MANGA, title: 'Alt' }, 'W/"d1"');
    stubFetch(() => fakeResponse(200, MANGA));
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Server Titel' })).toBeTruthy();
    expect(readCache(editor.id, detailKey('5')).data.title).toBe('Server Titel');
  });

  it('a series opened from a scrolled shelf starts at the top', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    window.scrollY = 1500;
    stubFetch(() => json(200, MANGA));
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Server Titel' });
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('Back to a series returns to where it was left', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    stubFetch(() => json(200, MANGA));
    const entry = { pathname: '/manga/5', key: 'eintrag5' };
    sessionStorage.setItem(DETAIL_SCROLL_KEY, JSON.stringify({ eintrag5: 640 }));
    render(
      <MemoryRouter initialEntries={['/', entry]} initialIndex={1}>
        <Routes><Route path="/manga/:id" element={<MangaDetail user={editor} />} /></Routes>
      </MemoryRouter>
    );
    await screen.findByRole('heading', { level: 1, name: 'Server Titel' });
    expect(window.scrollTo).toHaveBeenCalledWith(0, 640);
  });

  it('leaving a series stores its scroll position for this history entry', async () => {
    stubFetch(() => json(200, MANGA));
    const view = render(
      <MemoryRouter initialEntries={[{ pathname: '/manga/5', key: 'eintrag7' }]}>
        <Routes><Route path="/manga/:id" element={<MangaDetail user={editor} />} /></Routes>
      </MemoryRouter>
    );
    await screen.findByRole('heading', { level: 1, name: 'Server Titel' });
    act(() => {
      window.scrollY = 321;
      window.dispatchEvent(new Event('scroll'));
    });
    view.unmount();
    expect(JSON.parse(sessionStorage.getItem(DETAIL_SCROLL_KEY)).eintrag7).toBe(321);
  });

  it('dialogs are not mounted until opened', async () => {
    stubFetch(() => json(200, MANGA));
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Server Titel' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Mehrere Bände anlegen/ }));
    expect(await screen.findByRole('dialog', { name: 'Bände hinzufügen' })).toBeTruthy();
  });
});

describe('backLinkTarget', () => {
  it('only accepts in-app paths', () => {
    expect(backLinkTarget({ from: '/?view=shopping' })).toBe('/?view=shopping');
    expect(backLinkTarget(null)).toBe('/');
    expect(backLinkTarget({ from: 'https://example.com/' })).toBe('/');
    expect(backLinkTarget({ from: '//example.com' })).toBe('/');
    expect(backLinkTarget({ from: '/\\example.com' })).toBe('/');
    expect(backLinkTarget({ from: { pathname: '/x' } })).toBe('/');
  });
});

describe('MangaDetail offline toggles', () => {
  const series = { ...MANGA, volumes: [{ id: 51, manga_id: 5, volume_number: '1', type: 'volume', status: 'Fehlt', owners: [], read_users: [] }] };
  afterEach(() => {
    loadMangaDetail.mockReset().mockResolvedValue(null);
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('an editor in the offline mode can toggle the status; a visitor cannot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    localStorage.setItem('mangashelf_volume_view_mode', 'grid');
    loadMangaDetail.mockResolvedValue(series);
    const view = renderPage({ user: { id: 2, username: 'ed', role: 'visitor', realRole: 'editor', offline: true } });
    const toggle = await screen.findByRole('button', { name: /^Status: Fehlt/ });
    expect(toggle.disabled).toBe(false);
    expect(screen.queryByRole('button', { name: /löschen$/ })).toBeNull();
    view.unmount();

    renderPage({ user: { id: 3, username: 'gast', role: 'visitor', realRole: 'visitor', offline: true } });
    expect((await screen.findByRole('button', { name: /^Status: Fehlt/ })).disabled).toBe(true);
  });
});
