// DetailBottomBar on phones and the detail scan action.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const scan = vi.hoisted(() => ({ code: '' }));
vi.mock('../components/common/BarcodeScannerButton', () => ({
  default: ({ id, onDetected, children }) => <button type="button" id={id} onClick={() => onDetected(scan.code)}>{children}</button>
}));
vi.mock('../utils/offlineStore', () => ({
  loadMangaDetail: vi.fn(async () => null),
  updateCachedManga: vi.fn(async () => {}),
  syncOfflineCopy: vi.fn(async () => true)
}));

import MangaDetail from '../MangaDetail';
import { detailScanAction, findScannedVolume, DETAIL_SCAN_FAILED } from '../components/detail/DetailBottomBar';
import { NARROW_QUERY } from '../components/common/BottomNav';
import { clearDataCache } from '../utils/dataCache';
import { loadMangaDetail } from '../utils/offlineStore';
import { fakeResponse } from './fakeResponse';
import { recordToasts } from './toastLog';

const json = (status, body) => fakeResponse(status, body);
const editor = { id: 2, username: 'ed', role: 'editor' };
const visitor = { id: 3, username: 'gast', role: 'visitor' };
const VOLUMES = [
  { id: 51, manga_id: 5, volume_number: '1', type: 'volume', status: 'Vorhanden', isbn: '9783551000019', owners: [], read_users: [] },
  { id: 52, manga_id: 5, volume_number: '2', type: 'volume', status: 'Fehlt', isbn: '', owners: [], read_users: [] }
];
const MANGA = { id: 5, title: 'Server Titel', status: 'Laufend', total_volumes: 3, volumes: VOLUMES, reader_stats: [] };

/** A phone (375 px): the narrow query matches. */
function phone(narrow = true) {
  vi.stubGlobal('matchMedia', vi.fn((query) => ({
    matches: query === NARROW_QUERY ? narrow : false, media: query, addEventListener() {}, removeEventListener() {}
  })));
}

