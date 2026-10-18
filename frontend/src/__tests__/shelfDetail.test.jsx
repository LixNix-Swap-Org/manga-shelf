// Series page and shelves: the move to another shelf asks first and names whose marks go; a viewer of the shelf marks
// their own reads but not ownership.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { useState } from 'react';

vi.mock('../utils/offlineStore', async (importOriginal) => ({
  ...(await importOriginal()),
  loadMangaDetail: vi.fn(async () => null),
  updateCachedManga: vi.fn(async () => {}),
  patchCachedManga: vi.fn(async () => {}),
  syncOfflineCopy: vi.fn(async () => true)
}));

import MangaDetail from '../MangaDetail';
import MangaHeroCard from '../components/detail/MangaHeroCard';
import { shelfMoveConfirmText } from '../hooks/useMangaData';
import { clearShelves } from '../utils/shelfScope';
import { clearDataCache } from '../utils/dataCache';
import { resetOutbox } from '../utils/outbox';
import { fakeResponse } from './fakeResponse';
import { recordToasts } from './toastLog';

const SHELVES = [
  { id: 1, name: 'Familie', role: 'owner', is_default: true },
  { id: 3, name: 'Zweites', role: 'editor', is_default: false }
];

let toasts;
let routes;
let fetchMock;
beforeEach(() => {
  toasts = recordToasts();
  localStorage.clear();
  clearShelves();
  clearDataCache();
  resetOutbox();
  routes = {};
  fetchMock = vi.fn(async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${String(url)}`;
    const handler = routes[key];
    return handler ? handler(init) : fakeResponse(404, { error: 'unbekannt' });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  toasts.stop();
  vi.unstubAllGlobals();
});

const sent = (method, prefix) => fetchMock.mock.calls
  .filter(([url, init = {}]) => (init.method || 'GET') === method && String(url).startsWith(prefix))
  .map(([url, init]) => [String(url), init.body ? JSON.parse(init.body) : undefined]);

describe('shelfMoveConfirmText', () => {
  it('names each affected user with the counts, or says it in general without the preview', () => {
    const named = shelfMoveConfirmText({ title: 'Naruto', shelf: 'Zweites', affected: [{ user_id: 2, username: 'erika', owned: 3, read: 1 }] });
    expect(named).toContain('„Naruto“ nach „Zweites“ verschieben?');
    expect(named).toContain('erika (3 Bände im Besitz, 1 Band gelesen)');
    expect(named).toContain('Das lässt sich nicht rückgängig machen.');
    const general = shelfMoveConfirmText({ title: 'Naruto', shelf: 'Zweites', affected: null });
    expect(general).toContain('Wer dieses Regal nicht sieht, verliert seine Besitz- und Lesemarkierungen an der Reihe;');
  });
});

describe('MangaHeroCard: shelf select', () => {
  function Host({ manga }) {
    const [formData, setFormData] = useState({ title: manga.title, status: 'Laufend', cover_image: '', shelf_id: String(manga.shelf_id) });
    return (
      <>
        <MangaHeroCard
          canEdit completionPct={0} editing formData={formData} setFormData={setFormData} manga={manga}
          handleCoverUpload={vi.fn()} handleDeleteManga={vi.fn()} handleEditLookup={vi.fn()} handleUpdate={(e) => e.preventDefault()}
          ownedCount={0} saving={false} setEditLookupResults={vi.fn()} setEditing={vi.fn()} startEditing={vi.fn()} cancelEditing={vi.fn()}
          totalOwnedValue={0} totalTarget={0} uploadingCover={false}
          movableShelves={SHELVES}
        />
        <output data-testid="chosen">{formData.shelf_id}</output>
      </>
    );
  }
  const manga = { id: 5, title: 'Naruto', shelf_id: 1, cover_image: null };
  const renderCard = () => render(<MemoryRouter><Host manga={manga} /></MemoryRouter>);
  const chosen = () => screen.getByTestId('chosen').textContent;

  it('asks before the choice counts and names the users who lose their marks; Abbrechen keeps the shelf', async () => {
    routes['GET /api/mangas/5/shelf-move?shelf_id=3'] = () => fakeResponse(200, { manga_id: 5, shelf_id: 3, affected: [{ user_id: 2, username: 'erika', owned: 3, read: 5 }] });
    renderCard();
    const select = screen.getByLabelText('Regal');
    fireEvent.change(select, { target: { value: '3' } });
    let question = await screen.findByRole('dialog', { name: 'Reihe verschieben' });
    expect(question.textContent).toContain('erika (3 Bände im Besitz, 5 Bände gelesen)');
    expect(chosen()).toBe('1');
    fireEvent.click(within(question).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Reihe verschieben' })).toBeNull());
    expect(chosen()).toBe('1');
    expect(select.value).toBe('1');

    fireEvent.change(select, { target: { value: '3' } });
    question = await screen.findByRole('dialog', { name: 'Reihe verschieben' });
    fireEvent.click(within(question).getByRole('button', { name: 'Verschieben' }));
    await waitFor(() => expect(chosen()).toBe('3'));
    expect(select.value).toBe('3');
  });

  it('without anybody losing marks the choice counts at once; an older server gets the general question', async () => {
    routes['GET /api/mangas/5/shelf-move?shelf_id=3'] = () => fakeResponse(200, { manga_id: 5, shelf_id: 3, affected: [] });
    const { unmount } = renderCard();
    fireEvent.change(screen.getByLabelText('Regal'), { target: { value: '3' } });
    await waitFor(() => expect(chosen()).toBe('3'));
    expect(screen.queryByRole('dialog', { name: 'Reihe verschieben' })).toBeNull();
    unmount();

    delete routes['GET /api/mangas/5/shelf-move?shelf_id=3'];
    renderCard();
    fireEvent.change(screen.getByLabelText('Regal'), { target: { value: '3' } });
    const question = await screen.findByRole('dialog', { name: 'Reihe verschieben' });
    expect(question.textContent).toContain('Wer dieses Regal nicht sieht, verliert seine Besitz- und Lesemarkierungen an der Reihe;');
    expect(chosen()).toBe('1');
  });
});

const owner = { id: 1, username: 'felix', role: 'editor' };
const renderPage = (user) => render(
  <MemoryRouter initialEntries={['/manga/5']}>
    <Routes>
      <Route path="/manga/:id" element={<MangaDetail user={user} onUnauthorized={vi.fn()} />} />
      <Route path="/" element={<p>Regal</p>} />
    </Routes>
  </MemoryRouter>
);

describe('MangaDetail: moving a series', () => {
  beforeEach(() => {
    routes['GET /api/shelves'] = () => fakeResponse(200, { shelves: SHELVES });
    routes['GET /api/mangas/5'] = () => fakeResponse(200, { id: 5, title: 'Naruto', status: 'Laufend', shelf_id: 1, volumes: [], reader_stats: [] });
    routes['GET /api/mangas/5/shelf-move?shelf_id=3'] = () => fakeResponse(200, { manga_id: 5, shelf_id: 3, affected: [{ user_id: 2, username: 'erika', owned: 1, read: 2 }] });
    routes['PUT /api/mangas/5/shelf'] = () => fakeResponse(200, { success: true, id: 5, shelf_id: 3 });
  });

  it('PUT /api/mangas/:id/shelf only runs after the confirmed question', async () => {
    renderPage(owner);
    fireEvent.click(await screen.findByRole('button', { name: /Bearbeiten/ }));
    const select = await screen.findByLabelText('Regal');
    fireEvent.change(select, { target: { value: '3' } });
    const question = await screen.findByRole('dialog', { name: 'Reihe verschieben' });
    expect(question.textContent).toContain('erika (1 Band im Besitz, 2 Bände gelesen)');
    fireEvent.click(within(question).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Reihe verschieben' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /Speichern/ }));
    await waitFor(() => expect(screen.queryByLabelText('Regal')).toBeNull());
    expect(sent('PUT', '/api/mangas/5/shelf')).toEqual([]);

    fireEvent.click(await screen.findByRole('button', { name: /Bearbeiten/ }));
    fireEvent.change(await screen.findByLabelText('Regal'), { target: { value: '3' } });
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Reihe verschieben' })).getByRole('button', { name: 'Verschieben' }));
    await waitFor(() => expect(screen.getByLabelText('Regal').value).toBe('3'));
    fireEvent.click(screen.getByRole('button', { name: /Speichern/ }));
    await waitFor(() => expect(sent('PUT', '/api/mangas/5/shelf')).toEqual([['/api/mangas/5/shelf', { shelf_id: 3 }]]));
  });
});

describe('MangaDetail: a viewer of the shelf', () => {
  const volume = { id: 51, manga_id: 5, volume_number: '1', type: 'volume', status: 'Vorhanden', owners: [{ user_id: 3, username: 'anna' }], read_users: [] };
  beforeEach(() => {
    localStorage.setItem('mangashelf_volume_view_mode', 'grid');
    routes['GET /api/shelves'] = () => fakeResponse(200, { shelves: [{ id: 3, name: 'Zweites', role: 'viewer', is_default: false }] });
    routes['GET /api/mangas/5'] = () => fakeResponse(200, { id: 5, title: 'Naruto', status: 'Laufend', shelf_id: 3, volumes: [volume], reader_stats: [] });
    routes['POST /api/volumes/51/read'] = () => fakeResponse(200, { success: true, read: true });
  });

  it('marks own reads, but cannot change ownership or edit the series', async () => {
    renderPage({ id: 2, username: 'ben', role: 'editor' });
    expect(await screen.findByText('Nur Leseansicht (Leser)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Bearbeiten/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Status: Vorhanden/ }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: /Bis Band X als gelesen/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Mehrere Bände anlegen/ })).toBeNull();
    const read = screen.getByRole('button', { name: 'Ungelesen – Band 1' });
    expect(read.disabled).toBe(false);
    fireEvent.click(read);
    await waitFor(() => expect(sent('POST', '/api/volumes/51/read')).toHaveLength(1));
  });

  it('a visitor account reads only, as before', async () => {
    renderPage({ id: 4, username: 'gast', role: 'visitor' });
    await screen.findByText('Naruto');
    expect(screen.getByRole('button', { name: 'Ungelesen – Band 1' }).disabled).toBe(true);
    expect(sent('GET', '/api/shelves')).toEqual([]);
  });
});