function stubFetch(lookup = () => json(404, {})) {
  const fetchMock = vi.fn(async (url) => {
    if (url === '/api/mangas/5') return json(200, MANGA);
    if (url.startsWith('/api/mangas/5/gaps')) return json(200, { matched: false, gaps: [] });
    if (url.startsWith('/api/lookup/isbn')) return lookup(url);
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderPage({ user = editor, state = { from: '/?view=shopping' } } = {}) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/manga/5', state }]}>
      <Routes>
        <Route path="/manga/:id" element={<><MangaDetail user={user} /><Where /></>} />
        <Route path="/" element={<p>Regal</p>} />
      </Routes>
    </MemoryRouter>
  );
}

let toasts;
beforeEach(() => {
  toasts = recordToasts();
  clearDataCache();
  localStorage.clear();
  localStorage.setItem('mangashelf_volume_view_mode', 'grid');
  scan.code = '';
});
afterEach(() => {
  toasts.stop();
  vi.unstubAllGlobals();
});

describe('detail context bar at 375 px', () => {
  it('shows back, scan and "Band hinzufügen"; the page leaves room for it', async () => {
    phone();
    stubFetch();
    const { container } = renderPage();
    await screen.findByText('Server Titel');
    const bar = document.getElementById('detail-bottom-bar');
    expect(bar).toBeTruthy();
    expect(bar.parentElement).toBe(document.body);
    expect(bar.querySelector('#btn-detail-back').getAttribute('href')).toBe('/?view=shopping');
    expect(bar.querySelector('#btn-detail-scan')).toBeTruthy();
    const page = container.firstElementChild;
    expect(page.className).toContain('max-sm:pb-[calc(5.5rem+env(safe-area-inset-bottom))]');
    expect(page.className).toContain('max-sm:[&_#bulk-action-bar]:bottom-[calc(4.25rem+env(safe-area-inset-bottom))]');
  });

  it('"Band hinzufügen" focuses the number field of the add form', async () => {
    phone();
    stubFetch();
    renderPage();
    await screen.findByText('Server Titel');
    fireEvent.click(screen.getByRole('button', { name: 'Band hinzufügen' }));
    expect(document.activeElement.id).toMatch(/-number$/);
    expect(document.activeElement.closest('form')).toBeTruthy();
  });

  it('is not rendered on wider screens or without matchMedia', async () => {
    phone(false);
    stubFetch();
    renderPage();
    await screen.findByText('Server Titel');
    expect(document.getElementById('detail-bottom-bar')).toBeNull();
  });

  it('visitors get back and scan, but no "Band hinzufügen"', async () => {
    phone();
    stubFetch();
    renderPage({ user: visitor });
    await screen.findByText('Server Titel');
    expect(document.getElementById('detail-bottom-bar')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Band hinzufügen' })).toBeNull();
  });

  it('a scanned ISBN of a loaded volume opens it without asking the server', async () => {
    phone();
    const fetchMock = stubFetch();
    renderPage();
    await screen.findByText('Server Titel');
    scan.code = '3551000018';
    fireEvent.click(document.getElementById('btn-detail-scan'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith('/api/lookup/isbn'))).toBe(false);
  });

  it('a catalogue hit this series lacks fills the add form with number and price', async () => {
    phone();
    stubFetch(() => json(200, {
      isbn: '9783551000035', found: true, matched_manga: { id: 5, title: 'Server Titel' }, matched_volume: null,
      book: { title: 'Server Titel', volume_number: '3', volume_number_known: true, price: 7.5 }
    }));
    renderPage();
    await screen.findByText('Server Titel');
    scan.code = '9783551000035';
    fireEvent.click(document.getElementById('btn-detail-scan'));
    await waitFor(() => expect(document.activeElement.value).toBe('3'));
    expect(screen.getByDisplayValue('7.5')).toBeTruthy();
    expect(toasts.messages('info')).toContain('Band 3 übernommen – bitte prüfen und hinzufügen.');
  });

  it('an ISBN of another series offers to open it', async () => {
    phone();
    stubFetch(() => json(200, {
      isbn: '9783551999999', found: true, matched_manga: { id: 9, title: 'Andere Reihe' }, matched_volume: { id: 90 }, book: {}
    }));
    renderPage();
    await screen.findByText('Server Titel');
    scan.code = '9783551999999';
    fireEvent.click(document.getElementById('btn-detail-scan'));
    await waitFor(() => expect(toasts.messages('info')).toContain('Diese ISBN gehört zu „Andere Reihe“.'));
    toasts.last().action.onClick();
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/manga/9'));
  });

  it('offline the scan only finds the loaded volumes', async () => {
    phone();
    const fetchMock = vi.fn(async () => { throw new TypeError('offline'); });
    vi.stubGlobal('fetch', fetchMock);
    loadMangaDetail.mockResolvedValue(MANGA);
    const { container } = renderPage({ user: { ...editor, role: 'visitor', realRole: 'editor', offline: true } });
    await screen.findByText('Server Titel');
    expect(container.firstElementChild.className).toContain('max-sm:pb-[calc(8rem+env(safe-area-inset-bottom))]');
    scan.code = '9783551000035';
    fireEvent.click(document.getElementById('btn-detail-scan'));
    await waitFor(() => expect(toasts.messages('error')).toEqual(['Die ISBN-Suche braucht eine Verbindung zum Server.']));
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/lookup/isbn'))).toBe(false);
    loadMangaDetail.mockReset().mockResolvedValue(null);
  });
});

describe('detailScanAction', () => {
  const book = { title: 'Naruto', series: 'Naruto', volume_number: '4', volume_number_known: true, price: 7 };

  it('opens a volume of this series and points to another series', () => {
    expect(detailScanAction({ ok: true, data: { found: true, matched_manga: { id: 5 }, matched_volume: { id: 1 } }, mangaId: '5' }))
      .toEqual({ type: 'open', volume: { id: 1 } });
    expect(detailScanAction({ ok: true, data: { found: true, matched_manga: { id: 6, title: 'B' }, matched_volume: { id: 1 } }, mangaId: 5 }).type)
      .toBe('other');
    expect(detailScanAction({ ok: true, data: { found: true, matched_manga: null, matched_candidates: [{ id: 7 }], book }, mangaId: 5, canEdit: true }))
      .toEqual({ type: 'other', manga: { id: 7 } });
    expect(detailScanAction({ ok: true, data: { found: true, matched_manga: null, matched_candidates: [{ id: 7 }, { id: 8 }], book }, mangaId: 5 }).type)
      .toBe('notice');
  });

  it('prefills for editors (number only when the catalogue knew it), tells visitors it is missing', () => {
    expect(detailScanAction({ ok: true, data: { isbn: '9783551000019', found: true, matched_manga: { id: 5 }, book }, mangaId: 5, canEdit: true }))
      .toEqual({ type: 'prefill', number: '4', price: '7', title: '', isbn: '9783551000019' });
    expect(detailScanAction({ ok: true, data: { found: true, matched_manga: null, matched_candidates: [{ id: 5 }, { id: 8 }], book: { ...book, volume_number_known: false, price: null } }, mangaId: 5, canEdit: true }))
      .toEqual({ type: 'prefill', number: '', price: '', title: 'Naruto', isbn: '' });
    expect(detailScanAction({ ok: true, data: { found: true, matched_manga: { id: 5 }, book }, mangaId: 5, canEdit: false }).type).toBe('notice');
  });

  it('reports errors and unknown ISBNs', () => {
    expect(detailScanAction({ ok: false, data: { error: 'Das ist keine gültige ISBN' } })).toEqual({ type: 'error', message: 'Das ist keine gültige ISBN' });
    expect(detailScanAction({ ok: false, data: null })).toEqual({ type: 'error', message: DETAIL_SCAN_FAILED });
    expect(detailScanAction({ ok: true, data: { found: false, message: 'Keine Metadaten' } })).toEqual({ type: 'notFound', message: 'Keine Metadaten' });
  });

  it('findScannedVolume compares ISBN-10 and ISBN-13', () => {
    expect(findScannedVolume(VOLUMES, '3551000018')?.id).toBe(51);
    expect(findScannedVolume(VOLUMES, '978-3-551-00001-9')?.id).toBe(51);
    expect(findScannedVolume(VOLUMES, '9783551000035')).toBeNull();
    expect(findScannedVolume(VOLUMES, '')).toBeNull();
  });
});
